import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSetting } from '../server/db.js';
import { Beds24Client } from '../server/beds24.js';
import { syncBeds24, mapBooking, normalizeChannel } from '../server/sync.js';
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
