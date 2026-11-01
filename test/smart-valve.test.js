/*
 * smart-valve 0.82 test suite.
 * Runs on a fake clock with a fake Node-RED runtime, an in-memory MQTT broker and simulated
 * Zigbee2MQTT devices (see test/helpers/fake-red.js). Run with: npm test
 */
'use strict';
const assert = require('assert');
const sinon = require('sinon');
const H = require('./helpers/fake-red');

const START = Date.parse('2026-10-29T20:00:00+01:00');
let clock, RED, rooms;

function load(settings = {}) {
    delete require.cache[require.resolve('../smart-valve.js')];
    RED = H.createRED();
    require('../smart-valve.js')(RED);
    RED.addConfig('vs', Object.assign({ mqttHost: 'broker', mqttPort: 1883, mqttRootPath: 'homeassistant', haDiscovery: false, haBaseTopic: 'smartheating' }, settings));
}

const min = (n) => clock.tick(n * 60000);
const sec = (n) => clock.tick(n * 1000);

// Builds a room: valve node, room sensor and TRV, in the order a real start-up would see them.
function room(name, o = {}) {
    const v = RED.create('smart-valve', H.valveConfig('v_' + name, name, o.cfg || {}));
    clock.tick(10);                                     // MQTT connect + subscribe
    const th = new H.Sensor(`zigbee2mqtt/TH_${name}`, o.temp !== undefined ? o.temp : 19, o.sensorEvery || 20).start();
    const trv = new H.Trv(`TRV_${name}`, { mode: o.mode, state: o.trvState, ignoreExternal: o.ignoreExternal, step: o.step, every: o.trvEvery }).start();
    sec(2);
    const r = { v, th, trv };
    rooms.push(r);
    return r;
}

const boilerMsgs = (v) => v.sent.filter(s => s.msg.payload && s.msg.payload.target === 'boiler');
const lastBoiler = (v) => { const a = boilerMsgs(v); return a.length ? a[a.length - 1].msg.payload : undefined; };
const schedule = (v, sp) => RED.input(v, { payload: { command: 'set', setpoint: sp } });

// A room with the schedule applied and settled, ready for a scenario.
function settledRoom(name, o = {}) {
    const r = room(name, o);
    schedule(r.v, o.sp !== undefined ? o.sp : 20);
    min(2);
    return r;
}

describe('smart-valve 0.82', function () {
    this.timeout(60000);      // long simulated periods (12 h, 25 h) on a fake clock; slow disks need more than 2 s
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        H.resetBroker();
        rooms = [];
        load();
    });
    afterEach(async function () {
        rooms.forEach(r => { r.th.stop(); r.trv.stop(); });
        for (const r of rooms) await RED.close(r.v);
        clock.restore();
    });

    describe('Setpoint flow (scheduler is the source of truth)', function () {
        it('V-01 applies the scheduled setpoint to the TRV and sends the demand to the boiler', function () {
            const { v, trv } = settledRoom('LOU', { temp: 19, trvState: { occupied_heating_setpoint: 18 } });
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
            const p = lastBoiler(v);
            assert.strictEqual(p.setpoint, '20.00');
            assert.strictEqual(p.temperature, '19.00');
            assert.strictEqual(p.requestedBy, 'LOU');
            assert.strictEqual(p.health, 'OK');
        });

        it('V-02 manual valve off: a knob change on the TRV is pushed back and never reaches the boiler', function () {
            const { v, trv } = settledRoom('LOU');
            const before = boilerMsgs(v).length;
            trv.knob(23);
            sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20, 'TRV put back to the schedule');
            const after = boilerMsgs(v).slice(before).map(m => m.msg.payload.setpoint);
            assert.ok(!after.includes('23.00'), 'boiler never received 23');
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-03 manual valve on: a knob change becomes an override, capped at max setpoint', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true, maxSp: '22' } });
            trv.knob(25);
            sec(35);                                 // knob settles (20 s)
            const ov = v.sent.map(s => s.msg.payload).filter(p => p && p.command === 'override');
            assert.strictEqual(ov.length, 1);
            assert.strictEqual(ov[0].setpoint, 22);
            assert.strictEqual(lastBoiler(v).setpoint, '22.00');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 22, 'TRV capped to 22');
        });

        it('V-04 override expires after the configured duration and the schedule is restored', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true, OverrideDuration: '30' } });
            trv.knob(22);
            sec(35);                                 // knob settles (20 s)
            assert.strictEqual(lastBoiler(v).setpoint, '22.00');
            min(28);
            assert.strictEqual(lastBoiler(v).setpoint, '22.00', 'still overridden at 28 min');
            min(4);
            assert.strictEqual(lastBoiler(v).setpoint, '20.00', 'schedule back after 30 min');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
        });

        it('V-05 a schedule change during an override is kept and applied when it ends', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true, OverrideDuration: '30' } });
            trv.knob(22);
            sec(35);                                 // knob settles (20 s)
            schedule(v, 18);
            sec(5);
            assert.strictEqual(lastBoiler(v).setpoint, '22.00', 'override still wins');
            min(32);
            assert.strictEqual(lastBoiler(v).setpoint, '18.00', 'new schedule applied after expiry');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 18);
        });

        it('V-06 reads the editor option "OverrideDuration" (was ignored in 0.81)', function () {
            const { v } = room('LOU', { cfg: { allowOverride: true, OverrideDuration: '15' } });
            assert.strictEqual(v.overrideDuration, 15);
        });

        it('V-07 caps a scheduled setpoint above max setpoint', function () {
            const { v, trv } = settledRoom('LOU', { sp: 30 });
            assert.strictEqual(lastBoiler(v).setpoint, '24.00');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 24);
        });
    });

    describe('Health checks', function () {
        it('V-08 room sensor silent -> FAILED sensor_silent, demand released, recovers when it reports', function () {
            const { v, th } = settledRoom('LOU', { temp: 19 });
            th.alive = false;
            min(115);
            assert.strictEqual(v.health.state, 'OK');
            min(10);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.deepStrictEqual(v.health.reasons, ['sensor_silent']);
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
            assert.strictEqual(lastBoiler(v).health, 'FAILED');
            th.alive = true; th.set(19.2);
            sec(2);
            assert.strictEqual(v.health.state, 'OK');
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-09 TRV silent: DEGRADED after half the timeout (demand kept), FAILED after 150 min', function () {
            const { v, trv } = settledRoom('LOU');
            trv.mode = 'dead';
            min(70);
            assert.strictEqual(v.health.state, 'OK');
            min(10);
            assert.strictEqual(v.health.state, 'DEGRADED');
            assert.deepStrictEqual(v.health.reasons, ['trv_silent']);
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
            min(75);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
        });

        it('V-10 valve alarm alone is a warning: DEGRADED, room keeps heating, OK when cleared', function () {
            const { v, trv } = settledRoom('LOU');
            trv.state.valve_alarm = true; trv.report();
            sec(2);
            assert.strictEqual(v.health.state, 'DEGRADED');
            min(180);
            assert.strictEqual(v.health.state, 'DEGRADED', 'never escalates by default');
            assert.strictEqual(lastBoiler(v).setpoint, '20.00', 'still heating');
            trv.state.valve_alarm = false; trv.report();
            sec(2);
            assert.strictEqual(v.health.state, 'OK');
        });

        it('V-10b "Valve alarm" above 0 escalates to FAILED after that many minutes', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { alarmDuration: '60' } });
            trv.state.valve_alarm = true; trv.report();
            sec(2);
            min(59);
            assert.strictEqual(v.health.state, 'DEGRADED');
            min(2);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.deepStrictEqual(v.health.reasons, ['valve_alarm']);
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
        });

        it('V-11 frozen TRV (its temperature far from the room sensor) -> FAILED trv_frozen after 60 min', function () {
            const { v } = settledRoom('LOU', { temp: 19, ignoreExternal: true, trvState: { local_temperature: 31.9 } });
            assert.strictEqual(v.health.state, 'DEGRADED');
            assert.deepStrictEqual(v.health.reasons, ['trv_frozen']);
            min(60);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
        });

        it('V-12 frozen check is skipped in internal sensor mode (no external temperature topic)', function () {
            const { v } = settledRoom('LOU', { temp: 19, ignoreExternal: true, trvState: { local_temperature: 27 },
                cfg: { valveTemperatureSetTopic: '', valveTemperatureSensorTypeSetTopic: '' } });
            min(120);
            assert.strictEqual(v.health.state, 'OK');
        });

        it('V-13 setpoint not acknowledged: sent again once (DEGRADED), then FAILED, retried, recovers', function () {
            const { v, trv } = settledRoom('LOU');
            trv.mode = 'stuck';
            schedule(v, 21);
            min(4);
            assert.strictEqual(v.health.state, 'OK');
            min(2);
            assert.strictEqual(v.health.state, 'DEGRADED', 'first miss: sent again');
            assert.strictEqual(lastBoiler(v).setpoint, '21.00');
            min(6);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.deepStrictEqual(v.health.reasons, ['no_ack']);
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
            const pushes = trv.sets.filter(s => s.key === 'occupied_heating_setpoint').length;
            min(16);
            assert.ok(trv.sets.filter(s => s.key === 'occupied_heating_setpoint').length > pushes, 'setpoint retried');
            trv.mode = 'healthy';
            min(16);
            assert.strictEqual(v.health.state, 'OK');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 21);
            assert.strictEqual(lastBoiler(v).setpoint, '21.00');
        });

        it('V-14 no acknowledgement check before the TRV has ever reported (wrong key cannot fail a room)', function () {
            const { v } = settledRoom('LOU', { mode: 'dead', cfg: { trvTimeout: '0' } });
            schedule(v, 21);
            min(30);
            assert.strictEqual(v.health.state, 'OK');
            assert.strictEqual(lastBoiler(v).setpoint, '21.00');
        });

        it('V-15 "When FAILED = keep" keeps the scheduled demand', function () {
            const { v, th } = settledRoom('LOU', { cfg: { failedAction: 'failedAction.keep' } });
            th.alive = false;
            min(125);
            assert.strictEqual(v.health.state, 'FAILED');
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-16 a check set to 0 is disabled', function () {
            const { v, th } = settledRoom('LOU', { cfg: { sensorTimeout: '0' } });
            th.alive = false;
            min(300);
            assert.ok(!v.health.reasons.includes('sensor_silent'));
        });
    });

    describe('Boiler messages and modes', function () {
        it('V-17 heartbeat re-sends the demand every 10 min when nothing changes', function () {
            const { v } = settledRoom('LOU');
            const n0 = boilerMsgs(v).length;
            min(60);
            const n = boilerMsgs(v).length - n0;
            assert.ok(n >= 5 && n <= 7, `expected ~6 heartbeats, got ${n}`);
        });

        it('V-18 "off" command sends the off setpoint', function () {
            const { v } = settledRoom('LOU');
            RED.input(v, { payload: { command: 'off' } });
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
            RED.input(v, { payload: { command: 'on' } });
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-19 TRV switched off on the device sends the off setpoint', function () {
            const { v, trv } = settledRoom('LOU');
            trv.state.system_mode = 'off'; trv.report();
            sec(2);
            assert.strictEqual(lastBoiler(v).setpoint, '5.00');
        });

        it('V-20 messages for the boiler sent by other valves are ignored', function () {
            const { v } = settledRoom('LOU');
            RED.input(v, { payload: { command: 'set', target: 'boiler', setpoint: 25, temperature: 10 } });
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });
    });

    describe('Robustness', function () {
        it('V-21 malformed MQTT payloads do not crash or change the temperature', function () {
            const { v } = settledRoom('LOU', { temp: 19 });
            ['not json', 'null', '42', '{"temperature":"abc"}', '{"temperature":999}', '{}'].forEach(p =>
                H.broker.publish('zigbee2mqtt/TH_LOU', p));
            assert.doesNotThrow(() => sec(2));
            assert.strictEqual(v.refTemp, 19);
            H.broker.publish('zigbee2mqtt/TRV_LOU', '{"occupied_heating_setpoint":"x"}');
            assert.doesNotThrow(() => sec(2));
        });

        it('V-22 invalid input commands are rejected', function () {
            const { v } = settledRoom('LOU');
            [{}, { payload: null }, { payload: { command: 'set' } }, { payload: { command: 'set', setpoint: 'abc' } },
             { payload: { command: 'set', setpoint: 55 } }, { payload: { command: 42 } }, { payload: { command: 'boom' } }]
                .forEach(m => assert.doesNotThrow(() => RED.input(v, m)));
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-23 a restored temperature is not trusted forever after a restart', async function () {
            const r = settledRoom('LOU', { temp: 19 });
            r.th.stop();
            await RED.close(r.v);
            rooms = [];
            const v = RED.create('smart-valve', H.valveConfig('v_LOU', 'LOU'));      // same id: state file reloaded
            rooms.push({ v, th: { stop() {} }, trv: r.trv });
            sec(5);
            assert.strictEqual(v.refTemp, 19);
            min(125);
            assert.ok(v.health.reasons.includes('sensor_silent'));
        });
    });

    describe('Home Assistant discovery', function () {
        it('V-24 publishes discovery, availability and state when enabled', function () {
            load({ haDiscovery: true });
            const { v, th } = settledRoom('LOU');
            const uid = 'smartvalve_vLOU';
            ['sensor/' + uid + '/health', 'binary_sensor/' + uid + '/problem', 'sensor/' + uid + '/setpoint', 'sensor/' + uid + '/temperature']
                .forEach(t => assert.ok(H.broker.retained['homeassistant/' + t + '/config'], 'missing ' + t));
            const cfg = JSON.parse(H.broker.retained['homeassistant/sensor/' + uid + '/health/config']);
            assert.strictEqual(cfg.state_topic, 'smartheating/valve/lou/state');
            assert.strictEqual(H.broker.retained['smartheating/valve/lou/availability'], 'online');
            let st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.health, 'OK');
            assert.strictEqual(st.boiler_setpoint, 20);
            th.alive = false;
            min(125);
            st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.health, 'FAILED');
            assert.deepStrictEqual(st.reasons, ['sensor_silent']);
            assert.strictEqual(st.boiler_setpoint, 5);
        });

        it('V-25 publishes nothing for Home Assistant when disabled (default)', function () {
            settledRoom('LOU');
            assert.ok(!Object.keys(H.broker.retained).some(t => t.startsWith('homeassistant/') || t.startsWith('smartheating/')));
        });

        it('V-26 marks the valve offline in Home Assistant when the node closes', async function () {
            load({ haDiscovery: true });
            const r = settledRoom('LOU');
            await RED.close(r.v);
            rooms = rooms.filter(x => x !== r); r.th.stop(); r.trv.stop();
            assert.strictEqual(H.broker.retained['smartheating/valve/lou/availability'], 'offline');
        });
    });

    describe('Status detail (plain-language explanation)', function () {
        const status = () => JSON.parse(H.broker.retained['smartheating/valve/lou/state']).status;

        it('V-28 explains a healthy room, a valve alarm and a failure with times and actions', function () {
            load({ haDiscovery: true });
            const { th, trv } = settledRoom('LOU', { temp: 19 });
            assert.match(status(), /^OK, following the schedule: 20\.0 °C, room 19\.0 °C, asking for heat\./);
            trv.state.valve_alarm = true; trv.report();
            sec(2);
            assert.match(status(), /^Warning, heating continues normally\. The TRV reports a valve alarm since \d\d:\d\d, but it still follows the room temperature \(19\.0 °C\)/);
            assert.match(status(), /recalibrate the TRV\.$/);
            trv.state.valve_alarm = false; trv.report();
            th.alive = false;
            min(125);
            assert.match(status(), /^FAILED: this room no longer asks the boiler for heat\. Room sensor silent for 12\d min \(limit 120 min\)/);
        });

        it('V-29 explains a frozen TRV and a setpoint not acknowledged', function () {
            load({ haDiscovery: true });
            const r = settledRoom('LOU', { temp: 19, ignoreExternal: true, trvState: { local_temperature: 31.9 } });
            assert.match(status(), /The TRV reads 31\.9 °C while the room is 19\.0 °C since \d\d:\d\d: it no longer follows the room temperature.*becomes a failure at \d\d:\d\d/);
            r.trv.mode = 'stuck';
            schedule(r.v, 21);
            min(6);
            assert.match(status(), /Setpoint 21\.0 °C was not confirmed by the TRV within 5 min; sent again at \d\d:\d\d\./);
            min(6);
            assert.match(status(), /Setpoint 21\.0 °C sent at \d\d:\d\d was not confirmed by the TRV \(it reports 20\.0 °C\); retried every 15 min/);
        });

        const checks = () => JSON.parse(H.broker.retained['smartheating/valve/lou/state']).checks;

        it('V-31 every check has its own line, also when everything is OK', function () {
            load({ haDiscovery: true });
            settledRoom('LOU', { temp: 19 });
            const c = checks();
            assert.deepStrictEqual(Object.keys(c).sort(), ['sensor', 'setpoint', 'tracking', 'trv_link', 'valve_alarm']);
            Object.values(c).forEach(x => assert.strictEqual(x.level, 'ok', JSON.stringify(x)));
            assert.match(c.sensor.text, /^OK: 19\.0 °C, reported \d+ min ago \(limit 120 min\)\.$/);
            assert.match(c.trv_link.text, /^OK: last message \d+ min ago \(limit 150 min\)\.$/);
            assert.strictEqual(c.valve_alarm.text, 'OK: no valve alarm reported.');
            assert.strictEqual(c.tracking.text, 'OK: TRV reads 19.0 °C, room 19.0 °C (gap 0.0 °C, limit 3).');
            assert.strictEqual(c.setpoint.text, 'OK: the TRV has 20.0 °C, as requested.');
        });

        it('V-32 each failing check explains itself; the others stay OK', function () {
            load({ haDiscovery: true });
            const r = settledRoom('LOU', { temp: 19 });
            r.trv.state.valve_alarm = true; r.trv.report();
            sec(2);
            let c = checks();
            assert.strictEqual(c.valve_alarm.level, 'warning');
            assert.match(c.valve_alarm.text, /^Warning: alarm since \d\d:\d\d, the TRV still follows its setpoint and the room temperature\. Warning only \(Valve alarm = 0\)\./);
            assert.strictEqual(c.sensor.level, 'ok');
            r.trv.state.valve_alarm = false; r.trv.report();
            r.th.alive = false;
            min(125);
            c = checks();
            assert.strictEqual(c.sensor.level, 'failed');
            assert.match(c.sensor.text, /^Failed: silent for 12\d min \(limit 120 min\)\. Check the sensor battery/);
            assert.strictEqual(c.trv_link.level, 'ok');
        });

        it('V-33 tracking and setpoint checks: warning, waiting and failed', function () {
            load({ haDiscovery: true });
            const r = settledRoom('LOU', { temp: 19, ignoreExternal: true, trvState: { local_temperature: 31.9 } });
            let c = checks();
            assert.strictEqual(c.tracking.level, 'warning');
            assert.match(c.tracking.text, /^Warning: TRV reads 31\.9 °C, room 19\.0 °C \(gap 12\.9 °C, limit 3\) since \d\d:\d\d\. Becomes a failure at \d\d:\d\d\./);
            r.trv.mode = 'stuck';
            schedule(r.v, 21);
            sec(30);
            c = checks();
            assert.strictEqual(c.setpoint.level, 'waiting');
            min(6);
            c = checks();
            assert.strictEqual(c.setpoint.level, 'warning');
            assert.match(c.setpoint.text, /^Warning: 21\.0 °C not confirmed within 5 min, sent again at \d\d:\d\d\.$/);
            min(6);
            c = checks();
            assert.strictEqual(c.setpoint.level, 'failed');
            assert.match(c.setpoint.text, /^Failed: 21\.0 °C sent at \d\d:\d\d, the TRV still reports 20\.0 °C; retried every 15 min/);
            min(60);
            assert.strictEqual(checks().tracking.level, 'failed');
        });

        it('V-34 the five checks are published as Home Assistant entities', function () {
            load({ haDiscovery: true });
            settledRoom('LOU');
            ['sensor', 'trv_link', 'valve_alarm', 'tracking', 'setpoint'].forEach(k => {
                const cfg = JSON.parse(H.broker.retained['homeassistant/sensor/smartvalve_vLOU/check_' + k + '/config']);
                assert.ok(cfg.name.endsWith('check'), cfg.name);
                assert.strictEqual(cfg.value_template, `{{ value_json.checks.${k}.text[:255] }}`);
            });
        });

        it('V-30 publishes the Status detail entity to Home Assistant', function () {
            load({ haDiscovery: true });
            settledRoom('LOU');
            const cfg = JSON.parse(H.broker.retained['homeassistant/sensor/smartvalve_vLOU/status/config']);
            assert.strictEqual(cfg.name, 'Status detail');
            assert.strictEqual(cfg.state_topic, 'smartheating/valve/lou/state');
        });
    });

    describe('Review fixes (0.82.1)', function () {
        it('V-35 a TRV that rounds to 0.5 °C steps confirms 20.2 °C as 20 °C', function () {
            const { v, trv } = settledRoom('LOU', { step: 0.5 });
            schedule(v, 20.2);
            min(20);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
            assert.strictEqual(v.health.state, 'OK');
        });

        it('V-36 manual valve on: a knob turn while a setpoint is being applied is taken as an override', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            trv.mode = 'stuck';
            schedule(v, 21);
            sec(5);
            trv.mode = 'healthy';
            trv.knob(22);
            min(2);                                   // input just received: evaluation waits for the next cycle
            assert.strictEqual(lastBoiler(v).setpoint, '22.00');
            assert.strictEqual(v.overrideMode, true);
            min(10);
            assert.strictEqual(v.health.state, 'OK');
        });

        it('V-37 manual valve on: the expired override value coming back is not a new override', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true, OverrideDuration: '30' } });
            trv.knob(23);
            sec(35);                                 // knob settles (20 s)
            assert.strictEqual(lastBoiler(v).setpoint, '23.00');
            min(32);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20, 'schedule restored');
            trv.knob(23);                             // the TRV reverts to its stale value
            min(2);
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
            assert.strictEqual(v.overrideMode, false);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20, 'pushed back');
        });

        it('V-38 a setpoint restored at start-up is capped at max setpoint', function () {
            const fs = require('fs'), path = require('path');
            const dir = path.join(RED.settings.userDir, '.node-red-state');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'valve-v_LOU.json'), JSON.stringify({ requestSp: 28, scheduledSp: 28, sp: 28, refTemp: 19 }));
            const v = RED.create('smart-valve', H.valveConfig('v_LOU', 'LOU', { maxSp: '21' }));
            rooms.push({ v, th: { stop() {} }, trv: { stop() {} } });
            assert.strictEqual(v.requestSp, 21);
            assert.strictEqual(v.scheduledSp, 21);
        });

        it('V-39 one missed TRV check-in (quiet TRV, ~52 min) warns but keeps heating', function () {
            const { v, trv } = settledRoom('LOU', { trvEvery: 52 });
            trv.mode = 'dead';
            min(100);
            assert.strictEqual(v.health.state, 'DEGRADED');
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
            trv.mode = 'healthy'; trv.report();
            sec(2);
            assert.strictEqual(v.health.state, 'OK');
        });
    });

    describe('Incident replay (TRV_CHLOE, 25-30 Oct 2026)', function () {
        it('V-27 stuck TRV reporting 23 °C with manual valve on: room FAILED and demand released within the hour', function () {
            // As in production: SV_CHLOE had "Manual valve" on; TRV_CHLOE stuck at sp 23, local 31.9,
            // valve alarm on, checking in hourly with the cached values. Schedule 19 °C, room 19.5 °C.
            const r = room('CHLOE', { temp: 19.5, mode: 'stuck', cfg: { allowOverride: true },
                trvState: { occupied_heating_setpoint: 23, local_temperature: 31.9, valve_alarm: true } });
            schedule(r.v, 19);
            min(12 * 60);
            const msgs = boilerMsgs(r.v).map(m => ({ t: m.t, sp: parseFloat(m.msg.payload.setpoint) }));
            const firstRelease = msgs.find(m => m.sp === 5);
            assert.ok(firstRelease, 'demand released');
            assert.ok(firstRelease.t - START <= 65 * 60000, `released after ${(firstRelease.t - START) / 60000} min`);
            const after = msgs.filter(m => m.t >= firstRelease.t);
            assert.ok(after.every(m => m.sp === 5), 'stays released for the rest of the night');
            assert.ok(!msgs.some(m => m.sp === 23 && m.t - START > 5 * 60000), 'never asks the boiler for 23 °C');
            assert.strictEqual(r.v.health.state, 'FAILED');
        });
    });

    describe('Away mode (0.83)', function () {
        const away = (v, val) => RED.input(v, { payload: val === undefined ? { command: 'away' } : { command: 'away', value: val } });

        it('V-40 away: frost setpoint on the TRV and to the boiler, schedule kept and applied when back home', function () {
            const { v, trv } = settledRoom('LOU', { temp: 19 });
            away(v);
            sec(5);
            assert.strictEqual(v.away, true);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            const p = lastBoiler(v);
            assert.strictEqual(p.setpoint, '7.00');
            assert.strictEqual(p.away, true);
            schedule(v, 21);                                   // the scheduler keeps running while away
            sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7, 'schedule not applied while away');
            assert.strictEqual(lastBoiler(v).setpoint, '7.00');
            RED.input(v, { payload: { command: 'home' } });
            sec(5);
            assert.strictEqual(v.away, false);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 21, 'latest schedule applied on return');
            assert.strictEqual(lastBoiler(v).setpoint, '21.00');
            assert.strictEqual(lastBoiler(v).away, false);
        });

        it('V-41 away setpoint is configurable and still asks for heat below it (frost protection)', function () {
            const { v, th } = settledRoom('LOU', { temp: 19, cfg: { awaySp: '8' } });
            away(v, 'on');
            th.temp = 6; th.report(); sec(5);
            const p = lastBoiler(v);
            assert.strictEqual(p.setpoint, '8.00');
            assert.strictEqual(p.temperature, '6.00');
            assert.match(v._status.text, /Away t:6.00°C, sp:8.00°C/);
            assert.strictEqual(v._status.fill, "blue");
        });

        it('V-42 a knob turn while away is put back, an override running is cancelled, group overrides ignored', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            trv.knob(23);
            sec(35);                                 // knob settles (20 s)
            assert.strictEqual(v.overrideMode, true);
            away(v, true);
            sec(5);
            assert.strictEqual(v.overrideMode, false, 'override cancelled');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            trv.knob(22);
            min(2);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7, 'knob turn put back');
            assert.ok(!v.sent.some(s => s.msg.payload.command === 'override' && s.msg.payload.setpoint === 22), 'no override sent');
            RED.input(v, { payload: { command: 'override', setpoint: 24, requestedBy: 'OTHER', groupId: '1' } });
            sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            assert.strictEqual(lastBoiler(v).setpoint, '7.00');
            RED.input(v, { payload: { command: 'home' } });
            sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20, 'schedule, not the cancelled override');
        });

        it('V-43 away survives a Node-RED restart', async function () {
            const r = settledRoom('LOU');
            away(r.v);
            sec(5);
            r.th.stop();
            await RED.close(r.v);
            rooms = [];
            const v = RED.create('smart-valve', H.valveConfig('v_LOU', 'LOU'));
            const th = new H.Sensor('zigbee2mqtt/TH_LOU', 19, 20).start();
            rooms.push({ v, th, trv: r.trv });
            sec(5);
            assert.strictEqual(v.away, true);
            assert.strictEqual(r.trv.state.occupied_heating_setpoint, 7);
            assert.strictEqual(lastBoiler(v).setpoint, '7.00');
        });

        it('V-44 invalid away values are rejected', function () {
            const { v } = settledRoom('LOU');
            assert.doesNotThrow(() => away(v, 'maybe'));
            assert.strictEqual(v.away, false);
        });

        it('V-45 Home Assistant: Away switch discovered, set from Home Assistant, state and retained command in line', function () {
            load({ haDiscovery: true });
            const { v, trv } = settledRoom('LOU');
            const uid = 'smartvalve_vLOU';
            const cfg = JSON.parse(H.broker.retained['homeassistant/switch/' + uid + '/away/config']);
            assert.strictEqual(cfg.command_topic, 'smartheating/valve/lou/away/set');
            assert.strictEqual(cfg.state_topic, 'smartheating/valve/lou/state');
            let st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.away, false);
            H.broker.publish('smartheating/valve/lou/away/set', 'ON', { retain: true });
            sec(5);
            assert.strictEqual(v.away, true);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.away, true);
            assert.strictEqual(st.away_setpoint, 7);
            assert.match(st.status, /^Away: frost protection at 7\.0 °C/);
            RED.input(v, { payload: { command: 'home' } });      // from a flow, not from Home Assistant
            sec(5);
            assert.strictEqual(H.broker.retained['smartheating/valve/lou/away/set'], 'OFF', 'retained command follows');
            assert.strictEqual(JSON.parse(H.broker.retained['smartheating/valve/lou/state']).away, false);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
        });
    });

    describe('Manual change: rotary knob and room sync (0.84)', function () {
        const ov = (v) => v.sent.map(x => x.msg.payload).filter(p => p && p.command === 'override');
        const grp = (g) => H.broker.on(`smartheating/group/${g}/manual`);
        const salon = (cfg = {}) => ['BIBLIO', 'ESCALIER', 'CANAPE'].map(n => settledRoom(n, { cfg: Object.assign({ allowOverride: true, groupId: '3' }, cfg) }));

        it('V-50 a rotary knob (20.5, 21, 21.5, 22 in 6 s) gives one override at 22 once it stays still', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            const b0 = boilerMsgs(v).length;
            [20.5, 21, 21.5, 22].forEach(sp => { trv.knob(sp); sec(2); });
            sec(10);
            assert.strictEqual(ov(v).length, 0, 'nothing while the knob moves');
            assert.strictEqual(trv.state.occupied_heating_setpoint, 22, 'the knob is never fought');
            assert.match(v._status.text, /Knob 22\.0°C settling/);
            sec(10);                                    // last step at 6 s -> taken at 26 s
            assert.strictEqual(ov(v).length, 1, 'taken 20 s after the last step');
            assert.strictEqual(ov(v)[0].setpoint, 22);
            assert.strictEqual(v.overrideMode, true);
            const sps = boilerMsgs(v).slice(b0).map(m => m.msg.payload.setpoint);
            assert.deepStrictEqual([...new Set(sps)], ['22.00'], 'boiler never sees the intermediate steps');
        });

        it('V-51 a single detent (0.5 °C) is a manual change', function () {
            const { v } = settledRoom('LOU', { cfg: { allowOverride: true } });
            v.sent.length = 0;
            const trv = rooms[0].trv;
            trv.knob(20.5);
            sec(35);
            assert.strictEqual(ov(v).length, 1);
            assert.strictEqual(lastBoiler(v).setpoint, '20.50');
        });

        it('V-52 knob turned and back to the setpoint before it settles: nothing happens', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            trv.knob(21); sec(3); trv.knob(20.5); sec(3); trv.knob(20);
            sec(40);
            assert.strictEqual(ov(v).length, 0);
            assert.strictEqual(v.overrideMode, false);
            assert.strictEqual(v.manual, null);
            assert.strictEqual(lastBoiler(v).setpoint, '20.00');
        });

        it('V-53 a knob that never settles (jittering TRV) is still taken and shared after 1 min', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            for (let i = 0; i < 3; i++) { trv.knob(i % 2 ? 21.5 : 21); sec(15); }   // steps at 0, 15, 30 s
            trv.knob(21.5); sec(14);                                                 // step at 45 s, now 59 s
            assert.strictEqual(ov(v).length, 0, 'still waiting at 59 s');
            sec(1);
            assert.strictEqual(ov(v).length, 1, 'taken at 60 s');
            assert.strictEqual(v.overrideMode, true);
        });

        it('V-54 a knob turn in a 3-valve room is applied to the others with the same end time, once, without wiring', function () {
            const [a, b, c] = salon();
            const lou = settledRoom('LOU', { cfg: { allowOverride: true, groupId: '51' } });
            a.trv.knob(21.5); sec(1); a.trv.knob(22);
            sec(35);
            assert.strictEqual(grp(3).length, 1, 'one group message');
            [b, c].forEach(r => {
                assert.strictEqual(r.trv.state.occupied_heating_setpoint, 22);
                assert.strictEqual(r.v.overrideMode, true);
                assert.strictEqual(r.v.overrideStartTs, a.v.overrideStartTs, 'same end time');
                assert.strictEqual(ov(r.v).length, 0, 'receivers do not re-broadcast');
                assert.strictEqual(lastBoiler(r.v).setpoint, '22.00');
            });
            assert.strictEqual(lou.trv.state.occupied_heating_setpoint, 20, 'other room untouched');
            min(5);
            assert.strictEqual(grp(3).length, 1, 'TRV echoes are not new manual changes');
            min(56);
            [a, b, c].forEach(r => {
                assert.strictEqual(r.v.overrideMode, false);
                assert.strictEqual(r.trv.state.occupied_heating_setpoint, 20, 'schedule back everywhere');
            });
        });

        it('V-55 the same change received twice (MQTT and flow wiring) is applied once', function () {
            const [a, b] = salon();
            a.trv.knob(22);
            sec(35);
            const start = b.v.overrideStartTs, sets = b.trv.sets.length;
            RED.input(b.v, { payload: ov(a.v)[0] });          // as if a's output were wired to b
            sec(5);
            assert.strictEqual(b.v.overrideStartTs, start);
            assert.strictEqual(b.trv.sets.length, sets, 'no second push');
        });

        it('V-56 valves with Manual valve off, off or away ignore the room change', function () {
            const a = settledRoom('BIBLIO', { cfg: { allowOverride: true, groupId: '3' } });
            const b = settledRoom('ESCALIER', { cfg: { allowOverride: false, groupId: '3' } });
            const c = settledRoom('CANAPE', { cfg: { allowOverride: true, groupId: '3' } });
            RED.input(c.v, { payload: { command: 'away' } }); sec(5);
            a.trv.knob(22);
            sec(35);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 20);
            assert.strictEqual(c.trv.state.occupied_heating_setpoint, 7);
            assert.strictEqual(b.v.overrideMode, false);
        });

        it('V-57 a room override survives a restart and still ends on time', async function () {
            const [a, b] = salon();
            a.trv.knob(22);
            sec(35);
            min(10);
            b.th.stop();
            await RED.close(b.v);
            rooms = rooms.filter(r => r !== b);
            const v = RED.create('smart-valve', H.valveConfig('v_ESCALIER', 'ESCALIER', { allowOverride: true, groupId: '3' }));
            const th = new H.Sensor('zigbee2mqtt/TH_ESCALIER', 19, 20).start();
            rooms.push({ v, th, trv: b.trv });
            sec(5);
            assert.strictEqual(v.overrideMode, true);
            assert.strictEqual(lastBoiler(v).setpoint, '22.00');
            min(51);
            assert.strictEqual(v.overrideMode, false);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 20);
        });

        it('V-58 the room change is capped at Max setpoint on every valve', function () {
            const [a, b] = salon({ maxSp: '22' });
            a.trv.knob(25);
            sec(40);
            assert.strictEqual(a.trv.state.occupied_heating_setpoint, 22);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 22);
        });

        it('V-59 a schedule change during the room override is applied to every valve when it ends', function () {
            const rs = salon();
            rs[0].trv.knob(22);
            sec(35);
            rs.forEach(r => schedule(r.v, 18));
            sec(5);
            rs.forEach(r => assert.strictEqual(r.trv.state.occupied_heating_setpoint, 22));
            min(61);
            rs.forEach(r => assert.strictEqual(r.trv.state.occupied_heating_setpoint, 18));
        });

        it('V-60 "Share with room" off: the change stays on its own valve', function () {
            const [a, b] = salon({ groupSync: false });
            a.trv.knob(22);
            sec(35);
            assert.strictEqual(grp(3).length, 0);
            assert.strictEqual(a.v.overrideMode, true);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 20);
        });

        it('V-61 Home Assistant shows when the override ends and a knob settling', function () {
            load({ haDiscovery: true });
            const { trv } = settledRoom('LOU', { cfg: { allowOverride: true } });
            trv.knob(22); sec(3);
            let st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            sec(35);
            st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.override, true);
            assert.ok(st.override_until && Date.parse(st.override_until) > Date.now() + 59 * 60000);
            assert.strictEqual(st.knob_settling, null);
        });
    });

    describe('Window sensor (0.85)', function () {
        const WIN = (name) => ({ windowStateTopic: `zigbee2mqtt/WIN_${name}` });
        const win = (name, open) => H.broker.publish(`zigbee2mqtt/WIN_${name}`, JSON.stringify({ contact: !open, battery: 100 }));
        const grpWin = (g) => H.broker.on(`smartheating/group/${g}/window`);

        it('W-01 window open for more than 60 s: frost setpoint on the TRV and to the boiler; closed: schedule back at once', function () {
            const { v, trv } = settledRoom('LOU', { cfg: WIN('LOU') });
            win('LOU', true);
            sec(50);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20, 'nothing before the delay');
            sec(15);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            let p = lastBoiler(v);
            assert.strictEqual(p.setpoint, '7.00');
            assert.strictEqual(p.window, true);
            assert.match(v._status.text, /^Window open/);
            win('LOU', false);
            sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
            p = lastBoiler(v);
            assert.strictEqual(p.setpoint, '20.00');
            assert.strictEqual(p.window, false);
        });

        it('W-02 a door opened for less than the delay changes nothing', function () {
            const { v, trv } = settledRoom('LOU', { cfg: WIN('LOU') });
            const n = boilerMsgs(v).length;
            win('LOU', true); sec(30); win('LOU', false); sec(60);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
            assert.ok(!boilerMsgs(v).slice(n).some(m => m.msg.payload.setpoint === '7.00'));
        });

        it('W-03 schedule changes while open are applied on close; a manual override keeps its end time', function () {
            const { v, trv } = settledRoom('LOU', { cfg: Object.assign({ allowOverride: true }, WIN('LOU')) });
            trv.knob(22); sec(25);
            assert.strictEqual(v.overrideMode, true);
            const end = v.overrideStartTs + 60 * 60000;
            win('LOU', true); sec(65);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            schedule(v, 19); sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7, 'still paused');
            win('LOU', false); sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 22, 'override resumes');
            assert.strictEqual(v.overrideStartTs + 60 * 60000, end, 'same end time');
            clock.tick(end - Date.now() + 2 * 60000);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 19, 'then the latest schedule');
        });

        it('W-04 a knob turn while the window is open is put back, a knob settling is cancelled', function () {
            const { v, trv } = settledRoom('LOU', { cfg: Object.assign({ allowOverride: true, windowOpenDelay: '10' }, WIN('LOU')) });
            trv.knob(23); sec(5);                              // settling (taken at 25 s)...
            win('LOU', true); sec(12);                         // ...but the window pauses the room at 15 s
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            sec(50);
            assert.strictEqual(v.manual, null);
            assert.strictEqual(v.overrideMode, false);
            trv.knob(24); min(2);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
        });

        it('W-05 one sensor pauses the whole room (same group), closing resumes everyone', function () {
            const a = settledRoom('BIBLIO', { cfg: Object.assign({ groupId: '3' }, WIN('BIBLIO')) });
            const b = settledRoom('ESCALIER', { cfg: { groupId: '3' } });
            const c = settledRoom('CANAPE', { cfg: { groupId: '3' } });
            const lou = settledRoom('LOU', { cfg: { groupId: '51' } });
            win('BIBLIO', true); sec(65);
            [a, b, c].forEach(r => assert.strictEqual(r.trv.state.occupied_heating_setpoint, 7, r.v.name));
            assert.strictEqual(lastBoiler(b.v).window, true);
            assert.strictEqual(lou.trv.state.occupied_heating_setpoint, 20, 'other room untouched');
            min(20);                                          // refreshed every 5 min: still paused
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 7);
            win('BIBLIO', false); sec(5);
            [a, b, c].forEach(r => assert.strictEqual(r.trv.state.occupied_heating_setpoint, 20, r.v.name));
        });

        it('W-06 a room window state is forgotten 15 min after its valve went silent', async function () {
            const a = settledRoom('BIBLIO', { cfg: Object.assign({ groupId: '3' }, WIN('BIBLIO')) });
            const b = settledRoom('ESCALIER', { cfg: { groupId: '3' } });
            win('BIBLIO', true); sec(65);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 7);
            a.th.stop(); a.trv.stop(); await RED.close(a.v); rooms = rooms.filter(r => r !== a);
            min(22);
            assert.strictEqual(b.trv.state.occupied_heating_setpoint, 20, 'heating resumes');
        });

        it('W-07 a window sensor silent for more than 3 h is taken as closed', function () {
            const { trv } = settledRoom('LOU', { cfg: WIN('LOU') });
            win('LOU', true); sec(65);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            min(185);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
        });

        it('W-08 an open window survives a Node-RED restart', async function () {
            const r = settledRoom('LOU', { cfg: WIN('LOU') });
            win('LOU', true); sec(65);
            r.th.stop(); await RED.close(r.v); rooms = [];
            const v = RED.create('smart-valve', H.valveConfig('v_LOU', 'LOU', WIN('LOU')));
            const th = new H.Sensor('zigbee2mqtt/TH_LOU', 19, 20).start();
            rooms.push({ v, th, trv: r.trv });
            sec(5);
            assert.strictEqual(v.window.eff, true);
            assert.strictEqual(lastBoiler(v).setpoint, '7.00');
            win('LOU', false); sec(5);
            assert.strictEqual(r.trv.state.occupied_heating_setpoint, 20);
        });

        it('W-09 configurable key and open value; window state from a flow', function () {
            const { v, trv } = settledRoom('LOU', { cfg: { windowStateTopic: 'zigbee2mqtt/WIN_LOU', windowKey: 'window', windowOpenValue: 'open', windowOpenDelay: '10' } });
            H.broker.publish('zigbee2mqtt/WIN_LOU', JSON.stringify({ window: 'OPEN' })); sec(15);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            H.broker.publish('zigbee2mqtt/WIN_LOU', JSON.stringify({ window: 'closed' })); sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
            RED.input(v, { payload: { command: 'window', value: true } }); sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 7);
            RED.input(v, { payload: { command: 'window', value: false } }); sec(5);
            assert.strictEqual(trv.state.occupied_heating_setpoint, 20);
        });

        it('W-10 no window topic: nothing subscribed or published, no change of behaviour', function () {
            settledRoom('LOU');
            assert.ok(!H.broker.subs.some(s => /WIN_|\/window$/.test(s.topic) && false));
            win('LOU', true); sec(65);
            assert.strictEqual(rooms[0].trv.state.occupied_heating_setpoint, 20);
            assert.strictEqual(grpWin(1).length, 0);
        });

        it('W-11 Home Assistant: Window binary sensor and status detail', function () {
            load({ haDiscovery: true });
            settledRoom('LOU', { cfg: WIN('LOU') });
            const cfg = JSON.parse(H.broker.retained['homeassistant/binary_sensor/smartvalve_vLOU/window/config']);
            assert.strictEqual(cfg.device_class, 'window');
            win('LOU', true); sec(65);
            const st = JSON.parse(H.broker.retained['smartheating/valve/lou/state']);
            assert.strictEqual(st.window, true);
            assert.strictEqual(st.window_source, 'sensor');
            assert.match(st.status, /^Window open since \d\d:\d\d \(WIN_LOU\): heating paused, frost protection at 7\.0 °C/);
            assert.deepStrictEqual(st.window_sensors, ['WIN_LOU']);
            assert.strictEqual(st.health, 'OK', 'an open window is not a fault');
        });
    });

    describe('Several window sensors per valve (0.86)', function () {
        const T = (n) => `zigbee2mqtt/${n}`;
        const ds = (n, open) => H.broker.publish(T(n), JSON.stringify({ contact: !open, battery: 100 }));
        const two = (name, extra = {}) => settledRoom(name, { cfg: Object.assign({ windowStateTopic: `${T('DS_' + name + '_W')}, ${T('DS_' + name + '_E')}` }, extra) });
        const sp = (r) => r.trv.state.occupied_heating_setpoint;

        it('M-01 two windows: paused while any is open, resumes only when both are closed', function () {
            const r = two('CHLOE');
            ds('DS_CHLOE_W', true); sec(65);
            assert.strictEqual(sp(r), 7);
            ds('DS_CHLOE_E', true); sec(65);
            ds('DS_CHLOE_W', false); sec(5);
            assert.strictEqual(sp(r), 7, 'E still open');
            assert.strictEqual(lastBoiler(r.v).window, true);
            ds('DS_CHLOE_E', false); sec(5);
            assert.strictEqual(sp(r), 20);
            assert.strictEqual(lastBoiler(r.v).window, false);
        });

        it('M-02 each sensor has its own delay: a short opening of one never adds to another', function () {
            const r = two('ARTHUR');
            ds('DS_ARTHUR_W', true); sec(40); ds('DS_ARTHUR_W', false);      // 40 s: under the delay
            sec(10); ds('DS_ARTHUR_E', true); sec(40);                       // E open for 40 s, W closed
            assert.strictEqual(sp(r), 20, 'no window open for 60 s yet');
            sec(25);
            assert.strictEqual(sp(r), 7, 'E open for 65 s');
        });

        it('M-03 a brief opening of the second window while the first is already open changes nothing', function () {
            const r = two('CHLOE');
            ds('DS_CHLOE_W', true); sec(65);
            const n = r.trv.sets.length;
            ds('DS_CHLOE_E', true); sec(20); ds('DS_CHLOE_E', false); sec(60);
            assert.strictEqual(sp(r), 7);
            assert.strictEqual(r.trv.sets.filter(x => x.key === 'occupied_heating_setpoint').length,
                               r.trv.sets.slice(0, n).filter(x => x.key === 'occupied_heating_setpoint').length, 'no extra push');
            ds('DS_CHLOE_W', false); sec(5);
            assert.strictEqual(sp(r), 20);
        });

        it('M-04 a silent sensor stuck open is dropped after 3 h, the other one still works', function () {
            const r = two('CHLOE');
            ds('DS_CHLOE_W', true); sec(65);
            for (let i = 0; i < 4; i++) { ds('DS_CHLOE_E', false); min(50); }  // E keeps reporting, W silent
            assert.strictEqual(sp(r), 20, 'W silent for more than 180 min: taken as closed');
            ds('DS_CHLOE_E', true); sec(65);
            assert.strictEqual(sp(r), 7, 'E opening still pauses the room');
            ds('DS_CHLOE_E', false); sec(5);
            assert.strictEqual(sp(r), 20);
            ds('DS_CHLOE_W', false); sec(5);                                   // W comes back, closed
            assert.strictEqual(sp(r), 20);
        });

        it('M-05 restart with two windows open: both remembered, closed one by one', async function () {
            const r = two('ARTHUR');
            ds('DS_ARTHUR_W', true); ds('DS_ARTHUR_E', true); sec(65);
            r.th.stop(); await RED.close(r.v); rooms = [];
            const v = RED.create('smart-valve', H.valveConfig('v_ARTHUR', 'ARTHUR', { windowStateTopic: `${T('DS_ARTHUR_W')}, ${T('DS_ARTHUR_E')}` }));
            const th = new H.Sensor('zigbee2mqtt/TH_ARTHUR', 19, 20).start();
            rooms.push({ v, th, trv: r.trv });
            sec(5);
            assert.strictEqual(v.window.eff, true);
            ds('DS_ARTHUR_W', false); sec(5);
            assert.strictEqual(r.trv.state.occupied_heating_setpoint, 7, 'E still open');
            ds('DS_ARTHUR_E', false); sec(5);
            assert.strictEqual(r.trv.state.occupied_heating_setpoint, 20);
        });

        it('M-06 topic list: commas, semicolons, spaces, new lines and duplicates; one subscription each', function () {
            const list = ` ${T('DS_A')},${T('DS_B')} ; ${T('DS_C')}\n${T('DS_A')}  ${T('DS_D')} `;
            const r = settledRoom('LOU', { cfg: { windowStateTopic: list } });
            assert.deepStrictEqual(r.v.windowTopics, [T('DS_A'), T('DS_B'), T('DS_C'), T('DS_D')]);
            ['DS_A', 'DS_B', 'DS_C', 'DS_D'].forEach(n =>
                assert.strictEqual(H.broker.subs.filter(x => x.topic === T(n) && x.client !== undefined && x.client.opts).length, 1, n));
            ds('DS_D', true); sec(65);
            assert.strictEqual(sp(r), 7);
            ds('DS_D', false); sec(5);
            assert.strictEqual(sp(r), 20);
        });

        it('M-07 a window opened from a flow and a sensor are independent', function () {
            const r = two('CHLOE');
            RED.input(r.v, { payload: { command: 'window', value: true } }); sec(5);
            assert.strictEqual(sp(r), 7);
            ds('DS_CHLOE_W', true); sec(65); ds('DS_CHLOE_W', false); sec(5);
            assert.strictEqual(sp(r), 7, 'still open from the flow');
            RED.input(r.v, { payload: { command: 'window', value: false } }); sec(5);
            assert.strictEqual(sp(r), 20);
        });

        it('M-08 room of two valves, one window each: the room resumes only when both windows are closed', function () {
            const banc = settledRoom('CUISINE_BANC', { cfg: { groupId: '4', windowStateTopic: T('DS_CUISINE_WINDOW_LEFT') } });
            const plan = settledRoom('CUISINE_PLAN', { cfg: { groupId: '4', windowStateTopic: T('DS_CUISINE_WINDOW_MID') } });
            ds('DS_CUISINE_WINDOW_MID', true); sec(65);
            assert.strictEqual(sp(banc), 7); assert.strictEqual(sp(plan), 7);
            ds('DS_CUISINE_WINDOW_LEFT', true); sec(65);
            ds('DS_CUISINE_WINDOW_MID', false); sec(5);
            assert.strictEqual(sp(banc), 7); assert.strictEqual(sp(plan), 7, 'LEFT still open (shared by the room)');
            ds('DS_CUISINE_WINDOW_LEFT', false); sec(5);
            assert.strictEqual(sp(banc), 20); assert.strictEqual(sp(plan), 20);
        });

        it('M-09 Home Assistant and status name the open windows', function () {
            load({ haDiscovery: true });
            two('CHLOE');
            ds('DS_CHLOE_W', true); ds('DS_CHLOE_E', true); sec(65);
            const st = JSON.parse(H.broker.retained['smartheating/valve/chloe/state']);
            assert.deepStrictEqual(st.window_sensors.sort(), ['DS_CHLOE_E', 'DS_CHLOE_W']);
            assert.match(st.status, /^Window open since \d\d:\d\d \((DS_CHLOE_W, DS_CHLOE_E|DS_CHLOE_E, DS_CHLOE_W)\)/);
        });
    });
});
