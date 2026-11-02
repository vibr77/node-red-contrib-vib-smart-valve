
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.82.1
  \ V / | || _ \   /      Date: 20261030
   \_/ |___|___/_|_\      Description: Nodered Heating Valve Management
                2026      Licence: Creative Commons
______________________
*/
/* TEST Env
npm install ./modulename (SmartValve / SmartBoiler / SmartSchedule)
node-red -v -D logging.console.level=trace
// Web http://localhost:1880/

Deploy to npmjs
npm publish

0.82 hardening
 - The scheduler is the single source of truth. A setpoint reported by the TRV is only used as
   feedback; with "Manual valve" off it is never forwarded to the boiler and the scheduled setpoint
   is pushed back to the TRV.
 - Overrides expire and the scheduled setpoint is restored. Scheduler updates received during an
   override are kept.
 - Health model per room (OK / DEGRADED / FAILED) from: reference sensor silence, TRV silence,
   valve alarm, frozen TRV (its temperature far from the room sensor), setpoint not acknowledged.
   A FAILED room stops asking the boiler for heat (configurable).
 - Heartbeat to the boiler so it can expire silent valves.
 - Optional Home Assistant MQTT discovery: health, problem and setpoint entities per valve.
 - Robustness: guarded JSON parsing, setpoint ceiling, queue flush fix, "OverrideDuration" option
   actually read.
*/

var moment = require('moment');
const mqtt = require("mqtt");
const fs = require('fs');
const pjson = require('./package.json');

module.exports = function(RED) {

    var path = require('path')

    // Numeric option helper: returns def when the field is missing, empty or not a number.
    function opt(v, def, asInt){
        if (v===undefined || v===null || v==="" || isNaN(v)) return def;
        return asInt ? parseInt(v) : parseFloat(v);
    }

    function truthy(v){
        if (v===true || v===1) return true;
        if (typeof v === 'string') return /^(true|on|1|yes)$/i.test(v.trim());
        return false;
    }

    function slug(s){
        return String(s||'valve').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'valve';
    }

    var SmartValve = function(n) {
        RED.nodes.createNode(this, n)
        this.name = n.name

        this.groupId=n.groupId;                                                                         // GroupId <!> Important for the SmartBoiler, interger unique
        this.mqttSettings = RED.nodes.getNode(n.mqttSettings);                                          // MQTT connexion settings
        this.mqttstack=[];
        this.cycleDuration=opt(n.cycleDuration,5,true);                                                 // duration cycle in min
        if (this.cycleDuration<1) this.cycleDuration=1;
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';         // Execution mode [statechange|+startup|every cycle]

        this.allowOverride=truthy(n.allowOverride);                                                     // Allow Manual update from the valve // climate
        this.executionMode=true;
        this.offSp=opt(n.offSp,5);
        this.awaySp=opt(n.awaySp,7);                                                                     // Frost protection setpoint while away
        this.away=false;                                                                                // Away: frost protection only, schedule kept for the return

        this.temperatureSensorStateTopic=n.temperatureSensorStateTopic;
        this.temperatureSensorKey=n.temperatureSensorKey;

        this.valveSetpointStateTopic=n.valveSetpointStateTopic;
        this.valveSetpointSetTopic=n.valveSetpointSetTopic;
        this.valveSetpointKey=n.valveSetpointKey;

        this.valveTemperatureSetTopic=n.valveTemperatureSetTopic;
        this.valveTemperatureKey=n.valveTemperatureKey;

        this.valveModeStateTopic=n.valveModeStateTopic;
        this.valveModeSetTopic=n.valveModeSetTopic;
        this.valveModeKey=n.valveModeKey;

        this.valveTemperatureSensorTypeSetTopic=n.valveTemperatureSensorTypeSetTopic;
        this.valveTemperatureSensorTypePayload=n.valveTemperatureSensorTypePayload;

        this.prevSp=undefined;                      // Last setpoint sent to the boiler
        this.sp=undefined;                          // Setpoint applied (or being applied) to the TRV
        this.requestSp=undefined;                   // Setpoint the room should have now (schedule or accepted override)
        this.scheduledSp=undefined;                 // Last setpoint received from the scheduler

        this.inputTrigger=false;                    // Request coming from input node
        this.firstEval = true;                      // First evaluation cycle

        this.refTemp=undefined;                     // Reference temperature from sensor
        this.prevRefTemp=undefined;                 // Previous reference temperature sent to the boiler
        this.refTempTs=0;                           // When the reference temperature was last received

        this.noOut=false;                           // To avoid output message when override from valve detected

        this.msgStormMsgCounter=0;
        this.msgStormMaxMsg=opt(n.msgStormMaxMsg,20,true);
        this.debugInfo=n.debugInfo? n.debugInfo :"debug";                                                 // debug verbose to the console
        this.msgStormInterval=10000; // 10 seconde
        this.msgStormLastTs=0;

        this.inputLastTs=0;
        this.inputMaxInterval=10000; // 10 secondes

        this.overrideStartTs=0;
        this.overrideMode=false;
        // The editor saves this option as "OverrideDuration"; 0.81 read "overrideDuration" and always used 60.
        this.overrideDuration=opt(n.OverrideDuration!==undefined ? n.OverrideDuration : n.overrideDuration,60,true);
        this.overrideLen=this.overrideDuration;     // minutes of the override in progress (can come from another valve of the room)
        // 0.84: a knob turn is only taken once the knob stays still for manualSettle seconds (a rotary knob
        // reports every 0.5 °C step), then shared with the other valves of the same group (room).
        this.manualSettle=opt(n.manualSettle,20,true);
        if (this.manualSettle<2) this.manualSettle=2;
        this.manualMaxWait=opt(n.manualMaxWait,60,true);   // s: a knob that keeps moving is taken and shared after this at most
        if (this.manualMaxWait<this.manualSettle) this.manualMaxWait=this.manualSettle;
        this.groupSync = (n.groupSync===undefined || n.groupSync==="") ? true : truthy(n.groupSync);
        this.manual=null;                           // knob turn waiting to settle {sp, raw, firstTs, lastTs}
        this.manualTimer=null;

        // 0.85: window/door contact sensor. While a window of the room is open the room is not heated
        // (frost protection at the away setpoint); the schedule comes back as soon as it closes.
        // 0.86: one or several sensors (topics separated by commas, semicolons, spaces or new lines).
        this.windowTopics = String(n.windowStateTopic||'').split(/[\s,;]+/).map(function(t){return t.trim();})
            .filter(function(t,i,a){ return t!=='' && a.indexOf(t)===i; });
        this.windowStateTopic = this.windowTopics.length ? this.windowTopics.join(', ') : undefined;
        this.windowKey = (n.windowKey && String(n.windowKey).trim()!=='') ? String(n.windowKey).trim() : 'contact';
        this.windowOpenValue = (n.windowOpenValue!==undefined && String(n.windowOpenValue).trim()!=='') ? String(n.windowOpenValue).trim() : 'false';
        this.windowOpenDelay = opt(n.windowOpenDelay,60,true);      // s the window must stay open before heating stops
        this.windowTimeout = opt(n.windowTimeout,180,true);         // min without news from the sensor -> taken as closed (0 = never)
        // sensors: per topic (and 'input' for the flow command) {raw, open, since, lastMsgTs, timer, stale}
        this.window = {sensors:{}, own:false, ownSince:0, peers:{}, eff:false, effSince:0, lastPubTs:0};
        this.windowTopics.forEach(function(t){ this.window.sensors[t]={raw:false, open:false, since:0, lastMsgTs:0, timer:null, stale:false}; }, this);

        // --- 0.82 options (all minutes unless stated, 0 disables a check) -----------------------------
        this.maxSp=opt(n.maxSp,24);                         // °C ceiling for any setpoint applied or forwarded
        this.heartbeat=opt(n.heartbeat,10,true);            // re-send to the boiler at least this often
        this.sensorTimeout=opt(n.sensorTimeout,120,true);   // reference sensor silent -> FAILED
        this.trvTimeout=opt(n.trvTimeout,150,true);         // TRV silent: DEGRADED after half, FAILED after this (Aqara check-in ~ every 50 min)
        // Valve alarm: always shown as DEGRADED (a TRV can keep a stale alarm while working normally).
        // alarmDuration > 0 escalates it to FAILED after that many minutes; 0 (default) = warning only.
        this.alarmDuration=opt(n.alarmDuration,0,true);
        this.frozenDelta=opt(n.frozenDelta,3);              // °C gap TRV temperature vs room sensor
        this.frozenDuration=opt(n.frozenDuration,60,true);  // gap held this long -> FAILED
        this.ackTimeout=opt(n.ackTimeout,5,true);           // setpoint sent but not confirmed -> FAILED
        this.failedAction=n.failedAction ? n.failedAction : 'failedAction.release'; // release | keep
        this.trvLocalTempKey=n.trvLocalTempKey ? n.trvLocalTempKey : 'local_temperature';
        this.trvAlarmKey=n.trvAlarmKey ? n.trvAlarmKey : 'valve_alarm';
        this.sensorTypeRefresh=60;                          // re-send "sensor type" to the TRV at most hourly

        // --- 0.87: TRV reset (battery change, power loss) and valve closing ---------------------------
        this.resetReapply = (n.resetReapply===undefined || n.resetReapply==="") ? true : truthy(n.resetReapply);
        this.autoCalibrate = (n.autoCalibrate===undefined || n.autoCalibrate==="") ? true : truthy(n.autoCalibrate);
        this.calibrateMax = opt(n.calibrateMax,2,true);             // automatic calibrations allowed...
        this.calibrateWindow = opt(n.calibrateWindow,24);           // ...within this many hours
        if (!(this.calibrateWindow>0)) this.calibrateWindow=24;
        this.calibrateDelay = 120;                                  // s after the trigger: the TRV has booted and taken its settings
        this.leakDelta = opt(n.leakDelta,6);                        // °C TRV body above the room while it should be closed (0 = off)
        this.leakDuration = opt(n.leakDuration,30,true);            // min held -> valve not closing
        this.leakGrace = 60;                                        // min the valve must have been asked to close (radiator cools down)
        const key=function(v,d){ return (v===undefined || v===null || String(v).trim()==='') ? d : String(v).trim(); };
        this.trvSensorKey = key(n.trvSensorKey,'sensor');
        this.trvOutageKey = key(n.trvOutageKey,'power_outage_count');
        this.trvBatteryKey = key(n.trvBatteryKey,'battery');
        this.trvCalibratedKey = key(n.trvCalibratedKey,'calibrated');
        this.trvBodyTempKey = key(n.trvBodyTempKey,'device_temperature');
        // Sensor mode the TRV must have: the "Sensor type" payload (a plain value or {"sensor":"external"}).
        this.expectedSensor = undefined;
        if (this.valveTemperatureSensorTypeSetTopic && this.valveTemperatureSetTopic && this.valveTemperatureSensorTypePayload!==undefined && String(this.valveTemperatureSensorTypePayload).trim()!==''){
            let sv=String(this.valveTemperatureSensorTypePayload).trim();
            try{ let j=JSON.parse(sv); if (j && typeof j==='object' && j[this.trvSensorKey]!==undefined) sv=String(j[this.trvSensorKey]); else if (typeof j!=='object') sv=String(j); }catch(e){ /* plain value */ }
            this.expectedSensor = sv.toLowerCase();
        }
        // Calibrate command: <device>/set/calibrate by default, next to the other /set/<key> topics.
        this.valveCalibrateSetTopic = undefined;
        if (n.valveCalibrateSetTopic && String(n.valveCalibrateSetTopic).trim()!=='') this.valveCalibrateSetTopic=String(n.valveCalibrateSetTopic).trim();
        else {
            let m=String(this.valveTemperatureSensorTypeSetTopic || this.valveSetpointSetTopic || '').match(/^(.*\/set)\/[^\/]+$/);
            if (m) this.valveCalibrateSetTopic=m[1]+'/calibrate';
            else if (this.valveSetpointStateTopic) this.valveCalibrateSetTopic=this.valveSetpointStateTopic+'/set/calibrate';
        }
        this.valveCalibratePayload = key(n.valveCalibratePayload,'calibrate');
        this.trvGetTopic = this.valveSetpointStateTopic ? this.valveSetpointStateTopic+'/get' : undefined;
        this.trvGetEvery = 60;                                      // min between checks of the TRV sensor mode (/get)

        this.startTs=moment().valueOf();
        this.trv={
            lastMsgTs:0,            // last message on the TRV state topic
            lastSp:undefined,       // last setpoint reported by the TRV
            localTemp:undefined,    // TRV's own temperature reading
            alarm:false,
            alarmSince:0,
            frozenSince:0,
            pendingAck:null,        // {sp, ts}: setpoint pushed, waiting for the TRV to report it
            noAck:false,            // the last push was never confirmed
            lastPushTs:0,
            // 0.87
            sensor:undefined,       // sensor mode reported by the TRV (internal/external)
            sensorBadSince:0,       // TRV on another sensor mode than expected since
            battery:undefined, outage:undefined, calibrated:undefined,
            bodyTemp:undefined, bodyTs:0,     // TRV body (device) temperature
            resetGraceUntil:0,      // right after a reset the setpoint it reports is not a knob turn
            lastReset:null,         // {ts, why:[...]}
            lastReapplyTs:0,
            calTimes:[],            // automatic calibrations sent (ts), for the limit
            lastCal:null,           // {ts, why, manual}
            calPending:null,        // {why, at, manual}
            calTimer:null,
            calSkipped:null,        // {ts, why}: wanted but the limit was reached (or auto calibrate off)
            calibratingUntil:0,
            notCalHandled:false,    // a calibration was already sent while the TRV says "not calibrated"
            closedSince:0, hotSince:0, leak:false, leakCalAsked:false,
            lastGetTs:0
        };
        this.trv.lastGetTs=this.startTs;            // first sensor-mode check one hour after start
        this.driftPending=false;
        this.sensorTypeTs=0;
        this.lastBoilerSendTs=0;
        this.health={state:'UNKNOWN',reasons:[],since:moment().valueOf()};
        this.lastHaPublishTs=0;
        this.lastHaPayload=undefined;

        var node = this;

        function nlog(msg, level="debug"){
            const levels = {
                "none": 0,
                "error": 1,
                "warn": 2,
                "info": 3,
                "debug": 4
            };
            const currentLevel = levels[node.debugInfo] || 0;
            const msgLevel = levels[level] || 4;

            if (msgLevel <= currentLevel){
                if (level === "error") {
                    node.error(msg);
                } else if (level === "warn") {
                    node.warn(msg);
                } else {
                    node.log(msg);
                    if (level === "debug" || level === "info") {
                         node.warn(msg);
                    }
                }
            }
        }

        function clampSp(v){
            let f=parseFloat(v);
            if (isNaN(f)) return undefined;
            f=parseFloat(f.toFixed(2));
            if (f>node.maxSp){
                nlog(`Setpoint ${f}°C above max ${node.maxSp}°C, capped`,"warn");
                return node.maxSp;
            }
            return f;
        }

        // TRVs work in 0.5 °C steps: a reported setpoint within 0.5 °C of what we sent is a confirmation.
        function sameAck(a,b){
            return a!==undefined && b!==undefined && Math.abs(parseFloat(a)-parseFloat(b))<=0.5;
        }

        function same(a,b){
            return a!==undefined && b!==undefined && Math.abs(parseFloat(a)-parseFloat(b))<0.05;
        }

        // Did someone move the knob? A TRV rounds what we send to its step (0.5 °C), so for a setpoint off
        // that grid a difference up to 0.5 °C is rounding. For a setpoint on the grid any difference is a detent.
        function knobMoved(v,sp){
            if (v===undefined || sp===undefined) return false;
            let g=parseFloat(sp)*2;
            return Math.abs(g-Math.round(g))<0.02 ? !same(v,sp) : !sameAck(v,sp);
        }

        function overrideEnd(){
            return node.overrideStartTs + node.overrideLen*60000;
        }

        // Window: open according to this valve's sensor (fresh enough) or to another valve of the room.
        const PEER_TTL = 15*60000;
        function sensorName(k){ return k==='input' ? 'input' : String(k).split('/').pop(); }
        // This valve's sensors that are open (past the delay) and not silent for longer than the timeout.
        function openSensors(now){
            return Object.keys(node.window.sensors).filter(function(k){
                let w=node.window.sensors[k];
                if (!w.open) return false;
                if (k!=='input' && node.windowTimeout>0 && now-w.lastMsgTs>node.windowTimeout*60000){
                    if (!w.stale) nlog(`Window sensor ${sensorName(k)} silent for more than ${node.windowTimeout} min: taken as closed`,"warn");
                    w.stale=true;
                    return false;
                }
                w.stale=false;
                return true;
            });
        }
        function ownWindowOpen(now){ return openSensors(now).length>0; }
        function peerWindowOpen(now){
            return Object.keys(node.window.peers).filter(function(k){
                let w=node.window.peers[k]; return w.open && now-w.ts<PEER_TTL;
            });
        }
        function windowOpen(now){ return ownWindowOpen(now) || peerWindowOpen(now).length>0; }
        // Heating paused: away or a window open. Both mean frost protection only.
        function paused(){ return node.away || node.window.eff; }

        // ---------------------------------------------------------------------------------------
        // State persistence
        // ---------------------------------------------------------------------------------------

        const stateDir = path.join(RED.settings.userDir || '.', '.node-red-state');
        const stateFile = path.join(stateDir, `valve-${node.id}.json`);

        function saveState() {
            const state = {
                requestSp: node.requestSp,
                sp: node.sp,
                scheduledSp: node.scheduledSp,
                refTemp: node.refTemp,
                away: node.away,
                windowOpenSensors: Object.keys(node.window.sensors).filter(function(k){ return node.window.sensors[k].open; })
                    .map(function(k){ return {topic:k, since:node.window.sensors[k].since}; }),
                overrideMode: node.overrideMode,
                overrideStartTs: node.overrideStartTs,
                overrideLen: node.overrideLen,
                trvBattery: node.trv.battery,
                trvOutage: node.trv.outage,
                calTimes: node.trv.calTimes,
                lastCal: node.trv.lastCal,
                lastReset: node.trv.lastReset,
                timestamp: Date.now()
            };
            node.context().set("valveState", state);
            try {
                if (!fs.existsSync(stateDir)) {
                    fs.mkdirSync(stateDir, { recursive: true });
                }
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
            } catch (err) {
                nlog("Error saving state to file: " + err.message, "error");
            }
        }

        let savedState = null;
        try {
            if (fs.existsSync(stateFile)) {
                savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                nlog("Loaded state from file", "info");
            }
        } catch (err) {
            nlog("Error loading state from file: " + err.message, "warn");
        }
        if (!savedState) {
            savedState = node.context().get("valveState");
        }
        if (savedState) {
            node.requestSp = savedState.requestSp!==undefined ? clampSp(savedState.requestSp) : undefined;
            node.sp = savedState.sp;
            node.scheduledSp = savedState.scheduledSp!==undefined ? clampSp(savedState.scheduledSp) : undefined;
            node.refTemp = savedState.refTemp;
            node.away = savedState.away===true;
            // windows still open when Node-RED stopped: kept until their sensor says otherwise (or goes silent)
            let saved = Array.isArray(savedState.windowOpenSensors) ? savedState.windowOpenSensors
                      : (savedState.windowOpen===true && node.windowTopics.length ? [{topic:node.windowTopics[0], since:savedState.windowSince}] : []);
            saved.forEach(function(w){
                if (!w || (w.topic!=='input' && !node.window.sensors[w.topic])) return;     // sensor removed from the list since
                let s=node.window.sensors[w.topic] || (node.window.sensors[w.topic]={timer:null});
                Object.assign(s,{raw:true, open:true, since:w.since||Date.now(), lastMsgTs:Date.now(), stale:false});
            });
            if (saved.length){ node.window.own=true; node.window.ownSince=Math.min.apply(null,saved.map(function(w){return w.since||Date.now();})); }
            // An override in progress survives a restart and still ends at its time (0.83 forgot it and
            // kept the manual setpoint until the next schedule change).
            if (savedState.overrideMode===true && savedState.overrideStartTs){
                node.overrideStartTs = savedState.overrideStartTs;
                node.overrideLen = opt(savedState.overrideLen, node.overrideDuration);
                if (Date.now() < overrideEnd()) node.overrideMode = true;
                else if (node.scheduledSp!==undefined) node.requestSp = node.scheduledSp;
            }
            // A restored temperature counts as fresh from startup only: if the sensor stays silent
            // the room becomes FAILED after sensorTimeout instead of trusting it forever.
            node.refTempTs = node.refTemp!==undefined ? moment().valueOf() : 0;
            // 0.87: a battery changed while Node-RED was stopped is still seen; the calibration limit holds across restarts
            if (savedState.trvBattery!==undefined && savedState.trvBattery!==null) node.trv.battery=parseFloat(savedState.trvBattery);
            if (savedState.trvOutage!==undefined && savedState.trvOutage!==null) node.trv.outage=parseInt(savedState.trvOutage);
            if (Array.isArray(savedState.calTimes)) node.trv.calTimes=savedState.calTimes.filter(function(x){ return typeof x==='number'; });
            if (savedState.lastCal && savedState.lastCal.ts) node.trv.lastCal=savedState.lastCal;
            if (savedState.lastReset && savedState.lastReset.ts) node.trv.lastReset=savedState.lastReset;
            nlog("Loaded saved state: sp=" + node.sp + ", refTemp=" + node.refTemp, "info");
        }

        this.ev=function(){
            node.inputTrigger=true;
            evaluate();
        }

        // ---------------------------------------------------------------------------------------
        // Health
        // ---------------------------------------------------------------------------------------

        // Plain-language explanation of the current state, for people (node status, Home Assistant).
        function hhmm(ts){ return ts ? moment(ts).format('HH:mm') : '?'; }
        // 0.87 texts shared by the status detail and the per-check view
        function frozenAdvice(){
            return node.trv.sensorBadSince ? ` The TRV is on its ${node.trv.sensor} sensor: ${node.expectedSensor} is sent again every 5 min.`
                                           : ' Power-cycle the TRV.';
        }
        function calText(now){
            const c=node.trv;
            if (c.calPending) return ` Calibration at ${hhmm(c.calPending.at)} (${c.calPending.why}).`;
            if (c.lastCal && now-c.lastCal.ts<12*3600000) return ` Calibrated at ${hhmm(c.lastCal.ts)} (${c.lastCal.why}).`;
            return '';
        }
        function calSkippedText(now){
            const k=node.trv.calSkipped;
            if (!k || now-k.ts>=node.calibrateWindow*3600000) return '';
            return k.off ? ` Calibration advised at ${hhmm(k.ts)} (${k.why}) but Auto calibrate is off: press Calibrate in Home Assistant.`
                         : ` Calibration not sent at ${hhmm(k.ts)} (${k.why}): limit of ${node.calibrateMax} in ${node.calibrateWindow} h reached.`;
        }
        function leakText(now){
            const t=v=>v===undefined||v===null?'?':parseFloat(v).toFixed(1)+' °C';
            let after = node.trv.lastCal && node.trv.lastCal.ts>=node.trv.closedSince && !node.trv.calPending
                ? ` Still warm after the calibration at ${hhmm(node.trv.lastCal.ts)}.` : calText(now);
            return `The TRV body reads ${t(node.trv.bodyTemp)} while the room is ${t(node.refTemp)} and the valve should be closed (setpoint ${t(node.sp)}) since ${hhmm(node.trv.closedSince)}: hot water still flows through the radiator.`
                + after + calSkippedText(now) + ' Check the batteries, then that the valve pin moves freely.';
        }

        function explain(now){
            const min=60000, parts=[];
            const t=v=>v===undefined||v===null?'?':parseFloat(v).toFixed(1)+' °C';
            node.health.reasons.forEach(function(r){
                if (r==='no_sensor_data') parts.push('No room temperature received yet from the room sensor.');
                else if (r==='sensor_silent') parts.push(`Room sensor silent for ${Math.round((now-node.refTempTs)/min)} min (limit ${node.sensorTimeout} min): the room temperature can no longer be trusted. Check the sensor battery and its Zigbee link.`);
                else if (r==='trv_silent' && node.health.state!=='FAILED') parts.push(`TRV silent for ${Math.round((now-node.trv.lastMsgTs)/min)} min, a check-in was probably missed; it becomes a failure after ${node.trvTimeout} min.`);
                else if (r==='trv_silent') parts.push(`TRV silent for ${node.trv.lastMsgTs?Math.round((now-node.trv.lastMsgTs)/min):'more than '+node.trvTimeout} min (limit ${node.trvTimeout} min). Check the TRV battery and its Zigbee link.`);
                else if (r==='valve_alarm'){
                    let ok = node.trv.localTemp!==undefined && node.refTemp!==undefined && Math.abs(node.trv.localTemp-node.refTemp)<=node.frozenDelta && !node.trv.noAck;
                    let esc = (node.alarmDuration>0 && now<node.trv.alarmSince+node.alarmDuration*min) ? ` It becomes a failure at ${hhmm(node.trv.alarmSince+node.alarmDuration*min)} if it persists.` : '';
                    parts.push(`The TRV reports a valve alarm since ${hhmm(node.trv.alarmSince)}`+(ok?`, but it still follows the room temperature (${t(node.refTemp)}) and its setpoint.`:'.')+esc+' Check that the valve pin moves freely, then recalibrate the TRV.');
                }
                else if (r==='trv_frozen'){
                    let esc = (now-node.trv.frozenSince<node.frozenDuration*min) ? ` It becomes a failure at ${hhmm(node.trv.frozenSince+node.frozenDuration*min)} if it persists.` : '';
                    parts.push(`The TRV reads ${t(node.trv.localTemp)} while the room is ${t(node.refTemp)} since ${hhmm(node.trv.frozenSince)}: it no longer follows the room temperature (frozen or lost its external sensor).${esc}`+frozenAdvice());
                }
                else if (r==='sensor_mode') parts.push(`The TRV is on its ${node.trv.sensor} sensor since ${hhmm(node.trv.sensorBadSince)} although ${node.expectedSensor} was sent again at ${hhmm(node.trv.lastReapplyTs)}: it does not take it. Set it in Zigbee2MQTT or Home Assistant.`);
                else if (r==='not_calibrated') parts.push('The TRV reports it is not calibrated.'+calText(now)+calSkippedText(now)+' Check it is properly mounted, then press Calibrate.');
                else if (r==='valve_not_closing') parts.push(leakText(now));
                else if (r==='no_ack' && !node.trv.noAck) parts.push(`Setpoint ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} was not confirmed by the TRV within ${node.ackTimeout} min; sent again at ${hhmm(node.trv.lastPushTs)}.`);
                else if (r==='no_ack') parts.push(`Setpoint ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} sent at ${hhmm(node.trv.lastPushTs)} was not confirmed by the TRV (it reports ${t(node.trv.lastSp)}); retried every ${3*node.ackTimeout} min. Power-cycle or re-pair the TRV.`);
            });
            let head;
            if (node.health.state==='FAILED') head = node.failedAction==='failedAction.keep' ? 'FAILED, demand kept (When FAILED = keep).' : 'FAILED: this room no longer asks the boiler for heat.';
            else if (node.health.state==='DEGRADED') head = 'Warning, heating continues normally.';
            else if (node.executionMode==false) head = 'Off: this room does not ask for heat.';
            else if (node.window.eff && !node.away){
                let nw=moment().valueOf();
                let who = ` (${openSensors(nw).map(sensorName).concat(peerWindowOpen(nw).map(function(k){
                    let w=node.window.peers[k]; return (w.sensors&&w.sensors.length?w.sensors.join(', '):'')+' via '+(w.name||k); })).join(', ')})`;
                head = `Window open since ${hhmm(node.window.effSince)}${who}: heating paused, frost protection at ${t(node.awaySp)}, room ${t(node.refTemp)}.`+(node.requestSp!==undefined?` The schedule (${t(node.requestSp)}) resumes when it is closed.`:'');
            }
            else if (node.away) head = `Away: frost protection at ${t(node.awaySp)}, room ${t(node.refTemp)}`+(node.refTemp!==undefined&&parseFloat(node.awaySp)>parseFloat(node.refTemp)?', asking for heat to protect against frost.':', no heat requested.')+(node.requestSp!==undefined?` The schedule (${t(node.requestSp)}) resumes when back home.`:'');
            else if (node.health.state==='UNKNOWN') head = 'Starting.';
            else {
                let sp=node.requestSp, rt=node.refTemp;
                head = node.overrideMode ? `OK, manual setpoint ${t(sp)} until ${hhmm(overrideEnd())}, room ${t(rt)}.`
                     : `OK, following the schedule: ${t(sp)}, room ${t(rt)}${(sp!==undefined&&rt!==undefined&&parseFloat(sp)>parseFloat(rt))?', asking for heat.':', warm enough.'}`;
            }
            // Informative: a recent TRV restart and what was done about it.
            let lr=node.trv.lastReset;
            if (lr && now-lr.ts<30*60000 && !node.health.reasons.some(function(r){ return r==='sensor_mode'||r==='not_calibrated'||r==='valve_not_closing'; })){
                parts.push(`TRV restarted at ${hhmm(lr.ts)} (${whyText(lr.why)})`+(node.resetReapply?': sensor mode, room temperature and setpoint sent again.':'.')+calText(now)+calSkippedText(now));
            } else if (!node.health.reasons.some(function(r){ return r==='not_calibrated'||r==='valve_not_closing'; }) && calSkippedText(now)) parts.push(calSkippedText(now).trim());
            if (node.manual) parts.unshift(`Knob turned to ${t(node.manual.sp)}: taken in ${Math.max(0,Math.ceil((node.manual.lastTs+node.manualSettle*1000-now)/1000))} s if it stays there.`);
            return [head].concat(parts).join(' ');
        }

        // One line per check, always present (also when OK), for a per-check view in Home Assistant.
        // level: ok | warning | failed | waiting | off
        function checkDetails(now){
            const min=60000, R=node.health.reasons, F=node.health.state==='FAILED';
            const t=v=>v===undefined||v===null?'?':parseFloat(v).toFixed(1)+' °C';
            const lvl=(code, failedNow)=>R.includes(code) ? (failedNow ? 'failed' : 'warning') : 'ok';
            const line=(level,text)=>({level:level, text:text});
            const out={};

            // Room sensor
            if (node.refTemp===undefined) out.sensor=line('waiting','Waiting: no room temperature received yet.');
            else {
                let age=node.refTempTs?Math.round((now-node.refTempTs)/min):null;
                let lim=node.sensorTimeout>0?` (limit ${node.sensorTimeout} min)`:' (not checked: timeout 0)';
                out.sensor = R.includes('sensor_silent')
                    ? line('failed',`Failed: silent for ${age} min${lim}. Check the sensor battery and its Zigbee link.`)
                    : line(node.sensorTimeout>0?'ok':'off',`OK: ${t(node.refTemp)}, reported ${age} min ago${lim}.`);
            }

            // TRV link
            if (!node.valveSetpointStateTopic) out.trv_link=line('off','Not checked: no TRV state topic configured.');
            else if (R.includes('trv_silent') && now-node.trv.lastMsgTs<=node.trvTimeout*min) out.trv_link=line('warning',`Warning: last message ${Math.round((now-node.trv.lastMsgTs)/min)} min ago, a check-in was probably missed (failure after ${node.trvTimeout} min).`);
            else if (R.includes('trv_silent')) out.trv_link=line('failed',`Failed: no message for ${node.trv.lastMsgTs?Math.round((now-node.trv.lastMsgTs)/min):'more than '+node.trvTimeout} min (limit ${node.trvTimeout} min). Check the TRV battery and its Zigbee link.`);
            else if (!node.trv.lastMsgTs) out.trv_link=line('waiting','Waiting: no message from the TRV yet.');
            else out.trv_link=line(node.trvTimeout>0?'ok':'off',`OK: last message ${Math.round((now-node.trv.lastMsgTs)/min)} min ago`+(node.trvTimeout>0?` (limit ${node.trvTimeout} min).`:' (not checked: timeout 0).'));

            // Valve alarm
            if (!node.trv.alarm) out.valve_alarm=line('ok','OK: no valve alarm reported.');
            else {
                let failedNow = F && node.alarmDuration>0 && now-node.trv.alarmSince>=node.alarmDuration*min;
                let follows = node.trv.localTemp!==undefined && node.refTemp!==undefined && Math.abs(node.trv.localTemp-node.refTemp)<=node.frozenDelta && !node.trv.noAck;
                let esc = node.alarmDuration>0 ? (failedNow?'':` Becomes a failure at ${hhmm(node.trv.alarmSince+node.alarmDuration*min)}.`) : ' Warning only (Valve alarm = 0).';
                out.valve_alarm=line(failedNow?'failed':'warning',`${failedNow?'Failed':'Warning'}: alarm since ${hhmm(node.trv.alarmSince)}`+(follows?', the TRV still follows its setpoint and the room temperature.':'.')+esc+' Check the valve pin moves freely, then recalibrate the TRV.');
            }

            // TRV tracking (frozen)
            if (!(node.frozenDelta>0)) out.tracking=line('off','Not checked: Frozen gap = 0.');
            else if (!node.valveTemperatureSetTopic) out.tracking=line('off','Not checked: internal sensor mode (no room temperature sent to the TRV).');
            else if (node.trv.localTemp===undefined || node.refTemp===undefined) out.tracking=line('waiting','Waiting: TRV or room temperature not received yet.');
            else {
                let gap=Math.abs(node.trv.localTemp-node.refTemp).toFixed(1);
                if (R.includes('trv_frozen')){
                    let failedNow = now-node.trv.frozenSince>=node.frozenDuration*min;
                    out.tracking=line(failedNow?'failed':'warning',`${failedNow?'Failed':'Warning'}: TRV reads ${t(node.trv.localTemp)}, room ${t(node.refTemp)} (gap ${gap} °C, limit ${node.frozenDelta}) since ${hhmm(node.trv.frozenSince)}.`+(failedNow?'':` Becomes a failure at ${hhmm(node.trv.frozenSince+node.frozenDuration*min)}.`)+frozenAdvice());
                } else out.tracking=line('ok',`OK: TRV reads ${t(node.trv.localTemp)}, room ${t(node.refTemp)} (gap ${gap} °C, limit ${node.frozenDelta}).`);
            }

            // Setpoint confirmation
            if (!(node.ackTimeout>0)) out.setpoint=line('off','Not checked: Ack timeout = 0.');
            else if (node.trv.noAck) out.setpoint=line('failed',`Failed: ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} sent at ${hhmm(node.trv.lastPushTs)}, the TRV still reports ${t(node.trv.lastSp)}; retried every ${3*node.ackTimeout} min. Power-cycle or re-pair the TRV.`);
            else if (node.trv.pendingAck && node.trv.pendingAck.retried) out.setpoint=line('warning',`Warning: ${t(node.trv.pendingAck.sp)} not confirmed within ${node.ackTimeout} min, sent again at ${hhmm(node.trv.pendingAck.ts)}.`);
            else if (node.trv.pendingAck) out.setpoint=line('waiting',`Waiting: ${t(node.trv.pendingAck.sp)} sent at ${hhmm(node.trv.pendingAck.ts)}, confirmation expected within ${node.ackTimeout} min.`);
            else if (node.trv.lastSp===undefined) out.setpoint=line('waiting','Waiting: the TRV has not reported its setpoint yet.');
            else out.setpoint=line('ok',`OK: the TRV has ${t(node.trv.lastSp)}`+(node.sp!==undefined && !same(node.sp,node.trv.lastSp)?`, ${t(node.sp)} expected.`:', as requested.'));

            // 0.87: TRV settings (sensor mode, calibration, restarts)
            const used=calibrationsInWindow(now).length;
            const quota=` Automatic calibrations: ${used}/${node.calibrateMax} in ${node.calibrateWindow} h.`;
            const lr=node.trv.lastReset;
            const restarted = lr && now-lr.ts<24*3600000 ? ` Restarted at ${hhmm(lr.ts)} (${whyText(lr.why)}).` : '';
            if (!node.expectedSensor && !node.valveCalibrateSetTopic) out.trv_config=line('off','Not checked: no sensor type nor calibrate topic configured.');
            else if (R.includes('sensor_mode')) out.trv_config=line('warning',`Warning: on its ${node.trv.sensor} sensor since ${hhmm(node.trv.sensorBadSince)}, ${node.expectedSensor} sent again at ${hhmm(node.trv.lastReapplyTs)} without effect.`+quota);
            else if (R.includes('not_calibrated')) out.trv_config=line('warning','Warning: the TRV reports it is not calibrated.'+calText(now)+calSkippedText(now)+quota);
            else if (node.trv.calPending) out.trv_config=line('waiting',`Waiting: calibration at ${hhmm(node.trv.calPending.at)} (${node.trv.calPending.why}).`+restarted+quota);
            else if (now<node.trv.calibratingUntil) out.trv_config=line('waiting',`Waiting: calibrating since ${hhmm(node.trv.lastCal.ts)} (${node.trv.lastCal.why}).`+quota);
            else if (node.trv.sensorBadSince) out.trv_config=line('waiting',`Waiting: on its ${node.trv.sensor} sensor, ${node.expectedSensor} sent at ${hhmm(node.trv.lastReapplyTs)}.`+restarted);
            else if (node.trv.sensor===undefined && node.trv.calibrated===undefined) out.trv_config=line('waiting','Waiting: the TRV has not reported its sensor mode or calibration yet.');
            else {
                let bits=[];
                if (node.trv.sensor!==undefined) bits.push(`${node.trv.sensor} sensor`);
                if (node.trv.calibrated!==undefined) bits.push(node.trv.calibrated?'calibrated':'not calibrated');
                if (node.trv.battery!==undefined) bits.push(`battery ${node.trv.battery}%`);
                let lc=node.trv.lastCal && now-node.trv.lastCal.ts<24*3600000 ? ` Last calibration ${hhmm(node.trv.lastCal.ts)} (${node.trv.lastCal.why}).` : '';
                out.trv_config=line('ok',`OK: ${bits.join(', ')}.`+restarted+lc+calSkippedText(now)+quota);
            }

            // 0.87: valve closing (TRV body temperature while the valve should be closed)
            if (!(node.leakDelta>0)) out.valve_closing=line('off','Not checked: Leak gap = 0.');
            else if (node.trv.bodyTemp===undefined) out.valve_closing=line('waiting',`Waiting: no TRV body temperature (${node.trvBodyTempKey}) received.`);
            else if (R.includes('valve_not_closing')) out.valve_closing=line('warning','Warning: '+leakText(now));
            else if (!node.trv.closedSince) out.valve_closing=line('ok',`OK: valve open (setpoint ${t(node.sp)}, room ${t(node.refTemp)}), body ${t(node.trv.bodyTemp)}.`);
            else out.valve_closing=line('ok',`OK: valve closed since ${hhmm(node.trv.closedSince)}, body ${t(node.trv.bodyTemp)}, room ${t(node.refTemp)} (limit +${node.leakDelta} °C for ${node.leakDuration} min).`);
            return out;
        }

        function computeHealth(now){
            let failed=[], degraded=[];
            const min=60000;

            if (node.refTemp===undefined){
                degraded.push('no_sensor_data');
            } else if (node.sensorTimeout>0 && node.refTempTs>0 && now-node.refTempTs>node.sensorTimeout*min){
                failed.push('sensor_silent');
            }

            if (node.valveSetpointStateTopic){
                let lastTrv = node.trv.lastMsgTs>0 ? node.trv.lastMsgTs : node.startTs;
                if (node.trvTimeout>0 && now-lastTrv>node.trvTimeout*min){
                    failed.push('trv_silent');
                } else if (node.trvTimeout>0 && node.trv.lastMsgTs>0 && now-lastTrv>node.trvTimeout*min/2){
                    degraded.push('trv_silent');        // one check-in missed: warn before failing
                }
            }

            if (node.trv.alarm){
                if (node.alarmDuration>0 && now-node.trv.alarmSince>=node.alarmDuration*min) failed.push('valve_alarm');
                else degraded.push('valve_alarm');      // default: warning only
            }

            // Only meaningful in external sensor mode, where the TRV's own reading mirrors the room
            // temperature we send it. In internal mode a TRV next to a hot radiator reads higher.
            if (node.frozenDelta>0 && node.valveTemperatureSetTopic && node.trv.localTemp!==undefined && node.refTemp!==undefined &&
                Math.abs(parseFloat(node.trv.localTemp)-parseFloat(node.refTemp))>node.frozenDelta){
                if (!node.trv.frozenSince) node.trv.frozenSince=now;
                if (node.frozenDuration>=0 && now-node.trv.frozenSince>=node.frozenDuration*min) failed.push('trv_frozen');
                else degraded.push('trv_frozen');
            } else {
                node.trv.frozenSince=0;
            }

            // 0.87: TRV still on the wrong sensor mode 10 min after it was sent again (it does not take it).
            if (node.trv.sensorBadSince && now-node.trv.sensorBadSince>10*min) degraded.push('sensor_mode');

            // 0.87: the TRV says it is not calibrated (outside a calibration run). Calibrated once automatically.
            if (node.trv.calibrated===false && now>=node.trv.calibratingUntil && !node.trv.calPending){
                if (!node.trv.notCalHandled) requestCalibration('TRV not calibrated', now, false);
                if (!node.trv.calPending) degraded.push('not_calibrated');
            }

            // 0.87: valve not closing. The TRV should be closed (setpoint at least 1 °C under the room, for
            // leakGrace min so the radiator had time to cool) but its body stays hot: water still flows.
            let closedNow = node.sp!==undefined && node.refTemp!==undefined &&
                (node.executionMode==false || parseFloat(node.sp)<=parseFloat(node.refTemp)-1);
            if (closedNow){ if (!node.trv.closedSince) node.trv.closedSince=now; }
            else node.trv.closedSince=0;
            let bodyFresh = node.trv.bodyTemp!==undefined && now-node.trv.bodyTs<=3*60*min;
            if (node.leakDelta>0 && closedNow && bodyFresh && now-node.trv.closedSince>=node.leakGrace*min){
                let excess = parseFloat(node.trv.bodyTemp)-parseFloat(node.refTemp);
                let hot = node.trv.leak ? excess>node.leakDelta-1 : excess>node.leakDelta;       // 1 °C hysteresis
                if (hot){
                    if (!node.trv.hotSince) node.trv.hotSince=now;
                    if (node.trv.leak || now-node.trv.hotSince>=node.leakDuration*min){
                        if (!node.trv.leak){
                            node.trv.leak=true;
                            nlog(`Valve not closing: TRV body ${node.trv.bodyTemp}°C, room ${node.refTemp}°C, setpoint ${node.sp}°C`,"warn");
                        }
                        if (!node.trv.leakCalAsked){ node.trv.leakCalAsked=true; requestCalibration('valve not closing', now, false); }
                        degraded.push('valve_not_closing');
                    }
                } else { node.trv.hotSince=0; node.trv.leak=false; node.trv.leakCalAsked=false; }
            } else if (!closedNow || node.leakDelta<=0){
                node.trv.hotSince=0; node.trv.leak=false; node.trv.leakCalAsked=false;
            } else if (node.trv.leak){
                degraded.push('valve_not_closing');      // body reading too old: keep the last verdict
            }

            if (node.trv.pendingAck && node.ackTimeout>0 && now-node.trv.pendingAck.ts>node.ackTimeout*min){
                if (!node.trv.pendingAck.retried) node.trv.retryNow=true;     // a lost Zigbee write: send it once more
                else node.trv.noAck=true;
            }
            if (node.trv.noAck){
                failed.push('no_ack');
            } else if (node.trv.retryNow || (node.trv.pendingAck && node.trv.pendingAck.retried)){
                degraded.push('no_ack');
            }

            let state = failed.length>0 ? 'FAILED' : (degraded.length>0 ? 'DEGRADED' : 'OK');
            let reasons = failed.concat(degraded);
            if (state!==node.health.state || reasons.join()!==node.health.reasons.join()){
                let lvl = state==='FAILED' ? 'error' : (state==='DEGRADED' ? 'warn' : 'info');
                nlog(`Health ${node.health.state} -> ${state}${reasons.length?' ('+reasons.join(', ')+')':''}`, lvl);
                node.health={state:state,reasons:reasons,since: state!==node.health.state ? now : node.health.since};
                return true;
            }
            return false;
        }

        function releasesDemand(){
            return node.health.state==='FAILED' && node.failedAction!=='failedAction.keep';
        }

        // ---------------------------------------------------------------------------------------
        // MQTT
        // ---------------------------------------------------------------------------------------

        function subscribeMqtt(){
            if (node.mqttclient==null || node.mqttclient.connected!=true){
                nlog("subscribeMqtt: MQTT not connected...","error");
                return;
            }
            let subArray=[];
            [node.temperatureSensorStateTopic,node.valveSetpointStateTopic,node.valveModeStateTopic,ha.enabled?awaySetTopic:undefined,(ha.enabled&&node.valveCalibrateSetTopic)?calibrateCmdTopic:undefined,groupTopic,groupWindowTopic].concat(node.windowTopics).forEach(function(t){
                if (t && String(t).trim()!="" && !subArray.includes(t)) subArray.push(t);
            });
            try{
                node.mqttclient.subscribe(subArray, () => {
                    nlog("MQTT Subscribed to topic:"+JSON.stringify(subArray),"debug");
                })
            }catch(err){
                nlog("MQTT subscribe error:"+err.message,"error");
            }
        }

        function pushSetpointToTrv(sp, why){
            if (sp===undefined) return;
            if (node.valveSetpointSetTopic!=undefined && node.valveSetpointSetTopic!=""){
                node.mqttstack.push({topic:node.valveSetpointSetTopic,payload:parseFloat(parseFloat(sp).toFixed(2)),qos:0,retain:false});
                let now=moment().valueOf();
                node.trv.lastPushTs=now;
                // Only arm the acknowledgement check once the TRV has shown it reports its setpoint,
                // so a wrong key or topic can never fail a healthy room.
                if (node.valveSetpointStateTopic && node.valveSetpointKey && node.trv.lastSp!==undefined){
                    if (!node.trv.pendingAck || !same(node.trv.pendingAck.sp,sp)){
                        node.trv.pendingAck={sp:parseFloat(sp),ts:now,prev:node.trv.lastSp,retried:false};
                    }
                }
                nlog(`Setpoint ${sp}°C sent to the TRV (${why})`,"debug");
            }
            node.sp=parseFloat(sp);
        }

        // ---------------------------------------------------------------------------------------
        // 0.87: TRV reset (battery change, power loss) and calibration
        // ---------------------------------------------------------------------------------------
        const RESET_GRACE = 3*60000;        // after a reset, a setpoint the TRV reports is its own, not a knob turn
        const CAL_RUN = 5*60000;            // a calibration runs the motor end to end; its reports are ignored meanwhile
        const WHY = {sensor:'back on its internal sensor', restart:'power loss', battery:'battery changed'};
        function whyText(w){ return [].concat(w||[]).map(function(r){ return WHY[r]||r; }).join(', '); }

        function calibrationsInWindow(now){
            return node.trv.calTimes.filter(function(ts){ return now-ts < node.calibrateWindow*3600000; });
        }

        // Send again what the TRV forgets when it restarts: sensor mode, room temperature, setpoint.
        function reapplyTrvSettings(why, now){
            node.trv.lastReapplyTs=now;
            if (node.valveTemperatureSensorTypeSetTopic){
                node.mqttstack.push({topic:node.valveTemperatureSensorTypeSetTopic,payload:node.valveTemperatureSensorTypePayload,qos:0,retain:false});
                node.sensorTypeTs=now;
            }
            if (node.valveTemperatureSetTopic && node.refTemp!==undefined){
                node.mqttstack.push({topic:node.valveTemperatureSetTopic,payload:parseFloat(parseFloat(node.refTemp).toFixed(2)),qos:0,retain:false});
            }
            const target = paused() ? node.awaySp : node.requestSp;
            if (node.executionMode==true && target!==undefined){
                node.trv.pendingAck=null; node.trv.noAck=false; node.trv.retryNow=false;
                pushSetpointToTrv(target,'TRV restarted');
            }
            nlog(`TRV ${why}: sensor mode, room temperature and setpoint sent again`,"warn");
            sendMqtt();
        }

        // why: text for people. manual: asked from a flow or Home Assistant (no limit, not counted).
        function requestCalibration(why, now, manual){
            if (!node.valveCalibrateSetTopic) return false;
            if (node.trv.calPending || now<node.trv.calibratingUntil) return false;
            if (!manual && !node.autoCalibrate){
                if (!node.trv.calSkipped || now-node.trv.calSkipped.ts>60000) nlog(`TRV calibration advised (${why}), Auto calibrate is off`,"warn");
                node.trv.calSkipped={ts:now, why:why, off:true};
                return false;
            }
            if (!manual && calibrationsInWindow(now).length>=node.calibrateMax){
                nlog(`TRV calibration not sent (${why}): limit of ${node.calibrateMax} in ${node.calibrateWindow} h reached`,"warn");
                node.trv.calSkipped={ts:now, why:why};
                saveState();
                return false;
            }
            let delay = manual ? 1000 : node.calibrateDelay*1000;
            node.trv.calPending={why:why, at:now+delay, manual:!!manual};
            clearTimeout(node.trv.calTimer);
            node.trv.calTimer=setTimeout(fireCalibration, delay);
            nlog(`TRV calibration at ${moment(now+delay).format('HH:mm:ss')} (${why})`,"info");
            return true;
        }

        function fireCalibration(){
            let c=node.trv.calPending;
            node.trv.calTimer=null; node.trv.calPending=null;
            if (!c) return;
            let now=moment().valueOf();
            if (!c.manual && calibrationsInWindow(now).length>=node.calibrateMax){     // limit reached meanwhile
                node.trv.calSkipped={ts:now, why:c.why};
                nlog(`TRV calibration not sent (${c.why}): limit of ${node.calibrateMax} in ${node.calibrateWindow} h reached`,"warn");
                return;
            }
            node.mqttstack.push({topic:node.valveCalibrateSetTopic,payload:node.valveCalibratePayload,qos:0,retain:false});
            if (!c.manual) node.trv.calTimes=calibrationsInWindow(now).concat([now]);
            node.trv.lastCal={ts:now, why:c.why, manual:c.manual};
            node.trv.calibratingUntil=now+CAL_RUN;
            node.trv.notCalHandled=true;
            node.trv.calSkipped=null;
            nlog(`TRV calibration sent (${c.why})`+(c.manual?'':`, ${node.trv.calTimes.length}/${node.calibrateMax} in ${node.calibrateWindow} h`),"warn");
            computeHealth(now);
            haState(node.prevSp, true);
            sendMqtt();
            saveState();
        }

        // Reads what a TRV state message says about its configuration. True on a reset or a settings change.
        function trvHousekeeping(p, now){
            let reasons=[], changed=false;
            const before=[node.trv.sensorBadSince>0, node.trv.calibrated, node.trv.sensor].join();
            if (node.expectedSensor && p[node.trvSensorKey]!==undefined && p[node.trvSensorKey]!==null){
                let sv=String(p[node.trvSensorKey]).toLowerCase();
                node.trv.sensor=sv;
                if (sv!==node.expectedSensor){
                    if (!node.trv.sensorBadSince){ node.trv.sensorBadSince=now; reasons.push('sensor'); }
                    else if (node.resetReapply && now-node.trv.lastReapplyTs>=5*60000) reapplyTrvSettings(`still on its ${sv} sensor`, now);
                } else node.trv.sensorBadSince=0;
            }
            let o=parseInt(p[node.trvOutageKey]);
            if (p[node.trvOutageKey]!==undefined && p[node.trvOutageKey]!==null && !isNaN(o)){
                if (node.trv.outage!==undefined && o>node.trv.outage) reasons.push('restart');
                node.trv.outage=o;
            }
            let b=parseFloat(p[node.trvBatteryKey]);
            if (p[node.trvBatteryKey]!==undefined && p[node.trvBatteryKey]!==null && !isNaN(b)){
                if (node.trv.battery!==undefined && b-node.trv.battery>=20) reasons.push('battery');
                node.trv.battery=b;
            }
            let c=p[node.trvCalibratedKey];
            if (c!==undefined && c!==null){
                c = c===true || truthy(c) || String(c).toUpperCase()==='ON';
                if (c) node.trv.notCalHandled=false;
                node.trv.calibrated=c;
            }
            let bt=parseFloat(p[node.trvBodyTempKey]);
            if (p[node.trvBodyTempKey]!==undefined && p[node.trvBodyTempKey]!==null && !isNaN(bt)){
                node.trv.bodyTemp=bt; node.trv.bodyTs=now;
            }
            changed = before!==[node.trv.sensorBadSince>0, node.trv.calibrated, node.trv.sensor].join();
            if (!reasons.length) return changed;

            // A restart or a battery change explains the sensor mode: name the cause only.
            if (reasons.includes('restart') || reasons.includes('battery')) reasons=['battery','restart'].filter(function(r){ return reasons.includes(r); });
            let why=whyText(reasons);
            node.trv.lastReset={ts:now, why:reasons};
            node.trv.resetGraceUntil=now+RESET_GRACE;
            node.trv.frozenSince=0;
            if (node.manual) cancelManual('TRV restarted');
            nlog(`TRV reset detected (${why})`,"warn");
            if (node.resetReapply) reapplyTrvSettings(why==WHY.sensor ? WHY.sensor : `restarted (${why})`, now);
            // A restart or a battery change: the motor must find its end stops again.
            if (reasons.includes('restart') || reasons.includes('battery')) requestCalibration(why, now, false);
            saveState();
            return true;
        }

        function callbackMqtt(topic,p){
            let flgProcess=false;
            let now=moment().valueOf();

            if (node.window.sensors[topic] && topic!=='input'){
                let w=node.window.sensors[topic], v=p[node.windowKey];
                if (v!==undefined && v!==null){
                    w.lastMsgTs=now;
                    let open = String(v).trim().toLowerCase()===node.windowOpenValue.toLowerCase();
                    if (open && !w.raw){
                        w.raw=true;
                        nlog(`Window ${sensorName(topic)} opened, heating stops if it is still open in ${node.windowOpenDelay}s`,"info");
                        clearTimeout(w.timer);
                        w.timer=setTimeout(function(){ w.timer=null; w.open=true; w.since=moment().valueOf(); windowSensorsChanged(sensorName(topic)+' open'); }, node.windowOpenDelay*1000);
                    } else if (!open && w.raw){
                        w.raw=false;
                        clearTimeout(w.timer); w.timer=null;
                        if (w.open){ w.open=false; windowSensorsChanged(sensorName(topic)+' closed'); }
                        else nlog(`Window ${sensorName(topic)} closed before the delay, nothing changed`,"info");
                    } else if (w.open && w.stale){
                        flgProcess=true;                       // sensor back after a silence: re-evaluate
                    }
                }
            }

            if (topic==node.temperatureSensorStateTopic){
                let raw=p[node.temperatureSensorKey];
                let rt=parseFloat(raw);
                if (raw===undefined || raw===null){
                    nlog(`MQTT Invalid payload key:${node.temperatureSensorKey}, topic:${topic}`,"debug");
                } else if (isNaN(rt) || rt<-20 || rt>60){
                    nlog(`MQTT invalid reference temperature:${raw}, ignored`,"warn");
                } else {
                    node.refTempTs=now;
                    if (rt!=node.refTemp){
                        node.refTemp=rt;
                        flgProcess=true;
                    }
                    if (node.health.reasons.includes('sensor_silent')) flgProcess=true;
                    nlog(`[MQTT] receive reference temperature:${node.refTemp}`,"debug");
                }
            }

            if (topic==node.valveSetpointStateTopic){
                node.trv.lastMsgTs=now;
                if (node.health.reasons.includes('trv_silent')) flgProcess=true;

                if (p[node.trvLocalTempKey]!==undefined && p[node.trvLocalTempKey]!==null && !isNaN(p[node.trvLocalTempKey])){
                    node.trv.localTemp=parseFloat(p[node.trvLocalTempKey]);
                }
                if (trvHousekeeping(p, now)) flgProcess=true;
                const inGrace = now < node.trv.resetGraceUntil;
                if (p[node.trvAlarmKey]!==undefined && p[node.trvAlarmKey]!==null){
                    let a=truthy(p[node.trvAlarmKey]);
                    if (a && !node.trv.alarm) node.trv.alarmSince=now;
                    if (a!==node.trv.alarm) flgProcess=true;
                    node.trv.alarm=a;
                }

                let raw=p[node.valveSetpointKey];
                let valveSp=parseFloat(raw);
                if (raw!==undefined && raw!==null && !isNaN(valveSp)){
                    node.trv.lastSp=valveSp;
                    nlog(`[MQTT] receive valve setpoint:${valveSp}`,"debug");
                    // Just restarted: what it reports is its boot value. It becomes the reference, so the same value
                    // reported again later (our setpoint still not taken) is never mistaken for a knob turn.
                    if (inGrace && node.trv.pendingAck && !sameAck(valveSp,node.trv.pendingAck.sp)) node.trv.pendingAck.prev=valveSp;

                    let guard = node.expiredOverride && sameAck(valveSp,node.expiredOverride.sp) && now-node.expiredOverride.ts<30*60000;
                    if (node.trv.pendingAck && sameAck(valveSp,node.trv.pendingAck.sp)){
                        // The TRV confirmed what we sent.
                        node.trv.pendingAck=null;
                        if (node.trv.noAck){
                            node.trv.noAck=false;
                            flgProcess=true;
                        }
                    }
                    else if (node.requestSp===undefined){
                        // Fresh install with nothing from the scheduler yet: start from the TRV, capped.
                        node.requestSp=clampSp(valveSp);
                        flgProcess=true;
                    }
                    else if ((node.trv.pendingAck || node.trv.noAck) && node.allowOverride==true && node.executionMode==true && !guard && !paused() && !inGrace &&
                             node.trv.pendingAck && node.trv.pendingAck.prev!==undefined && !sameAck(valveSp,node.trv.pendingAck.prev)){
                        // A value that is neither what we sent nor what the TRV had before: someone turned the knob
                        // while we were waiting. Accept it as a manual change (Manual valve on).
                        nlog(`TRV changed by hand to ${valveSp}°C while ${node.trv.pendingAck.sp}°C was being applied`,"info");
                        node.trv.pendingAck=null; node.trv.noAck=false; node.trv.retryNow=false;
                        manualKnob(valveSp);
                    }
                    else if (node.trv.pendingAck || node.trv.noAck){
                        // Waiting for (or never got) the TRV to confirm our setpoint: whatever else it
                        // reports is not a manual change, it is a TRV that has not taken the command.
                    }
                    else if (guard && node.sp!==undefined && !sameAck(valveSp,node.sp)){
                        // The value of the override that just expired comes back: a TRV repeating a stale value
                        // (stuck, or its own schedule), not a person. Put the schedule back, do not re-override.
                        nlog(`TRV reports ${valveSp}°C again right after that override expired -> ignored, schedule re-applied`,"warn");
                        node.driftPending=true; node.driftForce=true;
                        flgProcess=true;
                    }
                    else if (inGrace && node.sp!==undefined && knobMoved(valveSp,node.sp) && node.executionMode==true){
                        // The TRV just restarted with its own setpoint: not a person, put ours back.
                        nlog(`TRV reports ${valveSp}°C after its restart -> ${node.sp}°C re-applied`,"info");
                        node.driftPending=true; node.driftForce=true;
                        flgProcess=true;
                    }
                    else if (node.sp!==undefined && knobMoved(valveSp,node.sp)){
                        if (paused() && node.executionMode==true){
                            // Away or window open: no heating, keep the frost protection setpoint.
                            nlog(`TRV reports ${valveSp}°C while ${node.away?'away':'the window is open'} (${node.sp}°C) -> re-applying`,"warn");
                            node.driftPending=true; node.driftForce=true;
                            flgProcess=true;
                        }
                        else if (node.allowOverride==true && node.executionMode==true){
                            // Manual change on the TRV: taken as an override once the knob stays still.
                            manualKnob(valveSp);
                        }
                        else if (node.executionMode==true){
                            // Manual valve disabled: the TRV is out of line. Never forward it, put ours back.
                            nlog(`TRV reports ${valveSp}°C, expected ${node.sp}°C (manual valve disabled) -> re-applying`,"warn");
                            node.driftPending=true;
                            flgProcess=true;
                        }
                    }
                    else if (node.manual && node.sp!==undefined && !knobMoved(valveSp,node.sp)){
                        cancelManual('knob turned back to '+valveSp+'°C');
                    }
                }
            }

            if (topic==node.valveModeStateTopic){
                let mode=p[node.valveModeKey];
                if (mode!==undefined && mode!==null){
                    mode=String(mode);
                    nlog(`[MQTT] receive valve mode:${mode}`,"debug");
                    if (mode.match(/^(heat|1|on|auto)$/i)){
                        if (node.executionMode==false){
                            node.executionMode=true;
                            flgProcess=true;
                        }
                    }else if (mode.match(/^(0|off)$/i)){
                        if (node.executionMode==true){
                            node.executionMode=false;
                            flgProcess=true;
                        }
                    }
                }
            }

            if (flgProcess==true){
                if (moment().valueOf()-node.inputLastTs<node.inputMaxInterval){
                    nlog("callbackMqtt(): inputLastTs within inputMaxInterval, evaluation deferred to next cycle","debug");
                    return;
                }
                evaluate();
            }
        }

        function sendMqtt(){
            if (node.mqttclient==null || node.mqttclient.connected!=true){
                nlog("sendMqtt: MQTT not connected, "+node.mqttstack.length+" message(s) queued","debug");
                return;
            }
            let msg=node.mqttstack.shift();
            while (msg!==undefined){
                if (msg.topic===undefined || msg.topic===null || msg.topic==="" || msg.payload===undefined){
                    msg=node.mqttstack.shift();
                    continue;
                }
                let msgstr = (typeof msg.payload === 'object') ? JSON.stringify(msg.payload) : String(msg.payload);
                node.mqttclient.publish(msg.topic.toString(),msgstr,{ qos: msg.qos||0, retain: msg.retain||false },(error) => {
                    if (error) {
                        node.error("mqtt error: "+error)
                    }
                });
                msg=node.mqttstack.shift();
            }
        }

        // ---------------------------------------------------------------------------------------
        // Home Assistant discovery
        // ---------------------------------------------------------------------------------------

        const ha = {
            enabled: !!(node.mqttSettings && truthy(node.mqttSettings.haDiscovery)),
            prefix: (node.mqttSettings && node.mqttSettings.mqttRootPath) ? node.mqttSettings.mqttRootPath : 'homeassistant',
            base: (node.mqttSettings && node.mqttSettings.haBaseTopic) ? node.mqttSettings.haBaseTopic : 'smartheating',
        };
        const uid = 'smartvalve_'+String(node.id).replace(/[^a-zA-Z0-9]/g,'');
        const stateTopic = `${ha.base}/valve/${slug(node.name)}/state`;
        const availTopic = `${ha.base}/valve/${slug(node.name)}/availability`;
        const awaySetTopic = `${ha.base}/valve/${slug(node.name)}/away/set`;
        const calibrateCmdTopic = `${ha.base}/valve/${slug(node.name)}/calibrate/set`;
        // Valves of one room (same group id) share manual changes on this topic, without any flow wiring.
        const hasGroup = node.groupId!==undefined && node.groupId!==null && String(node.groupId).trim()!=='';
        const groupTopic = (node.groupSync && hasGroup) ? `${ha.base}/group/${slug(String(node.groupId))}/manual` : null;
        // ... and window states (not retained, refreshed every 5 min while open, forgotten after 15 min)
        const groupWindowTopic = (node.groupSync && hasGroup) ? `${ha.base}/group/${slug(String(node.groupId))}/window` : null;

        function haDiscovery(){
            if (!ha.enabled) return;
            const device={identifiers:[uid],name:`SmartValve ${node.name}`,manufacturer:'vib',model:'smart-valve',sw_version:pjson.version};
            const common={state_topic:stateTopic,availability_topic:availTopic,json_attributes_topic:stateTopic,device:device};
            const entities=[
                ['sensor','health',Object.assign({name:'Health',unique_id:uid+'_health',value_template:'{{ value_json.health }}',icon:'mdi:heart-pulse'},common)],
                ['binary_sensor','problem',Object.assign({name:'Problem',unique_id:uid+'_problem',device_class:'problem',value_template:"{{ 'ON' if value_json.health in ['FAILED','DEGRADED'] else 'OFF' }}"},common)],
                ['sensor','setpoint',Object.assign({name:'Requested setpoint',unique_id:uid+'_setpoint',device_class:'temperature',unit_of_measurement:'°C',value_template:'{{ value_json.boiler_setpoint }}'},common)],
                ['sensor','temperature',Object.assign({name:'Room temperature',unique_id:uid+'_temperature',device_class:'temperature',unit_of_measurement:'°C',value_template:'{{ value_json.temperature }}'},common)],
                ['switch','away',Object.assign({},common,{name:'Away',unique_id:uid+'_away',icon:'mdi:home-export-outline',
                    value_template:"{{ 'ON' if value_json.away else 'OFF' }}",command_topic:awaySetTopic,
                    payload_on:'ON',payload_off:'OFF',state_on:'ON',state_off:'OFF',retain:true})],
            ];
            if (node.windowTopics.length || groupWindowTopic) entities.push(
                ['binary_sensor','window',Object.assign({},common,{name:'Window',unique_id:uid+'_window',device_class:'window',
                    value_template:"{{ 'ON' if value_json.window else 'OFF' }}"})]);
            entities.push(
                ['sensor','status',Object.assign({name:'Status detail',unique_id:uid+'_status',icon:'mdi:information-outline',value_template:'{{ value_json.status[:255] }}'},common)]);
            [['sensor','Room sensor check','mdi:thermometer-check'],['trv_link','TRV link check','mdi:access-point-check'],
             ['valve_alarm','Valve alarm check','mdi:valve'],['tracking','TRV tracking check','mdi:chart-line-variant'],
             ['setpoint','Setpoint confirmation check','mdi:check-network-outline'],
             ['trv_config','TRV settings check','mdi:cog-refresh-outline'],['valve_closing','Valve closing check','mdi:pipe-valve']].forEach(function(c){
                entities.push(['sensor','check_'+c[0],Object.assign({},common,{name:c[1],unique_id:uid+'_check_'+c[0],icon:c[2],
                    value_template:`{{ value_json.checks.${c[0]}.text[:255] }}`,
                    json_attributes_template:`{{ {'level': value_json.checks.${c[0]}.level} | tojson }}`})]);
            });
            if (node.valveCalibrateSetTopic) entities.push(['button','calibrate',{name:'Calibrate TRV',unique_id:uid+'_calibrate',icon:'mdi:tune-vertical',
                command_topic:calibrateCmdTopic,payload_press:'PRESS',availability_topic:availTopic,device:device}]);
            entities.forEach(function(e){
                node.mqttstack.push({topic:`${ha.prefix}/${e[0]}/${uid}/${e[1]}/config`,payload:e[2],qos:1,retain:true});
            });
            node.mqttstack.push({topic:availTopic,payload:'online',qos:1,retain:true});
        }

        function haState(boilerSp, force){
            if (!ha.enabled) return;
            const now=moment().valueOf();
            const st={
                health:node.health.state,
                status:explain(now),
                checks:checkDetails(now),
                reasons:node.health.reasons,
                health_since:new Date(node.health.since).toISOString(),
                temperature:node.refTemp!==undefined?parseFloat(node.refTemp):null,
                sensor_age_min:node.refTempTs?Math.round((now-node.refTempTs)/60000):null,
                boiler_setpoint:boilerSp!==undefined?parseFloat(parseFloat(boilerSp).toFixed(2)):null,
                requested_setpoint:node.requestSp!==undefined?parseFloat(node.requestSp):null,
                scheduled_setpoint:node.scheduledSp!==undefined?parseFloat(node.scheduledSp):null,
                trv_setpoint:node.trv.lastSp!==undefined?node.trv.lastSp:null,
                trv_temperature:node.trv.localTemp!==undefined?node.trv.localTemp:null,
                trv_age_min:node.trv.lastMsgTs?Math.round((now-node.trv.lastMsgTs)/60000):null,
                valve_alarm:node.trv.alarm,
                override:node.overrideMode,
                override_until:node.overrideMode?new Date(overrideEnd()).toISOString():null,
                knob_settling:node.manual?node.manual.sp:null,
                mode:node.executionMode?'on':'off',
                away:node.away,
                away_setpoint:parseFloat(node.awaySp),
                window:node.window.eff,
                window_since:node.window.eff?new Date(node.window.effSince).toISOString():null,
                window_source:node.window.eff?(ownWindowOpen(now)?'sensor':'room'):null,
                trv_sensor:node.trv.sensor!==undefined?node.trv.sensor:null,
                trv_calibrated:node.trv.calibrated!==undefined?node.trv.calibrated:null,
                trv_battery:node.trv.battery!==undefined?node.trv.battery:null,
                trv_body_temperature:node.trv.bodyTemp!==undefined?node.trv.bodyTemp:null,
                valve_not_closing:node.health.reasons.includes('valve_not_closing'),
                trv_restarted:node.trv.lastReset?new Date(node.trv.lastReset.ts).toISOString():null,
                trv_restart_reason:node.trv.lastReset?whyText(node.trv.lastReset.why):null,
                last_calibration:node.trv.lastCal?new Date(node.trv.lastCal.ts).toISOString():null,
                last_calibration_reason:node.trv.lastCal?node.trv.lastCal.why:null,
                calibration_pending:node.trv.calPending?new Date(node.trv.calPending.at).toISOString():null,
                calibrations_in_window:calibrationsInWindow(now).length,
                calibration_limit:node.calibrateMax,
                calibration_skipped:node.trv.calSkipped?new Date(node.trv.calSkipped.ts).toISOString():null,
                window_sensors:openSensors(now).map(sensorName).concat(peerWindowOpen(now).reduce(function(a,k){ return a.concat(node.window.peers[k].sensors||[]); },[])),
                group:node.groupId
            };
            const s=JSON.stringify(st);
            const cmp=JSON.stringify(Object.assign({},st,{sensor_age_min:0,trv_age_min:0,status:st.status.replace(/\d+ min/g,''),
                checks:JSON.stringify(st.checks).replace(/\d+ min ago/g,'')}));
            if (force || cmp!==node.lastHaPayload || now-node.lastHaPublishTs>=5*60000){
                node.mqttstack.push({topic:stateTopic,payload:s,qos:0,retain:true});
                node.lastHaPayload=cmp;
                node.lastHaPublishTs=now;
            }
        }

        // ---------------------------------------------------------------------------------------
        // Input
        // ---------------------------------------------------------------------------------------

        function checkOverrideExpiry(){
            if (node.overrideMode==true && moment().valueOf()>overrideEnd()){
                nlog("Override duration expired, back to the schedule","info");
                node.overrideMode=false;
                node.expiredOverride={sp:node.requestSp, ts:moment().valueOf()};
                if (node.scheduledSp!==undefined){
                    node.requestSp=node.scheduledSp;
                    node.inputTrigger=true;          // forces the scheduled setpoint to be pushed to the TRV
                }
            }
        }

        // Window of this valve's sensor open (after the delay) or closed.
        // A sensor of this valve changed (past the delay): the room is paused while any of them is open.
        function syncOwnWindow(now, why){
            let open=ownWindowOpen(now);
            if (open===node.window.own) return false;
            node.window.own=open; node.window.ownSince=now;
            nlog(`Window ${open?'open: heating paused':'closed: heating resumes'}${why?' ('+why+')':''}`,"info");
            publishWindow(true);
            return true;
        }
        function windowSensorsChanged(why){
            let now=moment().valueOf();
            if (!syncOwnWindow(now, why)) nlog(`Window ${why}: open now ${openSensors(now).map(sensorName).join(', ')||'none'}`,"info");
            publishWindow(true);
            saveState();
            evaluate();
        }
        function publishWindow(force){
            if (!groupWindowTopic || !Object.keys(node.window.sensors).length) return;
            let now=moment().valueOf();
            let open=ownWindowOpen(now);
            if (!force && !(open && now-node.window.lastPubTs>=5*60000)) return;
            node.window.lastPubTs=now;
            node.mqttstack.push({topic:groupWindowTopic,qos:1,retain:false,payload:{
                open:open, since:node.window.ownSince, sensors:openSensors(now).map(sensorName), groupId:node.groupId, from:node.id, requestedBy:node.name}});
        }
        // Window state of another valve of the room.
        function peerWindow(p){
            if (!p || typeof p!=='object' || p.from===undefined || p.from===node.id) return;
            if (String(p.groupId)!==String(node.groupId)) return;
            let now=moment().valueOf();
            node.window.peers[p.from]={open:p.open===true, ts:now, name:p.requestedBy, sensors:Array.isArray(p.sensors)?p.sensors.map(String):[]};
            if (windowOpen(now)!==node.window.eff) evaluate();
        }

        // Away: frost protection setpoint on the TRV, the room only asks the boiler for heat below it,
        // the schedule keeps being recorded and is applied again when back home.
        function setAway(on, why){
            on=!!on;
            if (on===node.away){
                haState(node.prevSp, true); sendMqtt();
                return;
            }
            node.away=on;
            nlog(`${on?'Away':'Back home'} (${why})`,"info");
            if (on) cancelManual('away');
            if (on && node.overrideMode){
                node.overrideMode=false;                  // a manual setpoint does not survive leaving
                if (node.scheduledSp!==undefined) node.requestSp=node.scheduledSp;
            }
            // Keep the retained Home Assistant command in line, so a restart never replays an old one.
            if (ha.enabled) node.mqttstack.push({topic:awaySetTopic,payload:on?'ON':'OFF',qos:1,retain:true});
            node.inputTrigger=true;                       // push the new TRV setpoint now
            node.lastBoilerSendTs=0;                      // and tell the boiler straight away
            saveState();
            evaluate();
            haState(node.prevSp, true); sendMqtt();
        }
        function awayValue(v){
            if (v===undefined || v===null) return undefined;
            if (typeof v==='object') v=v.away!==undefined ? v.away : (v.state!==undefined ? v.state : v.value);
            if (typeof v==='boolean') return v;
            v=String(v).trim().toLowerCase();
            if (/^(on|1|true|away|yes)$/.test(v)) return true;
            if (/^(off|0|false|home|no)$/.test(v)) return false;
            return undefined;
        }

        // ---------------------------------------------------------------------------------------
        // Manual change (knob) and room synchronisation
        // ---------------------------------------------------------------------------------------

        function startOverride(sp, startTs, len){
            node.overrideMode=true;
            node.overrideStartTs=startTs;
            node.overrideLen=len;
            node.requestSp=sp;
        }

        // A rotary knob reports every step (20.5, 21, 21.5...). Wait until it stays still for manualSettle s,
        // then take the last value once. A knob that never settles (jittering TRV) is taken after manualMaxWait s.
        function manualKnob(valveSp){
            let v=clampSp(valveSp), now=moment().valueOf();
            if (v===undefined) return;
            if (node.manual && same(node.manual.sp,v) && same(node.manual.raw,valveSp)) return;   // same value repeated: no extension
            if (!node.manual){
                node.manual={sp:v, raw:parseFloat(valveSp), firstTs:now, lastTs:now};
                nlog(`Knob turned to ${valveSp}°C, waiting ${node.manualSettle}s for it to settle`,"info");
            }
            node.manual.sp=v; node.manual.raw=parseFloat(valveSp); node.manual.lastTs=now;
            clearTimeout(node.manualTimer);
            let wait=Math.min(node.manualSettle*1000, node.manual.firstTs+node.manualMaxWait*1000-now);
            node.manualTimer=setTimeout(commitManual, Math.max(0,wait));
            setStatus(node.prevSp);
        }

        function cancelManual(why){
            if (!node.manual) return;
            nlog(`Knob change cancelled (${why})`,"info");
            clearTimeout(node.manualTimer); node.manualTimer=null;
            node.manual=null;
            setStatus(node.prevSp);
        }

        function commitManual(){
            node.manualTimer=null;
            let m=node.manual;
            node.manual=null;
            if (!m) return;
            if (!(node.allowOverride==true && node.executionMode==true && !paused())) return;
            let now=moment().valueOf();
            nlog(`Manual setpoint ${m.sp}°C taken for ${node.overrideDuration} min`+(groupTopic?`, shared with group ${node.groupId}`:''),"info");
            startOverride(m.sp, now, node.overrideDuration);
            node.sp=m.raw;                               // what the TRV has now; evaluate() caps it if needed
            if (groupTopic){
                node.mqttstack.push({topic:groupTopic,qos:1,retain:false,payload:{
                    setpoint:m.sp, start:now, duration:node.overrideLen, groupId:node.groupId,
                    from:node.id, requestedBy:node.name}});
            }
            // Kept for flows that wire the output to the other valves (0.81/0.82 way); they ignore duplicates.
            node.send([{topic:node.topic,payload:{
                command:"override", setpoint:parseFloat(parseFloat(m.sp).toFixed(2)),
                temperature:node.refTemp!==undefined?parseFloat(parseFloat(node.refTemp).toFixed(2)):undefined,
                requestedBy:node.name, groupId:node.groupId, start:now, duration:node.overrideLen, from:node.id, noOut:true}}]);
            node.inputTrigger=true;
            evaluate();
        }

        // Manual change made on another valve of the same group: same setpoint, same end time.
        function applyGroupOverride(p, via){
            if (!p || typeof p!=='object') return false;
            if (p.from===node.id || (p.requestedBy!==undefined && p.requestedBy==node.name)) return false;
            if (!hasGroup || p.groupId===undefined || String(p.groupId)!==String(node.groupId)){
                nlog(`Override from ${p.requestedBy} (group ${p.groupId}) via ${via}: other group, ignored`,"debug");
                return false;
            }
            if (!(node.allowOverride==true && node.executionMode==true)){
                nlog(`Override from ${p.requestedBy} via ${via} ignored (manual valve disabled or off)`,"debug");
                return false;
            }
            if (node.away){
                nlog(`Override from ${p.requestedBy} via ${via} ignored while away`,"debug");
                return false;
            }
            let sp=parseFloat(p.setpoint);
            if (p.setpoint===undefined || p.setpoint===null || isNaN(sp) || sp<0 || sp>40){
                nlog(`Override from ${p.requestedBy} via ${via}: invalid setpoint ${p.setpoint}`,"warn");
                return false;
            }
            sp=clampSp(sp);
            let now=moment().valueOf();
            let start=parseFloat(p.start);
            if (isNaN(start) || start>now+60000 || start<now-10*60000) start=now;
            let len=parseFloat(p.duration);
            if (isNaN(len) || len<=0 || len>24*60) len=node.overrideDuration;
            if (now>=start+len*60000) return false;      // already over
            // The same change received twice (MQTT and flow wiring): applied once.
            if (node.overrideMode && same(node.requestSp,sp) && Math.abs(node.overrideStartTs-start)<120000) return false;
            if (node.manual) cancelManual('override from '+p.requestedBy);
            nlog(`Override ${sp}°C from ${p.requestedBy} (via ${via}) until ${moment(start+len*60000).format('HH:mm')}`,"info");
            startOverride(sp, start, len);
            node.inputTrigger=true;
            evaluate();
            return true;
        }

        node.on('input', function(msg) {
            if (msg===undefined || msg.payload===undefined || msg.payload===null){
                node.warn("invalid input returning");
                return;
            }

            checkOverrideExpiry();

            let command=msg.payload.command;
            if (command===undefined || command===null){
                nlog('unhandled msg.payload:'+JSON.stringify(msg.payload),"debug");
                return;
            }
            command=String(command);
            if (!command.match(/^(1|set|on|auto|0|off|trigger|override|away|home|window|calibrate)$/i)){
                nlog('unhandled msg.payload:'+JSON.stringify(msg.payload),"debug");
                return;
            }
            command=command.toLowerCase();

            if (command=='away' || command=='home'){
                let v = command=='home' ? false : (msg.payload.value===undefined ? true : awayValue(msg.payload.value));
                if (v===undefined){
                    nlog(`Command:away invalid value ${JSON.stringify(msg.payload.value)}`,"error");
                    return;
                }
                if (msg.payload.noOut===true) node.noOut=true;
                setAway(v,'input');
                return;
            }

            if (command=='calibrate'){
                // {command:"calibrate"}: calibrate the TRV now (not counted in the automatic limit)
                let now=moment().valueOf();
                if (!requestCalibration('asked from the flow', now, true)) nlog('Calibration asked from the flow ignored: one is already planned or running, or no calibrate topic',"warn");
                haState(node.prevSp, true); sendMqtt();
                return;
            }

            if (command=='window'){
                // window state from a flow (no sensor topic needed): {command:"window", value:true|false}
                let v=awayValue(msg.payload.value===undefined ? true : msg.payload.value);
                if (v===undefined){ nlog(`Command:window invalid value ${JSON.stringify(msg.payload.value)}`,"error"); return; }
                let w=node.window.sensors['input'] || (node.window.sensors['input']={timer:null});
                let was=w.open===true;
                Object.assign(w,{raw:v, open:v, since:v?(was?w.since:moment().valueOf()):0, lastMsgTs:moment().valueOf(), stale:false});
                if (was===v){ evaluate(); return; }
                windowSensorsChanged('input '+(v?'open':'closed'));
                return;
            }

            if (command=='0' || command=='off'){
                node.executionMode=false;
            }
            else if (command=='on'){
                node.executionMode=true;
            }
            else if (command=='auto'){
                node.executionMode=true;
                node.overrideMode=false;
                if (node.scheduledSp!==undefined) node.requestSp=node.scheduledSp;
            }
            else if (command=='set' || command=='override'){

                if (command=='set' && msg.payload.target=="boiler"){
                    nlog("Command 'set' for target 'boiler' -> ignoring","debug");
                    return;
                }

                let sp=parseFloat(msg.payload.setpoint);
                if (msg.payload.setpoint===undefined || msg.payload.setpoint===null || isNaN(sp) || sp<0 || sp>40){
                    nlog(`Command:${command} missing or invalid setpoint`,"error");
                    return;
                }

                if (command=='override'){
                    if (msg.payload.requestedBy===undefined || msg.payload.groupId===undefined){
                        nlog("Command:override ignored (incomplete message)","debug");
                        return;
                    }
                    node.inputLastTs=moment().valueOf();
                    applyGroupOverride(msg.payload,'input');
                    return;
                }

                if (command=='set'){
                    // Always remember the schedule, even during an override, so it can be restored.
                    node.scheduledSp=clampSp(sp);
                    if (node.overrideMode==true){
                        nlog("In override mode, scheduled setpoint stored for later","info");
                        saveState();
                        return;
                    }
                }

                let t=parseFloat(msg.payload.temperature);
                if (msg.payload.temperature!==undefined && msg.payload.temperature!==null && !isNaN(t) && t>=-20 && t<=60){
                    node.refTemp=t;
                    node.refTempTs=moment().valueOf();
                }

                node.requestSp=clampSp(sp);
            }
            // '1' and 'trigger' only force an evaluation

            if (msg.payload.noOut===true) {
                node.noOut=true;
            }
            node.inputTrigger = true;
            nlog(`Command:${command}, sp:${node.requestSp}, noOut:${node.noOut}, executionMode:${node.executionMode}`,"debug");
            node.inputLastTs=moment().valueOf();
            evaluate();
        });

        // ---------------------------------------------------------------------------------------
        // Evaluation
        // ---------------------------------------------------------------------------------------

        function setStatus(boilerSp){
            let t=node.refTemp!==undefined ? parseFloat(node.refTemp).toFixed(2) : "?";
            let sp=boilerSp!==undefined ? parseFloat(boilerSp).toFixed(2) : "?";
            if (node.health.state==='FAILED'){
                node.status({fill:'red',shape:'ring',text:`FAILED (${node.health.reasons.join(', ')}) t:${t}°C, sp:${sp}°C`});
                return;
            }
            if (node.executionMode==false){
                node.status({fill:'grey',shape:'dot',text:`Off t:${t}°C, sp:${sp}°C`});
                return;
            }
            if (paused()){
                let deg=node.health.state==='DEGRADED' ? `(${node.health.reasons.join(', ')}) ` : '';
                node.status({fill:'blue',shape:'dot',text:`${deg}${node.away?'Away':'Window open'} t:${t}°C, sp:${sp}°C`});
                return;
            }
            let prefix='';
            if (node.overrideMode){
                let left=Math.max(0,Math.ceil((overrideEnd()-moment().valueOf())/60000));
                prefix=`(Manual ${left}min left) `;
            }
            if (node.manual) prefix=`(Knob ${parseFloat(node.manual.sp).toFixed(1)}°C settling) `+prefix;
            if (node.health.state==='DEGRADED') prefix+=`(${node.health.reasons.join(', ')}) `;
            let heat=parseFloat(boilerSp)>parseFloat(node.refTemp);
            node.status({fill: node.health.state==='DEGRADED' ? 'yellow' : (heat?'red':'green'), shape:'dot', text:`${prefix}${heat?'Heat':'idle'} t:${t}°C, sp:${sp}°C`});
        }

        function evaluate() {
            node.msgStormMsgCounter+=1;
            if (moment().diff(node.msgStormLastTs)>node.msgStormInterval){
                node.msgStormMsgCounter=1;
            }
            node.msgStormLastTs=moment();
            if (node.msgStormMsgCounter>node.msgStormMaxMsg){
                nlog(`evaluate(): <!> Message storm detected: ${node.msgStormMsgCounter} messages within ${node.msgStormInterval/1000}s, evaluate() aborted!`,"error");
                return;
            }

            const now=moment().valueOf();
            checkOverrideExpiry();
            let healthChanged=computeHealth(now);

            // Window: effective state (own sensors or room), a change pushes the TRV and tells the boiler now.
            if (syncOwnWindow(now, 'sensor silent')) saveState();
            let wopen=windowOpen(now);
            if (wopen!==node.window.eff){
                node.window.eff=wopen; node.window.effSince=now;
                if (wopen) cancelManual('window open');
                node.inputTrigger=true; node.lastBoilerSendTs=0; healthChanged=true;
            }
            publishWindow(false);                                        // refresh for the room while open

            if (node.refTemp===undefined || (node.requestSp===undefined && !paused())){
                let t=node.refTemp!==undefined ? node.refTemp : "?";
                let sp=node.requestSp!==undefined ? node.requestSp : "?";
                node.status({fill:'yellow',shape:'dot',text:`Not ready t:${t}°C, sp:${sp}°C`});
                haState(undefined, healthChanged);
                sendMqtt();
                node.inputTrigger=false;
                return;
            }

            // --- Setpoint towards the TRV ------------------------------------------------------
            const target = paused() ? node.awaySp : node.requestSp;      // what the TRV should have now
            if (node.executionMode==true && !node.manual){                // never fight a knob being turned
                if (node.firstEval==true && node.inputTrigger==false){
                    // Startup: adopt the saved/known setpoint and make sure the TRV has it.
                    if (node.sp===undefined || !same(node.sp,target) || (node.trv.lastSp!==undefined && !same(node.trv.lastSp,target))){
                        pushSetpointToTrv(target,'startup');
                    } else {
                        node.sp=target;
                    }
                }
                else if ((node.inputTrigger==true && !same(node.sp,target)) || node.spUpdateMode=="spUpdateMode.cycle"){
                    pushSetpointToTrv(target, node.away?'away':(node.window.eff?'window open':(node.inputTrigger?'schedule':'cycle')));
                }

                if (node.driftPending==true){
                    if ((node.allowOverride!=true || node.driftForce) && node.sp!==undefined){
                        // At most one correction a minute; a change seen sooner stays pending for the next cycle
                        // (it used to be dropped, leaving a knob turned right after a push in place).
                        if (now-node.trv.lastPushTs>=60000){
                            pushSetpointToTrv(node.sp,'TRV out of line');
                            node.driftPending=false; node.driftForce=false;
                        }
                    } else {
                        node.driftPending=false; node.driftForce=false;
                    }
                }

                // First confirmation missed: send the same setpoint once more before calling it a failure.
                if (node.trv.retryNow && node.trv.pendingAck){
                    node.trv.retryNow=false;
                    let pa=node.trv.pendingAck;
                    pushSetpointToTrv(pa.sp,'not confirmed, sent again');
                    node.trv.pendingAck=Object.assign(pa,{ts:now,retried:true});
                }

                // Never confirmed: retry every 3 x ackTimeout so a recovered TRV gets back in line.
                if (node.trv.noAck && node.ackTimeout>0 && now-node.trv.lastPushTs>=3*node.ackTimeout*60000){
                    node.trv.pendingAck=null;
                    pushSetpointToTrv(target,'retry');
                    node.trv.pendingAck={sp:parseFloat(target),ts:now};
                }
            }

            // --- Room temperature towards the TRV (external sensor mode) ----------------------
            if (node.valveTemperatureSetTopic && node.refTemp!==undefined && node.refTemp!=node.prevRefTemp){
                node.mqttstack.push({topic:node.valveTemperatureSetTopic,payload:parseFloat(parseFloat(node.refTemp).toFixed(2)),qos:0,retain:false});
                if (node.valveTemperatureSensorTypeSetTopic && (node.sensorTypeTs==0 || now-node.sensorTypeTs>=node.sensorTypeRefresh*60000)){
                    node.mqttstack.push({topic:node.valveTemperatureSensorTypeSetTopic,payload:node.valveTemperatureSensorTypePayload,qos:0,retain:false});
                    node.sensorTypeTs=now;
                }
            }

            // --- 0.87: ask the TRV its sensor mode now and then (Zigbee2MQTT publishes only on change) ---
            if (node.resetReapply && node.expectedSensor && node.trvGetTopic && now-node.trv.lastGetTs>=node.trvGetEvery*60000){
                let q={}; q[node.trvSensorKey]="";
                node.mqttstack.push({topic:node.trvGetTopic,payload:q,qos:0,retain:false});
                node.trv.lastGetTs=now;
            }

            // --- Demand towards the boiler ----------------------------------------------------
            // Away: only frost protection, the room asks for heat when it falls below the away setpoint.
            // Window open: same, the room only keeps itself above the frost setpoint.
            let boilerSp = (node.executionMode==false || releasesDemand()) ? node.offSp : (paused() ? node.awaySp : node.requestSp);
            let heartbeatDue = node.heartbeat>0 && now-node.lastBoilerSendTs>=node.heartbeat*60000;
            if (node.refTemp!=node.prevRefTemp || !same(boilerSp,node.prevSp) || node.firstEval==true || heartbeatDue || healthChanged){
                if (node.noOut==false){
                    node.send([{payload:{
                        command:"set",
                        target:"boiler",
                        setpoint:parseFloat(boilerSp).toFixed(2),
                        temperature:parseFloat(node.refTemp).toFixed(2),
                        requestedBy:node.name,
                        groupId:node.groupId,
                        health:node.health.state,
                        reasons:node.health.reasons,
                        away:node.away,
                        window:node.window.eff
                    }}]);
                    node.lastBoilerSendTs=now;
                }
                node.prevRefTemp=node.refTemp;
                node.prevSp=boilerSp;
            }

            setStatus(boilerSp);
            haState(boilerSp, healthChanged);
            sendMqtt();
            saveState();

            node.firstEval=false;
            node.inputTrigger=false;
            node.noOut=false;
        }

        // ---------------------------------------------------------------------------------------
        // MQTT connection and timers
        // ---------------------------------------------------------------------------------------

        if ( node.mqttSettings && node.mqttSettings.mqttHost){
            const connectUrl = `mqtt://${node.mqttSettings.mqttHost}:${node.mqttSettings.mqttPort}`;
            const opts={
                clientId:`smv_${Math.random().toString(16).slice(3)}`,
                clean: true,
                keepalive:60,
                connectTimeout: 40000,
                username: node.mqttSettings.mqttUser,
                password: node.mqttSettings.mqttPassword,
                reconnectPeriod: 10000,
            };
            if (ha.enabled){
                opts.will={topic:availTopic,payload:'offline',qos:1,retain:true};
            }
            node.mqttclient = mqtt.connect(connectUrl, opts);

            node.mqttclient.on('error', function (error) {
                if (!node.mqttErrorLogged){                  // once per outage, not every retry
                    node.warn("MQTT error: "+error+" (will keep retrying, logged once)");
                    node.mqttErrorLogged=true;
                }
            });
            node.mqttclient.on('connect', () => {
                if (node.mqttErrorLogged) node.log('MQTT connected again');
                node.mqttErrorLogged=false;
                subscribeMqtt();
                haDiscovery();
                sendMqtt();
            });
            node.mqttclient.on('message', (topic, payload) => {
                if (ha.enabled && topic===calibrateCmdTopic){
                    try{
                        let now=moment().valueOf();
                        if (!requestCalibration('asked from Home Assistant', now, true)) nlog('Calibration from Home Assistant ignored: one is already planned or running',"warn");
                        haState(node.prevSp, true); sendMqtt();
                    }catch(e){ node.error("Error processing calibrate command: "+e.message); }
                    return;
                }
                if (ha.enabled && topic===awaySetTopic){
                    let v=payload.toString(), j;
                    try{ j=JSON.parse(v); }catch(e){ j=v; }
                    let a=awayValue(j);
                    if (a===undefined){ nlog(`Away command ignored: ${v}`,"warn"); return; }
                    try{ setAway(a,'Home Assistant'); }catch(e){ node.error("Error processing away command: "+e.message); }
                    return;
                }
                let obj;
                try{
                    obj=JSON.parse(payload.toString());
                }catch(e){
                    nlog(`MQTT non-JSON payload on ${topic} ignored`,"debug");
                    return;
                }
                if (obj===null || typeof obj!=='object') return;
                if (groupWindowTopic && topic===groupWindowTopic){
                    try{ peerWindow(obj); }catch(e){ node.error("Error processing room window state: "+e.message); }
                    return;
                }
                if (groupTopic && topic===groupTopic){
                    try{ applyGroupOverride(obj,'MQTT'); }catch(e){ node.error("Error processing group manual change: "+e.message); }
                    if (topic!==node.temperatureSensorStateTopic && topic!==node.valveSetpointStateTopic && topic!==node.valveModeStateTopic) return;
                }
                try{
                    callbackMqtt(topic,obj);
                }catch(e){
                    node.error("Error processing MQTT message on "+topic+": "+e.message);
                }
            });
        }

        node.evalInterval = setInterval(evaluate, node.cycleDuration*60000);
        node.startTimeout = setTimeout(evaluate, 1000);

        node.on('close', function(done) {
            clearTimeout(node.manualTimer);
            clearTimeout(node.trv.calTimer);
            Object.keys(node.window.sensors).forEach(function(k){ clearTimeout(node.window.sensors[k].timer); });
            clearInterval(node.evalInterval);
            clearTimeout(node.startTimeout);
            if (node.mqttclient) {
                if (ha.enabled && node.mqttclient.connected){
                    node.mqttclient.publish(availTopic,'offline',{qos:1,retain:true});
                }
                node.mqttclient.end();
            }
            done();
        })
    }
    RED.nodes.registerType('smart-valve', SmartValve)

    RED.httpAdmin.post("/smartvalve/:id", RED.auth.needsPermission("inject.write"), function(req,res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
                node.ev();
                res.sendStatus(200);
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("inject.failed",{error:err.toString()}));
            }
        } else {
            res.sendStatus(404);
        }
    });
}
