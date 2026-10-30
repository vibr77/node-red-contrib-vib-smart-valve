# Smart-Valve Node

The `smart-valve` node manages a radiator thermostatic valve (TRV) in Node-RED, over MQTT (typically
Zigbee2MQTT) and with optional Home Assistant integration. It applies the setpoint coming from
`smart-scheduler`, feeds the TRV the room temperature measured by a separate sensor, watches the health of the
room's devices, and tells `smart-boiler` how much heat the room needs.

## Features

*   **Scheduler as single source of truth**: the setpoint reported by the TRV is feedback only; with "Manual
    valve" off it is never forwarded to the boiler and the scheduled value is pushed back to the TRV.
*   **Manual overrides** (optional): a change on the TRV becomes a temporary override, capped, and the schedule
    comes back when it ends.
*   **External temperature reference**: the room sensor's temperature is sent to the TRV (external sensor mode).
*   **Room health** (OK / DEGRADED / FAILED): silent sensor, silent TRV, valve alarm, frozen TRV, setpoint not
    acknowledged. A FAILED room stops asking the boiler for heat and recovers by itself.
*   **Boiler integration**: demand re-sent at least every 10 minutes (heartbeat), with the room's health.
*   **Home Assistant discovery** (optional): Health, Problem, Requested setpoint and Room temperature per valve.
*   **State persistence** across Node-RED restarts and deploys.

`smart-valve` drives one radiator thermostatic valve (TRV) for one room and tells the boiler how much
heat that room needs. It sits in the middle of the heating chain:

```
smart-scheduler ──set──▶ smart-valve ──set──▶ smart-boiler ──MQTT──▶ boiler
                         │   ▲
            setpoint,    │   │ TRV state (setpoint, own temperature, alarm, mode)
     room temperature    ▼   │ room temperature (sensor)
                        MQTT (Zigbee2MQTT)
```

## What the node does

1. **Receives the setpoint from the scheduler** (`command: "set"`). The scheduler is the source of truth.
2. **Applies it to the TRV** over MQTT and checks that the TRV confirms it.
3. **Feeds the TRV the room temperature** measured by a separate sensor (external sensor mode), so the TRV
   regulates on the real room temperature and not on its own reading next to the hot radiator.
4. **Tells the boiler what the room needs**: its setpoint and the room temperature. The boiler heats for
   the room with the largest gap.
5. **Watches the health of the room** (sensor and TRV). A room whose equipment has failed stops asking the
   boiler for heat, so one broken device cannot keep the boiler running.

A room with several radiators (for example the living room with four TRVs) uses one `smart-valve` node per
TRV, all reading the same room sensor and sharing the same **Group id**.

## Node status (under the node in the editor)

| Status | Meaning |
|---|---|
| 🔴 dot `Heat t:19.5°C, sp:20°C` | Room below its setpoint, asking for heat |
| 🟢 dot `idle t:20.6°C, sp:20°C` | Room warm enough |
| ⚪ grey dot `Off …` | Room switched off (command `off` or TRV in mode off): sends the Off setpoint |
| 🟡 dot `(Manual 42min left) …` | Manual change on the TRV accepted, 42 minutes left before the schedule returns |
| 🟡 dot `(valve_alarm) …` | DEGRADED: a problem has started but not lasted long enough to act on it |
| 🔴 ring `FAILED (no_ack, trv_frozen) …` | FAILED: the room no longer asks the boiler for heat (see Safety) |
| 🟡 dot `Not ready t:?°C, sp:?°C` | No room temperature or no setpoint received yet |

## Editor parameters

### General

| Field | What it does | Default / example |
|---|---|---|
| **Name** | Name of the valve. Also used as the room identifier towards the boiler (`requestedBy`) and in Home Assistant. Keep it unique. | `SV_CHLOE` |
| **MQTT** | Shared MQTT connection (a `smart-valve-settings` node). All valves can use the same one. | `jarvis` |
| **Group id** | Number identifying the room. Valves of the same room share it; the boiler reports it as the leading device id. With *Manual valve* on, a manual change on one TRV is sent as an `override` message on the output; wire the output to the other valves of the group if you want them to follow. | Salon: `3` for all four TRVs |

### Temperature sensor

| Field | What it does | Example |
|---|---|---|
| **State topic** | MQTT topic of the room temperature sensor. The value read here is *the* room temperature for this valve and for the boiler. | `zigbee2mqtt/TH_CHLOE` |
| **key** | Name of the temperature field in that message. Values outside −20…60 °C or not numeric are ignored. | `temperature` |

### Valve set point

| Field | What it does | Example |
|---|---|---|
| **State topic** | Topic where the TRV publishes its state. Read to know the setpoint the TRV really has, its own temperature and its valve alarm. With Zigbee2MQTT this is the device topic. | `zigbee2mqtt/TRV_CHLOE` |
| **Set topic** | Topic used to send the setpoint to the TRV. | `zigbee2mqtt/TRV_CHLOE/set/occupied_heating_setpoint` |
| **key** | Name of the setpoint field in the TRV state. | `occupied_heating_setpoint` |

### Valve temperature (external sensor mode)

| Field | What it does | Example |
|---|---|---|
| **Set topic** | Topic used to send the room temperature to the TRV each time it changes. Leave empty if the TRV uses its own sensor; the *frozen TRV* check is then disabled. | `zigbee2mqtt/TRV_CHLOE/set/external_temperature_input` |
| **key** | Not used by the node (the temperature is sent as a plain number). | `notuse` |

### Valve sensor internal/external

| Field | What it does | Example |
|---|---|---|
| **Set topic** | Topic used to tell the TRV to use the external temperature. Sent with the first temperature after start-up and then at most once an hour. Check that it points to *this* TRV. | `zigbee2mqtt/TRV_CHLOE/set/sensor` |
| **Payload** | Value sent on that topic. | `external` |

### Valve mode

| Field | What it does | Example |
|---|---|---|
| **State** | Topic where the TRV reports its mode. If the TRV is switched off on the device (mode `off` / `0`), the room stops asking for heat until it is switched back to `heat`. | `zigbee2mqtt/TRV_CHLOE` |
| **Set** | Not used by the node at present. | `zigbee2mqtt/TRV_CHLOE/set/system_mode` |
| **key** | Name of the mode field. | `system_mode` |

### Off and update behaviour

| Field | What it does | Default |
|---|---|---|
| **Off setpoint** | Setpoint sent to the boiler when the room is off or FAILED. Choose a value below any room temperature you will see, so it never creates demand. It only removes the room's demand from the boiler: the TRV keeps its last setpoint (to close a radiator, send it a low setpoint from the scheduler instead). | `5` °C |
| **Mode** | When the setpoint is pushed to the TRV: *when state changes* (default, only when the schedule changes), *when state changes + startup*, or *every cycle* (re-sent at each cycle, more radio traffic). Since 0.82 the setpoint is also re-applied whenever the TRV reports something else and at start-up if the TRV disagrees. | when state changes |
| **Cycle** | How often the node re-evaluates on its own (health checks, heartbeat, override expiry). | `1` min (minimum 1) |
| **Manual valve** | Off: the TRV knob is ignored; any change on the TRV is pushed back to the scheduled value. On: a change on the TRV becomes a temporary override (capped at *Max setpoint*) and an `override` message is sent on the output for the other valves of the group. | off (recommended) |
| **Manual … min duration** | How long an override lasts. When it ends, the scheduled setpoint is restored and pushed to the TRV (0.81 never restored it, and ignored this field). | `60` min |

### Safety (new in 0.82)

Each check can be disabled by setting it to `0`.

| Field | What it does | Default | Why this default |
|---|---|---|---|
| **Max setpoint** | Ceiling for any setpoint applied to the TRV or sent to the boiler, whatever its origin (schedule, knob, override). | `24` °C | Nothing in a house needs more. |
| **Heartbeat** | The demand is re-sent to the boiler at least this often, even if nothing changed. This lets the boiler tell a quiet room from a dead one. | `10` min | Must stay well below the boiler's *Valve timeout* (30 min). |
| **Sensor timeout** | If the room sensor sends nothing for this long, the room is FAILED (`sensor_silent`). | `120` min | Aqara sensors report at least about every 50 min. |
| **TRV timeout** | If the TRV sends nothing for this long, the room is FAILED (`trv_silent`). | `90` min | Aqara TRVs check in about every 50 min even when idle. |
| **Valve alarm** | The TRV reports a valve alarm (stuck pin, motor fault): DEGRADED at once, FAILED (`valve_alarm`) if it lasts this long. | `60` min | Lets a short calibration alarm clear by itself. |
| **Frozen gap** / **Frozen for** | In external sensor mode the TRV's own temperature should follow the room temperature we send it. If it stays more than *gap* away for *for* minutes, the TRV is considered frozen (`trv_frozen`). This is what caught TRV_CHLOE (31.9 °C against 20.4 °C). | `3` °C / `60` min | Normal lag is a few tenths of a degree. |
| **Ack timeout** | After a setpoint is sent, the TRV must report it within this time, otherwise the room is FAILED (`no_ack`). The setpoint is then retried every 3 × this time; the room recovers by itself as soon as the TRV confirms. Armed only once the TRV has reported a setpoint at least once, so a wrong key cannot fail a healthy room. | `5` min | Zigbee2MQTT confirms within seconds. |
| **When FAILED** | *stop asking for heat* (send the Off setpoint to the boiler) or *keep the scheduled demand* (only report the problem). | stop asking | A broken room cannot be heated anyway. |
| **TRV temp key** | Field of the TRV's own temperature in its state message. | `local_temperature` | Zigbee2MQTT name. |
| **TRV alarm key** | Field of the valve alarm in its state message. | `valve_alarm` | Zigbee2MQTT name for Aqara E1. |

**Health states**: `OK`, `DEGRADED` (a problem started, still heating), `FAILED` (see above),
`UNKNOWN` (just started). The reasons (`sensor_silent`, `trv_silent`, `valve_alarm`, `trv_frozen`,
`no_ack`, `no_sensor_data`) are shown in the status, sent to the boiler and to Home Assistant.

### Debug

| Field | What it does | Default |
|---|---|---|
| **Storm** | Maximum evaluations in 10 s. Beyond it, evaluations are skipped (protects against message loops). | `20` |
| **Debug Level** | Messages shown in the debug sidebar: None, Error, Warn, Info, Debug. Use *Warn* in normal operation to see health changes. | None |

## Messages

### Input (from the scheduler or another flow)

| `msg.payload.command` | Effect |
|---|---|
| `set` + `setpoint` (+ optional `temperature`) | New scheduled setpoint (0–40 °C, capped at Max setpoint). During an override it is stored and applied when the override ends. |
| `override` + `setpoint`, `requestedBy`, `groupId` | Override from another valve of the same group (Manual valve on only). |
| `auto` | Back to the schedule, end of any override. |
| `on` / `off` (or `0`) | Switch the room on / off. Off sends the Off setpoint to the boiler. |
| `trigger` / `1` | Re-evaluate now. |

Messages with `target: "boiler"` (sent by other valves) are ignored.

### Output (to the boiler)

```json
{ "command": "set", "target": "boiler", "setpoint": "20.00", "temperature": "19.50",
  "requestedBy": "SV_CHLOE", "groupId": "52", "health": "OK", "reasons": [] }
```

Sent when the temperature or setpoint changes, when the health changes, and at least every *Heartbeat*.
With Manual valve on, a manual change also sends `command: "override"` on the same output, meant for the other valves of the group (the boiler ignores it).

## Home Assistant

Tick **HA discovery** in the `smart-valve-settings` node (once for all valves). Each valve appears as a
device **SmartValve <name>** with:

| Entity | Value |
|---|---|
| Health | `OK` / `DEGRADED` / `FAILED` |
| Problem (binary sensor) | on when DEGRADED or FAILED — use it for alerts |
| Requested setpoint | what the room asks the boiler for (the Off setpoint when FAILED) |
| Room temperature | from the room sensor |

All four share the state topic `smartheating/valve/<name>/state`, whose attributes include `reasons`,
`health_since`, `scheduled_setpoint`, `trv_setpoint`, `trv_temperature`, `trv_age_min`, `sensor_age_min`,
`valve_alarm`, `override` and `mode`. The device becomes *unavailable* when Node-RED stops.

Example alert:

```yaml
alias: Heating — room problem
triggers:
  - trigger: state
    entity_id: binary_sensor.smartvalve_sv_chloe_problem   # one per valve, or a group
    to: "on"
    for: "00:30:00"
actions:
  - action: notify.family
    data:
      message: >
        {{ state_attr(trigger.entity_id, 'reasons') | join(', ') }} on
        {{ trigger.to_state.attributes.friendly_name }}
```

## Settings node (`smart-valve-settings`)

| Field | What it does |
|---|---|
| **Name** | Label of the connection. |
| **MQTT Host / Port** | Broker address. |
| **Username / Password** | Broker credentials (the password is stored encrypted by Node-RED). |
| **Root path** | Home Assistant discovery prefix, normally `homeassistant`. |
| **HA discovery** | Publish the Home Assistant entities described above. Off by default. |
| **State topic** | Base topic of the published states (`smartheating`). |
| **Test Connection** | Checks the broker and whether anything is published under the root path. |

## Recommended settings for an Aqara E1 (SRTS-A01) with Zigbee2MQTT

- Manual valve **off**, unless people really use the knobs.
- Keep the Safety defaults.
- Check that *Valve Sensor Internal/External → Set* points to the TRV of the same node.
- One TRV that keeps reporting `valve_alarm`: remove it, check the pin moves freely, refit and calibrate.

## State persistence

The node saves its state to `~/.node-red/.node-red-state/valve-{node-id}.json` (and to the node context):
requested setpoint, setpoint applied to the TRV, scheduled setpoint, room temperature and timestamp. It is
restored when Node-RED restarts or the flow is redeployed. A restored room temperature only counts as fresh from
start-up: if the sensor stays silent, the room becomes FAILED after the sensor timeout instead of trusting the old
value forever.

## Tests

```
npm install
npm test
```

27 tests run the node with a fake clock, an in-memory MQTT broker and simulated Zigbee2MQTT devices (a room
sensor and a TRV that can be healthy, stuck or dead), including a replay of a stuck-TRV incident.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

---
*Author: Vincent BESSON*
*License: Creative Commons*

<a href="https://www.buymeacoffee.com/vincentbe" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
