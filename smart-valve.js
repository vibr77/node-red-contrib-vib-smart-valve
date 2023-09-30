
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.11
  \ V / | || _ \   /      Date: 20230930
   \_/ |___|___/_|_\      Description: Nodered Heating Valve Management
                2023      Licence: Creative Commons
______________________
*/ 


module.exports = function(RED) {
   
    var path = require('path')
    var util = require('util')

    var SmartValve = function(n) {
        RED.nodes.createNode(this, n)
        this.settings = RED.nodes.getNode(n.settings) // Get global settings
        var global = this.context().global;
        var node = this
        this.topic = n.topic;
        
        this.climates = n.climates;
        this.tempEntity=n.tempEntity ? n.tempEntity : '';
        
        this.cycleDuration=n.cycleDuration ? parseInt(n.cycleDuration): 5;
        this.spUpdateMode=n.spUpdateMode ? n.spUpdateMode : 'spUpdateMode.statechange.startup';
        this.adjustValveTempMode=n.adjustValveTempMode ? n.adjustValveTempMode : 'adjustValveTempMode.noAdjust'
        this.adjustThreshold=n.adjustThreshold ? parseFloat(n.adjustThreshold) : 0.5
        this.activeSp=0;
        this.prevSp=0;
        this.requestSp=0;
        this.firstEval = true;
        this.valveManualSpUpdate=false;
        this.valveManualSp=0;

        node.on('input', function(msg) {
            msg.payload = msg.payload.toString() // Make sure we have a string.
            if (msg.payload.match(/^(1|on|0|off|auto|override|trigger)$/i)) {
                
                if (msg.payload == '1' || msg.payload == 'trigger' || msg.payload == 'on'){
                    node.manualTrigger = true;
                    node.requestSp=parseFloat(msg.sp).toFixed(2);
                    node.log("incoming request sp:"+msg.sp);
                }

                evaluate()
            } else node.warn('Failed to interpret incoming msg.payload. Ignoring it!')
        });

        function evaluate() {
            var msg = {
                topic: node.topic,
            }
            
            let tempEntity=global.get("homeassistant.homeAssistant.states['"+node.tempEntity+"']");
            let refTemp=parseFloat(tempEntity.state);
            let threshold=parseFloat(node.adjustThreshold);
            
            // Check if there is an update on the valve
            node.log("Phase 0 ----------->");
            if (node.manualTrigger==true)
                node.log("   Phase 0 node.manualTrigger:true");
            else 
                node.log("   Phase 0 node.manualTrigger:false");

            if (node.firstEval==true)
                node.log("   Phase 0 node.firstEval:true");
            else 
                node.log("   Phase 0 node.firstEval:false");
   

            node.climates.forEach((climate) => {
                
                let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                let sp=parseFloat(climateEntity.attributes.temperature).toFixed(2);
                node.log("-->"+climate.entity);
                node.log("   Phase 1 sp:"+sp);
                node.log("   Phase 1 node.requestSp:"+node.requestSp);
                node.log("   BEFORE");
                if (node.manualTrigger == false && sp!=node.requestSp && node.firstEval == false){
                    
                    node.log("   Phase 1 manual update from the valve");
                    node.valveManualSp=sp;
                    node.valveManualSpUpdate=true;
                }
                node.log("   AFTER");
            
            });

            // There is a ManualUpdate directly on the valve
            if(node.valveManualSpUpdate==true){
                
                node.climates.forEach((climate) => {
                    
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
                node.log("$$$$$$$$$$$$$$$$$$$$$$$$$$$");
                msg.payload="override"; // Send to the scheduler to delay any update for the override duration
                msg.sp=node.valveManualSp;
                msg.noout=true;
                node.send([null,msg]);
                msg = {
                    topic: node.topic,
                }
                
            }else{

                node.climates.forEach((climate) => {
                
                    let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");
                    let sp=parseFloat(climateEntity.attributes.temperature).toFixed(2);
                    
                    node.log("-->"+climate.entity);
                    if (node.firstEval) node.log("   node.firstEval:true");
                    else node.log("   node.firstEval:false");

                    if (node.manualTrigger) node.log("   node.manualTrigger:true");
                    else  node.log("   node.manualTrigger:false");

                    node.log("   node.spUpdateMode:"+node.spUpdateMode);

                    if (node.manualTrigger == false && sp!=node.requestSp && node.firstEval == false){
                        // It means Manual update from the valve
                        node.log("     manual update from the valve");
                    }
                    

                    if (node.firstEval== true || (node.manualTrigger == true && sp!=node.requestSp) || node.spUpdateMode=="spUpdateMode.cycle"){
                        node.log("   enter condition:");
                        node.log("     sp:"+sp);
                        node.log("     node.requestSp:"+node.requestSp);
                        
                        if (node.manualTrigger == false && sp!=node.requestSp && node.firstEval == false){
                            // It means Manual update from the valve
                            node.log("     manual update from the valve");
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
                                temperature:node.requestSp
                            }
                        };
                        
                        //console.log(msg);
                        node.send([msg,null]);
                    }
                });
                
                node.firstEval = false;
                node.manualTrigger = false;
            }

            if (node.adjustValveTempMode!="adjustValveTempMode.noAdjust"){

                node.climates.forEach((climate) => {

                    let climateEntity=global.get("homeassistant.homeAssistant.states['"+climate.entity+"']");

                    let currentCalibration=parseFloat(global.get("homeassistant.homeAssistant.states['"+climate.calibration+"'].state"));
                    let currentTemperature=parseFloat(climateEntity.attributes.current_temperature);
                        
                    let delta=Math.abs(currentTemperature-refTemp);

                    if (node.adjustValveTempMode=="adjustValveTempMode.adjust.startup" || delta>threshold){
                        let newCalibration=parseFloat(currentCalibration+delta).toFixed(2);
                        
                        node.log("newCalibration:"+newCalibration);
                        node.log("delta:"+delta);
                        node.log("threshold:"+node.adjustThreshold);
                        node.log("currentCalibration:"+currentCalibration);
                        node.log("currentTemperature:"+currentTemperature);
                        node.log("refTemp:"+refTemp);

                        msg.payload={
                            domain:"number",
                            service:"set_value",
                            target:{
                                entity_id:[
                                    climate.calibration
                                ]
                            },
                            data:{
                                value:newCalibration
                            } 
                        };   
                        
                        node.send([msg,null]);
                    } 
                });
            }
        }

        // re-evaluate every cycle
        node.evalInterval = setInterval(evaluate, parseInt(node.cycleDuration)*30000)

        // Run initially directly after start / deploy.
        /*if (node.triggerMode != 'triggerMode.statechange') {
            node.firstEval = false
            setTimeout(evaluate, 1000)
        }*/

        node.on('close', function() {
            clearInterval(node.evalInterval)
            clearInterval(node.rndInterval)
        })

    }
    RED.nodes.registerType('smart-valve', SmartValve)
}
