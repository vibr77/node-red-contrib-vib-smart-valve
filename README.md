    # Smart-valve 
    
    WORK IN PROGRESS, help me and log any issue

    is part of a suite of nodes to manage multi room heating system based on TRV and boiler

    - Smart-Scheduler: multi-zonning SmartScheduler,
    - Smart-Valve: Valve grouping, auto-calibration, manual override,
    - Smart-Boiler: Boiler OpenTherm, multi valve management.

    ## Smart-valve

    This node enables to manage multiple valve (climate) in a same room like one. 
    It support the following features :
    - External temperature sensor,
    - Multiple valves updates,
    - TRV temperture Recalibration based on the external temperature sensor,
    - Manual update directly on the valve to trigger override message to the scheduler and update the other valve

    ### Inputs
    
    - payload (string):[1|on|trigger]
    - sp (integer): [0-35]    
    
    ## Outputs
    
    1. Update home assistant via call service
    
    2. Update of SP to the boiler (smart-Boiler) or override message to the smart-scheduler
    
    ### Settings

    - Name: [string], name of the node and also the name of the group sent to the smart-boiler node
    - Topic: [string], not used,
    - Group Id: [integer], used by the smart-boiler node to identify this group of valves, need to be unique
    
    - Temperature: [string], is the name of the external temperature sensor entity in home assistant ex: sensor.temp9
    - Update mode: [state changed|state changed+startup|every cycle], define how frequently updates are sent to the smart-boiler node
    - Update cycle: [integer], duration in minute between two cycle. default is 5
    - Allow manual updates: [true|false], enable direct set point (target temperature) change on the valve or home assistant. If true when a valve set point is changed all the other valves are updated and a override message is sent to the smart-scheduler node.
    - Recalibration: [No|Yes|Yes+threshold], enable to adjust the valve (TRV) current temperature based on the external temperature sensor,
    - Delta threshold: [integer] [0-9], threshold delta between external temperature sensor and the TRV current temperature to trigger recalibration,
    - Debug: [true|false], send debug info to the node-red console
    - Climate: each valve entry has 2 field:
        - climate: [string], home assitant climate entity of the valve ex: climate.kitchen
        - calibration: [string], home assistant calibration entity of the valve ex: number.kitchen_calibration
    
    ### Execution rules 

    - Step 0: update current group setpoint with the sp of the valve,
    - Cycle :
        Step 1: identify if manual updates on valve, then update all valves,
        Step 2: check and execute recalibration
        Step 3: based on the execution mode, output to the smart-boiler node
    - On input: 
        Update the requested set-point on each valves




<a href="https://www.buymeacoffee.com/vincentbe" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

