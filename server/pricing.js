// Laramie pricing tool: a recommended nightly price and minimum stay for every unbooked night, built from
// transparent factors (base, day of week, season, local events, booking pace vs last year, lead time and
// gap nights) so every number can be explained. Prices are pushed to Beds24 only when the owner applies
// them, or daily if auto-pricing is switched on.
import { getSetting, setSetting } from './db.js';
import { addDays, diffDays } from './sync.js';
import { syncCalendar, readDays } from './rates.js';
import { localToday } from './doors.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ACTIVE = ['confirmed', 'new', 'request', 'block'];

// Defaults tuned for Laramie: summer and football season are strong, deep winter is soft.
export const PRICING_DEFAULTS = {
  base: null, min: null, max: null, rounding: 5,
  dow: [-5, 0, 0, 0, 5, 15, 20],                          // Sun..Sat, %
  season: [-15, -15, -10, -5, 5, 15, 25, 15, 5, 5, -5, -5], // Jan..Dec, %
  lastMinuteDays: 7, lastMinutePct: -20,                   // ramps to this discount on the night itself
  farOutDays: 120, farOutPct: 5,
  pacing: true, pacingMax: 10,
  gapPct: -15, minStay: 2,
  auto: false, autoHorizon: 180, autoThreshold: 5, autoMaxChangePct: 25,
};

export function pricingSettings(db, roomId) {
  const raw = getSetting(db, `pricing_${roomId}`);
  return { ...PRICING_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
}

export function savePricingSettings(db, roomId, input) {
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ? AND id > 0').get(roomId)) throw userError('Choose a room that exists in Beds24.');
  const s = { ...pricingSettings(db, roomId) };
  const num = (k, lo, hi, int = false) => {
    if (input[k] === undefined) return;
    const v = input[k] === '' || input[k] === null ? null : Number(input[k]);
    if (v !== null && !(Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v)))) throw userError(`${k} must be between ${lo} and ${hi}.`);
    s[k] = v;
  };
  num('base', 10, 100000); num('min', 10, 100000); num('max', 10, 100000);
  num('rounding', 1, 50, true); num('lastMinuteDays', 0, 60, true); num('lastMinutePct', -60, 0);
  num('farOutDays', 14, 730, true); num('farOutPct', 0, 50); num('pacingMax', 0, 30); num('gapPct', -60, 0);
  num('minStay', 1, 30, true); num('autoHorizon', 7, 365, true); num('autoThreshold', 0, 500); num('autoMaxChangePct', 5, 100);
  for (const [k, n] of [['dow', 7], ['season', 12]]) {
    if (input[k] === undefined) continue;
    if (!Array.isArray(input[k]) || input[k].length !== n || !input[k].every(v => Number.isFinite(+v) && +v >= -80 && +v <= 200)) {
      throw userError(`${k === 'dow' ? 'Day-of-week' : 'Monthly'} adjustments must be ${n} percentages between -80 and 200.`);
    }
    s[k] = input[k].map(Number);
  }
  for (const k of ['pacing', 'auto']) if (input[k] !== undefined) s[k] = !!input[k];
  if (s.min != null && s.max != null && s.min > s.max) throw userError('The minimum price is above the maximum.');
  if (s.auto && !s.base) throw userError('Set a base price before turning on auto-pricing.');
  setSetting(db, `pricing_${roomId}`, JSON.stringify(s));
  return s;
}

// ---------- Events ----------
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** The n-th (1-based) weekday of a month; n = -1 for the last one. weekday: 0 = Sunday. */
export function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return ymd(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0));
  return ymd(year, month, lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7));
}

/** Holidays and recurring local events for a year. `estimated` ones should be checked against the real date. */
export function recurringEvents(year) {
  const memorial = nthWeekday(year, 5, 1, -1), labor = nthWeekday(year, 9, 1, 1), thanks = nthWeekday(year, 11, 4, 4);
  const lastSunJuly = nthWeekday(year, 7, 0, -1);
  return [
    { name: 'Memorial Day weekend', start: addDays(memorial, -3), end: addDays(memorial, -1), pct: 15, min_stay: 2 },
    { name: 'Independence Day', start: ymd(year, 7, 3), end: ymd(year, 7, 4), pct: 15, min_stay: 2 },
    // Frontier Days runs the ten days ending on the last Sunday of July; Laramie gets the overflow.
    { name: 'Cheyenne Frontier Days (overflow)', start: addDays(lastSunJuly, -9), end: addDays(lastSunJuly, -1), pct: 15, min_stay: 2, estimated: true },
    { name: 'Labor Day weekend', start: addDays(labor, -3), end: addDays(labor, -1), pct: 15, min_stay: 2 },
    { name: 'Thanksgiving', start: addDays(thanks, -1), end: addDays(thanks, 2), pct: 15, min_stay: 2 },
    { name: 'Christmas & New Year', start: ymd(year, 12, 23), end: ymd(year, 12, 31), pct: 15, min_stay: 3 },
    // UW commencement is usually the second or third weekend of May; families book early.
    { name: 'UW Commencement weekend', start: addDays(nthWeekday(year, 5, 6, 2), -1), end: nthWeekday(year, 5, 6, 2), pct: 50, min_stay: 2, estimated: true },
    // Move-in is the week before fall classes (usually the last Monday of August).
    { name: 'UW move-in', start: addDays(nthWeekday(year, 8, 1, -1), -5), end: addDays(nthWeekday(year, 8, 1, -1), -2), pct: 30, min_stay: 2, estimated: true },
  ];
}

// Confirmed dates, with where they came from.
const CONFIRMED_EVENTS = [
  { name: 'UW football vs Northern Illinois', start: '2026-10-16', end: '2026-10-17', pct: 60, min_stay: 2, source: 'gowyo.com 2026 schedule' },
  { name: 'UW football vs Air Force', start: '2026-10-23', end: '2026-10-24', pct: 70, min_stay: 2, source: 'gowyo.com 2026 schedule' },
  { name: 'UW football vs New Mexico', start: '2026-11-20', end: '2026-11-21', pct: 50, min_stay: 2, source: 'gowyo.com 2026 schedule' },
  { name: 'UW football vs UConn (Thanksgiving weekend)', start: '2026-11-27', end: '2026-11-28', pct: 50, min_stay: 2, source: 'gowyo.com 2026 schedule' },
  { name: 'Laramie Jubilee Days', start: '2027-07-03', end: '2027-07-11', pct: 25, min_stay: 2, source: 'laramiejubileedays.org' },
];

/** Add the starter events once. The owner can edit or delete any of them afterwards. */
export function seedEvents(db, today) {
  if (getSetting(db, 'pricing_events_seeded')) return;
  const year = +today.slice(0, 4);
  const add = db.prepare('INSERT INTO pricing_events(name,start_date,end_date,pct,min_stay,source) VALUES(?,?,?,?,?,?)');
  for (const e of [...CONFIRMED_EVENTS, ...recurringEvents(year), ...recurringEvents(year + 1)]) {
    if (e.end < today) continue;
    add.run(e.name, e.start, e.end, e.pct, e.min_stay ?? null, e.source || (e.estimated ? 'estimated: check the date' : 'holiday'));
  }
  setSetting(db, 'pricing_events_seeded', '1');
}

export const listEvents = db => db.prepare('SELECT * FROM pricing_events ORDER BY start_date').all();

export function saveEvent(db, e) {
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const name = (e.name || '').trim();
  if (!name) throw userError('Give the event a name.');
  if (!isDate(e.start_date) || !isDate(e.end_date) || e.end_date < e.start_date) throw userError('Choose the first and last night of the event.');
  const pct = Number(e.pct);
  if (!Number.isFinite(pct) || pct < -50 || pct > 300) throw userError('The price change must be between -50% and +300%.');
  const minStay = e.min_stay === '' || e.min_stay == null ? null : Number(e.min_stay);
  if (minStay != null && !(Number.isInteger(minStay) && minStay >= 1 && minStay <= 30)) throw userError('Minimum stay must be 1 to 30 nights.');
  if (e.id) {
    db.prepare('UPDATE pricing_events SET name=?, start_date=?, end_date=?, pct=?, min_stay=?, source=? WHERE id=?')
      .run(name, e.start_date, e.end_date, pct, minStay, 'edited', e.id);
    return Number(e.id);
  }
  return Number(db.prepare('INSERT INTO pricing_events(name,start_date,end_date,pct,min_stay,source) VALUES(?,?,?,?,?,?)')
    .run(name, e.start_date, e.end_date, pct, minStay, 'added').lastInsertRowid);
}
export const deleteEvent = (db, id) => db.prepare('DELETE FROM pricing_events WHERE id = ?').run(id);

// ---------- Pace ----------
/**
 * For each month, how full it is now versus how full the same month was at this point last year.
 * Last year counts only stays that had already been booked a year ago today, so it's a fair comparison.
 */
export function monthlyPace(db, roomId, today, months = 12) {
  const out = {};
  const lastYearToday = addDays(today, -365);
  for (let i = 0; i < months; i++) {
    const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + i);
    const first = d.toISOString().slice(0, 10); d.setUTCMonth(d.getUTCMonth() + 1);
    const next = d.toISOString().slice(0, 10);
    const lyFirst = addDays(first, -364), lyNext = addDays(next, -364);  // same weekdays, one year back
    const nights = (from, to, bookedBy) => db.prepare(`SELECT arrival, departure FROM bookings WHERE room_id = ?
        AND status IN ('confirmed','new') AND arrival < ? AND departure > ? ${bookedBy ? 'AND booked_at IS NOT NULL AND booked_at <= ?' : ''}`)
      .all(roomId, to, from, ...(bookedBy ? [bookedBy + 'T23:59:59'] : []))
      .reduce((n, b) => n + diffDays(b.arrival > from ? b.arrival : from, b.departure < to ? b.departure : to), 0);
    const anyLastYear = db.prepare(`SELECT 1 FROM bookings WHERE room_id = ? AND status IN ('confirmed','new','cancelled') AND arrival < ? AND departure > ?`).get(roomId, lyNext, lyFirst);
    const days = diffDays(first, next);
    out[first.slice(0, 7)] = {
      now: nights(first, next) / days,
      lastYear: anyLastYear ? nights(lyFirst, lyNext, lastYearToday) / days : null,
    };
  }
  return out;
}

// ---------- Recommendations ----------
const roundTo = (v, step) => Math.round(v / step) * step;

/** Recommended price and minimum stay per night, with the reasons, plus the current Beds24 values. */
export function recommend(db, roomId, { start, days = 365, today } = {}) {
  const s = pricingSettings(db, roomId);
  today ||= localToday(getSetting(db, 'door_tz') || 'America/Denver');
  start = start && start > today ? start : today;
  if (!s.base) return { settings: s, nights: [], needsBase: true };
  const end = addDays(start, days);
  const current = new Map(readDays(db, roomId, start, days).map(d => [d.date, d]));
  const events = db.prepare('SELECT * FROM pricing_events WHERE end_date >= ? AND start_date < ?').all(start, end);
  const pace = s.pacing ? monthlyPace(db, roomId, today, Math.ceil(diffDays(today, end) / 30) + 1) : {};

  // Gap nights: a run of free nights between two stays (or between today and the next stay) that is shorter
  // than the usual minimum stay can't be booked as things stand, so it gets a discount and a matching minimum.
  // The scan always starts today, so the edge of the viewed window is never mistaken for a stay.
  const occupied = new Set();
  const stays = db.prepare(`SELECT arrival, departure FROM bookings WHERE room_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})
    AND departure > ? AND arrival < ? ORDER BY arrival`).all(roomId, ...ACTIVE, today, addDays(end, 30));
  const blockedCal = new Set(db.prepare(`SELECT date FROM calendar_days WHERE room_id = ? AND override = 'blackout' AND date >= ?`).all(roomId, today).map(r => r.date));
  for (const b of stays) for (let d = b.arrival; d < b.departure; d = addDays(d, 1)) occupied.add(d);
  const gapLen = new Map();
  let run = [];
  const closeRun = boundedRight => {
    // A run only counts as a gap if something follows it (a stay), so open-ended availability isn't discounted.
    if (boundedRight && run.length && run.length < s.minStay) for (const d of run) gapLen.set(d, run.length);
    run = [];
  };
  for (let d = today; d < addDays(end, 30); d = addDays(d, 1)) {
    if (occupied.has(d) || blockedCal.has(d)) closeRun(true); else run.push(d);
  }

  const nights = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    const cur = current.get(d);
    if (cur?.booking) { nights.push({ date: d, booked: true, booking: cur.booking, current: cur.price }); continue; }
    if (cur?.blocked) { nights.push({ date: d, blocked: true, current: cur.price }); continue; }
    const wd = new Date(d + 'T00:00:00Z').getUTCDay(), mo = +d.slice(5, 7) - 1;
    const factors = [{ label: 'Base price', value: s.base }];
    const pct = (label, p) => { if (p) factors.push({ label, pct: Math.round(p * 10) / 10 }); };
    pct(DAY_NAMES[wd], s.dow[wd]);
    pct(MONTH_NAMES[mo], s.season[mo]);
    const ev = events.filter(e => e.start_date <= d && e.end_date >= d).sort((a, b) => b.pct - a.pct)[0];
    if (ev) pct(`Event: ${ev.name}`, ev.pct);
    const p = pace[d.slice(0, 7)];
    if (p && p.lastYear != null) {
      const diffPts = (p.now - p.lastYear) * 100;
      const adj = Math.max(-s.pacingMax, Math.min(s.pacingMax, diffPts * 0.25));
      if (Math.abs(adj) >= 1) pct(`Pace: ${Math.round(p.now * 100)}% booked vs ${Math.round(p.lastYear * 100)}% this time last year`, adj);
    }
    const out = diffDays(today, d);
    if (s.lastMinuteDays && out < s.lastMinuteDays) pct(`Last-minute (${out === 0 ? 'tonight' : out + ' day' + (out === 1 ? '' : 's') + ' out'})`, s.lastMinutePct * (1 - out / s.lastMinuteDays));
    if (s.farOutPct && out >= s.farOutDays) pct(`Booking far ahead (${out} days out)`, s.farOutPct);
    const gap = gapLen.get(d);
    if (gap) pct(`Gap night (${gap}-night gap between stays)`, s.gapPct);

    let price = factors.slice(1).reduce((v, f) => v * (1 + f.pct / 100), s.base);
    const notes = [];
    if (s.min != null && price < s.min) { price = s.min; notes.push(`Raised to your minimum of $${s.min}`); }
    if (s.max != null && price > s.max) { price = s.max; notes.push(`Capped at your maximum of $${s.max}`); }
    price = Math.max(1, roundTo(price, s.rounding || 1));
    const minStay = gap ? gap : Math.max(s.minStay, ev?.min_stay || 0);
    nights.push({ date: d, price, minStay, factors, notes, event: ev?.name || null, gap: gap || null,
      current: cur?.price ?? null, currentMinStay: cur?.minStay ?? null });
  }
  return { settings: s, nights, pace };
}

/** Nights where the recommendation differs enough from what Beds24 has to be worth sending. */
export function pendingChanges(rec, { threshold = 0, includeMinStay = true, maxChangePct = null } = {}) {
  return rec.nights.filter(n => !n.booked && !n.blocked).flatMap(n => {
    const priceDiff = n.current == null || Math.abs(n.price - n.current) >= Math.max(threshold, 0.01);
    const minDiff = includeMinStay && n.minStay !== n.currentMinStay;
    if (!priceDiff && !minDiff) return [];
    let price = n.price;
    // Auto-pricing never moves a night more than maxChangePct in one go, so a bad setting can't swing prices wildly.
    if (maxChangePct != null && n.current) {
      const lo = n.current * (1 - maxChangePct / 100), hi = n.current * (1 + maxChangePct / 100);
      price = Math.round(Math.min(hi, Math.max(lo, price)));
      if (price === n.current && !minDiff) return [];
    }
    return [{ date: n.date, price, minStay: includeMinStay ? n.minStay : undefined, before: n.current, beforeMinStay: n.currentMinStay }];
  });
}

/** Send per-night prices (and minimum stays) to Beds24, confirm by re-reading, and log the change. */
export async function applyNightly(db, client, roomId, changes, { label = 'Pricing tool', today } = {}) {
  if (!changes.length) return { applied: 0, warnings: [] };
  today ||= localToday(getSetting(db, 'door_tz') || 'America/Denver');
  for (const c of changes) {
    if (c.date < today) throw userError('Past nights can\'t be changed.');
    if (!(c.price >= 1 && c.price <= 100000)) throw userError(`Invalid price for ${c.date}.`);
  }
  const booked = new Set(readDays(db, roomId, changes[0].date, diffDays(changes[0].date, changes.at(-1).date) + 1)
    .filter(d => d.booking || d.blocked).map(d => d.date));
  changes = changes.filter(c => !booked.has(c.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (!changes.length) return { applied: 0, warnings: ['Those nights are booked or blocked now.'] };

  const ranges = [];
  for (const c of changes) {
    const last = ranges.at(-1);
    if (last && addDays(last.to, 1) === c.date && last.price1 === c.price && last.minStay === c.minStay) last.to = c.date;
    else ranges.push({ from: c.date, to: c.date, price1: c.price, ...(c.minStay != null && { minStay: c.minStay }) });
  }
  const first = changes[0].date, last = changes.at(-1).date;
  const log = db.prepare('INSERT INTO change_log(at,room_id,date_from,date_to,nights,summary,ok,error) VALUES(?,?,?,?,?,?,?,?)');
  const at = new Date().toISOString(), summary = `${label}: ${changes.length} night${changes.length === 1 ? '' : 's'} repriced`;
  try {
    const res = await client.post('/inventory/rooms/calendar', [{ roomId, calendar: ranges }]);
    const errs = (Array.isArray(res) ? res : [res]).flatMap(r => (r?.errors || []).map(e => e.message || e.field));
    if (errs.length || (Array.isArray(res) && res.some(r => r?.success === false))) throw new Error('Beds24 rejected the change: ' + (errs.join('; ') || 'unknown error'));
  } catch (e) { log.run(at, roomId, first, last, changes.length, summary, 0, e.message); throw e; }

  const warnings = [];
  try {
    await syncCalendar(db, client, first, last);
    const now = new Map(readDays(db, roomId, first, diffDays(first, last) + 1).map(d => [d.date, d]));
    const off = changes.filter(c => now.get(c.date)?.price !== c.price);
    if (off.length) warnings.push(`Beds24 shows a different price for ${off.length} night${off.length === 1 ? '' : 's'} (first: ${off[0].date}).`);
  } catch (e) { warnings.push(`Sent, but re-checking Beds24 failed: ${e.message}`); }
  log.run(at, roomId, first, last, changes.length, summary, 1, warnings.join(' ') || null);
  return { applied: changes.length, ranges: ranges.length, warnings };
}

/** Once a day, if auto-pricing is on, push recommendations that differ by more than the threshold. */
export async function autoPrice(db, client, today) {
  const results = [];
  for (const { id } of db.prepare('SELECT id FROM rooms WHERE id > 0').all()) {
    const s = pricingSettings(db, id);
    if (!s.auto || !s.base || getSetting(db, `pricing_auto_${id}`) === today) continue;
    const rec = recommend(db, id, { days: s.autoHorizon, today });
    const changes = pendingChanges(rec, { threshold: s.autoThreshold, maxChangePct: s.autoMaxChangePct });
    const r = await applyNightly(db, client, id, changes, { label: 'Auto-pricing', today });
    setSetting(db, `pricing_auto_${id}`, today);
    results.push({ roomId: id, ...r });
  }
  return results;
}

/** Suggest a base price and monthly/weekday adjustments from the last two years of the room's own stays. */
export function suggestFromHistory(db, roomId, today) {
  const rows = db.prepare(`SELECT arrival, departure, nights, price FROM bookings WHERE room_id = ? AND status IN ('confirmed','new')
    AND price > 0 AND nights > 0 AND departure <= ? AND arrival >= ?`).all(roomId, today, addDays(today, -730));
  const byMonth = Array.from({ length: 12 }, () => []), byDow = Array.from({ length: 7 }, () => []), all = [];
  for (const b of rows) {
    const rate = b.price / b.nights;
    for (let d = b.arrival; d < b.departure; d = addDays(d, 1)) {
      byMonth[+d.slice(5, 7) - 1].push(rate); byDow[new Date(d + 'T00:00:00Z').getUTCDay()].push(rate); all.push(rate);
    }
  }
  if (all.length < 20) return { enough: false, nights: all.length };
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const weekday = [0, 1, 2, 3].flatMap(i => byDow[i]);
  const base = Math.round(median(weekday.length >= 10 ? weekday : all));
  const overall = avg(all);
  const r5 = v => Math.round(v / 5) * 5;
  const season = byMonth.map((m, i) => (m.length >= 6 ? r5((avg(m) / overall - 1) * 100) : PRICING_DEFAULTS.season[i]));
  const weekdayAvg = avg(weekday.length ? weekday : all);
  const dow = byDow.map((m, i) => (m.length >= 6 ? r5((avg(m) / weekdayAvg - 1) * 100) : PRICING_DEFAULTS.dow[i]));
  return { enough: true, nights: all.length, base, season, dow, adr: Math.round(overall),
    monthAdr: byMonth.map(m => (m.length ? Math.round(avg(m)) : null)) };
}
