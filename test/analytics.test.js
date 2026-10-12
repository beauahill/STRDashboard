import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { analytics, monthly, headline, pace, channels, bookingWindow, byWeekday, cancellations, rangeFor } from '../server/analytics.js';

const TODAY = '2026-10-12';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(1,'Laramie House','Laramie'); INSERT INTO rooms(id,property_id,name,qty) VALUES(10,1,'Whole house',1);");
  const add = db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,adults,children,price,booked_at,cancelled_at,source)
    VALUES(?,1,10,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Last year
  add.run(-1, 'confirmed', 'Airbnb', '2025-07-04', '2025-07-06', 2, 'Guesty Guest', 2, 0, 300, '2025-06-01', null, 'guesty');
  add.run(1, 'confirmed', 'Airbnb', '2025-10-03', '2025-10-06', 3, 'Ann A', 2, 0, 600, '2025-09-01T10:00:00Z', null, 'beds24');
  add.run(2, 'confirmed', 'VRBO', '2025-10-20', '2025-10-22', 2, 'Bob B', 4, 2, 500, '2025-10-15T10:00:00Z', null, 'beds24');
  // This year
  add.run(3, 'confirmed', 'Airbnb', '2026-10-02', '2026-10-05', 3, 'Cat C', 2, 1, 750, '2026-08-01T10:00:00Z', null, 'beds24');
  add.run(4, 'confirmed', 'Direct', '2026-10-20', '2026-10-24', 4, 'Dan D', 3, 0, 1000, '2026-10-10T10:00:00Z', null, 'beds24');
  add.run(5, 'cancelled', 'Airbnb', '2026-10-25', '2026-10-27', 2, 'Eve E', 2, 0, 400, '2026-09-01T10:00:00Z', '2026-10-01T09:00:00Z', 'beds24');
  add.run(6, 'block', 'Direct', '2026-11-01', '2026-11-03', 2, null, 0, 0, 0, null, null, 'beds24');
  return db;
}

test('monthly trend pairs each month with the same month last year, including Guesty history', () => {
  const db = setup();
  const m = monthly(db, TODAY);
  assert.equal(m[0].month, '2025-07', 'starts at the first month with data');
  assert.equal(m.at(-1).month, '2027-04', 'runs 6 months ahead');
  const oct = m.find(x => x.month === '2026-10');
  assert.equal(oct.current, true);
  assert.equal(oct.nights, 7);
  assert.equal(oct.revenue, 1750);
  assert.equal(oct.lastYear.nights, 5);
  assert.equal(oct.lastYear.revenue, 1100);
  assert.equal(m.find(x => x.month === '2025-07').revenue, 300, 'Guesty-imported stays count');
  assert.equal(m.find(x => x.month === '2025-07').lastYear, null, 'no history before the first stay');
  assert.equal(m.find(x => x.month === '2026-11').nights, 0, 'blocks are not stays');
});

test('headline: year to date vs the same dates last year; null when there is no history', () => {
  const db = setup();
  const h = headline(db, TODAY);
  assert.equal(h.ytd.current.revenue, 750);
  assert.equal(h.ytd.lastYear.revenue, 900);
  assert.equal(h.next90.current.nights, 4);
  const empty = openDb();
  empty.exec("INSERT INTO properties(id,name) VALUES(1,'X'); INSERT INTO rooms(id,property_id,name) VALUES(10,1,'R');");
  empty.exec("INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,price) VALUES(1,1,10,'confirmed','Airbnb','2026-09-01','2026-09-03',2,200)");
  assert.equal(headline(empty, TODAY).ytd.lastYear, null);
  // Leap day maps to Feb 28 last year instead of an invalid date.
  assert.equal(headline(empty, '2028-02-29').ytd.lastYear.available, 59);
});

test('pace compares with what was booked by this date last year', () => {
  const db = setup();
  const [oct] = pace(db, TODAY);
  assert.equal(oct.month, '2026-10');
  assert.equal(oct.now.nights, 4, 'only nights from today on');
  assert.equal(oct.now.revenue, 1000);
  assert.equal(oct.lastYearAtThisPoint.nights, 0, 'Bob booked after this date last year');
  assert.equal(oct.lastYearFinal.nights, 2);
});

test('channels, booking window, weekdays and cancellations', () => {
  const db = setup();
  const ch = channels(db, '2025-10-13', '2026-10-13');
  assert.deepEqual(ch.map(c => c.channel), ['Airbnb', 'VRBO']);
  assert.equal(ch[0].avgLead, 62);
  assert.equal(ch[1].avgLead, 5);
  assert.equal(ch[0].revenueShare, 0.6);

  const w = bookingWindow(db, '2025-01-01', '2027-01-01');
  assert.equal(w.bookings, 5);
  assert.equal(w.lead.buckets.find(b => b.label === '1–2 weeks').bookings, 1, 'Dan booked 10 days ahead');
  assert.equal(w.stay.buckets.find(b => b.label === '3 nights').bookings, 2);
  assert.equal(w.guests.withChildren, 2);

  const wk = byWeekday(db, '2026-10-19', '2026-10-26');
  assert.equal(wk.find(d => d.day === 'Tue').occupancy, 1);
  assert.equal(wk.find(d => d.day === 'Mon').occupancy, 0);
  assert.equal(wk.find(d => d.day === 'Sun').occupancy, 0, 'the cancelled stay is not counted');

  const c = cancellations(db, '2026-10-01', '2026-11-01');
  assert.equal(c.bookings, 3);
  assert.equal(c.cancelled, 1);
  assert.equal(c.lostRevenue, 400);
  assert.equal(c.medianNoticeDays, 24);
  assert.equal(c.byChannel.find(x => x.channel === 'Airbnb').rate, 0.5);
});

test('named ranges and the full page payload', () => {
  const db = setup();
  assert.deepEqual(rangeFor(db, TODAY, 'ly'), ['2025-01-01', '2026-01-01']);
  assert.deepEqual(rangeFor(db, TODAY, 'ytd'), ['2026-01-01', '2026-10-13']);
  assert.deepEqual(rangeFor(db, TODAY, 'all'), ['2025-07-04', '2026-10-13']);
  const a = analytics(db, TODAY, { range: 'bogus' });
  assert.equal(a.range, '12m');
  assert.ok(a.headline && a.monthly.length && a.pace.length === 6 && a.window && a.weekdays.length === 7);
  assert.deepEqual(a.sources.map(s => s.source).sort(), ['beds24', 'guesty']);
  const scoped = analytics(db, TODAY, { propertyId: 99 });
  assert.equal(scoped.headline.ytd.current.revenue, 0, 'property filter applies');
});
