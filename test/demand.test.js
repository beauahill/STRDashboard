import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { recordSignals, demandSignals, historyBaseline, forwardStats, usualLeadTime, levelOf } from '../server/demand.js';
import { recommend, savePricingSettings, pricingSettings } from '../server/pricing.js';
import { addDays } from '../server/sync.js';

const TODAY = '2026-10-14';
const FLAT = { base: 100, rounding: 1, dow: [0, 0, 0, 0, 0, 0, 0], season: Array(12).fill(0), pacing: false, lastMinuteDays: 0, farOutPct: 0, minStay: 1 };

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(1,'Laramie House','Laramie'); INSERT INTO rooms(id,property_id,name) VALUES(10,1,'Whole house');");
  return db;
}
const add = (db, id, status, arrival, departure, { price = 0, bookedAt = null, firstSeen = null, channel = 'Airbnb' } = {}) =>
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,price,booked_at,first_seen,source)
    VALUES(?,1,10,?,?,?,?,?,?,?,?,?,'beds24')`).run(id, status, channel, arrival, departure, (Date.parse(departure) - Date.parse(arrival)) / 864e5, 'Guest', price, bookedAt, firstSeen);
const factor = (night, re) => night.factors.find(f => re.test(f.label));

test('inquiries and requests are remembered, even after they lapse, and nudge those nights up', () => {
  const db = setup();
  savePricingSettings(db, 10, FLAT);
  add(db, 50, 'inquiry', '2026-11-06', '2026-11-08', { firstSeen: '2026-10-10T12:00:00Z' });
  add(db, 51, 'request', '2026-11-07', '2026-11-09', { firstSeen: '2026-10-12T12:00:00Z', channel: 'VRBO' });
  add(db, 52, 'inquiry', '2026-11-07', '2026-11-08', { firstSeen: '2026-08-01T12:00:00Z' });   // too old to count
  add(db, 53, 'confirmed', '2026-11-20', '2026-11-22', { bookedAt: '2026-10-01T00:00:00Z' });  // a booking isn't an inquiry
  assert.equal(recordSignals(db), 3);
  assert.equal(recordSignals(db), 0, 'each is recorded once');
  // While a request is pending, Beds24 holds its nights.
  assert.ok(recommend(db, 10, { start: '2026-11-07', days: 1, today: TODAY }).nights[0].booked);
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id IN (50, 51)").run();   // the inquiry expired, the request was declined

  const rec = recommend(db, 10, { start: '2026-11-05', days: 5, today: TODAY });
  const n = Object.fromEntries(rec.nights.map(x => [x.date, x]));
  assert.equal(factor(n['2026-11-05'], /Demand/), undefined);
  assert.deepEqual(factor(n['2026-11-06'], /Demand/), { label: 'Demand: 1 guest asked about this night', pct: 5 });
  assert.deepEqual(factor(n['2026-11-07'], /Demand/), { label: 'Demand: 2 guests asked about this night', pct: 10 });
  assert.equal(n['2026-11-07'].price, 110);
  assert.equal(n['2026-11-08'].price, 105);
  assert.deepEqual(rec.signals.asked.map(a => a.booking_id).sort(), [50, 51]);

  savePricingSettings(db, 10, { demandMax: 8 });
  assert.equal(recommend(db, 10, { start: '2026-11-07', days: 1, today: TODAY }).nights[0].price, 108, 'capped');
  savePricingSettings(db, 10, { demand: false });
  assert.equal(recommend(db, 10, { start: '2026-11-07', days: 1, today: TODAY }).nights[0].price, 100, 'switched off');
  assert.throws(() => savePricingSettings(db, 10, { demandMax: 80 }), /demandMax/);
});

test('a stay booked far further ahead than usual lifts the nights around it', () => {
  const db = setup();
  savePricingSettings(db, 10, FLAT);
  // Usually booked 20 days ahead.
  for (let i = 0; i < 8; i++) {
    const arrival = addDays('2025-11-01', i * 30);
    add(db, 100 + i, 'confirmed', arrival, addDays(arrival, 2), { price: 200, bookedAt: addDays(arrival, -20) + 'T10:00:00Z' });
  }
  assert.deepEqual(usualLeadTime(db, 10, TODAY), { days: 20, stays: 8 });
  add(db, 200, 'confirmed', '2027-01-15', '2027-01-17', { price: 300, bookedAt: '2026-10-01T09:00:00Z' });   // 106 days ahead
  add(db, 201, 'confirmed', '2026-11-20', '2026-11-22', { price: 300, bookedAt: '2026-10-25T09:00:00Z' });   // ordinary
  const rec = recommend(db, 10, { start: '2027-01-11', days: 10, today: TODAY });
  const n = Object.fromEntries(rec.nights.map(x => [x.date, x]));
  assert.equal(factor(n['2027-01-11'], /Demand/), undefined, 'more than 3 nights away');
  assert.deepEqual(factor(n['2027-01-14'], /Demand/), { label: 'Demand: a nearby stay was booked 106 days ahead (usually 20)', pct: 5 });
  assert.ok(n['2027-01-15'].booked && !n['2027-01-15'].factors, 'the booked nights themselves');
  assert.ok(factor(n['2027-01-19'], /Demand/));
  assert.equal(factor(n['2027-01-20'], /Demand/), undefined);
  assert.deepEqual(rec.signals.pickup.map(b => [b.id, b.lead]), [[200, 106]]);
});

test('demand score: history (or the pricing rules), events, pace and signals, in four levels', () => {
  const db = setup();
  savePricingSettings(db, 10, { ...FLAT, season: pricingSettings(db, 10).season.map((_, i) => (i === 6 ? 25 : 0)), dow: [0, 0, 0, 0, 0, 0, 20] });
  // Every Saturday night of March, two years running, was booked; Tuesdays never were.
  for (const d of ['2025-03-01', '2025-03-08', '2025-03-15', '2025-03-22', '2025-03-29', '2026-03-07', '2026-03-14', '2026-03-21', '2026-03-28']) {
    add(db, Number(d.replace(/-/g, '')), 'confirmed', d, addDays(d, 1), { price: 150, bookedAt: addDays(d, -30) + 'T00:00:00Z' });
  }
  const s = pricingSettings(db, 10);
  const base = historyBaseline(db, 10, TODAY, s);
  assert.equal(base.nights, 9);
  assert.deepEqual(base.at('2027-03-06'), { value: 100, from: 'history' }, 'a March Saturday');
  assert.deepEqual(base.at('2027-03-09'), { value: 0, from: 'history' }, 'a March Tuesday');
  assert.deepEqual(base.at('2026-10-17').from, 'both', 'October Saturdays: only two so far');
  const none = setup();
  savePricingSettings(none, 10, s);
  assert.deepEqual(historyBaseline(none, 10, TODAY, s).at('2027-07-10'), { value: 50 + 0.8 * (25 + 20), from: 'rules' }, 'no history: season and weekday rules');

  const sig = demandSignals(db, 10, TODAY, s);
  const plain = sig.score('2027-03-09');
  assert.deepEqual([plain.score, plain.level], [0, 'low']);
  const ev = sig.score('2027-03-09', { event: { name: 'Spring tournament', pct: 50 }, pace: { now: 0.6, lastYear: 0.3 } });
  assert.deepEqual(ev.parts.map(p => [p.label, p.points]), [
    ['Your history for this month and weekday', 0], ['Event: Spring tournament', 30], ['Booking pace (60% booked vs 30% last year)', 15]]);
  assert.deepEqual([ev.score, ev.level], [45, 'mid']);
  assert.equal(sig.score('2027-03-06', { event: { name: 'Big game', pct: 80 } }).score, 100, 'capped at 100');
  assert.deepEqual([0, 34, 35, 54, 55, 74, 75, 100].map(v => levelOf(v).key), ['low', 'low', 'mid', 'mid', 'high', 'high', 'vhigh', 'vhigh']);

  // Every night of the recommendation carries its score, booked ones included.
  add(db, 9, 'confirmed', '2027-03-13', '2027-03-14', { price: 150, bookedAt: '2026-10-01T00:00:00Z' });
  const rec = recommend(db, 10, { start: '2027-03-12', days: 3, today: TODAY });
  assert.ok(rec.nights.every(n => typeof n.demand.score === 'number' && n.demand.parts.length));
  assert.equal(rec.nights[1].booked, true);
});

test('forward numbers: occupancy, ADR and RevPAR on the books, against last year at this point and how it finished', () => {
  const db = setup();
  add(db, 1, 'confirmed', '2026-10-15', '2026-10-20', { price: 500, bookedAt: '2026-09-01T00:00:00Z' });
  add(db, 2, 'cancelled', '2026-10-22', '2026-10-24', { price: 400, bookedAt: '2026-09-01T00:00:00Z' });
  add(db, 3, 'confirmed', '2025-10-16', '2025-10-18', { price: 300, bookedAt: '2025-09-01T00:00:00Z' });   // on the books a year ago
  add(db, 4, 'confirmed', '2025-10-20', '2025-10-25', { price: 1000, bookedAt: '2025-10-18T00:00:00Z' });  // booked later
  db.prepare("INSERT INTO calendar_days(room_id,date,override) VALUES(10,'2026-10-25','blackout')").run();
  const [w30] = forwardStats(db, 10, TODAY);
  assert.equal(w30.days, 30);
  assert.deepEqual({ ...w30.now }, { nights: 5, available: 29, occupancy: 5 / 29, adr: 100, revpar: 500 / 29, revenue: 500 });
  assert.equal(w30.lastYearAtThisPoint.nights, 2);
  assert.equal(w30.lastYearAtThisPoint.adr, 150);
  assert.equal(w30.lastYearFinal.nights, 7);
  assert.equal(w30.lastYearFinal.revenue, 1300);
  const fresh = setup();
  add(fresh, 1, 'confirmed', '2026-10-15', '2026-10-17', { price: 200 });
  assert.equal(forwardStats(fresh, 10, TODAY)[0].lastYearAtThisPoint, null, 'no history yet');
});

test('an old inquiry pulled in by the first sync is not fresh demand', () => {
  const db = setup();
  savePricingSettings(db, 10, FLAT);
  // Asked in February (Beds24's time), first seen by this app today.
  add(db, 60, 'inquiry', '2026-11-24', '2026-11-26', { bookedAt: '2026-02-03T10:00:00Z', firstSeen: '2026-10-14T12:00:00Z' });
  recordSignals(db, new Date('2026-10-14T12:00:00Z'));
  assert.equal(db.prepare('SELECT seen_at FROM demand_signals WHERE booking_id = 60').get().seen_at, '2026-02-03T10:00:00Z');
  assert.equal(factor(recommend(db, 10, { start: '2026-11-24', days: 1, today: TODAY }).nights[0], /Demand/), undefined);
});
