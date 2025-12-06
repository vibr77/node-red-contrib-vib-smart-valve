# Smart-Valve Node

The `smart-valve` node is designed to manage heating valves (TRVs) in a Node-RED environment, specifically tailored for Home Assistant and MQTT integration. It allows grouping multiple valves in a single room, handling external temperature sensors, and managing manual overrides.

## Features

*   **Multi-Valve Management**: Group multiple TRVs to operate as a single zone.
*   **External Temperature Reference**: Use an external temperature sensor for more accurate room temperature readings.
*   **MQTT Integration**: Extensive use of MQTT for receiving status and sending commands.
*   **Manual Override Detection**: Detects if a valve's setpoint is changed manually and updates other valves in the group.
*   **Boiler Integration**: Sends demand signals to a `smart-boiler` node.
*   **Auto-Calibration**: (Optional) Adjusts valve temperature based on external sensor (if supported).
*   **State Persistence**: Automatically saves and restores setpoint and temperature values across Node-RED restarts and flow deploys.

## Configuration

### General
*   **Name**: Node name, also used as the group name for the boiler.
*   **Topic**: MQTT topic (optional/informational).
*   **MQTT Settings**: Reference to a global MQTT configuration node.
*   **Group ID**: Unique integer ID for the valve group (required for `smart-boiler`).

### Temperature Settings
*   **Temperature Entity**: Name of the external temperature sensor entity (e.g., `sensor.living_room_temp`).
*   **Temperature Topic**: MQTT topic for the external temperature sensor.
*   **Off Setpoint**: Temperature setpoint when the valve is turned "Off" (e.g., 5°C for frost protection).

### Climates (Valves)
Define each valve controlled by this node:
*   **Climate Entity**: Home Assistant entity ID (e.g., `climate.radiator_1`).
*   **Ext Temp Topic**: MQTT topic to publish external temperature to the valve (for TRVs that support it).
*   **Entity Topic**: MQTT topic to receive status updates from the valve.
*   **SetPoint Topic**: MQTT topic to send setpoint commands to the valve.

### Advanced
*   **Update Mode**:
    *   `when state changes`: Send updates only when values change.
    *   `when state changes + startup`: Send updates on change and node startup.
    *   `every cycle`: Send updates every cycle regardless of changes.
*   **Update Cycle**: Duration in minutes between evaluation cycles (default: 5).
*   **Allow Manual Update**: If enabled, manual changes on a TRV will propagate to others and override the schedule.
*   **Recalibration**: Option to adjust valve temperature offset (requires specific TRV support).
*   **Debug**: Enable verbose logging to the Node-RED console.

## Inputs

The node accepts messages to control its state:

*   **Command**: `msg.payload.command`
    *   `on` / `1`: Turn the node ON (Auto mode).
    *   `off` / `0`: Turn the node OFF (Frost protection mode).
    *   `set` / `trigger`: Set a specific setpoint. Requires `msg.payload.setpoint`.
*   **Setpoint**: `msg.payload.setpoint` (Number) - Target temperature (required for `set` command).

Example `msg.payload`:
```json
{
    "command": "set",
    "setpoint": 21.5
}
```

## Business Rules

### Valve Activation Condition
A valve is considered **ACTIVE** (heating required) when:
```
setpoint > temperature
```
This means heating is requested when the target temperature exceeds the current room temperature.

### Target Conditions on Input
*   **Command "set" or "on"**: Valve processes input if `executionMode = true`
*   **Command "trigger" or "1"**: Only triggers evaluation if `executionMode = true`
*   **Command "override"**: Always processed regardless of executionMode, forces setpoint update across all valves in group
*   **Command "off" or "0"**: Sets `executionMode = false`, disables valve operation
*   **GroupId matching**: Input messages only processed if `msg.payload.groupId` matches the node's configured Group ID
*   **Manual override propagation**: When manual update is detected on one valve, all valves in the same group are synchronized to the new setpoint

## Outputs

1.  **Home Assistant / MQTT**: (Deprecated/Internal) Used for direct service calls or debugging.
2.  **Boiler / Scheduler**: Sends status updates to `smart-boiler` or `smart-scheduler`.
    *   `msg.payload` contains: `command`, `topic`, `setpoint`, `temperature`, `name`, `groupid`.

## MQTT Topics

The node subscribes to:
*   `Temperature Topic`: To get the reference room temperature.
*   `Entity Topic` (for each climate): To get current TRV status (setpoint, local temp).

The node publishes to:
*   `SetPoint Topic` (for each climate): To set the target temperature.
*   `Ext Temp Topic` (for each climate): To push external temperature reference to TRVs.

## Logic

1.  **Initialization**: 
    *   Connects to MQTT and subscribes to topics.
    *   Loads last saved state from file system (`.node-red-state/valve-{node-id}.json`).
    *   Restores previous setpoint and temperature values if available.
2.  **Cycle (Every x minutes)**:
    *   **Phase 1 (Check)**: Checks if any valve was manually adjusted (if allowed).
    *   **Phase 2 (Update)**:
        *   If manual update detected: Syncs all other valves to the new setpoint.
        *   If no manual update: Enforces the requested setpoint (from input/schedule).
    *   **Phase 3 (Ext Temp)**: Updates TRVs with external temperature reading.
    *   **Phase 4 (Boiler)**: Sends current demand (setpoint vs current temp) to the boiler node.
    *   **Phase 5 (Persistence)**: Saves current state to file for persistence across restarts.

## State Persistence

The node automatically saves its state to the file system at `~/.node-red/.node-red-state/valve-{node-id}.json`. This includes:

*   **requestSp**: Requested setpoint
*   **sp**: Current setpoint
*   **refTemp**: Reference temperature from external sensor
*   **timestamp**: Last save timestamp

This state is automatically restored when:
*   Node-RED restarts
*   Flows are redeployed
*   Node is reinitialized

The state file persists independently of Node-RED's context storage, ensuring valve settings are preserved even after complete system restarts.

---
*Author: Vincent BESSON*
*License: Creative Commons*

<a href="https://www.buymeacoffee.com/vincentbe" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

