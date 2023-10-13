
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.6
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
        var node = this
        this.topic = n.topic;
        this.groupId=n.groupId;
        this.climates = n.climates;
        this.tempEntity=n.tempEntity ? n.tempEntity : '';
        
        this.cycleDuration=n.cycleDuration ? parseInt(n.cycleDuration): 5;
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';
        this.adjustValveTempMode=n.adjustValveTempMode ? n.adjustValveTempMode : 'adjustValveTempMode.noAdjust'
        this.adjustThreshold=n.adjustThreshold ? parseFloat(n.adjustThreshold) : 0.5
        this.allowGroupManualSp=n.allowGroupManualSp ? n.allowGroupManualSp : 'allowGroupManualSp.no'
        this.activeSp=0;
        this.prevSp=0;
        this.requestSp=0;
        this.firstEval = true;
        this.valveManualSpUpdate=false;
        this.valveManualSp=0;
        this.startTs=0;

        node.previousRefTemp=0;
        node.previousSp=0;

        node.manualTrigger=false;

        node.on('input', function(msg) {
            msg.payload = msg.payload.toString() // Make sure we have a string.
            if (msg.payload.match(/^(1|on|0|off|auto|override|trigger)$/i)) {
                
                if (msg.payload == '1' || msg.payload == 'trigger' || msg.payload == 'on'){
                    
                    if (msg.sp=== undefined || isNaN(msg.sp) || parseFloat(msg.sp)<0 || parseFloat(msg.sp)>35){ //<----------- Todo define Max & Min in config
                        node.warn('received trigger missing or invalid msg.sp number');
                        return;
                    }

                    node.manualTrigger = true;
                    node.requestSp=parseFloat(msg.sp).toFixed(2);
                    node.log("incoming request sp:"+msg.sp);
                    
                    evaluate();
                }

                
            } else node.warn('Failed to interpret incoming msg.payload. Ignoring it!')
        });

        function evaluate() {
            
            var msg = {
                topic: node.topic,
            }
            
            let tempEntity=global.get("homeassistant.homeAssistant.states['"+node.tempEntity+"']");
            let refTemp=parseFloat(tempEntity.state).toFixed(2);;
            let threshold=parseFloat(node.adjustThreshold).toFixed(2);;
            
            // Check if there is an update on the valve
            node.log("New cycle");
            node.log("  node.manualTrigger:"+node.manualTrigger);
            node.log("  node.firstEval:"+node.firstEval);
            node.log("  refTemp:"+refTemp);
            node.log("  threshold:"+threshold);


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

                if (node.allowGroupManualSp!=="allowGroupManualSp.yes"){                                // <----------- To be reworked
                    node.warn("  Phase 2 node.allowGroupManualSp=NO skipping group update");
                    return;
                }

                let sp=parseFloat(climateEntity.attributes.temperature).toFixed(2);
                
                node.log("-->"+climate.entity);
                node.log("   Phase 1 sp:"+sp);
                node.log("   Phase 1 node.requestSp:"+node.requestSp);
                
                if(node.firstEval == true && node.manualTrigger==false){
                    // At startup node.requestSp==0; 
                    // we should assign the existing sp to node.requestSP
                    // If Smart-scheduler is wire as input node.manualTriger will be true

                    node.log("  Phase 1 first Eval node.reqestSp=sp");
                    node.requestSp=sp;
                }else if (node.manualTrigger == false && sp!=node.requestSp && node.firstEval == false){
                    
                    let now = moment();                                             // <-------- 60 s is needed for Home assistant to update
                    let diff=now.diff(node.startTs)/1000;
                    node.log("   Phase 1 diff startTs:"+diff);
                    if (diff<60){
                        node.log("   Phase 1 node.startTs < 60s returning");
                        return;
                    }

                    node.log("   Phase 1 manual update from the valve");
                    node.valveManualSp=sp;
                    node.valveManualSpUpdate=true;
                    node.log("   Phase 1 node.valveManualSp:"+node.valveManualSp);
                }
            });


            if(node.valveManualSpUpdate==true){             // There is a ManualUpdate directly on the valve, update all valve
                
                node.log("   Phase 2 node.valveManualSp:"+node.valveManualSp);
                node.climates.forEach((climate) => {

                    if (node.allowGroupManualSp!=="allowGroupManualSp.yes"){
                        node.warn("  Phase 2 node.allowGroupManualSp=NO skipping group update");
                        return;
                    }
                    
                    msg.payload={
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
                
                msg={
                    topic:node.topic,
                    payload:"override",
                    sp:node.valveManualSp,
                    noout:true
                }
        
                node.send([null,msg]);
                
                msg = {topic: node.topic}

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
                
                    node.log("-->"+climate.entity);
                    node.log("   node.firstEval:"+node.firstEval);
                    node.log("   node.manualTrigger"+node.manualTrigger);
                    node.log("   node.spUpdateMode:"+node.spUpdateMode);

                    if (node.firstEval== true || (node.manualTrigger == true && sp!=node.requestSp) || node.spUpdateMode=="spUpdateMode.cycle"){
                        node.log("   enter condition:");
                        node.log("     sp:"+sp);
                        node.log("     node.requestSp:"+node.requestSp);
                        
                        msg.payload={
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
            node.log("-->Phase 4 - Boiler update");
            if (refTemp!=node.previousRefTemp || node.requestSp!=node.previousSp || node.firstEval==true){

                // Something have changed or firstEval output
                let msg={};
                msg.payload={
                    sp:node.requestSp,
                    temp:refTemp,
                    name:node.name,
                    id:node.groupId
                }

                node.log("output to boiler");
                node.log(JSON.stringify(msg));

                node.send([null,msg]);

                node.log("  update sent to the boiler");
                node.log("  sp:"+node.requestSp);
                node.log("  temp:"+refTemp);
                node.log("  name:"+node.name);
                node.log("  id:"+node.groupId);

                node.previousRefTemp=refTemp;
                node.prevSp=node.requestSp;

            }else{
                node.log("  no update");
            }

            if (node.adjustValveTempMode!="adjustValveTempMode.noAdjust"){

                node.climates.forEach((climate) => {

                    if (climate.calibration === null || climate.calibration === "") {
                        node.warn("climate.calibration is null or empty skipping");
                        return;
                    }

                    if (climate.entity === null || climate.entity === "") {
                        node.warn("climate.entity is null or empty skipping");
                        return;
                    }

                    node.log("-->Phase 5 Adjust:"+climate.entity);
                    let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                                   
                    let currentCalibration=parseFloat(global.get("homeassistant.homeAssistant.states['"+climate.calibration+"'].state"));
                    
                    if (isNaN(currentCalibration)){
                        node.warn("   Phase 5 isNaN(currentCalibration)");
                        return;
                    }

                    let currentTemperature=parseFloat(climateEntity.attributes.current_temperature);

                    if (isNaN(currentTemperature)){
                        node.warn("   Phase 5 isNaN(currentTemperature)");
                        return;
                    }
                        
                    let delta=currentTemperature-refTemp;
                    
                    if (node.adjustValveTempMode=="adjustValveTempMode.adjust.startup" || Math.abs(delta)>threshold){
                        let newCalibration=parseFloat(currentCalibration-delta).toFixed(2);
                        node.log("   refTemp:"+refTemp);
                        node.log("   currentTemperature:"+currentTemperature);
                        node.log("   currentCalibration:"+currentCalibration);
                        node.log("   delta:"+delta);
                        
                        node.log("   newCalibration:"+newCalibration);
                        node.log("   threshold:"+node.adjustThreshold);
                        
                        msg.payload={
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
            setTimeout(evaluate, 20000)
        }

        node.on('close', function() {
            clearInterval(node.evalInterval)
        })

    }
    RED.nodes.registerType('smart-valve', SmartValve)
}
