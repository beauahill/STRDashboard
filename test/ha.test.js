import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, getSetting } from '../server/db.js';
import {
  classify, connectHA, haSettings, saveEntities, saveHASettings, storeStates, evaluateAlerts, activeAlerts, occupancy, climatePhase, climateFor,
  runClimate, freezeProtect, runCheckoutLocks, pollHA, homeStatus, homeBrief, stayList, stayRecord, HAClient, disconnectHA,
} from '../server/ha.js';
import { saveNotifySettings, collect, runNotifications } from '../server/notify.js';

const T = s => Date.parse(s);
const NOW = T('2026-10-13T18:00:00Z');             // noon in Laramie
const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes: { friendly_name: entity_id.split('.')[1].replace(/_/g, ' '), ...attributes } });
const DEVICES = () => [
  st('climate.living_room', 'heat', { current_temperature: 64, temperature: 62, hvac_modes: ['off', 'heat', 'cool', 'heat_cool'], min_temp: 45, max_temp: 90, hvac_action: 'idle' }),
  st('lock.front_door', 'locked'), st('lock.back_door', 'locked'),
  st('binary_sensor.kitchen_leak', 'off', { device_class: 'moisture' }),
  st('binary_sensor.smoke_alarm', 'off', { device_class: 'smoke' }),
  st('sensor.bedroom_temperature', '66', { device_class: 'temperature', unit_of_measurement: '°F' }),
  st('sensor.outdoor_temperature', '30', { device_class: 'temperature', unit_of_measurement: '°F' }),
  st('sensor.bedroom_humidity', '40', { device_class: 'humidity', unit_of_measurement: '%' }),
  st('sensor.living_pm2_5', '4', { device_class: 'pm25', unit_of_measurement: 'µg/m³' }),
  st('sensor.front_door_battery', '80', { device_class: 'battery', unit_of_measurement: '%' }),
  st('light.porch', 'on'), st('sensor.power', '120', { device_class: 'power' }),
];

function fakeHA(devices = DEVICES()) {
  const states = new Map(devices.map(d => [d.entity_id, d]));
  const calls = [];
  let down = false;
  const fetchImpl = async (url, opts) => {
    if (down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const u = new URL(url);
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (opts.headers.authorization !== 'Bearer good-token') return res(401, { message: 'Unauthorized' });
    if (u.pathname === '/api/config') return res(200, { unit_system: { temperature: '°F' }, location_name: 'Laramie House' });
    if (u.pathname === '/api/states') return res(200, [...states.values()].map(s => structuredClone(s)));
    const m = u.pathname.match(/^\/api\/services\/(\w+)\/(\w+)$/);
    if (!m) return res(404, { message: 'not found' });
    const body = JSON.parse(opts.body), d = states.get(body.entity_id);
    calls.push([`${m[1]}.${m[2]}`, body]);
    if (m[2] === 'set_hvac_mode') d.state = body.hvac_mode;
    if (m[2] === 'set_temperature') Object.assign(d.attributes, Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'entity_id')));
    if (m[2] === 'lock') d.state = 'locked';
    return res(200, []);
  };
  return { fetchImpl, states, calls, set: (id, state, attrs = {}) => { const d = states.get(id); d.state = state; Object.assign(d.attributes, attrs); }, down: v => { down = v; } };
}

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name) VALUES(1,'Laramie House'); INSERT INTO rooms(id,property_id,name) VALUES(10,1,'Whole house');");
  // Arrives Wed Oct 14 (check-in 4 PM = 22:00 UTC), leaves Fri Oct 16 (11 AM = 17:00 UTC).
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,source) VALUES(1,1,10,'confirmed','Airbnb','2026-10-14','2026-10-16',2,'Sam Rivers','beds24')`).run();
  return db;
}
async function connected(ha = fakeHA()) {
  const db = setup();
  await connectHA(db, { url: 'https://ha.example.com/', token: 'good-token' }, ha.fetchImpl);
  return { db, ha };
}
const poll = (db, ha, at) => pollHA(db, { now: at, fetchImpl: ha.fetchImpl });

test('classify picks out the devices this app follows', () => {
  const roles = Object.fromEntries(DEVICES().map(d => [d.entity_id, classify(d)]));
  assert.equal(roles['climate.living_room'], 'thermostat');
  assert.equal(roles['lock.front_door'], 'lock');
  assert.equal(roles['binary_sensor.kitchen_leak'], 'leak');
  assert.equal(roles['binary_sensor.smoke_alarm'], 'safety');
  assert.equal(roles['sensor.bedroom_temperature'], 'temperature');
  assert.equal(roles['sensor.outdoor_temperature'], 'outdoor');
  assert.equal(roles['sensor.living_pm2_5'], 'pm25');
  assert.equal(roles['sensor.front_door_battery'], 'battery');
  assert.equal(roles['light.porch'], null);
  assert.equal(roles['sensor.power'], null);
});

test('connect: checks address and token, follows the relevant devices, never needs the token again', async () => {
  const ha = fakeHA();
  const db = setup();
  await assert.rejects(connectHA(db, { url: 'ha.example.com', token: 'x' }, ha.fetchImpl), /Enter your Home Assistant address/);
  await assert.rejects(connectHA(db, { url: 'https://ha.example.com', token: '' }, ha.fetchImpl), /long-lived access token/);
  await assert.rejects(connectHA(db, { url: 'https://ha.example.com', token: 'wrong' }, ha.fetchImpl), /rejected the access token/);
  const s = await connectHA(db, { url: 'https://ha.example.com/', token: 'good-token' }, ha.fetchImpl);
  assert.equal(s.url, 'https://ha.example.com');
  assert.equal(s.name, 'Laramie House');
  assert.equal(Object.keys(s.entities).length, 10);
  assert.deepEqual(s.entities['lock.front_door'], { role: 'lock', propertyId: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ha_states').get().n, 10);
  const view = homeStatus(db, NOW);
  assert.ok(!JSON.stringify(view).includes('good-token'), 'the token is never in what the page gets');
  assert.equal(view.devices.find(d => d.id === 'climate.living_room').current, 64);
  // Reconnecting with a blank token keeps the saved one; the device choices are kept.
  saveEntities(db, { 'lock.front_door': { role: 'lock', propertyId: 1 } });
  await connectHA(db, { url: 'https://ha.example.com', token: '' }, ha.fetchImpl);
  assert.deepEqual(Object.keys(haSettings(db).entities), ['lock.front_door']);
  assert.throws(() => saveEntities(db, { 'lock.front_door': { role: 'toaster' } }), /Unknown device type/);
  assert.throws(() => saveEntities(db, { 'not an entity': { role: 'lock' } }), /isn't a Home Assistant entity/);
  await assert.rejects(new HAClient('https://ha.example.com', 'good-token', async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); }).states(), /Couldn't reach Home Assistant at https:\/\/ha.example.com \(ENOTFOUND\)/);
});

test('alerts: leaks at once, freeze after 5 minutes, clear only after recovering, and keep the worst reading', async () => {
  const { db, ha } = await connected();
  ha.set('binary_sensor.kitchen_leak', 'on');
  ha.set('sensor.bedroom_temperature', '49');
  await poll(db, ha, NOW);
  assert.deepEqual(activeAlerts(db, NOW).map(a => a.title), ['Leak detected: kitchen leak']);
  assert.equal(activeAlerts(db, NOW)[0].priority, 5);
  assert.deepEqual(activeAlerts(db, NOW + 5 * 60e3).map(a => a.rule).sort(), ['freeze', 'leak']);
  ha.set('sensor.bedroom_temperature', '47');
  await poll(db, ha, NOW + 6 * 60e3);
  ha.set('sensor.bedroom_temperature', '51');      // above 50 but not by the 2° margin: still a problem
  await poll(db, ha, NOW + 7 * 60e3);
  assert.ok(activeAlerts(db, NOW + 7 * 60e3).some(a => a.rule === 'freeze'));
  ha.set('sensor.bedroom_temperature', '53');
  ha.set('binary_sensor.kitchen_leak', 'off');
  await poll(db, ha, NOW + 8 * 60e3);
  assert.equal(activeAlerts(db, NOW + 8 * 60e3).length, 0);
  const log = db.prepare("SELECT * FROM ha_alert_log WHERE rule = 'freeze'").get();
  assert.equal(log.peak, 47, 'lowest temperature kept');
  assert.equal(log.until, new Date(NOW + 8 * 60e3).toISOString());
});

test('alerts: unlocked only matters when nobody is staying; offline, battery and air quality', async () => {
  const { db, ha } = await connected();
  ha.set('lock.back_door', 'unlocked');
  ha.set('sensor.front_door_battery', '15');
  ha.set('sensor.living_pm2_5', '60');
  ha.set('binary_sensor.smoke_alarm', 'unavailable');
  await poll(db, ha, NOW);
  const later = NOW + 31 * 60e3;
  await poll(db, ha, later);
  const titles = activeAlerts(db, later).map(a => a.title);
  assert.ok(titles.includes('back door is unlocked with no guest staying'));
  assert.ok(titles.includes('front door battery: battery at 15%'));
  assert.ok(titles.includes('smoke alarm is offline'));
  const air = activeAlerts(db, later).find(a => a.rule === 'air');
  assert.equal(air.title, 'Air quality: PM2.5 60 µg/m³ (living pm2 5)');
  assert.equal(air.message, 'No guests staying.');
  // During the stay the door being unlocked is the guest's business, and smoke-like air is called out.
  const stay = T('2026-10-15T15:00:00Z');
  await poll(db, ha, stay);
  await poll(db, ha, stay + 31 * 60e3);
  const during = activeAlerts(db, stay + 31 * 60e3);
  assert.ok(!during.some(a => a.rule === 'unlocked'));
  assert.equal(during.find(a => a.rule === 'air').message, 'During a guest stay: possible smoking or vaping.');
});

test('alerts reach phone notifications once, including Home Assistant being unreachable', async () => {
  const { db, ha } = await connected();
  saveNotifySettings(db, { enabled: true }, NOW - 3600e3);
  ha.set('binary_sensor.kitchen_leak', 'on');
  await poll(db, ha, NOW);
  const items = collect(db, NOW).filter(i => i.refs[0][0] === 'home');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Leak detected: kitchen leak');
  assert.equal(items[0].priority, 5);
  const pushes = [];
  const fetchImpl = async (url, o) => { pushes.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => '' }; };
  await runNotifications(db, { now: NOW, fetchImpl });
  await runNotifications(db, { now: NOW + 60e3, fetchImpl });
  assert.equal(pushes.length, 1);
  ha.down(true);
  await assert.rejects(poll(db, ha, NOW + 2 * 60e3), /Couldn't reach Home Assistant/);
  await assert.rejects(poll(db, ha, NOW + 33 * 60e3), /Couldn't reach/);
  assert.ok(activeAlerts(db, NOW + 33 * 60e3).some(a => a.title === 'Home Assistant can\'t be reached'));
  ha.down(false);
  await poll(db, ha, NOW + 34 * 60e3);
  assert.ok(!activeAlerts(db, NOW + 34 * 60e3).some(a => a.rule === 'unreachable'));
  saveNotifySettings(db, { home: false });
  assert.equal(collect(db, NOW + 34 * 60e3).filter(i => i.refs[0][0] === 'home').length, 0);
});

test('booking climate: eco when vacant, warm before check-in, set once per phase, back to eco after checkout', async () => {
  const { db, ha } = await connected();
  assert.throws(() => saveHASettings(db, { climate: { propertyId: 1, enabled: true } }), /at least one thermostat/);
  assert.throws(() => saveHASettings(db, { climate: { propertyId: 1, thermostats: ['lock.front_door'] } }), /Choose thermostats/);
  assert.throws(() => saveHASettings(db, { climate: { propertyId: 1, thermostats: ['climate.living_room'], vacantHeat: 45, freezeFloor: 50 } }), /below the freeze-protection/);
  saveHASettings(db, { climate: { propertyId: 1, enabled: true, thermostats: ['climate.living_room'] } });

  await poll(db, ha, NOW);
  assert.deepEqual(ha.calls, [['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 58 }]]);
  await poll(db, ha, NOW + 60e3);
  assert.equal(ha.calls.length, 1, 'not set again while still vacant');

  const preheat = T('2026-10-14T19:00:00Z');          // 3 hours before the 4 PM check-in
  await poll(db, ha, preheat - 60e3);
  assert.equal(ha.calls.length, 1);
  await poll(db, ha, preheat);
  assert.deepEqual(ha.calls[1], ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 68 }]);
  ha.set('climate.living_room', 'heat', { temperature: 72 });   // the guest turns it up
  await poll(db, ha, preheat + 3600e3);
  assert.equal(ha.calls.length, 2, 'the guest\'s choice is left alone during the stay');

  const setback = T('2026-10-16T17:30:00Z');          // 30 minutes after the 11 AM checkout
  await poll(db, ha, setback - 60e3);
  assert.equal(ha.calls.length, 2);
  await poll(db, ha, setback);
  assert.deepEqual(ha.calls[2], ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 58 }]);
  assert.match(homeStatus(db, setback).actions[0].detail, /^No guests \(eco\): heat to 58°F/);
});

test('booking climate: thermostat off, heat/cool range, °C, and failures notify once', async () => {
  const ha = fakeHA();
  ha.set('climate.living_room', 'off');
  const { db } = await connected(ha);
  saveHASettings(db, { climate: { propertyId: 1, enabled: true, thermostats: ['climate.living_room'] } });
  await poll(db, ha, NOW);
  assert.deepEqual(ha.calls, [['climate.set_hvac_mode', { entity_id: 'climate.living_room', hvac_mode: 'heat' }],
    ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 58 }]]);

  ha.set('climate.living_room', 'heat_cool', { target_temp_low: 60, target_temp_high: 80 });
  await poll(db, ha, NOW + 60e3);
  assert.equal(ha.calls.length, 2, 'not set again in the same phase');
  await runClimate(db, new HAClient('https://ha.example.com', 'good-token', ha.fetchImpl), NOW + 60e3, { force: true });
  assert.deepEqual(ha.calls.at(-1), ['climate.set_temperature', { entity_id: 'climate.living_room', target_temp_low: 58, target_temp_high: 82 }]);

  const s = haSettings(db);
  setSetting(db, 'ha', JSON.stringify({ ...s, unit: '°C' }));
  ha.set('climate.living_room', 'heat', { min_temp: 7, max_temp: 35 });
  await poll(db, ha, NOW + 2 * 60e3);
  await runClimate(db, new HAClient('https://ha.example.com', 'good-token', ha.fetchImpl), NOW + 2 * 60e3, { force: true });
  assert.deepEqual(ha.calls.at(-1), ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 14.5 }], '58°F sent as 14.5°C');

  setSetting(db, 'ha', JSON.stringify({ ...s, unit: '°F' }));
  setSetting(db, 'ha_climate_last', '{}');
  ha.set('climate.living_room', 'unavailable');
  await poll(db, ha, NOW + 3 * 60e3);
  await poll(db, ha, NOW + 4 * 60e3);
  const fails = db.prepare("SELECT * FROM ha_actions WHERE ok = 0 ORDER BY id").all();
  assert.equal(fails.length, 2, 'retried');
  assert.deepEqual(fails.map(f => f.notify), [1, 0], 'but notified only once');
  assert.match(fails[0].detail, /offline in Home Assistant/);
});

test('freeze protection turns the heat on when the house nears freezing', async () => {
  const ha = fakeHA();
  ha.set('climate.living_room', 'off', { current_temperature: 51 });
  const { db } = await connected(ha);
  saveHASettings(db, { climate: { propertyId: 1, enabled: true, thermostats: ['climate.living_room'], offMode: 'leave' } });
  await poll(db, ha, NOW);
  assert.deepEqual(ha.calls, [['climate.set_hvac_mode', { entity_id: 'climate.living_room', hvac_mode: 'heat' }],
    ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 50 }]]);
  const a = db.prepare("SELECT * FROM ha_actions WHERE kind = 'freeze'").get();
  assert.match(a.detail, /house was at 51°F/);
  assert.equal(a.notify, 1);
  ha.set('climate.living_room', 'off');
  await poll(db, ha, NOW + 3600e3);
  assert.equal(ha.calls.filter(c => c[0] === 'climate.set_hvac_mode').length, 1, 'at most every 6 hours');
});

test('lock after checkout: locks an unlocked door once, leaves a locked one alone', async () => {
  const { db, ha } = await connected();
  saveHASettings(db, { checkoutLock: { propertyId: 1, enabled: true, locks: ['lock.front_door', 'lock.back_door'], minutes: 15 } });
  ha.set('lock.front_door', 'unlocked');
  const due = T('2026-10-16T17:15:00Z');
  await poll(db, ha, due - 60e3);
  assert.equal(ha.calls.length, 0);
  await poll(db, ha, due);
  assert.deepEqual(ha.calls, [['lock.lock', { entity_id: 'lock.front_door' }]]);
  ha.set('lock.front_door', 'unlocked');
  await poll(db, ha, due + 60e3);
  assert.equal(ha.calls.length, 1, 'once per stay');
  const log = db.prepare("SELECT detail FROM ha_actions WHERE kind = 'lock' ORDER BY id").all().map(r => r.detail);
  assert.deepEqual(log.sort(), ['Already locked after Sam Rivers\'s checkout', 'Locked after Sam Rivers\'s checkout']);
  assert.throws(() => saveHASettings(db, { checkoutLock: { propertyId: 1, locks: ['climate.living_room'] } }), /Choose locks/);
});

test('stay records: conditions during each stay, alerts and lock events', async () => {
  const { db, ha } = await connected();
  const checkIn = T('2026-10-14T22:00:00Z');
  for (let i = 0; i < 6; i++) {
    ha.set('sensor.bedroom_temperature', String(68 + i));
    ha.set('sensor.living_pm2_5', i === 3 ? '80' : '5');
    if (i === 2) ha.set('lock.front_door', 'unlocked');
    if (i === 4) ha.set('lock.front_door', 'locked');
    await poll(db, ha, checkIn + i * 11 * 60e3);
  }
  const after = T('2026-10-17T12:00:00Z');
  const [s] = stayList(db, after);
  assert.equal(s.id, 1);
  assert.equal(s.current, false);
  assert.deepEqual(s.summary.pm25, { min: 5, max: 80, avg: 17.5 });
  assert.equal(s.summary.temperature.max, 73);
  assert.equal(s.alerts, 1, 'the PM2.5 spike');
  const r = stayRecord(db, 1, after);
  assert.deepEqual(r.events.map(e => e.to_state), ['unlocked', 'locked']);
  assert.ok(r.series.find(x => x.id === 'sensor.living_pm2_5').points.length === 6);
  assert.equal(r.alerts[0].rule, 'air');
  assert.equal(r.alerts[0].peak, 80);
  assert.equal(homeBrief(db, after).locks.length, 2);
});

test('occupancy and phases use the property\'s check-in and checkout times', async () => {
  const db = setup();
  const before = occupancy(db, 1, T('2026-10-14T21:59:00Z'));
  assert.equal(before.state, 'vacant');
  assert.equal(before.next.id, 1);
  assert.equal(occupancy(db, 1, T('2026-10-14T22:00:00Z')).state, 'occupied');
  assert.equal(occupancy(db, 1, T('2026-10-16T17:00:00Z')).state, 'vacant');
  const cfg = climateFor({ climate: {} }, 1);
  assert.equal(climatePhase(cfg, occupancy(db, 1, T('2026-10-16T17:29:00Z')), T('2026-10-16T17:29:00Z')).phase, 'occupied');
  disconnectHA(db);
  assert.equal(getSetting(db, 'ha') && JSON.parse(getSetting(db, 'ha')).token, '');
});

test('an empty threshold switches that alert off', async () => {
  const { db, ha } = await connected();
  saveHASettings(db, { alerts: { offlineMinutes: '', unlockedMinutes: '' } });
  ha.set('binary_sensor.smoke_alarm', 'unavailable');
  ha.set('lock.back_door', 'unlocked');
  await poll(db, ha, NOW);
  assert.equal(activeAlerts(db, NOW + 24 * 3600e3).length, 0);
  assert.throws(() => saveHASettings(db, { alerts: { freezeBelow: 5 } }), /Freeze alert must be between 32 and 70/);
});

test('stay records only cover properties with their own devices', async () => {
  const { db, ha } = await connected();
  db.exec("INSERT INTO properties(id,name) VALUES(2,'Other Place'); INSERT INTO rooms(id,property_id,name) VALUES(20,2,'Unit');");
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,source) VALUES(2,2,20,'confirmed','VRBO','2026-10-14','2026-10-16',2,'Elsewhere Guest','beds24')`).run();
  ha.set('sensor.front_door_battery', '10');
  await poll(db, ha, T('2026-10-15T12:00:00Z'));
  const list = stayList(db, T('2026-10-17T12:00:00Z'));
  assert.deepEqual(list.map(s => s.id), [1]);
  assert.equal(list[0].alerts, 0, 'a low battery is not something that happened during the stay');
  assert.deepEqual(stayRecord(db, 2, T('2026-10-17T12:00:00Z')).series, []);
});

test('the schedule and freeze protection don\'t fight in the same minute', async () => {
  const ha = fakeHA();
  ha.set('climate.living_room', 'off', { current_temperature: 50 });
  const { db } = await connected(ha);
  saveHASettings(db, { climate: { propertyId: 1, enabled: true, thermostats: ['climate.living_room'] } });
  await poll(db, ha, NOW);
  assert.deepEqual(ha.calls, [['climate.set_hvac_mode', { entity_id: 'climate.living_room', hvac_mode: 'heat' }],
    ['climate.set_temperature', { entity_id: 'climate.living_room', temperature: 58 }]]);
  await poll(db, ha, NOW + 60e3);
  assert.equal(ha.calls.length, 2, 'heat at 58°F is above the floor: nothing more to do');
});
