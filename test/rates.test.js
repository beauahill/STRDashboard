import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Beds24Client } from '../server/beds24.js';
import { upsertProperties, upsertBookings, normalizeChannel, syncBeds24 } from '../server/sync.js';
import { syncCalendar, readDays, planChanges, toCalendarRanges, applyChanges, recentChanges } from '../server/rates.js';

const TODAY = new Date().toISOString().slice(0, 10);
const day = n => new Date(Date.parse(TODAY) + n * 86400000).toISOString().slice(0, 10);

/** In-memory stand-in for the Beds24 calendar API (inclusive from/to ranges, like the real one). */
class FakeCalendar {
  constructor() { this.days = new Map(); this.posts = []; this.ignoreWrites = false; this.reject = null; }
  set(roomId, date, v) { this.days.set(`${roomId}|${date}`, { ...this.get(roomId, date), ...v }); }
  get(roomId, date) { return this.days.get(`${roomId}|${date}`); }
  async getAll(path, q) {
    assert.equal(path, '/inventory/rooms/calendar');
    for (const f of ['includePrices', 'includeMinStay', 'includeNumAvail', 'includeOverride']) assert.equal(q[f], true);
    return q.roomId.map(roomId => {
      const calendar = [];
      for (let d = q.startDate; d <= q.endDate; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
        const v = this.get(roomId, d);
        if (v) calendar.push({ from: d, to: d, ...v });
      }
      return { roomId, propertyId: 500, calendar };
    });
  }
  async post(path, body) {
    assert.equal(path, '/inventory/rooms/calendar');
    this.posts.push(body);
    if (this.reject) return [{ success: false, errors: [{ field: 'price1', message: this.reject }] }];
    if (!this.ignoreWrites) {
      for (const { roomId, calendar } of body) for (const r of calendar) {
        for (let d = r.from; d <= r.to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
          const { from, to, ...v } = r;
          this.set(roomId, d, v);
        }
      }
    }
    return [{ success: true, modified: {} }];
  }
}

function setup() {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  const cal = new FakeCalendar();
  for (let i = 0; i < 40; i++) cal.set(600, day(i), { price1: 200, minStay: 2, numAvail: 1, override: 'none' });
  return { db, cal };
}

test('calendar sync expands inclusive ranges and clips them to the window', async () => {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'P', roomTypes: [{ id: 600, name: 'R', qty: 1 }] }]);
  const client = { getAll: async () => [{ roomId: 600, calendar: [
    { from: day(-5), to: day(2), price1: 150, minStay: 2, numAvail: 1, override: 'none' },
    { from: day(3), to: day(3), price1: 300, override: 'blackout', numAvail: 0 },
  ] }] };
  await syncCalendar(db, client, day(0), day(10));
  const days = readDays(db, 600, day(0), 5);
  assert.deepEqual(days.map(d => d.price), [150, 150, 150, 300, null]);
  assert.deepEqual(days.map(d => d.blocked), [false, false, false, true, false]);
  assert.equal(days[4].known, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calendar_days WHERE date < ?').get(day(0)).n, 0, 'nothing stored outside the window');
});

test('readDays shows which nights are booked', async () => {
  const { db, cal } = setup();
  upsertBookings(db, [{ id: 1, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival: day(2), departure: day(4), firstName: 'Pat' }]);
  await syncCalendar(db, cal, day(0), day(10));
  const days = readDays(db, 600, day(0), 5);
  assert.deepEqual(days.map(d => d.booking?.guest ?? null), [null, null, 'Pat', 'Pat', null], 'checkout night is free');
  assert.equal(days[2].booking.checkIn, true);
});

test('planChanges validates input', async () => {
  const { db, cal } = setup();
  await syncCalendar(db, cal, day(0), day(39));
  const ok = { roomId: 600, from: day(1), to: day(3), price: 250 };
  const bad = (patch, re) => assert.throws(() => planChanges(db, { ...ok, ...patch }), e => e.status === 400 && re.test(e.message));
  bad({ roomId: 999 }, /room/);
  bad({ from: day(-1) }, /Past dates/);
  bad({ to: day(0) }, /before the start/);
  bad({ from: 'tomorrow' }, /start and end date/);
  bad({ to: day(600) }, /500 nights/);
  bad({ price: 0 }, /between \$1/);
  bad({ price: 'abc' }, /between \$1/);
  bad({ price: '', minStay: 1.5 }, /whole number/);
  bad({ price: '', minStay: '', block: '' }, /Enter a price/);
  bad({ weekdays: [9] }, /weekday/);
  upsertProperties(db, [{ id: -1, name: 'Guesty placeholder', roomTypes: [{ id: -1, name: 'x' }] }]);
  bad({ roomId: -1 }, /room/);
});

test('planChanges lists only nights that change, honours weekdays, and warns', async () => {
  const { db, cal } = setup();
  cal.set(600, day(5), { price1: 250 });
  upsertBookings(db, [{ id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: day(6), departure: day(7), firstName: 'Lee' }]);
  await syncCalendar(db, cal, day(0), day(39));

  const p = planChanges(db, { roomId: 600, from: day(1), to: day(14), price: 250 });
  assert.equal(p.selected, 14);
  assert.equal(p.changes.length, 13, 'the night already at $250 is left out');
  assert.match(p.warnings.join(' '), /already booked/);
  assert.equal(p.summary, 'Price $250');

  const fri = planChanges(db, { roomId: 600, from: day(0), to: day(13), weekdays: [5, 6], minStay: 3 });
  assert.equal(fri.selected, 4);
  assert.ok(fri.changes.every(c => [5, 6].includes(new Date(c.date + 'T00:00:00Z').getUTCDay())));
  assert.match(fri.summary, /Min stay 3 nights · \(Fri, Sat only\)/);

  const drop = planChanges(db, { roomId: 600, from: day(1), to: day(2), price: 25 });
  assert.match(drop.warnings[0], /drop more than 40% \(e\.g\. \$200 → \$25\)/);

  const none = planChanges(db, { roomId: 600, from: day(1), to: day(2), price: 200, minStay: 2, block: 'unblock' });
  assert.equal(none.changes.length, 0);
});

test('changes are grouped into Beds24 date ranges with the right fields', async () => {
  const { db, cal } = setup();
  await syncCalendar(db, cal, day(0), day(39));
  const p = planChanges(db, { roomId: 600, from: day(0), to: day(13), weekdays: [5, 6], price: 300, block: 'block' });
  const ranges = toCalendarRanges(p);
  assert.equal(ranges.length, 2, 'two Fri–Sat weekends');
  for (const r of ranges) {
    assert.equal(r.price1, 300); assert.equal(r.override, 'blackout'); assert.ok(!('minStay' in r));
    assert.equal(new Date(r.from + 'T00:00:00Z').getUTCDay(), 5);
    assert.equal(new Date(r.to + 'T00:00:00Z').getUTCDay(), 6);
  }
  const open = toCalendarRanges(planChanges(db, { roomId: 600, from: day(1), to: day(3), block: 'unblock', minStay: 4 }));
  assert.deepEqual(open, [{ from: day(1), to: day(3), minStay: 4, override: 'none' }]);
});

test('applyChanges sends, confirms by re-reading Beds24, and logs', async () => {
  const { db, cal } = setup();
  await syncCalendar(db, cal, day(0), day(39));
  const res = await applyChanges(db, cal, { roomId: 600, from: day(3), to: day(5), price: 275.5 });
  assert.equal(res.applied, 3);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(cal.posts[0], [{ roomId: 600, calendar: [{ from: day(3), to: day(5), price1: 275.5 }] }]);
  assert.deepEqual(readDays(db, 600, day(3), 3).map(d => d.price), [275.5, 275.5, 275.5]);
  const [log] = recentChanges(db);
  assert.equal(log.ok, 1); assert.equal(log.nights, 3); assert.equal(log.summary, 'Price $275.5');

  const again = await applyChanges(db, cal, { roomId: 600, from: day(3), to: day(5), price: 275.5 });
  assert.equal(again.applied, 0, 'nothing sent when nothing changes');
  assert.equal(cal.posts.length, 1);
});

test('applyChanges reports Beds24 errors and values that did not stick', async () => {
  const { db, cal } = setup();
  await syncCalendar(db, cal, day(0), day(39));
  cal.reject = 'price too low';
  await assert.rejects(applyChanges(db, cal, { roomId: 600, from: day(1), to: day(1), price: 99 }), /rejected the change: price too low/);
  assert.equal(recentChanges(db)[0].ok, 0);

  cal.reject = null; cal.ignoreWrites = true;
  const res = await applyChanges(db, cal, { roomId: 600, from: day(1), to: day(2), price: 99 });
  assert.match(res.warnings.join(' '), /different values for 2 nights/);
});

test('Beds24 client: POST with token, 403 handling, and write-permission detection', async () => {
  const db = openDb(':memory:');
  const seen = [];
  let scopes = ['read:bookings', 'read:inventory'];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); seen.push({ path: u.pathname, ...opts });
    const json = (status, b) => ({ ok: status < 400, status, json: async () => b });
    if (u.pathname.endsWith('/authentication/setup')) return json(200, { token: 't', refreshToken: 'r', expiresIn: 86400 });
    if (u.pathname.endsWith('/authentication/details')) return json(200, { validToken: true, token: { scopes } });
    if (opts.method === 'POST') return json(403, { success: false, error: 'Token does not have write:inventory scope' });
    return json(200, { data: [] });
  };
  const c = new Beds24Client(db, fetchImpl);
  assert.equal(c.canWriteInventory, null, 'unknown before connecting');
  await c.connect('code');
  assert.equal(seen[0].headers.deviceName, 'STR Dashboard');
  assert.equal(c.canWriteInventory, false);
  await assert.rejects(c.post('/inventory/rooms/calendar', [{ roomId: 1 }]), e => e.status === 403 && /write:inventory/.test(e.message));
  const post = seen.find(s => s.method === 'POST');
  assert.equal(post.headers.token, 't'); assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), [{ roomId: 1 }]);

  scopes = ['all:bookings', 'all:inventory']; await c.refreshScopes();
  assert.equal(c.canWriteInventory, true);
  scopes = ['write:inventory']; await c.refreshScopes();
  assert.equal(c.canWriteInventory, true);
  c.disconnect();
  assert.equal(c.scopes, null);
});

test('channel mapping: Beds24 booking page is Direct, not Booking.com', () => {
  assert.equal(normalizeChannel({ channel: 'bookingpage' }), 'Direct');
  assert.equal(normalizeChannel({ channel: 'booking' }), 'Booking.com');
  assert.equal(normalizeChannel({ channel: 'vrbo' }), 'VRBO');
  assert.equal(normalizeChannel({ channel: 'vrboical' }), 'VRBO');
  assert.equal(normalizeChannel({ channel: 'airbnbical' }), 'Airbnb');
  assert.equal(normalizeChannel({ channel: 'expedia' }), 'Other');
});

test('incremental sync sends modifiedFrom in the format Beds24 documents', async () => {
  const db = openDb(':memory:');
  const urls = [];
  const client = { getAll: async (path, q) => { urls.push({ path, q }); return []; } };
  await syncBeds24(db, client);
  await syncBeds24(db, client);
  const inc = urls.filter(u => u.path === '/bookings')[1].q;
  assert.match(inc.modifiedFrom, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('the calendar window starts on the property\'s date, not the UTC one', async () => {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'P', roomTypes: [{ id: 600, name: 'R', qty: 1 }] }]);
  const seen = [];
  const client = { getAll: async (path, q) => { seen.push(q); return []; } };
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-12-25T01:00:00Z');   // 6 pm on Christmas Eve in Wyoming
  try { await syncCalendar(db, client); } finally { Date.now = realNow; }
  assert.equal(seen[0].startDate, '2026-12-24', 'tonight is refreshed too');
  assert.equal(seen[0].endDate, '2027-12-24');
});
