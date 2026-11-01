# Changelog

## 0.86.0 — 2026-11-01

- Several window sensors per valve: the topic field takes a list (commas, semicolons, spaces or new lines). The room is paused
  while any window has been open longer than the delay and resumes when all are closed; each sensor has its own delay and
  silence timeout; the open ones survive a restart. Home Assistant attribute `window_sensors` and status detail name them.

## 0.85.0 — 2026-11-01

- Window sensor (optional topic, key `contact`, open when `false`): a window open for more than 60 s stops the heating of the
  room (TRV and boiler at the Away/frost setpoint, `window: true`); closing it restores the schedule at once, a manual override
  keeps its end time. Shared with the other valves of the group (`smartheating/group/<id>/window`). A sensor silent for 3 h is
  taken as closed. Home Assistant *Window* binary sensor. Input command `window`.

## 0.84.0 — 2026-11-01

- Rotary knob: a knob turn is taken once the knob stays still for **Knob settle** seconds (default 20), and at most
  after **Knob max wait** (default 60 s); the steps in between are neither pushed back nor sent to the boiler, turning back cancels it.
- Room sync (**Share with room**, default on): the manual change is published once on
  `smartheating/group/<Group id>/manual` and applied by every other valve of the group (Manual valve on) with the same
  end time, no flow wiring needed. The `override` output message carries `start`/`duration`; duplicates are ignored.
- A single 0.5 °C detent is now detected (it was taken as TRV rounding).
- An override in progress survives a restart and still ends on time (it used to stay until the next schedule change).
- Home Assistant: `override_until`, `knob_settling`.

## 0.83.0 — 2026-11-01

- Away mode: `{command:"away"}` / `{command:"home"}` or the new **Away** switch in Home Assistant
  (`smartheating/valve/<name>/away/set`, ON/OFF, retained). The TRV gets the new **Away setpoint** (frost protection,
  default 7 °C), the boiler receives it with `away: true`, the schedule is recorded and applied again on return,
  a running override is cancelled, knob turns are put back, group overrides ignored. Saved across restarts.
- Home Assistant state: `away`, `away_setpoint`; status and Status detail show *Away*.
- Fix: a TRV changed within one minute of a push (manual valve off) is now put back at the next cycle instead of
  being left as is.

## 0.82.1 — 2026-10-30

- A valve alarm alone no longer makes a room FAILED: it is a warning (DEGRADED) by default, because Aqara TRVs
  can keep a stale alarm while working normally. "Valve alarm" > 0 restores escalation after that many minutes.
- New "Status detail" (Home Assistant entity and `status` attribute): plain-language explanation of the state,
  with times, values and what to do.
- Five check entities (Room sensor, TRV link, Valve alarm, TRV tracking, Setpoint confirmation), one line each
  with a `level` attribute (ok / warning / waiting / failed / off); also in the `checks` attribute.
- TRV timeout default 150 min (was 90): a quiet Aqara TRV missing one ~52 min check-in is now DEGRADED, not FAILED.
  FAILED only after the full timeout.
- Setpoint confirmation: a TRV reporting within 0.5 °C (rounding to its step) counts as confirmed; an unconfirmed
  setpoint is sent once more (DEGRADED) before the room becomes FAILED (`no_ack`).
- Manual valve on: a knob turn during the confirmation window is accepted as an override; the value of an override
  that just expired coming back within 30 min is pushed back instead of starting a new override.
- Setpoints restored at start-up are capped at Max setpoint.

## 0.82.0 — 2026-10-30

Hardening after a stuck TRV kept the boiler heating for several nights.

- The scheduler is the single source of truth: the setpoint reported by the TRV is never forwarded to the
  boiler unless "Manual valve" is on; otherwise the scheduled value is pushed back to the TRV.
- Overrides expire and restore the scheduled setpoint; scheduler updates received during an override are kept.
- The "Manual duration" option is read (it was ignored, always 60 min).
- Room health (OK / DEGRADED / FAILED): sensor silent, TRV silent, valve alarm, frozen TRV, setpoint not
  acknowledged. A FAILED room stops asking the boiler for heat (configurable) and recovers by itself.
- Heartbeat to the boiler (default 10 min); health and reasons added to the boiler message.
- Max setpoint (default 24 °C) for every setpoint applied or forwarded.
- Optional Home Assistant discovery (Health, Problem, Requested setpoint, Room temperature).
- Fixes: crash on a non-JSON MQTT payload or a numeric command; demand not restored after off→on; MQTT queue
  dropped after an invalid entry; duplicate subscription; "sensor type" re-sent on every temperature change;
  MQTT outage logged once instead of every retry.
- Editor: Safety section; upgraded nodes show the defaults of the new options.
- Tests: `npm test` (27 tests, fake clock and simulated Zigbee2MQTT devices).
