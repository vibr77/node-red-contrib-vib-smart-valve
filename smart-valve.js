
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.80
  \ V / | || _ \   /      Date: 20251201
   \_/ |___|___/_|_\      Description: Nodered Heating Valve Management
                2025      Licence: Creative Commons
______________________
*/ 
/* TEST Env
npm install ./modulename (SmartValve / SmartBoiler / SmartSchedule)
node-red -v -D logging.console.level=trace
// Web http://localhost:1880/

Deploy to npmjs
npm publish

*/

var moment = require('moment');
const mqtt = require("mqtt");
const fs = require('fs');
const { request } = require('http');
const { group } = require('console');

module.exports = function(RED) {
   
    var path = require('path')
    var util = require('util')

    var SmartValve = function(n) {
        RED.nodes.createNode(this, n)
        this.name = n.name
        this.settings = RED.nodes.getNode(n.settings) // Get global settings
        
        this.groupId=n.groupId;                                                                         // GroupId <!> Important for the SmartBoiler, interger unique
        this.mqttSettings = RED.nodes.getNode(n.mqttSettings);                                          // MQTT connexion settings
        this.mqttstack=[]; 
        this.cycleDuration=n.cycleDuration ? parseInt(n.cycleDuration): 5;                              // duration cycle in min
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';         // Execution mode [statechange|+startup|every cycle]
                                                       
        this.allowOverride=n.allowOverride ? n.allowOverride :false;                                    // Allow Manual update from the valve // climate
        this.executionMode=true;
        this.offSp=n.offSp ? n.offSp: 5;

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

        this.t=0;                                   // Current temperature          
        this.prevSp=0;                              // Previous setpoint     
        this.sp=0;                                  // Current setpoint
        this.requestSp=undefined;                   // Requested setpoint
       
        this.inputTrigger=false;                    // Request coming from input node
        this.firstEval = true;                      // First evaluation cycle
        
        this.refTemp=undefined;                     // Reference temperature from sensor
        this.prevRefTemp=undefined;                 // Previous reference temperature from sensor  

        this.noOut=false;                        // To avoid output message when override from valve detected
        
        this.msgStormMsgCounter=0;
        this.msgStormMaxMsg=n.msgStormMaxMsg ? parseInt(n.msgStormMaxMsg): 20;
        this.debugInfo=n.debugInfo? n.debugInfo :"debug";                                                 // debug verbose to the console
        this.msgStormInterval=10000; // 10 seconde
        this.msgStormLastTs=0;
        var node = this;
        
        /*function getRandomInt(min,max) {
            return min+Math.floor(Math.random() * (max-min));
        }*/

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
                    // Also send to warn if it was previously doing so for debug visibility in sidebar
                    // The original code did node.log AND node.warn for debugInfo=true
                    if (level === "debug" || level === "info") {
                         node.warn(msg); 
                    }
                }
            }
        }

        this.ev=function(){
            node.inputTrigger=true;
            evaluate();
        }

        function subscribeMqtt(){
            let subArray=[];

            if (node.mqttclient==null || node.mqttclient.connected!=true){
                nlog("subscribeMqtt: MQTT not connected...","error");
                return;
            }
            try{
                subArray.push(node.temperatureSensorStateTopic);
                subArray.push(node.valveSetpointStateTopic);
                subArray.push(node.temperatureSensorStateTopic);
                subArray.push(node.valveModeStateTopic);
                
                node.mqttclient.subscribe(subArray, () => {
                    nlog("MQTT Subscribed to topic:"+JSON.stringify(subArray),"debug");
                })
            }catch(err){
                nlog("MQTT subscribe error:"+err.message,"error");
            }
        }

        function callbackMqtt(topic,p){
            flgProcess=false;
            if (topic==node.temperatureSensorStateTopic){

                if (p[node.temperatureSensorKey]===undefined){
                    nlog(`MQTT Invalid payload key:${node.temperatureSensorKey}, topic:${topic}`,"warn");   
                    return;
                }

                node.refTemp=p[node.temperatureSensorKey];
                nlog(`[MQTT] receive reference temperature:${node.refTemp}`,"debug");

                if (node.refTemp!=node.prevRefTemp){
                    nlog("refTemp changed -> trigger","debug");
                    flgProcess=true;
                }else{
                    nlog("no refTemp change...","debug");
                }
            }

            if (topic==node.valveSetpointStateTopic){
            
                if (p[node.valveSetpointKey]===undefined){
                    nlog(`MQTT Invalid payload key:${node.valveSetpointKey}, topic:${topic}`,"warn");
                    return;
                }

                let valveSp=p[node.valveSetpointKey];
                nlog(`[MQTT] receive valve setpoint:${valveSp}`,"debug");
                node.requestSp=valveSp;

                if (node.sp!=node.requestSp || node.requestSp!=node.prevSp){
                    nlog("flgProcess:true","debug");
                    flgProcess=true;
                }
            }
            
            if (topic==node.valveModeTopic){
                if (p[node.valveModeKey]===undefined){
                    nlog(`MQTT Invalid payload key:${node.valveModeKey}, topic:${topic}`,"warn");
                    return;
                }
                let mode=p[node.valveModeKey];
                nlog(`[MQTT] receive valve mode:${mode}`,"debug");

                if (mode.match(/^(heat|1|on)$/i)){
                    if (node.executionMode==false){
                        nlog("MQTT valve mode changed to ON -> trigger","debug");
                        node.executionMode=true;
                        flgProcess=true;
                    }else{
                        nlog("no executionMode change...","debug");
                    }
                }else if (mode.match(/^(0|off)$/i)){
                    if (node.executionMode==true){
                        nlog("MQTT valve mode changed to OFF -> trigger","debug");
                        node.executionMode=false;
                        flgProcess=true;
                    }else{
                        nlog("no executionMode change...","debug");
                    }
                }   
            }

            if (flgProcess==true){
                nlog("flgProcess sp/refTemp changed-> trigger evaluate();","debug");
                evaluate();
                flgProcess=false;
            }else{
                nlog("no trigger...")
            }   
        }

        function sendMqtt(){
            
            if (node.mqttclient==null || node.mqttclient.connected!=true){
                node.warn("sendMqtt: MQTT not connected...");
                return;
            }

            let msg=node.mqttstack.shift();
            
            while (msg!==undefined){
                nlog('MQTT-> msg dequeueing',"debug");
               
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
            if (command !==undefined && command.match(/^(1|set|on|0|off|trigger|override)$/i)) {
                
                if (command == '1' || command== 'trigger' || command == 'on' || command == 'set' || command=='override'){
                    
                    if (command=='on'){
                        node.executionMode=true;
                    }

                    else if (command=='trigger' || command=='1'){
                        
                    }

                    else if (command=='set' || command=='override'){

                        if (command=="set" && msg.payload.setpoint=== undefined || isNaN(msg.payload.setpoint) || parseFloat(msg.payload.setpoint)<0 || parseFloat(msg.payload.setpoint)>40){ //<----------- Todo define Max & Min in config
                            nlog('received trigger missing or invalid msg.sp number',"error");
                            return;
                        }

                        if (command=="override" && node.allowOverride==true && node.executionMode==true && msg.payload.requestedBy!==undefined && msg.payload.groupId!==undefined){
                            if (msg.payload.requestedBy!=node.name && msg.payload.groupId==node.groupId){
                                nlog("Command:override, requestedBy:"+msg.payload.requestedBy+" != node.name:"+node.name+" -> process override","debug")
                            }else{
                                nlog("Command:override, requestedBy:"+msg.payload.requestedBy+" == node.name:"+node.name+" || node.groupId!="+msg.payload.groupId+" -> ignoring own override","debug")
                                return;
                            }
                        }

                        else if (command=="override"){
                            nlog("Command:override  -> ignoring msg.payload:"+JSON.stringify(msg.payload),"debug")

                            return;
                        }

                        if (msg.payload.temperature=== undefined || isNaN(msg.payload.temperature) || parseFloat(msg.payload.temperature)<0 || parseFloat(msg.payload.temperature)>40){
                            
                        }else{
                            node.refTemp=parseFloat(msg.payload.temperature).toFixed(2);
                        }

                        node.requestSp=parseFloat(msg.payload.setpoint).toFixed(2);
                       
                    }

                    if (msg.payload.noOut===true) {
                        node.noOut=true;
                    }
                    
                }else if(command=="0" || command=='off'){
                    nlog(`Command:${command}, set smart-valve off`,"debug");
                    node.executionMode=false;     
                }
                
                node.inputTrigger = true;
                nlog("msg:"+JSON.stringify(msg.payload),"debug");

                nlog(`Command:${command}, sp:${node.requestSp}, noOut:${node.noOut},inputTrigger:${node.inputTrigger}, executionMode:${node.executionMode}`,"debug");
                                                       
                evaluate();

            } else 
                nlog('evaluate(): unhandled msg.payload:'+JSON(msg.payload),"debug");
        });

        function evaluate() {

            nlog(`evaluate(): node.inputTrigger:${node.inputTrigger} node.firstEval:${node.firstEval} node.refTemp:${node.refTemp} node.requestSp:${node.requestSp} node.prevSp:${node.prevSp} allowOverride:${node.allowOverride}`,"debug");
            
            node.msgStormMsgCounter+=1;

            if (moment().diff(node.msgStormLastTs)>node.msgStormInterval){
                node.msgStormMsgCounter=1;
            }
            node.msgStormLastTs=moment();

            if (node.msgStormMsgCounter>node.msgStormMaxMsg){
                nlog(`evaluate(): <!> Message storm detected: ${node.msgStormMsgCounter} messages within ${node.msgStormInterval/1000}s, evaluate() aborted!`,"error");
                return;
            }
        
            if (node.refTemp===undefined || node.requestSp===undefined /*|| node.sp===undefined*/){
                nlog("evaluate(): node.refTemp or node.requestSp is undefined returning","debug");
                let t=node.refTemp!==undefined ? node.refTemp : "?";
                let sp=node.requestSp!==undefined ? node.requestSp : "?";

                node.status({
                    fill: 'yellow',
                    shape:'dot',
                    text:("Not ready t:"+t+"°C, sp:"+sp+"°C")
                });

                return;

            }else{
                if (parseFloat(node.refTemp)>=parseFloat(node.requestSp)){
                    node.status({
                        fill:  'green',
                        shape: 'dot',
                        text:("idle t:"+node.refTemp+"°C, sp:"+node.requestSp+"°C")
                    });
                }else{
                    node.status({
                        fill:  'red',
                        shape: 'dot',
                        text:("Heat t:"+node.refTemp+"°C, sp:"+node.requestSp+"°C")
                    });
                }
            }

            if (node.executionMode==false){                             // <--- Put default temperature mode
                
                if (isNaN(node.offSp) || parseFloat(node.offSp) < 0 || parseFloat(node.offSp) > 40) {
                    nlog("evaluate(): Invalid offSp value, setting to default 5°C", "warn");
                    node.offSp = 5;
                }

                let msg={};
                msg.payload={
                    command:"set",
                    topic: node.topic,
                    setpoint:node.offSp,
                    temperature:node.refTemp,
                    requestedBy:node.name,
                    groupId:node.groupId
                }
                                                                // <-- Send a Remove command to boiler when off 
                nlog("evaluate(): Output set payload:"+JSON.stringify(msg),"debug");
                node.send(msg);

                let t=node.refTemp!==undefined ? node.refTemp : "?";
                let sp=node.offSp!==undefined ? node.offSp : "?";
                node.status({
                    fill:  'gray',
                    shape: 'dot',
                    text:("Off t:"+t+"°C, sp:"+sp+"°C")
                });

                return;
            }
              
            // First evaluation
            // set default values to node

            if(node.firstEval == true && node.inputTrigger==false){
                    
                node.sp=node.requestSp;

            }
            
            // Manual updated detected
            // inputTrigger== false: request is not coming from input node but from MQTT,
            // allowOverride== true: we accept manual update on the valve

            else if (node.inputTrigger == false && 
                        node.sp!=node.requestSp && 
                        node.firstEval == false && 
                        node.allowOverride==true){
                    
                nlog("evaluate(): Manual update from the valve detected","debug");
                if (node.noOut==false){
                    let msg={
                        topic:node.topic,
                        payload:{
                            command:"override",
                            setpoint:node.requestSp,
                            temperature:node.refTemp,
                            requestedBy:node.name,
                            groupId:node.groupId,
                            noOut:true
                        }
                    }

                    nlog("evaluate(): Output override payload:"+JSON.stringify(msg),"debug");
                    node.send([msg]);
                }
        
                node.status({
                    fill:  'yellow',
                    shape: 'dot',
                    text:("Manual, t:"+node.refTemp+"°C, sp:"+node.requestSp+"°C")
                }); 
            }
            
            // Update from the input node
            // action is to update the valve by sending a MQTT message

            else if (node.firstEval== true || 
                (node.inputTrigger == true && node.sp!=node.requestSp) || 
                node.spUpdateMode=="spUpdateMode.cycle"){
                    
                if ( node.valveSetpointSetTopic!=undefined && node.valveSetpointSetTopic!=""){
                    let mqttmsg={topic:node.valveSetpointSetTopic,payload:parseFloat(node.requestSp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                }
                node.sp=node.requestSp;            
            }

            // Update of the external valve temperature topic
            if (node.valveTemperatureSetTopic === null || node.valveTemperatureSetTopic === "") {
                nlog("evaluate(): <!>valveTemperatureSetTopic is null or empty skipping","warn");
                return;
            }else{
                if (node.refTemp!=undefined && node.prevRefTemp!=node.refTemp){
                    nlog("evaluate(): MQTT valve external_temp:"+node.refTemp,"debug");

                    let mqttmsg={topic:node.valveTemperatureSetTopic,payload:parseFloat(node.refTemp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    if (node.valveTemperatureSensorTypeSetTopic!=undefined && node.valveTemperatureSensorTypeSetTopic!=""){
                        nlog("evaluate(): MQTT temperature sensor type:"+node.valveTemperatureSensorTypePayload,"debug");
                        let mqttmsgType={topic:node.valveTemperatureSensorTypeSetTopic,payload:node.valveTemperatureSensorTypePayload,qos:0,retain:false};
                        node.mqttstack.push(mqttmsgType);
                    }
                    
                }else{
                    nlog("evaluate(): no update","debug");
                }
            }

            // Send to Boiler if needed
            if (node.refTemp!=node.prevRefTemp || node.requestSp!=node.prevSp || node.firstEval==true){
                if (node.noOut==false){
                    let msg={};
                    msg.payload={
                        command:"set",
                        setpoint:node.requestSp,
                        temperature:node.refTemp,
                        requestedBy:node.name,
                        groupId:node.groupId
                    }

                    node.send([msg]);
                    nlog("evaluate(): Output set payload:"+JSON.stringify(msg),"debug");
                }

                node.prevRefTemp=node.refTemp;
                node.prevSp=node.requestSp;

            }else{
                nlog("evaluate(): no output to boiler","debug");
            }
        
            // At the very end we flush MQTT messages
            
            sendMqtt();

            node.firstEval=false;
            node.inputTrigger=false;
            node.noOut=false;
        }       

        
        if ( node.mqttSettings && node.mqttSettings.mqttHost){
            
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
            nlog("MQTT closing connexion");
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
