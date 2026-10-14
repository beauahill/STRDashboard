import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { upsertProperties, upsertBookings, addDays } from '../server/sync.js';
import { syncCalendar } from '../server/rates.js';
import {
  nthWeekday, recurringEvents, seedEvents, listEvents, saveEvent, deleteEvent, savePricingSettings, pricingSettings,
  recommend, monthlyPace, pendingChanges, applyNightly, autoPrice, suggestFromHistory, limitPrice,
} from '../server/pricing.js';

const TODAY = '2026-10-12';  // a Monday
const d = n => addDays(TODAY, n);

/** Beds24 calendar stand-in with inclusive ranges. */
class FakeCal {
  constructor() { this.days = new Map(); this.posts = []; this.ignore = false; }
  async getAll(path, q) {
    return q.roomId.map(roomId => ({ roomId, calendar: [...this.days.entries()].filter(([k]) => k.startsWith(roomId + '|'))
      .map(([k, v]) => ({ from: k.split('|')[1], to: k.split('|')[1], ...v })).filter(c => c.from >= q.startDate && c.from <= q.endDate) }));
  }
  async post(path, body) {
    this.posts.push(body);
    if (!this.ignore) for (const { roomId, calendar } of body) for (const r of calendar) {
      for (let x = r.from; x <= r.to; x = addDays(x, 1)) { const { from, to, ...v } = r; this.days.set(`${roomId}|${x}`, { ...this.days.get(`${roomId}|${x}`), ...v }); }
    }
    return [{ success: true }];
  }
}

function setup(settings = {}) {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  // Neutral settings so each test can switch on just the factor it checks.
  savePricingSettings(db, 600, { base: 200, dow: [0, 0, 0, 0, 0, 0, 0], season: Array(12).fill(0), lastMinuteDays: 0, farOutPct: 0,
    pacing: false, gapPct: 0, rounding: 1, minStay: 2, ...settings });
  return db;
}
const night = (rec, date) => rec.nights.find(n => n.date === date);

test('calendar helpers: holidays land on the right days', () => {
  assert.equal(nthWeekday(2026, 11, 4, 4), '2026-11-26');   // Thanksgiving
  assert.equal(nthWeekday(2027, 5, 1, -1), '2027-05-31');   // Memorial Day
  assert.equal(nthWeekday(2027, 9, 1, 1), '2027-09-06');    // Labor Day
  const ev = Object.fromEntries(recurringEvents(2027).map(e => [e.name, e]));
  assert.deepEqual([ev['Thanksgiving'].start, ev['Thanksgiving'].end], ['2027-11-24', '2027-11-27']);
  assert.deepEqual([ev['Memorial Day weekend'].start, ev['Memorial Day weekend'].end], ['2027-05-28', '2027-05-30']);
  assert.deepEqual([ev['Cheyenne Frontier Days (overflow)'].start, ev['Cheyenne Frontier Days (overflow)'].end], ['2027-07-16', '2027-07-24']);
});

test('starter events are added once, skip the past, and can be edited or removed', () => {
  const db = openDb(':memory:');
  seedEvents(db, TODAY);
  const ev = listEvents(db);
  assert.ok(ev.some(e => e.name === 'UW football vs Air Force' && e.start_date === '2026-10-23' && e.source.includes('gowyo')));
  assert.ok(ev.some(e => e.name === 'Laramie Jubilee Days' && e.start_date === '2027-07-03'));
  assert.ok(!ev.some(e => e.end_date < TODAY), 'nothing in the past');
  assert.ok(ev.filter(e => e.name === 'UW Commencement weekend').every(e => /estimated/.test(e.source)));
  seedEvents(db, TODAY);
  assert.equal(listEvents(db).length, ev.length, 'not added twice');
  assert.throws(() => saveEvent(db, { name: 'X', start_date: '2026-11-02', end_date: '2026-11-01', pct: 10 }), /first and last night/);
  assert.throws(() => saveEvent(db, { name: 'X', start_date: '2026-11-01', end_date: '2026-11-01', pct: 900 }), /-50% and \+300%/);
  const id = saveEvent(db, { name: 'Brewfest', start_date: '2027-06-04', end_date: '2027-06-05', pct: 20, min_stay: 2 });
  saveEvent(db, { id, name: 'Laramie Brewfest', start_date: '2027-06-04', end_date: '2027-06-05', pct: 25 });
  assert.equal(listEvents(db).find(e => e.id === id).pct, 25);
  deleteEvent(db, id);
  assert.ok(!listEvents(db).some(e => e.id === id));
});

test('settings are validated', () => {
  const db = setup();
  assert.throws(() => savePricingSettings(db, 600, { min: 300, max: 200 }), /minimum price is above the maximum/);
  assert.throws(() => savePricingSettings(db, 600, { dow: [1, 2, 3] }), /7 percentages/);
  assert.throws(() => savePricingSettings(db, 600, { base: 5 }), /base must be between/);
  assert.throws(() => savePricingSettings(db, 999, { base: 100 }), /room/);
  const db2 = openDb(':memory:');
  upsertProperties(db2, [{ id: 1, name: 'P', roomTypes: [{ id: 2, name: 'R' }] }]);
  assert.throws(() => savePricingSettings(db2, 2, { auto: true }), /base price before turning on auto/);
  assert.equal(pricingSettings(db2, 2).season.length, 12, 'defaults until saved');
});

test('day of week, season and events stack; the biggest overlapping event wins', () => {
  const db = setup({ dow: [0, 0, 0, 0, 0, 10, 20], season: [0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0] });
  saveEvent(db, { name: 'Small', start_date: d(12), end_date: d(12), pct: 10 });
  saveEvent(db, { name: 'UW game', start_date: d(11), end_date: d(12), pct: 60, min_stay: 3 });
  const rec = recommend(db, 600, { days: 30, today: TODAY });
  assert.equal(night(rec, d(1)).price, 220, 'Tuesday in October: 200 × 1.10');
  assert.equal(night(rec, d(5)).price, Math.round(200 * 1.2 * 1.1), 'Saturday in October');
  const sat = night(rec, d(12));  // Saturday of the event
  assert.equal(sat.price, Math.round(200 * 1.2 * 1.1 * 1.6));
  assert.equal(sat.event, 'UW game'); assert.equal(sat.minStay, 3);
  assert.deepEqual(sat.factors.map(f => f.label), ['Base price', 'Saturday', 'October', 'Event: UW game']);
});

test('floor, ceiling and rounding', () => {
  const db = setup({ min: 150, max: 260, rounding: 5, dow: [0, 0, 0, 0, 0, 0, 60], season: Array(12).fill(-30) });
  const rec = recommend(db, 600, { days: 14, today: TODAY });
  assert.equal(night(rec, d(1)).price, 150); assert.match(night(rec, d(1)).notes[0], /minimum of \$150/);
  assert.equal(night(rec, d(5)).price, 225, '200 × 0.7 × 1.6 = 224 → nearest $5');
  savePricingSettings(db, 600, { season: Array(12).fill(0) });
  assert.equal(night(recommend(db, 600, { days: 14, today: TODAY }), d(5)).price, 260, 'capped at the maximum');
});

test('last-minute discount ramps in, far-out premium applies', () => {
  const db = setup({ lastMinuteDays: 10, lastMinutePct: -20, farOutDays: 100, farOutPct: 10 });
  const rec = recommend(db, 600, { days: 120, today: TODAY });
  assert.equal(night(rec, d(0)).price, 160, 'tonight: full 20% off');
  assert.equal(night(rec, d(5)).price, 180, 'halfway: 10% off');
  assert.equal(night(rec, d(10)).price, 200, 'outside the window');
  assert.equal(night(rec, d(100)).price, 220, 'far ahead: +10%');
});

test('booked and blocked nights are shown but never repriced; gap nights get a discount and shorter minimum', async () => {
  const db = setup({ gapPct: -20, minStay: 2 });
  upsertBookings(db, [
    { id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: d(3), departure: d(6), firstName: 'A' },
    { id: 2, propertyId: 500, roomId: 600, status: 'confirmed', arrival: d(7), departure: d(9), firstName: 'B' },
  ]);
  const cal = new FakeCal();
  cal.days.set(`600|${d(20)}`, { price1: 180, override: 'blackout' });
  await syncCalendar(db, cal, TODAY, d(60));
  const rec = recommend(db, 600, { days: 30, today: TODAY });
  assert.equal(night(rec, d(4)).booked, true);
  assert.equal(night(rec, d(20)).blocked, true);
  const gap = night(rec, d(6));
  assert.equal(gap.gap, 1); assert.equal(gap.minStay, 1); assert.equal(gap.price, 160);
  assert.equal(night(rec, d(10)).gap, null, 'open-ended availability is not a gap');
  // Looking at a later window must not treat its first day as following a stay.
  const later = recommend(db, 600, { start: d(25), days: 10, today: TODAY });
  assert.equal(later.nights[0].gap, null);
});

test('booking pace compares with what was booked by this date last year', () => {
  const db = setup({ pacing: true, pacingMax: 10 });
  // Next month (Nov 2026): 15 of 30 nights booked now.
  upsertBookings(db, [{ id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2026-11-02', departure: '2026-11-17', bookingTime: '2026-09-01T00:00:00Z' }]);
  // Same month last year: one stay booked early (counts), one booked later (doesn't count toward pace).
  upsertBookings(db, [
    { id: 2, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2025-11-04', departure: '2025-11-07', bookingTime: '2025-08-01T00:00:00Z' },
    { id: 3, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2025-11-20', departure: '2025-11-27', bookingTime: '2025-11-15T00:00:00Z' },
  ]);
  const pace = monthlyPace(db, 600, TODAY, 3);
  assert.equal(Math.round(pace['2026-11'].now * 100), 50);
  assert.equal(Math.round(pace['2026-11'].lastYear * 100), 10);
  assert.equal(pace['2026-12'].lastYear, null, 'no history for that month: no pace adjustment');
  const n = night(recommend(db, 600, { days: 60, today: TODAY }), '2026-11-20');
  const f = n.factors.find(x => x.label.startsWith('Pace'));
  assert.equal(f.pct, 10, '40 points ahead → capped at +10%');
  assert.equal(n.price, 220);
});

test('pending changes: threshold, minimum stay, and the auto-pricing cap', () => {
  const rec = { nights: [
    { date: '2026-11-01', price: 220, minStay: 2, current: 200, currentMinStay: 2 },
    { date: '2026-11-02', price: 202, minStay: 2, current: 200, currentMinStay: 2 },
    { date: '2026-11-03', price: 200, minStay: 3, current: 200, currentMinStay: 2 },
    { date: '2026-11-04', price: 400, minStay: 2, current: 200, currentMinStay: 2 },
    { date: '2026-11-05', booked: true, current: 200 },
  ] };
  assert.deepEqual(pendingChanges(rec, { threshold: 5 }).map(c => c.date), ['2026-11-01', '2026-11-03', '2026-11-04']);
  assert.deepEqual(pendingChanges(rec, { threshold: 5, includeMinStay: false }).map(c => c.date), ['2026-11-01', '2026-11-04']);
  const capped = pendingChanges(rec, { threshold: 5, maxChangePct: 25 });
  assert.equal(capped.find(c => c.date === '2026-11-04').price, 250, 'at most +25% in one go');
});

test('applying sends grouped ranges, skips booked nights, confirms, and logs', async () => {
  const db = setup();
  const cal = new FakeCal();
  upsertBookings(db, [{ id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: d(4), departure: d(5) }]);
  await syncCalendar(db, cal, TODAY, d(30));
  const changes = [d(1), d(2), d(3), d(4), d(5)].map((date, i) => ({ date, price: i < 2 ? 210 : 230, minStay: 2 }));
  const r = await applyNightly(db, cal, 600, changes, { today: TODAY });
  assert.equal(r.applied, 4, 'the booked night is skipped');
  assert.deepEqual(cal.posts[0][0].calendar, [
    { from: d(1), to: d(2), price1: 210, minStay: 2 },
    { from: d(3), to: d(3), price1: 230, minStay: 2 },
    { from: d(5), to: d(5), price1: 230, minStay: 2 },
  ]);
  assert.deepEqual(r.warnings, []);
  const log = db.prepare('SELECT * FROM change_log').get();
  assert.equal(log.ok, 1); assert.match(log.summary, /4 nights repriced/);
  await assert.rejects(applyNightly(db, cal, 600, [{ date: d(-1), price: 100 }], { today: TODAY }), /Past nights/);
  cal.ignore = true;
  const r2 = await applyNightly(db, cal, 600, [{ date: d(8), price: 199, minStay: 2 }], { today: TODAY });
  assert.match(r2.warnings[0], /different price for 1 night/);
});

test('auto-pricing runs once a day, only when switched on', async () => {
  const db = setup({ auto: false });
  const cal = new FakeCal();
  for (let i = 0; i < 10; i++) cal.days.set(`600|${d(i)}`, { price1: 150, minStay: 2 });
  await syncCalendar(db, cal, TODAY, d(30));
  assert.deepEqual(await autoPrice(db, cal, TODAY), []);
  savePricingSettings(db, 600, { auto: true, autoHorizon: 10, autoThreshold: 5, autoMaxChangePct: 25 });
  const r = await autoPrice(db, cal, TODAY);
  assert.equal(r[0].applied, 10);
  assert.ok(cal.posts[0][0].calendar.every(c => c.price1 === 187), 'capped at +25% of $150 in one day ($187.50, rounded down so the cap holds)');
  assert.deepEqual(await autoPrice(db, cal, TODAY), [], 'not again the same day');
});

test('suggestions from history: base from weekday nights, monthly and weekday adjustments', () => {
  const db = setup();
  const stays = [];
  let id = 1;
  for (let m = 1; m <= 12; m++) {
    const rate = m >= 6 && m <= 8 ? 260 : 180;
    stays.push({ id: id++, propertyId: 500, roomId: 600, status: 'confirmed', arrival: `2025-${String(m).padStart(2, '0')}-05`, departure: `2025-${String(m).padStart(2, '0')}-12`, price: rate * 7 });
  }
  upsertBookings(db, stays);
  const s = suggestFromHistory(db, 600, TODAY);
  assert.equal(s.enough, true);
  assert.equal(s.base, 180);
  assert.ok(s.season[6] > 20 && s.season[0] < 0, 'July above average, January below');
  assert.equal(s.monthAdr[6], 260);
  assert.equal(suggestFromHistory(openDb(':memory:'), 600, TODAY).enough, false);
});

test('rounding never takes a price past the floor or ceiling', () => {
  assert.equal(limitPrice(199.4, { rounding: 5, max: 199 }), 195, 'not $200 over a $199 ceiling');
  assert.equal(limitPrice(98, { rounding: 5, min: 101 }), 105, 'not $100 under a $101 floor');
  assert.equal(limitPrice(150, { rounding: 10, min: 101, max: 109 }), 109, 'floor and ceiling closer than a step: the ceiling');
  const db = setup({ rounding: 5, max: 199, base: 250 });
  assert.ok(recommend(db, 600, { start: d(10), days: 5, today: TODAY }).nights.every(n => n.price === 195));
});

test('pace: a stay on the books a year ago still counts even if it was cancelled later', () => {
  const db = setup();
  const ly = (id, arr, dep, status, cancelled) => db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,price,booked_at,cancelled_at,source)
    VALUES(?,500,600,?,'Airbnb',?,?,?,300,?,?,'beds24')`).run(id, status, arr, dep, (Date.parse(dep) - Date.parse(arr)) / 864e5, '2025-09-01T00:00:00Z', cancelled);
  ly(1, '2025-11-05', '2025-11-10', 'cancelled', '2025-10-20T00:00:00Z');   // on the books on Oct 12, 2025; cancelled later
  ly(2, '2025-11-15', '2025-11-17', 'confirmed', null);
  ly(3, '2025-11-20', '2025-11-22', 'cancelled', '2025-10-01T00:00:00Z');   // already cancelled by then: doesn't count
  const pace = monthlyPace(db, 600, TODAY, 3)['2026-11'];
  assert.equal(Math.round(pace.lastYear * 30), 7, '5 + 2 nights were on the books this time last year');
});

test('auto-pricing: one room failing doesn\'t stop the others, and it waits before retrying', async () => {
  const db = setup({ auto: true, autoHorizon: 7, autoThreshold: 1 });
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Unit 1', qty: 1 }, { id: 601, name: 'Unit 2', qty: 1 }] }]);
  savePricingSettings(db, 601, { base: 200, rounding: 1, lastMinuteDays: 0, farOutPct: 0, pacing: false, gapPct: 0, auto: true, autoHorizon: 7, autoThreshold: 1 });
  const cal = new FakeCal();
  const post = cal.post.bind(cal);
  cal.post = async (path, body) => { if (body[0].roomId === 600) throw new Error('Beds24 rejected the change'); return post(path, body); };
  const now = Date.parse('2026-10-12T15:00:00Z');
  await assert.rejects(autoPrice(db, cal, TODAY, now), /Unit 1: .*rejected/);
  assert.ok(cal.days.size > 0, 'Unit 2 was still priced');
  const calls = cal.posts.length;
  assert.deepEqual(await autoPrice(db, cal, TODAY, now + 15 * 60e3), [], 'the failed room waits; the done room is done for today');
  assert.equal(cal.posts.length, calls);
  await assert.rejects(autoPrice(db, cal, TODAY, now + 4 * 3600e3), /Unit 1/, 'tried again after 3 hours');
  assert.deepEqual(await autoPrice(db, { ...cal, canWriteInventory: false }, '2026-10-13', now + 30 * 3600e3), [], 'a read-only code never tries');
});
