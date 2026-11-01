
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
            lastPushTs:0
        };
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
                overrideMode: node.overrideMode,
                overrideStartTs: node.overrideStartTs,
                overrideLen: node.overrideLen,
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
                    parts.push(`The TRV reads ${t(node.trv.localTemp)} while the room is ${t(node.refTemp)} since ${hhmm(node.trv.frozenSince)}: it no longer follows the room temperature (frozen or lost its external sensor).${esc} Power-cycle the TRV.`);
                }
                else if (r==='no_ack' && !node.trv.noAck) parts.push(`Setpoint ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} was not confirmed by the TRV within ${node.ackTimeout} min; sent again at ${hhmm(node.trv.lastPushTs)}.`);
                else if (r==='no_ack') parts.push(`Setpoint ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} sent at ${hhmm(node.trv.lastPushTs)} was not confirmed by the TRV (it reports ${t(node.trv.lastSp)}); retried every ${3*node.ackTimeout} min. Power-cycle or re-pair the TRV.`);
            });
            let head;
            if (node.health.state==='FAILED') head = node.failedAction==='failedAction.keep' ? 'FAILED, demand kept (When FAILED = keep).' : 'FAILED: this room no longer asks the boiler for heat.';
            else if (node.health.state==='DEGRADED') head = 'Warning, heating continues normally.';
            else if (node.executionMode==false) head = 'Off: this room does not ask for heat.';
            else if (node.away) head = `Away: frost protection at ${t(node.awaySp)}, room ${t(node.refTemp)}`+(node.refTemp!==undefined&&parseFloat(node.awaySp)>parseFloat(node.refTemp)?', asking for heat to protect against frost.':', no heat requested.')+(node.requestSp!==undefined?` The schedule (${t(node.requestSp)}) resumes when back home.`:'');
            else if (node.health.state==='UNKNOWN') head = 'Starting.';
            else {
                let sp=node.requestSp, rt=node.refTemp;
                head = node.overrideMode ? `OK, manual setpoint ${t(sp)} until ${hhmm(overrideEnd())}, room ${t(rt)}.`
                     : `OK, following the schedule: ${t(sp)}, room ${t(rt)}${(sp!==undefined&&rt!==undefined&&parseFloat(sp)>parseFloat(rt))?', asking for heat.':', warm enough.'}`;
            }
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
                    out.tracking=line(failedNow?'failed':'warning',`${failedNow?'Failed':'Warning'}: TRV reads ${t(node.trv.localTemp)}, room ${t(node.refTemp)} (gap ${gap} °C, limit ${node.frozenDelta}) since ${hhmm(node.trv.frozenSince)}.`+(failedNow?'':` Becomes a failure at ${hhmm(node.trv.frozenSince+node.frozenDuration*min)}.`)+' Power-cycle the TRV.');
                } else out.tracking=line('ok',`OK: TRV reads ${t(node.trv.localTemp)}, room ${t(node.refTemp)} (gap ${gap} °C, limit ${node.frozenDelta}).`);
            }

            // Setpoint confirmation
            if (!(node.ackTimeout>0)) out.setpoint=line('off','Not checked: Ack timeout = 0.');
            else if (node.trv.noAck) out.setpoint=line('failed',`Failed: ${t(node.trv.pendingAck?node.trv.pendingAck.sp:node.requestSp)} sent at ${hhmm(node.trv.lastPushTs)}, the TRV still reports ${t(node.trv.lastSp)}; retried every ${3*node.ackTimeout} min. Power-cycle or re-pair the TRV.`);
            else if (node.trv.pendingAck && node.trv.pendingAck.retried) out.setpoint=line('warning',`Warning: ${t(node.trv.pendingAck.sp)} not confirmed within ${node.ackTimeout} min, sent again at ${hhmm(node.trv.pendingAck.ts)}.`);
            else if (node.trv.pendingAck) out.setpoint=line('waiting',`Waiting: ${t(node.trv.pendingAck.sp)} sent at ${hhmm(node.trv.pendingAck.ts)}, confirmation expected within ${node.ackTimeout} min.`);
            else if (node.trv.lastSp===undefined) out.setpoint=line('waiting','Waiting: the TRV has not reported its setpoint yet.');
            else out.setpoint=line('ok',`OK: the TRV has ${t(node.trv.lastSp)}`+(node.sp!==undefined && !same(node.sp,node.trv.lastSp)?`, ${t(node.sp)} expected.`:', as requested.'));
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
            [node.temperatureSensorStateTopic,node.valveSetpointStateTopic,node.valveModeStateTopic,ha.enabled?awaySetTopic:undefined,groupTopic].forEach(function(t){
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

        function callbackMqtt(topic,p){
            let flgProcess=false;
            let now=moment().valueOf();

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
                    else if ((node.trv.pendingAck || node.trv.noAck) && node.allowOverride==true && node.executionMode==true && !guard && !node.away &&
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
                    else if (node.sp!==undefined && knobMoved(valveSp,node.sp)){
                        if (node.away && node.executionMode==true){
                            // Away: nobody is supposed to be there, keep the frost protection setpoint.
                            nlog(`TRV reports ${valveSp}°C while away (${node.sp}°C) -> re-applying`,"warn");
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
        // Valves of one room (same group id) share manual changes on this topic, without any flow wiring.
        const hasGroup = node.groupId!==undefined && node.groupId!==null && String(node.groupId).trim()!=='';
        const groupTopic = (node.groupSync && hasGroup) ? `${ha.base}/group/${slug(String(node.groupId))}/manual` : null;

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
                ['sensor','status',Object.assign({name:'Status detail',unique_id:uid+'_status',icon:'mdi:information-outline',value_template:'{{ value_json.status[:255] }}'},common)],
            ];
            [['sensor','Room sensor check','mdi:thermometer-check'],['trv_link','TRV link check','mdi:access-point-check'],
             ['valve_alarm','Valve alarm check','mdi:valve'],['tracking','TRV tracking check','mdi:chart-line-variant'],
             ['setpoint','Setpoint confirmation check','mdi:check-network-outline']].forEach(function(c){
                entities.push(['sensor','check_'+c[0],Object.assign({},common,{name:c[1],unique_id:uid+'_check_'+c[0],icon:c[2],
                    value_template:`{{ value_json.checks.${c[0]}.text[:255] }}`,
                    json_attributes_template:`{{ {'level': value_json.checks.${c[0]}.level} | tojson }}`})]);
            });
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
            if (!(node.allowOverride==true && node.executionMode==true && !node.away)) return;
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
            if (!command.match(/^(1|set|on|auto|0|off|trigger|override|away|home)$/i)){
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
            if (node.away){
                let deg=node.health.state==='DEGRADED' ? `(${node.health.reasons.join(', ')}) ` : '';
                node.status({fill:'blue',shape:'dot',text:`${deg}Away t:${t}°C, sp:${sp}°C`});
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

            if (node.refTemp===undefined || (node.requestSp===undefined && !node.away)){
                let t=node.refTemp!==undefined ? node.refTemp : "?";
                let sp=node.requestSp!==undefined ? node.requestSp : "?";
                node.status({fill:'yellow',shape:'dot',text:`Not ready t:${t}°C, sp:${sp}°C`});
                haState(undefined, healthChanged);
                sendMqtt();
                node.inputTrigger=false;
                return;
            }

            // --- Setpoint towards the TRV ------------------------------------------------------
            const target = node.away ? node.awaySp : node.requestSp;     // what the TRV should have now
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
                    pushSetpointToTrv(target, node.away?'away':(node.inputTrigger?'schedule':'cycle'));
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

            // --- Demand towards the boiler ----------------------------------------------------
            // Away: only frost protection, the room asks for heat when it falls below the away setpoint.
            let boilerSp = (node.executionMode==false || releasesDemand()) ? node.offSp : (node.away ? node.awaySp : node.requestSp);
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
                        away:node.away
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
