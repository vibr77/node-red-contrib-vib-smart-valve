
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.82
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

        // --- 0.82 options (all minutes unless stated, 0 disables a check) -----------------------------
        this.maxSp=opt(n.maxSp,24);                         // °C ceiling for any setpoint applied or forwarded
        this.heartbeat=opt(n.heartbeat,10,true);            // re-send to the boiler at least this often
        this.sensorTimeout=opt(n.sensorTimeout,120,true);   // reference sensor silent -> FAILED
        this.trvTimeout=opt(n.trvTimeout,90,true);          // TRV silent -> FAILED (Aqara check-in ~ every 50 min)
        this.alarmDuration=opt(n.alarmDuration,60,true);    // valve alarm on for this long -> FAILED
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

        function same(a,b){
            return a!==undefined && b!==undefined && Math.abs(parseFloat(a)-parseFloat(b))<0.05;
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
            node.requestSp = savedState.requestSp;
            node.sp = savedState.sp;
            node.scheduledSp = savedState.scheduledSp;
            node.refTemp = savedState.refTemp;
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
                }
            }

            if (node.trv.alarm){
                if (node.alarmDuration>0 && now-node.trv.alarmSince>=node.alarmDuration*min) failed.push('valve_alarm');
                else degraded.push('valve_alarm');
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
                node.trv.noAck=true;
            }
            if (node.trv.noAck){
                failed.push('no_ack');
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
            [node.temperatureSensorStateTopic,node.valveSetpointStateTopic,node.valveModeStateTopic].forEach(function(t){
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
                        node.trv.pendingAck={sp:parseFloat(sp),ts:now};
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

                    if (node.trv.pendingAck && same(valveSp,node.trv.pendingAck.sp)){
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
                    else if (node.trv.pendingAck || node.trv.noAck){
                        // Waiting for (or never got) the TRV to confirm our setpoint: whatever else it
                        // reports is not a manual change, it is a TRV that has not taken the command.
                    }
                    else if (node.sp!==undefined && !same(valveSp,node.sp)){
                        if (node.allowOverride==true && node.executionMode==true){
                            // Manual change on the TRV, accepted as an override (capped). evaluate() handles it.
                            let v=clampSp(valveSp);
                            if (!same(v,node.requestSp)){
                                node.requestSp=v;
                                flgProcess=true;
                            }
                        }
                        else if (node.executionMode==true){
                            // Manual valve disabled: the TRV is out of line. Never forward it, put ours back.
                            nlog(`TRV reports ${valveSp}°C, expected ${node.sp}°C (manual valve disabled) -> re-applying`,"warn");
                            node.driftPending=true;
                            flgProcess=true;
                        }
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

        function haDiscovery(){
            if (!ha.enabled) return;
            const device={identifiers:[uid],name:`SmartValve ${node.name}`,manufacturer:'vib',model:'smart-valve',sw_version:pjson.version};
            const common={state_topic:stateTopic,availability_topic:availTopic,json_attributes_topic:stateTopic,device:device};
            const entities=[
                ['sensor','health',Object.assign({name:'Health',unique_id:uid+'_health',value_template:'{{ value_json.health }}',icon:'mdi:heart-pulse'},common)],
                ['binary_sensor','problem',Object.assign({name:'Problem',unique_id:uid+'_problem',device_class:'problem',value_template:"{{ 'ON' if value_json.health in ['FAILED','DEGRADED'] else 'OFF' }}"},common)],
                ['sensor','setpoint',Object.assign({name:'Requested setpoint',unique_id:uid+'_setpoint',device_class:'temperature',unit_of_measurement:'°C',value_template:'{{ value_json.boiler_setpoint }}'},common)],
                ['sensor','temperature',Object.assign({name:'Room temperature',unique_id:uid+'_temperature',device_class:'temperature',unit_of_measurement:'°C',value_template:'{{ value_json.temperature }}'},common)],
            ];
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
                mode:node.executionMode?'on':'off',
                group:node.groupId
            };
            const s=JSON.stringify(st);
            const cmp=JSON.stringify(Object.assign({},st,{sensor_age_min:0,trv_age_min:0}));
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
            if (node.overrideMode==true && moment().valueOf()-node.overrideStartTs>(node.overrideDuration*60000)){
                nlog("Override duration expired, back to the schedule","info");
                node.overrideMode=false;
                if (node.scheduledSp!==undefined){
                    node.requestSp=node.scheduledSp;
                    node.inputTrigger=true;          // forces the scheduled setpoint to be pushed to the TRV
                }
            }
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
            if (!command.match(/^(1|set|on|auto|0|off|trigger|override)$/i)){
                nlog('unhandled msg.payload:'+JSON.stringify(msg.payload),"debug");
                return;
            }
            command=command.toLowerCase();

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
                    if (!(node.allowOverride==true && node.executionMode==true && msg.payload.requestedBy!==undefined && msg.payload.groupId!==undefined)){
                        nlog("Command:override ignored (manual valve disabled or incomplete message)","debug");
                        return;
                    }
                    if (msg.payload.requestedBy==node.name || msg.payload.groupId!=node.groupId){
                        nlog("Command:override from itself or another group -> ignoring","debug");
                        return;
                    }
                    node.overrideStartTs=moment().valueOf();
                    node.overrideMode=true;
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
            let prefix='';
            if (node.overrideMode){
                let left=Math.max(0,Math.ceil((node.overrideStartTs+(node.overrideDuration*60000)-moment().valueOf())/60000));
                prefix=`(Manual ${left}min left) `;
            }
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

            if (node.refTemp===undefined || node.requestSp===undefined){
                let t=node.refTemp!==undefined ? node.refTemp : "?";
                let sp=node.requestSp!==undefined ? node.requestSp : "?";
                node.status({fill:'yellow',shape:'dot',text:`Not ready t:${t}°C, sp:${sp}°C`});
                haState(undefined, healthChanged);
                sendMqtt();
                node.inputTrigger=false;
                return;
            }

            // --- Setpoint towards the TRV ------------------------------------------------------
            if (node.executionMode==true){
                if (node.firstEval==true && node.inputTrigger==false){
                    // Startup: adopt the saved/known setpoint and make sure the TRV has it.
                    if (node.sp===undefined || !same(node.sp,node.requestSp) || (node.trv.lastSp!==undefined && !same(node.trv.lastSp,node.requestSp))){
                        pushSetpointToTrv(node.requestSp,'startup');
                    } else {
                        node.sp=node.requestSp;
                    }
                }
                else if (node.inputTrigger==false && node.allowOverride==true && node.firstEval==false && !same(node.sp,node.requestSp)){
                    // Manual change accepted from the TRV.
                    nlog("Manual update from the valve detected","info");
                    if (node.noOut==false){
                        node.send([{
                            topic:node.topic,
                            payload:{
                                command:"override",
                                setpoint:parseFloat(parseFloat(node.requestSp).toFixed(2)),
                                temperature:parseFloat(parseFloat(node.refTemp).toFixed(2)),
                                requestedBy:node.name,
                                groupId:node.groupId,
                                noOut:true
                            }
                        }]);
                    }
                    node.overrideMode=true;
                    node.overrideStartTs=now;
                    node.sp=node.requestSp;
                    if (node.trv.lastSp!==undefined && !same(node.trv.lastSp,node.requestSp)){
                        pushSetpointToTrv(node.requestSp,'override capped');
                    }
                }
                else if ((node.inputTrigger==true && !same(node.sp,node.requestSp)) || node.spUpdateMode=="spUpdateMode.cycle"){
                    pushSetpointToTrv(node.requestSp, node.inputTrigger?'schedule':'cycle');
                }

                if (node.driftPending==true){
                    if (node.allowOverride!=true && node.sp!==undefined && now-node.trv.lastPushTs>=60000){
                        pushSetpointToTrv(node.sp,'TRV out of line');
                    }
                    node.driftPending=false;
                }

                // Never confirmed: retry every 3 x ackTimeout so a recovered TRV gets back in line.
                if (node.trv.noAck && node.ackTimeout>0 && now-node.trv.lastPushTs>=3*node.ackTimeout*60000){
                    node.trv.pendingAck=null;
                    pushSetpointToTrv(node.requestSp,'retry');
                    node.trv.pendingAck={sp:parseFloat(node.requestSp),ts:now};
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
            let boilerSp = (node.executionMode==false || releasesDemand()) ? node.offSp : node.requestSp;
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
                        reasons:node.health.reasons
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
                let obj;
                try{
                    obj=JSON.parse(payload.toString());
                }catch(e){
                    nlog(`MQTT non-JSON payload on ${topic} ignored`,"debug");
                    return;
                }
                if (obj===null || typeof obj!=='object') return;
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
