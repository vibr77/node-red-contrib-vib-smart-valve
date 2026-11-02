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
| **Away setpoint** | Frost protection setpoint while the room is *away* (see below): applied to the TRV and sent to the boiler, so the room asks for heat only if it falls below it. | `7` °C |
| **Off setpoint** | Setpoint sent to the boiler when the room is off or FAILED. Choose a value below any room temperature you will see, so it never creates demand. It only removes the room's demand from the boiler: the TRV keeps its last setpoint (to close a radiator, send it a low setpoint from the scheduler instead). | `5` °C |
| **Mode** | When the setpoint is pushed to the TRV: *when state changes* (default, only when the schedule changes), *when state changes + startup*, or *every cycle* (re-sent at each cycle, more radio traffic). Since 0.82 the setpoint is also re-applied whenever the TRV reports something else and at start-up if the TRV disagrees. | when state changes |
| **Cycle** | How often the node re-evaluates on its own (health checks, heartbeat, override expiry). | `1` min (minimum 1) |
| **Manual valve** | Off: the TRV knob is ignored; any change on the TRV is pushed back to the scheduled value. On: a change on the TRV becomes a temporary override (capped at *Max setpoint*) and an `override` message is sent on the output for the other valves of the group. A knob turn while a scheduled setpoint is still being applied is also taken as an override; the value of an override that just expired coming back within 30 min is not (a TRV repeating a stale value). | off (recommended) |
| **Knob settle** | A knob turn is taken once the knob stays still this long (a rotary knob reports each 0.5 °C step). Nothing is pushed back meanwhile. | `20` s |
| **Knob max wait** | Longest wait before a knob change is taken and shared with the room, even if the knob keeps moving (jittering TRV). | `60` s |
| **Share with room** | Apply a knob turn to every valve with the same *Group id* (see *Room sync*). | on |
| **Manual … min duration** | How long an override lasts. When it ends, the scheduled setpoint is restored and pushed to the TRV (0.81 never restored it, and ignored this field). | `60` min |

### Safety (new in 0.82)

Each check can be disabled by setting it to `0`.

| Field | What it does | Default | Why this default |
|---|---|---|---|
| **Max setpoint** | Ceiling for any setpoint applied to the TRV or sent to the boiler, whatever its origin (schedule, knob, override). | `24` °C | Nothing in a house needs more. |
| **Heartbeat** | The demand is re-sent to the boiler at least this often, even if nothing changed. This lets the boiler tell a quiet room from a dead one. | `10` min | Must stay well below the boiler's *Valve timeout* (30 min). |
| **Sensor timeout** | If the room sensor sends nothing for this long, the room is FAILED (`sensor_silent`). | `120` min | Aqara sensors report at least about every 50 min. |
| **TRV timeout** | If the TRV sends nothing for more than half this time, the room is DEGRADED (warning, heating continues); after the full time it is FAILED (`trv_silent`). | `150` min | Aqara TRVs check in about every 50 min even when idle: one missed check-in is only a warning. |
| **Valve alarm** | The TRV reports a valve alarm (stuck pin, motor fault): always DEGRADED (warning, heating continues). Above 0, the room becomes FAILED (`valve_alarm`) when the alarm lasts this long. | `0` (warning only) | Aqara TRVs can keep a stale alarm while working normally; a TRV that really stopped is caught by *Frozen* and *Ack timeout*. |
| **Frozen gap** / **Frozen for** | In external sensor mode the TRV's own temperature should follow the room temperature we send it. If it stays more than *gap* away for *for* minutes, the TRV is considered frozen (`trv_frozen`). This is what caught TRV_CHLOE (31.9 °C against 20.4 °C). | `3` °C / `60` min | Normal lag is a few tenths of a degree. |
| **Ack timeout** | After a setpoint is sent, the TRV must report it within this time (within 0.5 °C, as TRVs round to their step). If not, the setpoint is sent once more (DEGRADED); still not confirmed after a second period, the room is FAILED (`no_ack`). The setpoint is then retried every 3 × this time; the room recovers by itself as soon as the TRV confirms. Armed only once the TRV has reported a setpoint at least once, so a wrong key cannot fail a healthy room. | `5` min | Zigbee2MQTT confirms within seconds. |
| **When FAILED** | *stop asking for heat* (send the Off setpoint to the boiler) or *keep the scheduled demand* (only report the problem). | stop asking | A broken room cannot be heated anyway. |
| **TRV temp key** | Field of the TRV's own temperature in its state message. | `local_temperature` | Zigbee2MQTT name. |
| **TRV alarm key** | Field of the valve alarm in its state message. | `valve_alarm` | Zigbee2MQTT name for Aqara E1. |

**Status detail**: every state comes with a plain-language explanation of what is happening and what to do,
shown in Home Assistant (entity *Status detail*, attribute `status`), for example: *"Warning, heating continues
normally. The TRV reports a valve alarm since 22:50, but it still follows the room temperature (20.2 °C) and its
setpoint. Check that the valve pin moves freely, then recalibrate the TRV."*

**Health states**: `OK`, `DEGRADED` (a problem started, still heating), `FAILED` (see above),
`UNKNOWN` (just started). The reasons (`sensor_silent`, `trv_silent`, `valve_alarm`, `trv_frozen`,
`no_ack`, `no_sensor_data`, and DEGRADED-only since 0.87 `sensor_mode`, `not_calibrated`, `valve_not_closing`) are shown in the status, sent to the boiler and to Home Assistant.

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
| `override` + `setpoint`, `requestedBy`, `groupId` (+ optional `start`, `duration`) | Override from another valve of the same group (Manual valve on only); same end time when `start`/`duration` are given, duplicates ignored. |
| `auto` | Back to the schedule, end of any override. |
| `on` / `off` (or `0`) | Switch the room on / off. Off sends the Off setpoint to the boiler. |
| `trigger` / `1` | Re-evaluate now. |
| `away` (optional `value`: `true`/`false`, `"on"`/`"off"`) | Away on (default) or off. See *Away mode*. |
| `home` | Away off: the latest scheduled setpoint is applied again. |
| `window` (optional `value`: `true`/`false`) | Window open (default) / closed, as if reported by the window sensor (no delay). |

Messages with `target: "boiler"` (sent by other valves) are ignored.

### Output (to the boiler)

```json
{ "command": "set", "target": "boiler", "setpoint": "20.00", "temperature": "19.50",
  "requestedBy": "SV_CHLOE", "groupId": "52", "health": "OK", "reasons": [], "away": false, "window": false }
```

Sent when the temperature or setpoint changes, when the health changes, and at least every *Heartbeat*.
With Manual valve on, a manual change also sends `command: "override"` on the same output, meant for the other valves of the group (the boiler ignores it).

## Manual change and room sync (0.84)

With *Manual valve* on:

1. A knob turn starts a wait of *Knob settle* seconds; each new step (20.5, 21, 21.5…) restarts it, a repeated value does not.
   Turning back to the current setpoint cancels it. Meanwhile nothing is pushed to the TRV and the boiler demand does not change.
2. When the knob is still, the last value (capped at *Max setpoint*) becomes an override for *Manual … min duration*.
3. With *Share with room*, it is published once on `smartheating/group/<Group id>/manual`
   (`{setpoint, start, duration, groupId, from, requestedBy}`, not retained). Every other valve of that group with Manual valve on
   (not off, not away) applies it with the **same end time**; receivers never re-publish, and TRV confirmations are not taken as knob turns.
4. When it ends, every valve goes back to the latest schedule. The override survives Node-RED restarts.

No flow wiring is needed. The `override` message is still sent on the output (older flows wiring valves together keep working;
a change received twice is applied once). **Group id must be unique per room** with this option: valves of different rooms sharing
a group id would follow each other. Home Assistant attributes: `override_until`, `knob_settling`.

## Window sensor (0.85)

Optional: set **Window sensor [state]** to the Zigbee2MQTT topic of a door/window contact sensor (key `contact`, open when `false`,
both editable). A room with several windows lists them all, separated by commas (0.86), e.g.
`zigbee2mqtt/DS_CHLOE_VELUX_W, zigbee2mqtt/DS_CHLOE_VELUX_E`: the room is paused while **any** of them has been open longer than
the delay and resumes when **all** are closed. Each sensor has its own delay and its own silence timeout.

- Window open for more than **Open delay** (default 60 s, so walking through a door does nothing): the TRV gets the Away setpoint
  (frost protection, 7 °C) and the boiler receives it with `window: true`.
- Window closed: the current schedule is applied at once; a manual override in progress resumes with its original end time; a knob
  turned while open is put back; a knob still settling when the window opens is dropped.
- With *Share with room*, every valve with the same Group id follows (topic `smartheating/group/<Group id>/window`, refreshed every
  5 min while open, forgotten 15 min after the sending valve went silent): one sensor per room is enough.
- A sensor silent for more than the timeout (default 180 min) is taken as closed, so a flat battery never stops a room from heating.
- Not a fault: health stays OK. Survives a Node-RED restart. From a flow: `{command:"window", value:true|false}`.
- Home Assistant: **Window** binary sensor (device class window); attributes `window`, `window_since`, `window_source` (`sensor` / `room`),
  `window_sensors` (names of the open ones); the status detail names them too.

The Aqara TRV's own *window detection* (temperature drop) can stay on or be switched off; with a real sensor it is no longer needed.

## Away mode (0.83)

For a room (or the whole house) left empty for a while:

- the TRV gets the **Away setpoint** (frost protection, default 7 °C);
- the boiler receives the Away setpoint with `away: true`: the room no longer drives the heating, except to keep it above
  the frost setpoint (smart-boiler lists it under *Rooms away*);
- the scheduler keeps sending its setpoints, they are recorded and the latest one is applied when back home;
  a running override is cancelled, a knob turn on the TRV is put back, overrides from the group are ignored;
- the state is saved (state file) and survives Node-RED restarts and deploys; health checks keep running.

Set it from a flow (`{command:"away"}`, `{command:"home"}`) or from the **Away** switch in Home Assistant
(e.g. an automation on presence: all valves away when everybody leaves).

To take a valve out of smart-boiler completely (valve removed, room closed), send `remove` to the boiler, see the smart-boiler README.

## TRV restart and calibration (0.87)

A TRV that restarts (batteries changed, power lost) forgets part of its settings: an Aqara E1 boots on its
**internal** sensor with its own setpoint. Until 0.86 this showed up later as a "frozen" TRV with the wrong advice
("power-cycle the TRV"), as with TRV_SALON_ESCALIER on 2 Nov 2026.

**Detection**, from the TRV state message: sensor mode different from *Sensor type* (e.g. `internal` instead of
`external`), power outage counter up, or battery up by 20 points or more. Battery level and counter are saved, so a
battery changed while Node-RED was stopped is still seen. The sensor mode is also asked (`<TRV>/get`) every hour,
because Zigbee2MQTT only publishes changes.

**Re-apply** (default on): the sensor mode, the room temperature and the setpoint are sent again at once. For
3 min, a setpoint the TRV reports is its own boot value, not a knob turn: it is put back, never taken as an override.
A TRV that keeps the wrong mode is sent it again every 5 min and the room is DEGRADED (`sensor_mode`) after 10 min.

**Auto calibrate** (default on): the TRV is calibrated 2 min after a restart or a battery change (the motor finds its
end stops again), once when it reports `calibrated: false` outside a calibration (DEGRADED `not_calibrated` if it
stays so), and once per episode of *valve not closing*.

**Limit**: at most **At most** automatic calibrations within **Within** hours (default **2 in 24 h**), kept across
restarts. Beyond, the calibration is skipped, logged and shown in the status and in Home Assistant
(`calibration_skipped`). Settings are always re-applied; only calibration is limited. A calibration asked by hand,
`{command:"calibrate"}` or the *Calibrate TRV* button in Home Assistant, runs at once and is not counted.

**Valve not closing** (DEGRADED `valve_not_closing`): the setpoint is at least 1 °C under the room for 60 min (time
for the radiator to cool), yet the TRV body temperature (`device_temperature`) stays more than **Leak gap** (6 °C) above
the room for **Leak for** (30 min): hot water still goes through the radiator. In external sensor mode the TRV's
`local_temperature` mirrors the room, so only its body reading shows this. The demand to the boiler is not changed.

| Field | Default |
|---|---|
| Re-apply | on |
| Auto calibrate | on |
| At most / Within | `2` calibrations / `24` h |
| Calibrate topic / payload | empty = next to *Sensor type Set* (`…/set/calibrate`) / `calibrate` |
| Leak gap / Leak for | `6` °C (0 = off) / `30` min |
| Sensor mode, outage, battery, calibrated, body temp keys | `sensor`, `power_outage_count`, `battery`, `calibrated`, `device_temperature` (Zigbee2MQTT, Aqara E1) |

## Home Assistant

Tick **HA discovery** in the `smart-valve-settings` node (once for all valves). Each valve appears as a
device **SmartValve <name>** with:

| Entity | Value |
|---|---|
| Health | `OK` / `DEGRADED` / `FAILED` |
| Problem (binary sensor) | on when DEGRADED or FAILED — use it for alerts |
| Requested setpoint | what the room asks the boiler for (the Off setpoint when FAILED) |
| Room temperature | from the room sensor |
| Status detail | plain-language explanation of the state and what to do (first 255 characters; full text in the `status` attribute) |
| Away (switch) | on = away. Command topic `smartheating/valve/<name>/away/set`, payload `ON` / `OFF` (retained; the node keeps it in line when away is changed from a flow) |
| Calibrate TRV (button) | calibrates the TRV now (0.87), not counted in the automatic limit |
| Room sensor check, TRV link check, Valve alarm check, TRV tracking check, Setpoint confirmation check, TRV settings check, Valve closing check | one line per check, e.g. *"OK: 19.0 °C, reported 4 min ago (limit 120 min)."*; attribute `level` = `ok` / `warning` / `waiting` / `failed` / `off` |

All these share the state topic `smartheating/valve/<name>/state`, whose attributes include `reasons`,
`health_since`, `scheduled_setpoint`, `trv_setpoint`, `trv_temperature`, `trv_age_min`, `sensor_age_min`,
`valve_alarm`, `override`, `mode`, `away` and `away_setpoint`, and since 0.87 `trv_sensor`, `trv_calibrated`,
`trv_battery`, `trv_body_temperature`, `valve_not_closing`, `trv_restarted`, `trv_restart_reason`, `last_calibration`,
`last_calibration_reason`, `calibration_pending`, `calibrations_in_window`, `calibration_limit`, `calibration_skipped`. The device becomes *unavailable* when Node-RED stops.

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
- Keep *Re-apply* and *Auto calibrate* on; change the batteries of all TRVs of a room together (lithium AA hold their voltage in the cold).

## State persistence

The node saves its state to `~/.node-red/.node-red-state/valve-{node-id}.json` (and to the node context):
requested setpoint, setpoint applied to the TRV, scheduled setpoint, room temperature and timestamp, and since 0.87
the TRV battery level and outage counter, the automatic calibrations of the window and the last restart and calibration. It is
restored when Node-RED restarts or the flow is redeployed. A restored room temperature only counts as fresh from
start-up: if the sensor stays silent, the room becomes FAILED after the sensor timeout instead of trusting the old
value forever.

## Tests

```
npm install
npm test
```

108 tests run the node with a fake clock, an in-memory MQTT broker and simulated Zigbee2MQTT devices (a room
sensor and a TRV that can be healthy, stuck or dead), including a replay of a stuck-TRV incident.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

---
*Author: Vincent BESSON*
*License: Creative Commons*

<a href="https://www.buymeacoffee.com/vincentbe" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
