import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSetting } from '../server/db.js';
import { Beds24Client } from '../server/beds24.js';
import { syncBeds24, mapBooking, normalizeChannel, upsertProperties } from '../server/sync.js';
import { periodStats, summary } from '../server/stats.js';
import { loadDemo, clearDemo } from '../server/demo.js';

test('channel normalization', () => {
  assert.equal(normalizeChannel({ channel: 'airbnb' }), 'Airbnb');
  assert.equal(normalizeChannel({ channel: 'booking' }), 'Booking.com');
  assert.equal(normalizeChannel({ referer: 'HomeAway' , channel: 'x'}), 'VRBO');
  assert.equal(normalizeChannel({}), 'Direct');
});

test('mapBooking', () => {
  const m = mapBooking({ id: 1, arrival: '2026-10-01', departure: '2026-10-04', firstName: 'A', lastName: 'B', status: 'black', price: '300' });
  assert.equal(m.nights, 3); assert.equal(m.status, 'block'); assert.equal(m.guest_name, 'A B'); assert.equal(m.price, 300);
});

function fakeBeds24() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    const json = b => ({ ok: true, status: 200, json: async () => b });
    if (u.pathname.endsWith('/authentication/setup')) return json({ token: 't1', refreshToken: 'r1', expiresIn: 86400 });
    if (u.pathname.endsWith('/authentication/token')) return json({ token: 't2', expiresIn: 86400 });
    if (u.pathname.endsWith('/properties')) return json({ data: [{ id: 1, name: 'Cabin', roomTypes: [{ id: 10, name: 'Main', qty: 1 }] }], pages: {} });
    if (u.pathname.endsWith('/bookings')) {
      const page = Number(u.searchParams.get('page'));
      return json(page === 1
        ? { data: [{ id: 1, propertyId: 1, roomId: 10, status: 'confirmed', channel: 'airbnb', arrival: '2026-10-01', departure: '2026-10-05', price: 400 }], pages: { nextPageExists: true } }
        : { data: [{ id: 2, propertyId: 1, roomId: 10, status: 'cancelled', arrival: '2026-10-10', departure: '2026-10-12', price: 100 }], pages: {} });
    }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}

test('connect + paginated sync + stats', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeBeds24();
  const client = new Beds24Client(db, fetchImpl);
  await client.connect('invite');
  assert.ok(client.connected);
  const r = await syncBeds24(db, client);
  assert.equal(r.bookings, 2);
  assert.ok(getSetting(db, 'last_sync'));
  // second sync is incremental
  await syncBeds24(db, client);
  assert.ok(calls.some(c => c.includes('modifiedFrom=')));

  const s = periodStats(db, '2026-10-01', '2026-11-01');
  assert.equal(s.nights, 4);                       // cancelled booking excluded
  assert.equal(s.revenue, 400);
  assert.equal(s.available, 31);
  assert.equal(s.byChannel.Airbnb.nights, 4);
  // proration: booking straddling the range start counts only in-range nights
  assert.equal(periodStats(db, '2026-10-03', '2026-11-01').revenue, 200);

  const sum = summary(db, '2026-10-05');
  assert.equal(sum.departures.length, 1);
  assert.equal(sum.arrivals.length, 0);
});

test('expired token is refreshed', async () => {
  const db = openDb(':memory:');
  const { fetchImpl, calls } = fakeBeds24();
  const client = new Beds24Client(db, fetchImpl);
  await client.connect('x');
  db.prepare("UPDATE settings SET value='0' WHERE key='beds24_token_exp'").run();
  await client.get('/properties');
  assert.ok(calls.some(c => c.includes('/authentication/token')));
});

test('clearDemo removes only demo rows', () => {
  const db = openDb(':memory:');
  loadDemo(db, '2026-10-08');
  db.prepare("UPDATE properties SET name='My Real Place' WHERE id=2").run(); // same id, different name: untouched
  db.prepare("INSERT INTO properties(id,name) VALUES(123456,'Real Cabin')").run();
  db.prepare("INSERT INTO bookings(id,property_id,status,channel,arrival,departure,nights) VALUES(99999999,123456,'confirmed','Airbnb','2026-10-01','2026-10-03',2)").run();
  clearDemo(db);
  assert.deepEqual(db.prepare('SELECT id FROM properties ORDER BY id').all().map(r => r.id), [2, 123456]);
  assert.deepEqual(db.prepare('SELECT DISTINCT property_id FROM bookings ORDER BY 1').all().map(r => r.property_id), [2, 123456]);
  assert.deepEqual(db.prepare('SELECT DISTINCT property_id FROM rooms').all().map(r => r.property_id), [2]);
  assert.equal(getSetting(db, 'demo'), null);
});

test('calendar returns bookings and nightly prices only for the rooms in view', async () => {
  const { calendar } = await import('../server/stats.js');
  const { upsertProperties: up, upsertBookings: ub } = await import('../server/sync.js');
  const db = openDb(':memory:');
  up(db, [{ id: 1, name: 'A', roomTypes: [{ id: 10, name: 'A1' }] }, { id: 2, name: 'B', roomTypes: [{ id: 20, name: 'B1' }] }]);
  ub(db, [
    { id: 1, propertyId: 1, roomId: 10, status: 'confirmed', arrival: '2026-11-03', departure: '2026-11-06', numAdult: 2, numChild: 1, price: 300 },
    { id: 2, propertyId: 2, roomId: 20, status: 'confirmed', arrival: '2026-11-04', departure: '2026-11-05', price: 100 },
    { id: 3, propertyId: 1, roomId: 10, status: 'cancelled', arrival: '2026-11-10', departure: '2026-11-12', price: 100 },
    { id: 4, propertyId: 1, roomId: 10, status: 'confirmed', arrival: '2026-12-20', departure: '2026-12-22', price: 100 },
  ]);
  db.prepare("INSERT INTO calendar_days(room_id,date,price,override) VALUES(10,'2026-11-07',199,'none'),(10,'2026-11-08',199,'blackout'),(10,'2027-01-01',1,'none')").run();
  const all = calendar(db, '2026-11-01', 35);
  assert.deepEqual(all.bookings.map(b => b.id), [1, 2], 'cancelled and out-of-range stays are left out');
  assert.equal(all.bookings[0].adults, 2); assert.equal(all.bookings[0].children, 1);
  assert.deepEqual(all.nights.map(n => [n.date, n.price, n.blocked]), [['2026-11-07', 199, 0], ['2026-11-08', 199, 1]]);
  const onlyB = calendar(db, '2026-11-01', 35, 2);
  assert.deepEqual(onlyB.bookings.map(b => b.id), [2]);
  assert.deepEqual(onlyB.nights, []);
});

test('a room with quantity 0, or one Beds24 no longer lists, is kept but is not a sellable unit', () => {
  const db = openDb(':memory:');
  const rooms = (...r) => [{ id: 500, name: 'P', roomTypes: r }];
  const qty = id => db.prepare('SELECT qty FROM rooms WHERE id = ?').get(id)?.qty;
  upsertProperties(db, rooms({ id: 600, name: 'Whole house', qty: 1 }, { id: 601, name: 'Old listing (retired)', qty: 0 }, { id: 602, name: 'Annex' }));
  assert.deepEqual([qty(600), qty(601), qty(602)], [1, 0, 1], 'qty 0 is stored as given; a missing qty still means one');
  assert.equal(periodStats(db, '2026-09-01', '2026-10-01').available, 60, 'two sellable units');
  db.prepare("INSERT INTO rooms(id,property_id,name,qty) VALUES(-1,-1,'Guesty history',1)").run();
  upsertProperties(db, rooms({ id: 600, name: 'Whole house', qty: 1 }));   // 601 and 602 removed in Beds24
  assert.deepEqual([qty(600), qty(601), qty(602), qty(-1)], [1, 0, 0, 1], 'kept for their bookings but no longer for sale; local rooms untouched');
  assert.equal(periodStats(db, '2026-09-01', '2026-10-01', 500).available, 30);
  upsertProperties(db, []);
  assert.equal(qty(600), 1, 'an empty reply retires nothing');
  upsertProperties(db, rooms({ id: 600, name: 'Whole house', qty: 0 }));
  assert.equal(periodStats(db, '2026-09-01', '2026-10-01', 500).available, 30, 'never fewer than one unit, so nothing divides by zero');
});
