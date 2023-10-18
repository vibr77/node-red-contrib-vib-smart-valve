
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.62
  \ V / | || _ \   /      Date: 20230930
   \_/ |___|___/_|_\      Description: Nodered Heating Valve Management
                2023      Licence: Creative Commons
______________________
*/ 

var moment = require('moment'); // require

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
        
        this.cycleDuration=n.cycleDuration ? parseInt(n.cycleDuration): 5;                              // duration cycle in min
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';         // Execution mode [statechange|+startup|every cycle]
        this.adjustValveTempMode=n.adjustValveTempMode ? n.adjustValveTempMode : 'adjustValveTempMode.noAdjust';
        this.adjustThreshold=n.adjustThreshold ? parseFloat(n.adjustThreshold) : 1;
        this.debugInfo=n.debugInfo? n.debugInfo :false;                                                 // debug verbose to the console
        this.allowOverride=n.allowOverride ? n.allowOverride :false;                                    // Allow Manual update from the valve // climate
        this.executionMode=true;

        this.prevSp=0;
        this.requestSp=0;
        this.firstEval = true;
        this.valveManualSpUpdate=false;
        this.valveManualSp=0;
        this.startTs=0;

        var node = this;

        node.previousRefTemp=0;
        node.previousSp=0;

        node.manualTrigger=false;

        function nlog(msg){
            if (node.debugInfo==true){
                node.log(msg);
            }
        }

        this.ev=function(){
            node.manualTrigger=true;
            evaluate();
        }

        node.on('input', function(msg) {
            if (msg===undefined || msg.payload===undefined){
                node.warn("invaid input returning");
                return;
            }

            let command=msg.payload.command;
            if (command !==undefined && command.match(/^(1|set|on|0|off|trigger)$/i)) {
                
                if (command == '1' || command== 'trigger' || command == 'on' || command == 'set'){
                    
                    if (msg.payload.setpoint=== undefined || isNaN(msg.payload.setpoint) || parseFloat(msg.payload.setpoint)<0 || parseFloat(msg.payload.setpoint)>35){ //<----------- Todo define Max & Min in config
                        node.warn('received trigger missing or invalid msg.sp number');
                        return;
                    }

                    node.manualTrigger = true;
                    node.requestSp=parseFloat(msg.payload.setpoint).toFixed(2);
                    nlog("incoming request sp:"+node.requestSp);
                    node.executionMode=true;
                    evaluate();
                }else if(command=="0"|| command=='off'){
                    nlog("set smart-valve off")
                    node.executionMode=false;
                }

            } else node.warn('Failed to interpret incoming msg.payload. Ignoring it!')
        });

        function evaluate() {
            
            if (node.executionMode==false){
                nlog("smart-valve is off returning");
                return;
            }

            let tempEntity=global.get("homeassistant.homeAssistant.states['"+node.tempEntity+"']");
            if (tempEntity===undefined){
                nlog("tempEntity is undefined returning");
                return;
            }

            let refTemp=parseFloat(tempEntity.state).toFixed(2);
            let threshold=parseFloat(node.adjustThreshold).toFixed(2);;
            
            // Check if there is an update on the valve
            nlog("New cycle");
            nlog("  node.manualTrigger:"+node.manualTrigger);
            nlog("  node.firstEval:"+node.firstEval);
            nlog("  refTemp:"+refTemp);
            nlog("  threshold:"+threshold);
            nlog("  allowOverride:"+node.allowOverride);

            node.climates.forEach((climate) => {                            // Check if Manual update occured on one of the valve

                if (climate.entity === null || climate.entity === "") {
                    node.warn("climate.entity is null or empty skipping");
                    return;
                }
                
                let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                if (climateEntity===undefined || climateEntity.attributes===undefined || climateEntity.attributes.temperature===undefined){
                    node.warn("climateEntity is invalide => undefined skipping")
                    return;
                }

                let sp=parseFloat(climateEntity.attributes.temperature).toFixed(2);
                
                nlog("-->"+climate.entity);
                nlog("   Phase 1 sp:"+sp);
                nlog("   Phase 1 node.requestSp:"+node.requestSp);
                
                if(node.firstEval == true && node.manualTrigger==false){
                    // At startup node.requestSp==0; 
                    // we should assign the existing sp to node.requestSP
                    // If Smart-scheduler is wire as input node.manualTriger will be true

                    nlog("  Phase 1 first Eval node.reqestSp=sp");
                    node.requestSp=sp;
                }else if (node.manualTrigger == false && sp!=node.requestSp && node.firstEval == false && node.allowOverride==true){
                    
                    let now = moment();                                             // <-------- 60 s is needed for Home assistant to update
                    let diff=now.diff(node.startTs)/1000;
                    nlog("   Phase 1 diff startTs:"+diff);
                    if (diff<60){
                        nlog("   Phase 1 node.startTs < 60s returning");
                        return;
                    }

                    nlog("   Phase 1 manual update from the valve");
                    node.valveManualSp=sp;
                    node.valveManualSpUpdate=true;
                    nlog("   Phase 1 node.valveManualSp:"+node.valveManualSp);
                }
            });


            if(node.valveManualSpUpdate==true && node.allowOverride==true){             // There is a ManualUpdate directly on the valve, update all valve
                
                nlog("   Phase 2 node.valveManualSp:"+node.valveManualSp);
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
                            temperature:node.valveManualSp //  We update all valve with the same Manual SP
                        }
                    };
                    node.send([msg,null]);
                });

                node.valveManualSpUpdate=false;
                node.requestSp=node.valveManualSp;
                
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
                    text:("Manual override sp: "+node.valveManualSp+"°C, temp: "+refTemp+"°C")
                });   
                
            }else{                  // No Manual Update we can proceed to check if 

                node.climates.forEach((climate) => {
                
                    if (climate.entity === null || climate.entity === "") {
                        node.warn("climate.entity is null or empty skipping");
                        return;
                    }

                    let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                    
                    if (climateEntity===undefined || climateEntity.attributes===undefined || climateEntity.attributes.temperature===undefined || isNaN(climateEntity.attributes.temperature )){
                        node.warn("climateEntity is invalide => undefined skipping")
                        return;
                    }

                    let sp=parseFloat(climateEntity.attributes.temperature).toFixed(2);
                
                    nlog("-->Phase 3:"+climate.entity);
                    nlog("   node.firstEval:"+node.firstEval);
                    nlog("   node.manualTrigger"+node.manualTrigger);
                    nlog("   node.spUpdateMode:"+node.spUpdateMode);

                    if (node.firstEval== true || (node.manualTrigger == true && sp!=node.requestSp) || node.spUpdateMode=="spUpdateMode.cycle"){
                        nlog("   enter condition:");
                        nlog("     sp:"+sp);
                        nlog("     node.requestSp:"+node.requestSp);
                        
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
                        climate.lastRequestSp=moment();             // we store last updateTS 
                        nlog(JSON.stringify(msg));
                        node.send([msg,null]);
                    }
                });
                
                node.status({
                    fill:  'blue',
                    shape: 'dot',
                    text:("temp: "+refTemp+"°C, sp: "+node.requestSp+"°C")
                });

                
                node.manualTrigger = false;
            }


            // If Ref Temp or SP have changed send output update:
            nlog("-->Phase 4 - Boiler update");
            if (refTemp!=node.previousRefTemp || node.requestSp!=node.previousSp || node.firstEval==true){

                // Something have changed or firstEval output
                let msg={};
                msg.payload={
                    topic: node.topic,
                    setpoint:node.requestSp,
                    temperature:refTemp,
                    name:node.name,
                    id:node.groupId
                }

                nlog("output to boiler");
                nlog(JSON.stringify(msg));

                node.send([null,msg]);

                nlog("  update sent to the boiler");
                nlog("  sp:"+node.requestSp);
                nlog("  temp:"+refTemp);
                nlog("  name:"+node.name);
                nlog("  id:"+node.groupId);

                node.previousRefTemp=refTemp;
                node.prevSp=node.requestSp;

            }else{
                nlog("  no update");
            }

            if (node.adjustValveTempMode!="adjustValveTempMode.noAdjust"){     // <--- Add the threshold management

                node.climates.forEach((climate) => {

                    if (climate.calibration === null || climate.calibration === "") {
                        node.warn("climate.calibration is null or empty skipping");
                        return;
                    }

                    if (climate.entity === null || climate.entity === "") {
                        node.warn("climate.entity is null or empty skipping");
                        return;
                    }

                    nlog("-->Phase 5 Adjust:"+climate.entity);
                    let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                                   
                    let currentCalibration=parseFloat(global.get("homeassistant.homeAssistant.states['"+climate.calibration+"'].state"));
                    
                    if (isNaN(currentCalibration)){
                        node.warn("   Phase 5 isNaN(currentCalibration)");
                        nlog("set calibration:0");
                        currentCalibration=0;
                    }

                    let currentTemperature=parseFloat(climateEntity.attributes.current_temperature);

                    if (isNaN(currentTemperature)){
                        node.warn("   Phase 5 isNaN(currentTemperature)");
                        return;
                    }
                        
                    let delta=currentTemperature-refTemp;
                    
                    if (node.adjustValveTempMode=="adjustValveTempMode.adjust.startup" || Math.abs(delta)>threshold){
                        let newCalibration=parseFloat(currentCalibration-delta).toFixed(2);
                        nlog("   refTemp:"+refTemp);
                        nlog("   currentTemperature:"+currentTemperature);
                        nlog("   currentCalibration:"+currentCalibration);
                        nlog("   delta:"+delta);
                        
                        nlog("   newCalibration:"+newCalibration);
                        nlog("   threshold:"+node.adjustThreshold);
                        let msg={}
                        msg.payload={
                            topic: node.topic,
                            domain:"number",
                            service:"set_value",
                            target:{
                                entity_id:[
                                    climate.calibration
                                ]
                            },
                            data:{
                                value:parseInt(Math.round(newCalibration))
                            } 
                        };   

                        node.send([msg,null]);
                    } 
                });
            }
            node.firstEval = false;
        }
        node.startTs=moment();
        // re-evaluate every cycle
        node.evalInterval = setInterval(evaluate, parseInt(node.cycleDuration)*60000)

        // Run initially directly after start / deploy.
        if (node.triggerMode != 'triggerMode.statechange') {
            setTimeout(evaluate, 1000)
        }

        node.on('close', function() {
            clearInterval(node.evalInterval)
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
