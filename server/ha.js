// Home Assistant: live status of the rental's devices (thermostats, locks, leak, air-quality and temperature /
// humidity sensors), alerts when something needs a look, booking-aware thermostat changes, locking the doors after
// checkout, and a record of conditions during each stay. Uses Home Assistant's REST API with a long-lived access
// token, checked every minute. Temperatures are handled in °F here and converted when Home Assistant uses °C.
import { getSetting, setSetting } from './db.js';
import { addDays } from './sync.js';
import { doorSettings, localToday, zonedTimeToUtc } from './doors.js';
import { haFetch, isTailnetHost } from './tailnet.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const iso = t => new Date(t).toISOString();

export const ROLES = {
  thermostat: 'Thermostat', lock: 'Lock', leak: 'Leak sensor', safety: 'Smoke / CO / gas alarm',
  temperature: 'Temperature (inside)', outdoor: 'Temperature (outside)', humidity: 'Humidity',
  pm25: 'PM2.5', pm10: 'PM10', co2: 'CO₂', voc: 'VOC', aqi: 'Air quality index', co: 'Carbon monoxide', battery: 'Battery',
};
const AIR = { pm25: 'pm25Above', co2: 'co2Above', aqi: 'aqiAbove', voc: 'vocAbove', co: 'coAbove' };
export const ALERT_DEFAULTS = {
  freezeBelow: 50, hotAbove: 85, humidityAbove: 75, pm25Above: 35, co2Above: 2000, aqiAbove: 150, vocAbove: null, coAbove: 35,
  batteryBelow: 20, offlineMinutes: 30, unlockedMinutes: 30,
};
export const CLIMATE_DEFAULTS = {
  enabled: false, thermostats: [], occupiedHeat: 68, occupiedCool: 74, vacantHeat: 58, vacantCool: 82,
  preconditionHours: 3, setbackMinutes: 30, offMode: 'heat', freezeFloor: 50,
};
export const LOCK_DEFAULTS = { enabled: false, locks: [], minutes: 15 };
// Minutes a condition must last before it's an alert (a sensor blip isn't).
const DELAY = { leak: 0, safety: 0, jammed: 0, battery: 0, freeze: 5, hot: 15, humidity: 30, air: 10 };

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const toF = (v, unit) => (v == null ? null : unit === '°C' ? Math.round((v * 9 / 5 + 32) * 10) / 10 : v);
const fromF = (f, unit) => (unit === '°C' ? Math.round((f - 32) * 5 / 9 * 2) / 2 : f);

// ---------- Client ----------
export class HAClient {
  constructor(url, token, fetchImpl = haFetch) { this.url = url; this.token = token; this.fetch = fetchImpl; }
  async request(method, path, body) {
    let res;
    try {
      res = await this.fetch(this.url + path, {
        method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      const host = new URL(this.url).hostname;
      if (e.cause?.code === 'ENOTFOUND' && isTailnetHost(host)) {
        throw err(`Couldn't find ${host}: that's a Tailscale address, which only works inside your Tailscale network. `
          + 'Add a Tailscale auth key to the dashboard (TS_AUTHKEY, see DEPLOY.md section 9), or turn on Tailscale Funnel for it.', 502);
      }
      throw err(`Couldn't reach Home Assistant at ${this.url} (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}).`, 502);
    }
    if (res.status === 401 || res.status === 403) throw err('Home Assistant rejected the access token.');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw err(`Home Assistant answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, 502);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  config() { return this.request('GET', '/api/config'); }
  states() { return this.request('GET', '/api/states'); }
  call(domain, service, data) { return this.request('POST', `/api/services/${domain}/${service}`, data); }
}

// ---------- Settings ----------
function load(db) { try { return JSON.parse(getSetting(db, 'ha') || 'null'); } catch { return null; } }
const save = (db, s) => setSetting(db, 'ha', JSON.stringify(s));
export const haConfigured = db => !!load(db)?.token;
export function haSettings(db) {
  const s = load(db) || {};
  return { url: '', token: '', unit: '°F', entities: {}, climate: {}, checkoutLock: {}, ...s, alerts: { ...ALERT_DEFAULTS, ...(s.alerts || {}) } };
}
export const climateFor = (s, pid) => ({ ...CLIMATE_DEFAULTS, ...(s.climate[pid] || {}) });
export const lockFor = (s, pid) => ({ ...LOCK_DEFAULTS, ...(s.checkoutLock[pid] || {}) });
export const haClient = (db, fetchImpl) => { const s = haSettings(db); return s.token ? new HAClient(s.url, s.token, fetchImpl) : null; };

/** Which kind of device an entity is, or null if it isn't one this app follows. */
export function classify(st) {
  const [domain] = st.entity_id.split('.');
  const dc = st.attributes?.device_class;
  if (domain === 'climate') return 'thermostat';
  if (domain === 'lock') return 'lock';
  if (domain === 'binary_sensor') return dc === 'moisture' ? 'leak' : ['smoke', 'carbon_monoxide', 'gas'].includes(dc) ? 'safety' : null;
  if (domain !== 'sensor') return null;
  if (dc === 'temperature') return /outdoor|outside|exterior/i.test(`${st.attributes?.friendly_name || ''} ${st.entity_id}`) ? 'outdoor' : 'temperature';
  return { humidity: 'humidity', pm25: 'pm25', pm10: 'pm10', carbon_dioxide: 'co2', volatile_organic_compounds: 'voc',
    volatile_organic_compounds_parts: 'voc', aqi: 'aqi', carbon_monoxide: 'co', battery: 'battery' }[dc] || null;
}

/** Check the address and token, then (on first connection) follow every relevant device, assigned to the first property. */
export async function connectHA(db, { url, token } = {}, fetchImpl = haFetch) {
  url = String(url || '').trim().replace(/\/+$/, '');
  token = String(token || '').trim() || haSettings(db).token;
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw err('Enter your Home Assistant address, like https://home.example.com.');
  if (!token) throw err('Paste a long-lived access token from your Home Assistant profile.');
  const c = new HAClient(url, token, fetchImpl);
  const cfg = await c.config();
  const states = await c.states();
  if (!Array.isArray(states)) throw err('That address answered, but not like Home Assistant\'s API.', 502);
  const s = { ...haSettings(db), url, token, unit: cfg?.unit_system?.temperature === '°C' ? '°C' : '°F', name: cfg?.location_name || '', connectedAt: iso(Date.now()) };
  if (!Object.keys(s.entities).length) {
    const pid = db.prepare('SELECT id FROM properties WHERE id > 0 ORDER BY name LIMIT 1').get()?.id ?? null;
    s.entities = Object.fromEntries(states.map(st => [st.entity_id, classify(st)]).filter(([, role]) => role).map(([id, role]) => [id, { role, propertyId: pid }]));
  }
  save(db, s);
  storeStates(db, s, states, Date.now());
  setSetting(db, 'ha_error', null); setSetting(db, 'ha_fail_since', null);
  return s;
}

export function disconnectHA(db) {
  save(db, { ...haSettings(db), token: '', climate: Object.fromEntries(Object.entries(haSettings(db).climate).map(([k, v]) => [k, { ...v, enabled: false }])),
    checkoutLock: Object.fromEntries(Object.entries(haSettings(db).checkoutLock).map(([k, v]) => [k, { ...v, enabled: false }])) });
  db.exec('DELETE FROM ha_alerts');
}

/** Every device Home Assistant has that this app could follow, with how it's followed now. */
export async function discover(db, fetchImpl) {
  const c = haClient(db, fetchImpl);
  if (!c) throw err('Connect Home Assistant first.');
  const s = haSettings(db);
  return (await c.states()).map(st => ({ id: st.entity_id, name: st.attributes?.friendly_name || st.entity_id, state: st.state,
    unit: st.attributes?.unit_of_measurement || '', suggested: classify(st), ...(s.entities[st.entity_id] || {}) }))
    .filter(e => e.suggested || e.role).sort((a, b) => (a.role || a.suggested).localeCompare(b.role || b.suggested) || a.name.localeCompare(b.name));
}

export function saveEntities(db, entities) {
  const s = haSettings(db);
  const out = {};
  for (const [id, e] of Object.entries(entities || {})) {
    if (!e?.role) continue;
    if (!/^[a-z_]+\.[\w-]+$/.test(id)) throw err(`"${id}" isn't a Home Assistant entity.`);
    if (!ROLES[e.role]) throw err(`Unknown device type for ${id}.`);
    const pid = e.propertyId == null || e.propertyId === '' ? null : Number(e.propertyId);
    if (pid != null && !db.prepare('SELECT 1 FROM properties WHERE id = ?').get(pid)) throw err('Unknown property.');
    out[id] = { role: e.role, propertyId: pid };
  }
  s.entities = out;
  // Thermostats and locks no longer followed drop out of the automations.
  for (const c of Object.values(s.climate)) c.thermostats = (c.thermostats || []).filter(id => out[id]?.role === 'thermostat');
  for (const c of Object.values(s.checkoutLock)) c.locks = (c.locks || []).filter(id => out[id]?.role === 'lock');
  save(db, s);
  db.prepare(`DELETE FROM ha_alerts WHERE entity_id NOT IN (SELECT value FROM json_each(?)) AND entity_id != '_ha'`).run(JSON.stringify(Object.keys(out)));
  return out;
}

export function saveHASettings(db, input = {}) {
  const s = haSettings(db);
  const n = (v, lo, hi, label, nullable = false) => {
    if ((v === '' || v == null) && nullable) return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < lo || x > hi) throw err(`${label} must be between ${lo} and ${hi}.`);
    return x;
  };
  if (input.alerts) {
    const a = input.alerts, cur = s.alerts;
    const pick = (k, lo, hi, label) => { if (k in a) cur[k] = n(a[k], lo, hi, label, true); };
    pick('freezeBelow', 32, 70, 'Freeze alert'); pick('hotAbove', 70, 110, 'Too-hot alert'); pick('humidityAbove', 30, 100, 'Humidity alert');
    pick('pm25Above', 5, 500, 'PM2.5 alert'); pick('co2Above', 600, 10000, 'CO₂ alert'); pick('aqiAbove', 10, 500, 'Air quality alert');
    pick('vocAbove', 1, 100000, 'VOC alert'); pick('coAbove', 5, 400, 'Carbon monoxide alert'); pick('batteryBelow', 1, 90, 'Battery alert');
    pick('offlineMinutes', 5, 1440, 'Offline alert'); pick('unlockedMinutes', 5, 1440, 'Unlocked-door alert');
  }
  const pidOf = v => {
    const pid = Number(v);
    if (!db.prepare('SELECT 1 FROM properties WHERE id = ?').get(pid)) throw err('Unknown property.');
    return pid;
  };
  if (input.climate) {
    const pid = pidOf(input.climate.propertyId), c = { ...climateFor(s, pid) }, x = input.climate;
    if ('thermostats' in x) {
      if (!Array.isArray(x.thermostats) || x.thermostats.some(id => s.entities[id]?.role !== 'thermostat')) throw err('Choose thermostats from your followed devices.');
      c.thermostats = x.thermostats;
    }
    for (const [k, lo, hi, label] of [['occupiedHeat', 50, 85, 'Guest heat'], ['occupiedCool', 60, 90, 'Guest cooling'], ['vacantHeat', 40, 75, 'Vacant heat'],
      ['vacantCool', 60, 95, 'Vacant cooling'], ['preconditionHours', 0, 24, 'Hours before check-in'], ['setbackMinutes', 0, 720, 'Minutes after checkout'],
      ['freezeFloor', 35, 65, 'Freeze protection']]) if (k in x) c[k] = n(x[k], lo, hi, label);
    if ('offMode' in x) { if (!['heat', 'cool', 'heat_cool', 'leave'].includes(x.offMode)) throw err('Choose what to do when the thermostat is off.'); c.offMode = x.offMode; }
    if (c.occupiedCool < c.occupiedHeat || c.vacantCool < c.vacantHeat) throw err('Cooling temperatures must be at or above heating temperatures.');
    if (c.vacantHeat < c.freezeFloor) throw err('The vacant heat setting is below the freeze-protection temperature.');
    if ('enabled' in x) c.enabled = !!x.enabled;
    if (c.enabled && !c.thermostats.length) throw err('Choose at least one thermostat.');
    s.climate = { ...s.climate, [pid]: c };
  }
  if (input.checkoutLock) {
    const pid = pidOf(input.checkoutLock.propertyId), c = { ...lockFor(s, pid) }, x = input.checkoutLock;
    if ('locks' in x) {
      if (!Array.isArray(x.locks) || x.locks.some(id => s.entities[id]?.role !== 'lock')) throw err('Choose locks from your followed devices.');
      c.locks = x.locks;
    }
    if ('minutes' in x) c.minutes = n(x.minutes, 0, 240, 'Minutes after checkout');
    if ('enabled' in x) c.enabled = !!x.enabled;
    if (c.enabled && !c.locks.length) throw err('Choose at least one lock.');
    s.checkoutLock = { ...s.checkoutLock, [pid]: c };
  }
  save(db, s);
  return s;
}

// ---------- States, samples and events ----------
const SAMPLE_EVERY = 10 * 60e3;
function sampleValue(m, st, unit) {
  if (m.role === 'thermostat') return toF(num(st.attributes?.current_temperature), unit);
  if (m.role === 'temperature' || m.role === 'outdoor') return toF(num(st.state), st.attributes?.unit_of_measurement || unit);
  if (['humidity', 'pm25', 'pm10', 'co2', 'voc', 'aqi', 'co', 'battery'].includes(m.role)) return num(st.state);
  return null;
}

export function storeStates(db, s, states, now) {
  const prev = db.prepare('SELECT state FROM ha_states WHERE entity_id = ?');
  const put = db.prepare(`INSERT INTO ha_states(entity_id, state, attributes, last_changed, updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET state = excluded.state, attributes = excluded.attributes, last_changed = excluded.last_changed, updated_at = excluded.updated_at`);
  const event = db.prepare('INSERT INTO ha_events(entity_id, at, from_state, to_state) VALUES(?,?,?,?)');
  const sample = db.prepare('INSERT INTO ha_samples(entity_id, at, value) VALUES(?,?,?)');
  const sampling = now - Number(getSetting(db, 'ha_last_sample') || 0) >= SAMPLE_EVERY - 5000;
  db.exec('BEGIN');
  try {
    for (const st of states) {
      const m = s.entities[st.entity_id];
      if (!m) continue;
      const before = prev.get(st.entity_id)?.state;
      if (before !== undefined && before !== st.state && ['lock', 'leak', 'safety', 'thermostat'].includes(m.role)) event.run(st.entity_id, iso(now), before, st.state);
      put.run(st.entity_id, st.state, JSON.stringify(st.attributes || {}), st.last_changed || null, iso(now));
      const v = sampling ? sampleValue(m, st, s.unit) : null;
      if (v != null) sample.run(st.entity_id, iso(now), v);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (sampling) setSetting(db, 'ha_last_sample', now);
}

const stateOf = (db, id) => {
  const r = db.prepare('SELECT * FROM ha_states WHERE entity_id = ?').get(id);
  return r && { ...r, attributes: JSON.parse(r.attributes || '{}') };
};
const nameOf = (db, id) => stateOf(db, id)?.attributes?.friendly_name || id;

// ---------- Occupancy (from bookings, at the check-in and checkout times in the property's time zone) ----------
export function occupancy(db, propertyId, now = Date.now()) {
  const ds = doorSettings(db);
  const today = localToday(ds.tz, now);
  const stays = db.prepare(`SELECT id, guest_name, arrival, departure, nights, adults, children, channel FROM bookings
      WHERE status IN ('confirmed','new') AND departure >= ? AND arrival <= ? ${propertyId ? 'AND property_id = ?' : ''} ORDER BY arrival`)
    .all(addDays(today, -1), addDays(today, 60), ...(propertyId ? [propertyId] : []))
    .map(b => ({ ...b, checkInAt: Date.parse(zonedTimeToUtc(b.arrival, ds.checkin, ds.tz)), checkOutAt: Date.parse(zonedTimeToUtc(b.departure, ds.checkout, ds.tz)) }));
  const current = stays.find(b => b.checkInAt <= now && now < b.checkOutAt) || null;
  return { state: current ? 'occupied' : 'vacant', current, next: stays.find(b => b.checkInAt > now) || null, stays };
}

// ---------- Alerts ----------
function logAction(db, now, entityId, kind, detail, ok, notify = false) {
  db.prepare('INSERT INTO ha_actions(at, entity_id, kind, detail, ok, notify) VALUES(?,?,?,?,?,?)').run(iso(now), entityId, kind, detail, ok ? 1 : 0, notify ? 1 : 0);
}

/** Compare the latest readings with the alert rules; conditions are tracked from when they start until they clear. */
export function evaluateAlerts(db, now = Date.now()) {
  const s = haSettings(db), A = s.alerts;
  const active = new Map(db.prepare('SELECT * FROM ha_alerts').all().map(r => [`${r.entity_id}|${r.rule}`, r]));
  const occ = new Map();
  const occupied = pid => { if (!occ.has(pid)) occ.set(pid, occupancy(db, pid, now).state === 'occupied'); return occ.get(pid); };
  const found = [];
  for (const row of db.prepare('SELECT * FROM ha_states').all()) {
    const m = s.entities[row.entity_id];
    if (!m) continue;
    const a = JSON.parse(row.attributes || '{}');
    const was = rule => active.has(`${row.entity_id}|${rule}`);
    const add = (rule, value = null) => found.push({ entity_id: row.entity_id, rule, value });
    // A cleared condition needs to get a little better before it can alert again (no flapping).
    const above = (rule, v, limit, margin) => limit != null && v != null && v > (was(rule) ? limit - margin : limit);
    const below = (rule, v, limit, margin) => limit != null && v != null && v < (was(rule) ? limit + margin : limit);
    if (['unavailable', 'unknown'].includes(row.state)) { add('offline'); continue; }
    switch (m.role) {
      case 'leak': if (row.state === 'on') add('leak'); break;
      case 'safety': if (row.state === 'on') add('safety'); break;
      case 'lock':
        if (row.state === 'jammed') add('jammed');
        if (row.state === 'unlocked' && !occupied(m.propertyId)) add('unlocked');
        break;
      case 'battery': { const v = num(row.state); if (below('battery', v, A.batteryBelow, 5)) add('battery', v); break; }
      case 'thermostat': case 'temperature': {
        const v = m.role === 'thermostat' ? toF(num(a.current_temperature), s.unit) : toF(num(row.state), a.unit_of_measurement || s.unit);
        if (below('freeze', v, A.freezeBelow, 2)) add('freeze', v);
        if (above('hot', v, A.hotAbove, 2)) add('hot', v);
        break;
      }
      case 'humidity': { const v = num(row.state); if (above('humidity', v, A.humidityAbove, 5)) add('humidity', v); break; }
      default: if (AIR[m.role]) { const v = num(row.state), limit = A[AIR[m.role]]; if (above('air', v, limit, limit * 0.1)) add('air', v); }
    }
  }
  if (getSetting(db, 'ha_fail_since')) found.push({ entity_id: '_ha', rule: 'unreachable', value: null });

  const keys = new Set(found.map(f => `${f.entity_id}|${f.rule}`));
  const insert = db.prepare('INSERT INTO ha_alerts(entity_id, rule, since, value, log_id) VALUES(?,?,?,?,?)');
  const update = db.prepare('UPDATE ha_alerts SET value = ? WHERE entity_id = ? AND rule = ?');
  const logStart = db.prepare('INSERT INTO ha_alert_log(entity_id, rule, since, peak) VALUES(?,?,?,?)');
  const logPeak = db.prepare('UPDATE ha_alert_log SET peak = ? WHERE id = ?');
  const logEnd = db.prepare('UPDATE ha_alert_log SET until = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM ha_alerts WHERE entity_id = ? AND rule = ?');
  for (const f of found) {
    const cur = active.get(`${f.entity_id}|${f.rule}`);
    if (!cur) {
      // Offline and unreachable are noted for the log only, and the stay record ignores the app's own outages.
      const id = Number(logStart.run(f.entity_id, f.rule, iso(now), f.value).lastInsertRowid);
      insert.run(f.entity_id, f.rule, iso(now), f.value, id);
    } else {
      update.run(f.value, f.entity_id, f.rule);
      if (f.value != null && cur.log_id) {
        const lowIsWorse = ['freeze', 'battery'].includes(f.rule);
        const peak = db.prepare('SELECT peak FROM ha_alert_log WHERE id = ?').get(cur.log_id)?.peak;
        if (peak == null || (lowIsWorse ? f.value < peak : f.value > peak)) logPeak.run(f.value, cur.log_id);
      }
    }
  }
  for (const [k, r] of active) if (!keys.has(k)) { remove.run(r.entity_id, r.rule); if (r.log_id) logEnd.run(iso(now), r.log_id); }
  return found.length;
}

const delayFor = (rule, A) => rule === 'offline' || rule === 'unreachable' ? A.offlineMinutes : rule === 'unlocked' ? A.unlockedMinutes : DELAY[rule] ?? 0;

/** Conditions that have lasted long enough to be alerts, worded for people. */
export function activeAlerts(db, now = Date.now()) {
  const s = haSettings(db), A = s.alerts;
  if (!s.token) return [];
  // An empty threshold (e.g. offline minutes) switches that alert off.
  return db.prepare('SELECT * FROM ha_alerts ORDER BY since').all().filter(r => { const d = delayFor(r.rule, A); return d != null && now - Date.parse(r.since) >= d * 60e3; }).map(r => {
    const name = r.entity_id === '_ha' ? 'Home Assistant' : nameOf(db, r.entity_id), v = r.value, mins = Math.round((now - Date.parse(r.since)) / 60e3);
    const m = s.entities[r.entity_id] || {};
    const unit = stateOf(db, r.entity_id)?.attributes?.unit_of_measurement || '';
    const occupied = m.propertyId !== undefined && occupancy(db, m.propertyId, now).state === 'occupied';
    const w = {
      leak: [`Leak detected: ${name}`, 'Check the house as soon as possible.', 5, ['droplet', 'rotating_light']],
      safety: [`${name} is alarming`, 'Smoke, carbon monoxide or gas detected.', 5, ['rotating_light']],
      jammed: [`${name} is jammed`, 'The lock reports it is jammed.', 4, ['lock']],
      unlocked: [`${name} is unlocked with no guest staying`, `Unlocked for ${mins} minutes.`, 4, ['unlock']],
      offline: [`${name} is offline`, `No reading from Home Assistant for ${mins} minutes.`, 3, ['electric_plug']],
      unreachable: ['Home Assistant can\'t be reached', `${getSetting(db, 'ha_error') || 'No answer'} (for ${mins} minutes). Alerts and automations are paused.`, 4, ['warning']],
      battery: [`${name}: battery at ${v}%`, 'Replace the battery soon.', 3, ['battery']],
      freeze: [`Freeze risk: ${name} at ${v}°F`, `Below ${A.freezeBelow}°F. Check the heat.`, 5, ['snowflake', 'warning']],
      hot: [`${name} at ${v}°F`, `Above ${A.hotAbove}°F.`, 4, ['fire']],
      humidity: [`Humidity ${v}% (${name})`, 'Possible leak or ventilation problem.', 3, ['droplet']],
      air: [`Air quality: ${ROLES[m.role] || 'reading'} ${v}${unit ? ' ' + unit : ''} (${name})`, occupied ? 'During a guest stay: possible smoking or vaping.' : 'No guests staying.', 4, ['dash']],
    }[r.rule] || [`${name}: ${r.rule}`, '', 3, ['warning']];
    return { ref: `${r.rule}:${r.entity_id}:${r.since}`, entity: r.entity_id, rule: r.rule, since: r.since, value: v, title: w[0], message: w[1], priority: w[2], tags: w[3] };
  });
}

/** What phone notifications should send for Home Assistant: current alerts and failed automatic actions. */
export function homeNotifications(db, now = Date.now(), since = 0) {
  if (!haConfigured(db)) return [];
  const actions = db.prepare('SELECT * FROM ha_actions WHERE notify = 1 AND at >= ?').all(iso(Math.max(since, now - 24 * 3600e3)))
    .map(a => ({ ref: `action:${a.id}`, title: a.ok ? 'Home Assistant: automatic change' : 'Home Assistant: automatic change failed', message: `${nameOf(db, a.entity_id)}: ${a.detail}`,
      priority: a.ok ? 3 : 4, tags: [a.ok ? 'thermometer' : 'warning'], time: Date.parse(a.at) }));
  return [...activeAlerts(db, now).map(a => ({ ...a, time: Date.parse(a.since) })), ...actions];
}

// ---------- Booking-aware climate ----------
const clamp = (v, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v));

async function setThermostat(c, row, target, offMode, unit) {
  if (!row) throw new Error('no reading from this thermostat yet');
  const a = row.attributes;
  let mode = row.state;
  if (['unavailable', 'unknown'].includes(mode)) throw new Error('the thermostat is offline in Home Assistant');
  const steps = [];
  if (mode === 'off') {
    if (offMode === 'leave') return { detail: 'left off (it was switched off)', changed: false };
    if (a.hvac_modes && !a.hvac_modes.includes(offMode)) throw new Error(`it doesn't support ${offMode} mode`);
    await c.call('climate', 'set_hvac_mode', { entity_id: row.entity_id, hvac_mode: offMode });
    mode = offMode;
    steps.push(`switched on (${offMode})`);
  }
  const conv = f => clamp(fromF(f, unit), num(a.min_temp), num(a.max_temp));
  let data, desc;
  if (['heat_cool', 'auto'].includes(mode) && 'target_temp_low' in a) { data = { target_temp_low: conv(target.heat), target_temp_high: conv(target.cool) }; desc = `set to ${target.heat}–${target.cool}°F`; }
  else if (mode === 'cool') { data = { temperature: conv(target.cool) }; desc = `cool to ${target.cool}°F`; }
  else { data = { temperature: conv(target.heat) }; desc = `heat to ${target.heat}°F`; }
  await c.call('climate', 'set_temperature', { entity_id: row.entity_id, ...data });
  return { detail: [...steps, desc].join(', '), changed: true };
}

/** The thermostat phase a property should be in now: a guest stay (from N hours before check-in until N minutes after checkout) or vacant. */
export function climatePhase(cfg, occ, now) {
  const pre = cfg.preconditionHours * 3600e3, post = cfg.setbackMinutes * 60e3;
  const stay = occ.stays.find(b => b.checkInAt - pre <= now && now < b.checkOutAt + post);
  return stay ? { phase: 'occupied', key: `occupied:${stay.id}`, stay } : { phase: 'vacant', key: 'vacant' };
}

/**
 * Set each thermostat once when the phase changes (guests can still adjust it during their stay; it's set back
 * after they leave). `force` re-applies the current phase. Failures retry each minute, up to 5 times, and notify once.
 */
export async function runClimate(db, c, now = Date.now(), { force = false, propertyId = null } = {}) {
  const s = haSettings(db);
  const last = JSON.parse(getSetting(db, 'ha_climate_last') || '{}');
  const done = [];
  for (const pid of Object.keys(s.climate).map(Number)) {
    const cfg = climateFor(s, pid);
    if (!cfg.enabled || (propertyId && pid !== propertyId)) continue;
    const ph = climatePhase(cfg, occupancy(db, pid, now), now);
    const target = ph.phase === 'occupied' ? { heat: cfg.occupiedHeat, cool: cfg.occupiedCool } : { heat: cfg.vacantHeat, cool: cfg.vacantCool };
    const label = ph.phase === 'occupied' ? `Guest stay (${ph.stay.guest_name || 'guest'}, checking in ${new Date(ph.stay.checkInAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})` : 'No guests (eco)';
    for (const id of cfg.thermostats) {
      const l = last[id] || {};
      if (!force && l.key === ph.key) continue;
      try {
        const { detail, changed } = await setThermostat(c, stateOf(db, id), target, cfg.offMode, s.unit);
        logAction(db, now, id, 'climate', `${label}: ${detail}`, true);
        last[id] = { key: ph.key, at: now };
        done.push({ id, phase: ph.phase, detail, changed });
      } catch (e) {
        const fails = l.failKey === ph.key ? (l.fails || 0) + 1 : 1;
        logAction(db, now, id, 'climate', `${label}: couldn't set it (${e.message})`, false, fails === 1);
        last[id] = fails >= 5 ? { key: ph.key, at: now, gaveUp: true } : { ...l, failKey: ph.key, fails };
      }
    }
  }
  setSetting(db, 'ha_climate_last', JSON.stringify(last));
  return done;
}

/** Freeze protection: if a thermostat is off (or set below the floor) and the house is near freezing, heat it to the floor. */
export async function freezeProtect(db, c, now = Date.now(), skip = new Set()) {
  const s = haSettings(db);
  const recent = JSON.parse(getSetting(db, 'ha_freeze_last') || '{}');
  for (const pid of Object.keys(s.climate).map(Number)) {
    const cfg = climateFor(s, pid);
    if (!cfg.enabled) continue;
    for (const id of cfg.thermostats) {
      const row = stateOf(db, id);
      // Thermostats the schedule just set are judged on the next reading, not this (now outdated) one.
      if (skip.has(id) || !row || ['unavailable', 'unknown'].includes(row.state) || now - (recent[id] || 0) < 6 * 3600e3) continue;
      const cur = toF(num(row.attributes.current_temperature), s.unit);
      const set = toF(num(row.attributes.temperature ?? row.attributes.target_temp_low), s.unit);
      if (cur == null || cur >= cfg.freezeFloor + 2 || (row.state !== 'off' && row.state !== 'cool' && set != null && set >= cfg.freezeFloor)) continue;
      recent[id] = now;
      try {
        if (row.state !== 'heat' && row.state !== 'heat_cool' && row.state !== 'auto') await c.call('climate', 'set_hvac_mode', { entity_id: id, hvac_mode: 'heat' });
        await c.call('climate', 'set_temperature', { entity_id: id, temperature: fromF(cfg.freezeFloor, s.unit) });
        logAction(db, now, id, 'freeze', `Freeze protection: the house was at ${cur}°F, so the heat was set to ${cfg.freezeFloor}°F`, true, true);
      } catch (e) { logAction(db, now, id, 'freeze', `Freeze protection couldn't turn the heat on (${e.message})`, false, true); }
    }
  }
  setSetting(db, 'ha_freeze_last', JSON.stringify(recent));
}

// ---------- Lock after checkout ----------
export async function runCheckoutLocks(db, c, now = Date.now()) {
  const s = haSettings(db);
  const isDone = db.prepare('SELECT 1 FROM ha_done WHERE key = ?'), markDone = db.prepare('INSERT OR IGNORE INTO ha_done(key, at) VALUES(?,?)');
  const tries = JSON.parse(getSetting(db, 'ha_lock_tries') || '{}');
  for (const pid of Object.keys(s.checkoutLock).map(Number)) {
    const cfg = lockFor(s, pid);
    if (!cfg.enabled) continue;
    for (const b of occupancy(db, pid, now).stays) {
      const due = b.checkOutAt + cfg.minutes * 60e3;
      if (now < due || now > due + 6 * 3600e3) continue;
      const who = `${b.guest_name || 'the guest'}'s checkout`;
      for (const id of cfg.locks) {
        const key = `checkout:${b.id}:${id}`;
        if (isDone.get(key)) continue;
        const row = stateOf(db, id);
        if (row?.state === 'locked') { markDone.run(key, iso(now)); logAction(db, now, id, 'lock', `Already locked after ${who}`, true); continue; }
        try {
          if (row?.state !== 'unlocked') throw new Error(row ? `it reports "${row.state}"` : 'no reading from this lock yet');
          await c.call('lock', 'lock', { entity_id: id });
          markDone.run(key, iso(now));
          logAction(db, now, id, 'lock', `Locked after ${who}`, true);
        } catch (e) {
          tries[key] = (tries[key] || 0) + 1;
          if (tries[key] >= 3) markDone.run(key, iso(now));
          logAction(db, now, id, 'lock', `Couldn't lock after ${who} (${e.message})`, false, tries[key] === 1);
        }
      }
    }
  }
  setSetting(db, 'ha_lock_tries', JSON.stringify(tries));
}

/** One check: read every device, update alerts, then run the automations. Throws only if Home Assistant can't be read. */
export async function pollHA(db, { now = Date.now(), fetchImpl } = {}) {
  const c = haClient(db, fetchImpl);
  if (!c) return null;
  const s = haSettings(db);
  try {
    storeStates(db, s, await c.states(), now);
    setSetting(db, 'ha_error', null); setSetting(db, 'ha_fail_since', null);
  } catch (e) {
    setSetting(db, 'ha_error', e.message);
    if (!getSetting(db, 'ha_fail_since')) setSetting(db, 'ha_fail_since', iso(now));
    evaluateAlerts(db, now);
    throw e;
  }
  setSetting(db, 'ha_last_poll', iso(now));
  evaluateAlerts(db, now);
  const set = await runClimate(db, c, now);
  await freezeProtect(db, c, now, new Set(set.filter(x => x.changed).map(x => x.id)));
  await runCheckoutLocks(db, c, now);
  if (getSetting(db, 'ha_pruned') !== iso(now).slice(0, 10)) {
    const cutoff = iso(now - 400 * 86400e3);
    db.prepare('DELETE FROM ha_samples WHERE at < ?').run(cutoff);
    db.prepare('DELETE FROM ha_events WHERE at < ?').run(cutoff);
    db.prepare('DELETE FROM ha_alert_log WHERE since < ?').run(cutoff);
    db.prepare('DELETE FROM ha_actions WHERE at < ?').run(iso(now - 90 * 86400e3));
    setSetting(db, 'ha_pruned', iso(now).slice(0, 10));
  }
  return { ok: true };
}

// ---------- What the pages show ----------
function view(db, s, id, m, now) {
  const r = stateOf(db, id);
  const a = r?.attributes || {};
  const base = { id, role: m.role, propertyId: m.propertyId, name: a.friendly_name || id, state: r?.state ?? null, updatedAt: r?.updated_at || null };
  if (m.role === 'thermostat') {
    return { ...base, current: toF(num(a.current_temperature), s.unit), target: toF(num(a.temperature), s.unit), low: toF(num(a.target_temp_low), s.unit),
      high: toF(num(a.target_temp_high), s.unit), action: a.hvac_action || null, humidity: num(a.current_humidity) };
  }
  if (['temperature', 'outdoor'].includes(m.role)) return { ...base, value: toF(num(r?.state), a.unit_of_measurement || s.unit), unit: '°F' };
  return { ...base, value: num(r?.state), unit: a.unit_of_measurement || '' };
}

export function homeStatus(db, now = Date.now()) {
  const s = haSettings(db);
  if (!s.token) return { configured: false, url: s.url };
  const devices = Object.entries(s.entities).map(([id, m]) => view(db, s, id, m, now));
  const props = db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all();
  const last = JSON.parse(getSetting(db, 'ha_climate_last') || '{}');
  return {
    configured: true, url: s.url, name: s.name, unit: s.unit, tz: doorSettings(db).tz, lastPoll: getSetting(db, 'ha_last_poll'), error: getSetting(db, 'ha_error'),
    devices, alerts: activeAlerts(db, now), alertSettings: s.alerts, roles: ROLES,
    properties: props.map(p => {
      const occ = occupancy(db, p.id, now), cfg = climateFor(s, p.id);
      const phase = climatePhase(cfg, occ, now);
      const slim = b => b && { id: b.id, guest: b.guest_name, checkInAt: b.checkInAt, checkOutAt: b.checkOutAt };
      return { ...p, occupancy: { state: occ.state, current: slim(occ.current), next: slim(occ.next) }, climate: cfg, checkoutLock: lockFor(s, p.id),
        phase: phase.phase, preheatAt: occ.next ? occ.next.checkInAt - cfg.preconditionHours * 3600e3 : null,
        applied: cfg.thermostats.map(id => ({ id, key: last[id]?.key || null })) };
    }),
    actions: db.prepare('SELECT * FROM ha_actions ORDER BY id DESC LIMIT 20').all().map(a => ({ ...a, name: a.entity_id ? nameOf(db, a.entity_id) : '' })),
  };
}

/** A short version for the Dashboard. */
export function homeBrief(db, now = Date.now()) {
  const st = homeStatus(db, now);
  if (!st.configured) return null;
  const pick = role => st.devices.filter(d => d.role === role);
  return { alerts: st.alerts.map(a => a.title), error: st.error, lastPoll: st.lastPoll,
    thermostats: pick('thermostat').map(d => ({ name: d.name, current: d.current, target: d.target, low: d.low, high: d.high, state: d.state, action: d.action })),
    temps: pick('temperature').map(d => ({ name: d.name, value: d.value })), locks: pick('lock').map(d => ({ name: d.name, state: d.state })) };
}

// ---------- Stay records ----------
const ROLE_ORDER = ['temperature', 'thermostat', 'humidity', 'pm25', 'pm10', 'co2', 'voc', 'aqi', 'co'];
function stayWindow(db, b) {
  const ds = doorSettings(db);
  return [Date.parse(zonedTimeToUtc(b.arrival, ds.checkin, ds.tz)), Date.parse(zonedTimeToUtc(b.departure, ds.checkout, ds.tz))];
}
const ofProperty = (s, pid) => id => s.entities[id] && (s.entities[id].propertyId == null || s.entities[id].propertyId === pid);
function summarize(db, s, from, to, pid) {
  const rows = db.prepare('SELECT entity_id, MIN(value) mn, MAX(value) mx, AVG(value) av, COUNT(*) n FROM ha_samples WHERE at >= ? AND at < ? GROUP BY entity_id').all(iso(from), iso(to));
  const by = {};
  for (const r of rows) {
    const role = s.entities[r.entity_id]?.role;
    if (!ROLE_ORDER.includes(role) || !ofProperty(s, pid)(r.entity_id)) continue;
    const key = role === 'thermostat' ? 'temperature' : role;
    const cur = by[key] || { min: Infinity, max: -Infinity, sum: 0, n: 0 };
    by[key] = { min: Math.min(cur.min, r.mn), max: Math.max(cur.max, r.mx), sum: cur.sum + r.av * r.n, n: cur.n + r.n };
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { min: Math.round(v.min * 10) / 10, max: Math.round(v.max * 10) / 10, avg: Math.round(v.sum / v.n * 10) / 10 }]));
}
// Alerts during a stay that say something about the stay (not the app's or a battery's housekeeping).
const alertsIn = (db, s, from, to, pid) => db.prepare(`SELECT * FROM ha_alert_log WHERE rule NOT IN ('offline','unreachable','battery') AND since < ? AND (until IS NULL OR until > ?) ORDER BY since`)
  .all(iso(to), iso(from)).filter(a => ofProperty(s, pid)(a.entity_id));

/** Recent stays (current one first) with the conditions during each. */
export function stayList(db, now = Date.now(), { propertyId = null, limit = 15 } = {}) {
  const s = haSettings(db);
  if (!s.token) return [];
  const today = localToday(doorSettings(db).tz, now);
  // Only properties with devices of their own (devices without a property count for every property).
  const pids = [...new Set(Object.values(s.entities).map(e => e.propertyId))];
  const anyProperty = pids.includes(null);
  return db.prepare(`SELECT id, property_id, guest_name, channel, arrival, departure, nights, adults, children FROM bookings WHERE status IN ('confirmed','new')
      AND arrival <= ? ${propertyId ? 'AND property_id = ?' : ''} ORDER BY arrival DESC LIMIT ?`).all(today, ...(propertyId ? [propertyId] : []), limit * 4)
    .filter(b => anyProperty || pids.includes(b.property_id)).slice(0, limit)
    .map(b => {
      const [from, to] = stayWindow(db, b);
      if (from > now) return null;
      const end = Math.min(to, now);
      return { ...b, current: now < to, summary: summarize(db, s, from, end, b.property_id), alerts: alertsIn(db, s, from, end, b.property_id).length };
    }).filter(Boolean);
}

/** One stay in detail: readings over time per device, alerts, and lock / leak events. */
export function stayRecord(db, bookingId, now = Date.now()) {
  const s = haSettings(db);
  const b = db.prepare('SELECT id, property_id, guest_name, channel, arrival, departure, nights, adults, children FROM bookings WHERE id = ?').get(bookingId);
  if (!b) throw err('Booking not found.', 404);
  const [from, to] = stayWindow(db, b);
  const end = Math.min(to, now);
  const mine = ofProperty(s, b.property_id);
  const series = Object.entries(s.entities).filter(([id, m]) => ROLE_ORDER.includes(m.role) && mine(id)).map(([id, m]) => {
    const pts = db.prepare('SELECT at, value FROM ha_samples WHERE entity_id = ? AND at >= ? AND at < ? ORDER BY at').all(id, iso(from), iso(end));
    const step = Math.max(1, Math.ceil(pts.length / 300));
    return { id, role: m.role, name: nameOf(db, id), unit: ['temperature', 'thermostat'].includes(m.role) ? '°F' : stateOf(db, id)?.attributes?.unit_of_measurement || '',
      points: pts.filter((_, i) => i % step === 0).map(p => [Date.parse(p.at), p.value]) };
  }).filter(x => x.points.length);
  return {
    booking: b, from, to, summary: summarize(db, s, from, end, b.property_id),
    alerts: alertsIn(db, s, from, end, b.property_id).map(a => ({ ...a, name: nameOf(db, a.entity_id) })),
    events: db.prepare('SELECT * FROM ha_events WHERE at >= ? AND at < ? ORDER BY at').all(iso(from), iso(end))
      .filter(e => ['lock', 'leak', 'safety'].includes(s.entities[e.entity_id]?.role) && mine(e.entity_id)).map(e => ({ ...e, name: nameOf(db, e.entity_id) })),
    series,
  };
}
