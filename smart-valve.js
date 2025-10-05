
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.72
  \ V / | || _ \   /      Date: 20230930
   \_/ |___|___/_|_\      Description: Nodered Heating Valve Management
                2023      Licence: Creative Commons
______________________
*/ 

// Install npm install ./modulename (SmartValve / SmartBoiler / SmartSchedule)
// Terminal command:  node-red -v -D logging.console.level=trace
// to push to npmjs
// npm publish


// Web http://localhost:1880/

var moment = require('moment');
const mqtt = require("mqtt");
const fs = require('fs');

module.exports = function(RED) {
   
    var path = require('path')
    var util = require('util')

    var SmartValve = function(n) {
        RED.nodes.createNode(this, n)
        this.name = n.name
        this.settings = RED.nodes.getNode(n.settings) // Get global settings
        var global = this.context().global;
        
        this.topic = n.topic;
        this.groupId=n.groupId;                                                                         // GroupId <!> Important for the SmartBoiler, interger unique
        this.climates = n.climates;                                                                     // Array of climate entities to be manages
        this.tempEntity=n.tempEntity ? n.tempEntity : '';                                               // Reference Temperture entity
        this.tempEntityTopic=n.tempEntityTopic ? n.tempEntityTopic : '';
        this.mqttSettings = RED.nodes.getNode(n.mqttSettings);                                          // MQTT connexion settings
        this.mqttstack=[]; 
        this.cycleDuration=n.cycleDuration ? parseInt(n.cycleDuration): 5;                              // duration cycle in min
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';         // Execution mode [statechange|+startup|every cycle]
        this.adjustValveTempMode=n.adjustValveTempMode ? n.adjustValveTempMode : 'adjustValveTempMode.noAdjust';
        this.debugInfo=n.debugInfo? n.debugInfo :false;                                                 // debug verbose to the console
        this.allowOverride=n.allowOverride ? n.allowOverride :false;                                    // Allow Manual update from the valve // climate
        this.executionMode=true;
        this.offSp=n.offSp ? n.offSp: 5;

        this.prevSp=0;
        
        this.prevRequestSp=undefined;
        this.requestSp=undefined;
        
        this.firstEval = true;
        this.valveManualSpUpdate=false;
        this.valveManualSp=0;
        this.startTs=0;
        this.refTemp=undefined;
        this.prevRefTemp=undefined;

        this.lastInputTs=0;
        this.mqttDiscardMessageLastInputDuration=15; // Mqtt Message will be discarded within x s duration after last input sp message (it is to avoid ping pong)
        this.lastInputSp=0;
        var node = this;

        node.previousRefTemp=0;
        node.previousSp=0;
        node.lastCycleTs=0;

        node.manualTrigger=false;
        function getRandomInt(min,max) {
            return min+Math.floor(Math.random() * (max-min));
        }
        function nlog(msg){
            if (node.debugInfo==true){
                node.log(msg);
            }
        }

        this.ev=function(){
            node.manualTrigger=true;
            evaluate();
        }
        function flushDataToFS(){
            let fs_name="data_"+node.id;
            let data={};

            data.climates=node.climates;
            data.requestSp=node.requestSp;
            data.prevRequestSp=node.prevRequestSp;
            data.refTemp=node.refTemp;

            fs.writeFile(fs_name, JSON.stringify(data), (err) => {
                if (err) throw err;
               });
        }

        function loadDataFromFs(){
            let fs_name="data_"+node.id;
            fs.readFile(fs_name, (err, inputD) => {
                if (err){
                    nlog("unable to open file:"+fs_name);
                    return;
                };

                let data={};
                try {
                    data=JSON.parse(inputD.toString());
                    //JSON.parse(inputD.toString());
                } catch (e) {
                
                } 

                if (data.requestSp!=undefined){
                    node.requestSp=data.requestSp;
                }

                if (data.prevRequestSp!=undefined){
                    node.prevRequestSp=data.prevRequestSp;
                }

                if (data.refTemp!=undefined){
                    node.refTemp=data.refTemp;
                }
                 
                if (data.climates!=undefined){
                    node.climates.forEach((climate) => {
                        data.climates.forEach((dclimate)=>{
                            if (climate.entityTopic==dclimate.entityTopic){
                                climate.sp=dclimate.sp;
                                climate.t=dclimate.t;
                                nlog("****************YESSSSS  **************************");
                            }
                        });
                    });
                }
            });
        }

        function unlinkFs(){
            let fs_name="data_"+node.id;
            fs.unlinkSync(fs_name);
        }

        function subscribeMqtt(){
            let subArray=[];

            if (node.mqttclient==null || node.mqttclient.connected!=true){
                node.warn("subscribeMqtt: MQTT not connected...");
                return;
            }
            if (node.tempEntityTopic!=undefined && node.tempEntityTopic!=""){
                subArray.push(node.tempEntityTopic);
            }

            node.climates.forEach((climate) => {
                nlog("climateEntityTopic:"+climate.entityTopic);
                if (climate!=undefined && climate.entityTopic!=undefined && climate.entityTopic!=""){
                    subArray.push(climate.entityTopic);
                }
            });

            node.mqttclient.subscribe(subArray, () => {
                nlog("MQTT Subscribed to topic:");
                nlog("  "+JSON.stringify(subArray));
            })
        }

        function callbackMqtt(topic,p){

            if (topic==node.tempEntityTopic){
                nlog("   set mqtt refTemp:"+p.temperature);
                node.refTemp=p.temperature;
                if (node.refTemp!=node.refTemp){
                    evaluate();
                    node.prevRefTemp=node.refTemp;
                }
                
                return;
            }else{
                let bTriggerProcess=false;
                for ( climate of node.climates) {
                
                    if(climate!=undefined && climate.entityTopic!=undefined && climate.entityTopic==topic){
                        nlog("   Match");
                        nlog("   climate.entityTopic:"+climate.entityTopic);
                        nlog("   topic:"+topic);
                        nlog("   set mqtt climate prop:"+climate.entity);
                        
                        climate.lastSeen=moment();           //  hum p.last_seen;
                        climate.sp=p.occupied_heating_setpoint;
                        climate.t=p.local_temperature;

                        if (node.refTemp===undefined){
                            node.refTemp=p.local_temperature;
                            nlog("   set node.reftemp:"+p.local_temperature);
                            nlog("   bTriggerProcess:true");
                            bTriggerProcess=true;
                        }

                        if (node.requestSp===undefined){
                            node.requestSp=p.occupied_heating_setpoint;
                            nlog("   set node.requestSp:"+p.occupied_heating_setpoint);
                            nlog("   bTriggerProcess:true");
                            bTriggerProcess=true;
                        }

                        if (climate.sp!=node.requestSp && climate.sp!=node.prevRequestSp){
                            nlog("   climate.sp!=node.requestSp");
                            nlog("   climate.sp:"+climate.sp+" <> node.requestSp:"+node.requestSp);
                            nlog("   climate.sp:"+climate.sp+" <> node.prevRequestSp:"+node.prevRequestSp);
                            
                            let now = moment();
                            let diff=now.diff(node.lastInputTs)/1000;

                            nlog("  lastInputTs Elapsed:"+diff);
                            if (diff>node.mqttDiscardMessageLastInputDuration){
                                nlog("  mqttDiscardMessageLastInputDuration:"+node.mqttDiscardMessageLastInputDuration);
                                nlog("   bTriggerProcess:true");
                                bTriggerProcess=true;
                            }else{
                                nlog("   bTriggerProcess:false");
                            }
                        }
                        break;;
                    }
                }

                if (bTriggerProcess==true){
                    nlog("   bTriggerProces sp changed-> trigger evaluate();");
                    evaluate();
                    bTriggerProcess=false;
                }else{
                    nlog("   no trigger...")
                }
            } 
        }

        function sendMqtt(){
            
            if (node.mqttclient==null || node.mqttclient.connected!=true){
                node.warn("sendMqtt: MQTT not connected...");
                return;
            }

            let msg=node.mqttstack.shift();
            
            while (msg!==undefined){
                nlog('MQTT-> msg dequeueing');
               
                if (msg.topic===undefined || msg.payload===undefined)
                    return;
                let msgstr=JSON.stringify(msg.payload).replace(/\\"/g, '"');
                node.mqttclient.publish(msg.topic.toString(),msgstr,{ qos: msg.qos, retain: msg.retain },(error) => {
                    if (error) {
                        node.error("mqtt error: "+error)
                    }
                });
                msg=node.mqttstack.shift(); 
            }
        };

        node.on('input', function(msg) {
            if (msg===undefined || msg.payload===undefined){
                node.warn("invalid input returning");
                return;
            }

            let command=msg.payload.command;
            if (command !==undefined && command.match(/^(1|set|on|0|off|trigger)$/i)) {
                
                if (command == '1' || command== 'trigger' || command == 'on' || command == 'set'){
                    
                    if (command=='on'){
                        node.executionMode=true;
                        evaluate();
                        return;
                    }

                    if (node.executionMode==false){
                        evaluate();
                        return;
                    }
                        
                    if (msg.payload.setpoint=== undefined || isNaN(msg.payload.setpoint) || parseFloat(msg.payload.setpoint)<0 || parseFloat(msg.payload.setpoint)>35){ //<----------- Todo define Max & Min in config
                        node.warn('received trigger missing or invalid msg.sp number');
                        return;
                    }

                    node.manualTrigger = true;
                    node.prevRequestSp=node.requestSp;
                    node.requestSp=parseFloat(msg.payload.setpoint).toFixed(2);

                    nlog("incoming request sp:"+node.requestSp);

                    node.lastInputTs=moment();
                    this.lastInputSp=node.requestSp;
                    
                    node.executionMode=true;
                    evaluate();
                }else if(command=="0"|| command=='off'){
                    nlog("set smart-valve off")
                    node.executionMode=false;
                    evaluate();
                }

            } else node.warn('Failed to interpret incoming msg.payload. Ignoring it!')
        });

        function evaluate() {

            /* Evaluation process to trigger action
            //  -> Phase 1 : check if a manual update occured directly on the valve
                -> Phahse 2a If yes then:
                  phase2_ManualUpdate(); -> update all the valve with the new value
                -> Phahse 2b If no Then:
                  phase2_UpdateValve(); -> update the valve with the last node.requestSp
       
                -> Phase 3 phase3_UpdateExtTemperature() -> update the external temp value on the TRV
                -> Phase 4 phase4_UpdateBoiler() -> update the boiler
                -> Phase 5 flushDataToFS -> save current data
            */

            
            nlog("---------------------------------------");
            nlog("Evaluate() new cycle");
            nlog("---------------------------------------");
            nlog("   node.manualTrigger:"+node.manualTrigger);
            nlog("   node.firstEval:"+node.firstEval);
            nlog("   node.refTemp:"+node.refTemp);
            nlog("   node.requestSp:"+node.requestSp);
            nlog("   allowOverride:"+node.allowOverride);

            let now = moment();                                             // <-------- 60 s is needed for Home assistant to update
            let diff=now.diff(node.lastCycleTs)/1000;

            nlog("   lastCycleTs elapsed:"+diff);
            if (diff<10){                                                   // <----------to avoid ping pong party
                nlog("   lastCycle elapsed too short < 10s returning");
                return;
            }

            node.lastCycleTs=moment(); // to avoid ping pong party

            if (node.refTemp===undefined || node.requestSp===undefined){
                nlog("   <!> evaluate(): node.refTemp or node.requestSp is undefined returning");
                node.status({
                    fill:  'yellow',
                    shape: 'dot',
                    text:("Unavailable sp: "+node.requestSp+"°C, temp: "+node.refTemp+"°C")
                });
                // Change 1 parameters to the valve to trigger full update
                // Warning: to be fixed cause a little bit dirty
                if (node.climates[0]!=undefined && node.climates[0].entityTopic!=undefined && node.climates[0].entityTopic!=""){
                    let rndInt=getRandomInt(-10,10);
                    nlog("  away_preset_temperature updating with random int:"+rndInt)
                    let mqttmsg={topic:node.climates[0].entityTopic+"/set/away_preset_temperature",payload:rndInt.toString(),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    sendMqtt();
               }
                return;
            }else{
                if (/*Math.round(*/parseFloat(node.refTemp)/*)*/>parseFloat(node.requestSp)){
                    node.status({
                        fill:  'green',
                        shape: 'dot',
                        text:("temp: "+/*Math.round(*/node.refTemp/*)*/+"°C, sp: "+node.requestSp+"°C")
                    });
                }else{
                    node.status({
                        fill:  'red',
                        shape: 'dot',
                        text:("temp: "+/*Math.round(*/node.refTemp/*)*/+"°C, sp: "+node.requestSp+"°C")
                    });
                }
            }

            if (node.executionMode==false){                             // <--- Put default temperature mode
                nlog("<!> smart-valve is off returning");
                node.climates.forEach((climate) => {

                    let msg={};
                    msg.payload={
                        topic: node.topic,
                        domain:"climate",
                        service:"set_temperature",
                        target:{
                            entity_id:[
                                climate.entity
                            ]
                        },
                        data:{
                            temperature:node.offSp //  We update all valve with the same Manual SP
                        }
                    };
                    node.send([msg,null]);
                });

                let msg={};
                msg.payload={
                    command:"set",
                    topic: node.topic,
                    setpoint:node.offSp,
                    temperature:node.refTemp,
                    name:node.name,
                    groupid:node.groupId
                }
                                                                // <-- Send a Remove command to boiler when off 
                nlog("output to boiler:");
                nlog(JSON.stringify(msg));

                node.send([null,msg]);

                node.status({
                    fill:  'gray',
                    shape: 'dot',
                    text:("Off sp: "+node.offSp+"°C, temp: "+node.refTemp+"°C")
                });

                return;
            }
            
            phase1_Check();
            phase1_CheckLastSeen();
    
            if(node.valveManualSpUpdate==true && node.allowOverride==true){             // There is a ManualUpdate directly on the valve, update all valve
                phase2_ManualUpdate();
                
            }else{  // No Manual Update we can proceed to check if 
                phase2_UpdateValve();
            }
    
            phase3_UpdateExtTemperature();
            phase4_UpdateBoiler();
    
            node.firstEval = false;
            flushDataToFS();
            
        }

        function phase1_CheckLastSeen(){

        }

        function phase1_Check(){
            nlog("---------------------------------------");
            nlog("Phase 1 - Check for Manual update on TRV");
            nlog("---------------------------------------");
            //node.climates.forEach((climate) => {                            // Check if Manual update occured on one of the valve
            for ( climate of node.climates) {
                if (climate.sp === undefined ) {
                    node.warn("<!> climate.sp is null or empty skipping");
                    return;
                }
                 
                nlog("-->"+climate.entity);
                nlog("   Phase 1 climate.sp:"+climate.sp);
                nlog("   Phase 1 node.requestSp:"+node.requestSp);
                nlog("   Phase 1 node.firstEval:"+node.firstEval);
                nlog("   Phase 1 node.allowOverride:"+node.allowOverride);
                nlog("   Phase 1 node.manualTrigger:"+node.manualTrigger);

                if(node.firstEval == true && node.manualTrigger==false){
                    // At startup node.requestSp==0; 
                    // we should assign the existing sp to node.requestSP
                    // If Smart-scheduler is wire as input node.manualTriger will be true
    
                    nlog("   Phase 1 first Eval node.reqestSp=climate.sp");
                    node.requestSp=climate.sp;
                }else if (node.manualTrigger == false && climate.sp!=node.requestSp && node.firstEval == false && node.allowOverride==true){
                    
                    /*let now = moment();                                             // <-------- 60 s is needed for Home assistant to update
                    let diff=now.diff(node.startTs)/1000;

                    nlog("   Phase 1 diff startTs:"+diff);
                    if (diff<60){
                        nlog("   Phase 1 node.startTs < 60s returning");
                        return;
                    }*/

                    let now = moment();                                             // <-------- 60 s is needed for Home assistant to update
                    let diff=now.diff(node.lastSeen)/1000;
                    if (diff>120){
                        nlog("   Phase 1 !!! STRANGE !!! device is asleep for more than 2 min and still sending update ");
                        nlog("   Phase 1 !!! STRANGE !!! device is not considered");
                        nlog("   Phase 1 !!! STRANGE !!! Continue the loop");
                        continue;
                    }
    
                    nlog("   Phase 1 manual update from the valve detected");
                    node.valveManualSp=climate.sp;
                    node.valveManualSpUpdate=true;

                    nlog("   Phase 1 node.valveManualSp:"+node.valveManualSp);
                    
                    // Add 02/01/24
                    nlog("   Phase 1 update lastInputTs (manual update is compare to input to avoid ping pong)")
                    node.lastInputTs=moment();

                    nlog ("   Phase 1 returning before the end of the loop as manual update found")
                    break;
                }
            }//);
            nlog("---------------------------------------");
            nlog("End of Phase 1");
            nlog("---------------------------------------\n");
        }

        function phase2_ManualUpdate(){

            nlog("---------------------------------------");
            nlog("Phase 2a phase2_ManualUpdate()");
            nlog("---------------------------------------");

            nlog("   Phase 2 set node.prevSp=node.requestSp:"+node.requestSp);
            nlog("   Phase 2 set node.requestSp=node.valveManualSp:"+node.valveManualSp);
            
            node.prevRequestSp=node.requestSp;
            node.requestSp=node.valveManualSp;
            
            for ( climate of node.climates) {
            //node.climates.forEach((climate) => {

                let msg={};
                msg.payload={
                    topic: node.topic,
                    domain:"climate",
                    service:"set_temperature",
                    target:{
                        entity_id:[
                            climate.entity
                        ]
                    },
                    data:{
                        temperature:node.valveManualSp //  We update all valve with the same Manual SP
                    }
                };
                // 02/01/24 Everything by Mqtt for more simplicity
                //node.send([msg,null]);

                if (node.mqttUpdates==true && climate.valveSpTopic!=undefined && climate.valveSpTopic!=""){
                    let mqttmsg={topic:climate.valveSpTopic,payload:parseFloat(node.valveManualSp),qos:0,retain:false};
                    node.warn(JSON.stringify(mqttmsg));
                    node.mqttstack.push(mqttmsg);
                }
            }//);
            sendMqtt();
            
            node.valveManualSpUpdate=false;
            
            let msg={
                topic:node.topic,
                payload:{
                    command:"override",
                    setpoint:node.valveManualSp,
                    noout:true
                }
            }
    
            node.send([null,msg]);
        
            node.status({
                fill:  'yellow',
                shape: 'dot',
                text:("Manual override sp: "+node.valveManualSp+"°C, temp: "+node.refTemp+"°C")
            }); 
            
            nlog("---------------------------------------");
            nlog("End of Phase 2a");
            nlog("---------------------------------------\n");
        }

        function phase2_UpdateValve(){
            nlog("---------------------------------------");
            nlog("Phase 2b phase2_UpdateValve()");
            nlog("---------------------------------------");
            for ( climate of node.climates) {
            //node.climates.forEach((climate) => {
            
                if (climate.entity === null || climate.entity === "") {
                    node.warn("Phase 2 climate.entity is null or empty skipping");
                    return;
                }

                nlog("-->Phase 2:"+climate.entity);
                nlog("   node.firstEval:"+node.firstEval);
                nlog("   node.manualTrigger:"+node.manualTrigger);
                nlog("   node.spUpdateMode:"+node.spUpdateMode);
                nlog("   climate.sp:"+climate.sp);
                nlog("   node.requestSp:"+node.requestSp);

                if (climate.sp==undefined){
                    node.warn("Phase 2 climate.sp is null or empty skipping");
                    return;
                }

                if (node.firstEval== true || (node.manualTrigger == true && climate.sp!=node.requestSp) || node.spUpdateMode=="spUpdateMode.cycle"){
                    nlog("   condition:");
                    nlog("     climate.sp:"+climate.sp);
                    nlog("     node.requestSp:"+node.requestSp);
                    nlog("     node.firstEval:"+node.firstEval);
                    nlog("     node.manualTrigger:"+node.manualTrigger);
                    nlog("     node.spUpdateMode:"+node.spUpdateMode);

                    
                    
                    /*
                    let msg={};
                    msg.payload={
                        topic: node.topic,
                        domain:"climate",
                        service:"set_temperature",
                        target:{
                            entity_id:[
                                climate.entity
                            ]
                        },
                        data:{
                            temperature:node.requestSp
                        }
                    };
                    */

                    climate.lastRequestSp=moment();             // we store last updateTS 
                    //nlog("      Output msg:"+JSON.stringify(msg));
                    
                    // 02/01/24 Everything by Mqtt for more simplicity
                    //node.send([msg,null]);

                    if (node.mqttUpdates==true && climate.valveSpTopic!=undefined && climate.valveSpTopic!=""){
                        nlog("     send MQTT update");
                        let mqttmsg={topic:climate.valveSpTopic,payload:parseFloat(node.requestSp),qos:0,retain:false};
                        node.mqttstack.push(mqttmsg);
                    }
                }
            }//);

            sendMqtt();

            // Update the status in UI
            if (/*Math.round(*/parseFloat(node.refTemp)/*)*/>parseFloat(node.requestSp)){
                node.status({
                    fill:  'green',
                    shape: 'dot',
                    text:("temp: "+/*Math.round(*/node.refTemp/*)*/+"°C, sp: "+node.requestSp+"°C")
                });
            }else{
                node.status({
                    fill:  'red',
                    shape: 'dot',
                    text:("temp: "+/*Math.round(*/node.refTemp/*)*/+"°C, sp: "+node.requestSp+"°C")
                });
            }
    
            node.manualTrigger = false;
            nlog("---------------------------------------");
            nlog("End of Phase 2b");
            nlog("---------------------------------------\n");
        }

        function phase3_UpdateExtTemperature(){
            nlog("---------------------------------------");
            nlog("Phase 3 phase3_UpdateExtTemperature()");
            nlog("---------------------------------------");
            node.climates.forEach((climate) => {
                nlog("-->Phase 3: phase3_UpdateExtTemperature():"+climate.entity);
                if (climate.valveExtTempTopic === null || climate.valveExtTempTopic === "") {
                    node.warn("   <!>climate.valveExtTempTopic is null or empty skipping");
                    return;
                }
                
                if (node.mqttUpdates==true && node.refTemp!=undefined && climate.t!=node.refTemp){
                    nlog("   Update mqtt valve external_temp:"+node.refTemp);

                    let mqttmsg={topic:climate.valveExtTempTopic,payload:parseFloat(node.refTemp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:climate.entityTopic+"/set/sensor",payload:"external",qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                }else{
                    nlog("   No update needed...");
                }
            });
            sendMqtt();
            nlog("---------------------------------------");
            nlog("End of Phase 3");
            nlog("---------------------------------------\n");
        }

        function phase4_UpdateBoiler(){

            nlog("---------------------------------------");
            nlog("Phase 4 phase4_UpdateBoiler()");
            nlog("---------------------------------------");

            
            if (node.refTemp!=node.previousRefTemp || node.requestSp!=node.previousSp || node.firstEval==true){

                let msg={};
                msg.payload={
                    command:"set",
                    topic: node.topic,
                    setpoint:node.requestSp,
                    temperature:node.refTemp,
                    name:node.name,
                    groupid:node.groupId
                }

                node.send([null,msg]);

                nlog("  sp:"+node.requestSp);
                nlog("  temp:"+node.refTemp);
                nlog("  name:"+node.name);
                nlog("  id:"+node.groupId);

                node.previousRefTemp=node.refTemp;
                node.prevSp=node.requestSp;

            }else{
                nlog("  no update...");
            }
            nlog("---------------------------------------");
            nlog("End of Phase 4");
            nlog("---------------------------------------\n");
        }

        node.startTs=moment();
        node.warn("<!> nodeid:"+node.id);
        //unlinkFs();
        loadDataFromFs();
        
        node.mqttUpdates=true;
        if (node.mqttUpdates==true && node.mqttSettings && node.mqttSettings.mqttHost){
            
            const protocol = 'mqtt'
            const host = node.mqttSettings.mqttHost
            const port = node.mqttSettings.mqttPort
            const clientId=`smb_${Math.random().toString(16).slice(3)}`;
            const connectUrl = `${protocol}://${host}:${port}`
           
            node.mqttclient = mqtt.connect(connectUrl, {
                clientId,
                clean: true,
                keepalive:60,
                connectTimeout: 40000,
                username: node.mqttSettings.mqttUser,
                password: node.mqttSettings.mqttPassword,
                reconnectPeriod: 10000,
            });

            node.mqttclient.on('error', function (error) {
                node.warn("MQTT error: "+error);
            });
        
            node.mqttclient.on('connect', () => {
                subscribeMqtt();
                sendMqtt();
            });

            node.mqttclient.on('message', (topic, payload) => {
                let p=payload.toString();
                
                node.log('MQTT msg received topic:'+topic);
                callbackMqtt(topic,JSON.parse(p));
            });
        }

        node.evalInterval = setInterval(evaluate, parseInt(node.cycleDuration)*60000)

        // Run initially directly after start / deploy.
        if (node.triggerMode != 'triggerMode.statechange') {
            setTimeout(evaluate, 1000)
        }

        node.on('close', function() {
            nlog("closing connexion");
            node.log('MQTT disconnecting');
            clearInterval(node.evalInterval);
            node.mqttclient.end();
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
