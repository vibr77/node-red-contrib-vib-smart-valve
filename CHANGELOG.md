# Changelog

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
