import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSetting, setSetting } from '../server/db.js';
import { Beds24Client } from '../server/beds24.js';
import { syncBeds24, addDays } from '../server/sync.js';
import { summary } from '../server/stats.js';
import { availability } from '../server/site.js';
import { DOOR_DEFAULTS, localToday } from '../server/doors.js';

const today = localToday(DOOR_DEFAULTS.tz);
const day = n => addDays(today, n);
const LONG_AGO = '2026-01-01 00:00:00';   // Beds24-style modifiedTime: untouched since well before any sync
const HOUR = 3600000;

/** Beds24 v2 behind a fetch() stand-in: bookings honour modifiedFrom/departureFrom, and any route can be overridden. */
function fakeBeds24() {
  const f = { bookings: [], calls: [], override: {} };
  f.json = (body, status = 200, type = 'application/json') => ({ ok: status < 400, status, headers: { get: () => type },
    json: async () => { if (type !== 'application/json') throw new SyntaxError('Unexpected token <'); return body; } });
  f.fetchImpl = async (url, opts = {}) => {
    const u = new URL(url), path = u.pathname.replace(/^.*\/api\/v2/, ''), q = u.searchParams;
    f.calls.push({ path, q: Object.fromEntries([...new Set(q.keys())].map(k => [k, q.getAll(k)])), signal: opts.signal });
    const r = f.override[path]?.(u, opts);
    if (r) return r;
    if (path === '/authentication/setup') return f.json({ token: 't-' + opts.headers.code, refreshToken: 'r-' + opts.headers.code, expiresIn: 86400 });
    if (path === '/authentication/token') return f.json({ token: 't-refreshed', expiresIn: 86400 });
    if (path === '/authentication/details') return f.json({ token: { scopes: ['all:bookings', 'all:properties'] } });
    if (path === '/properties') return f.json({ success: true, data: [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }], pages: {} });
    if (path === '/bookings') {
      const from = (q.get('modifiedFrom') || '').replace('T', ' '), dep = q.get('departureFrom') || '';
      return f.json({ success: true, data: f.bookings.filter(b => b.modifiedTime >= from && b.departure >= dep), pages: {} });
    }
    return f.json({ success: false, error: 'not found ' + path }, 404);
  };
  f.stay = (id, arrival, departure, over = {}) => ({ id, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival, departure,
    price: 300, firstName: 'Guest ' + id, modifiedTime: LONG_AGO, ...over });
  return f;
}

const status = (db, id) => db.prepare('SELECT status FROM bookings WHERE id = ?').get(id)?.status;
const stale = db => setSetting(db, 'last_full_check', new Date(Date.now() - 25 * HOUR).toISOString());
async function connected(f) {
  const db = openDb(':memory:');
  const client = new Beds24Client(db, f.fetchImpl);
  await client.connect('x');
  return { db, client };
}

test('a 200 that is not the expected JSON fails the sync instead of passing as "nothing changed"', async () => {
  const cases = [
    ['HTML body', f => f.json('<html>maintenance</html>', 200, 'text/html'), /instead of JSON/],
    ['success:false', f => f.json({ success: false, code: 1001, error: 'Invalid token' }), /Invalid token/],
    ['no data list', f => f.json({ success: true }), /no data list/],
  ];
  for (const [name, reply, re] of cases) {
    const f = fakeBeds24();
    f.bookings.push(f.stay(1, day(3), day(5)));
    const { db, client } = await connected(f);
    f.override['/bookings'] = () => reply(f);
    await assert.rejects(syncBeds24(db, client), re, name);
    assert.equal(getSetting(db, 'last_sync'), null, `${name}: the watermark must not move`);
    assert.equal(status(db, 1), undefined, `${name}: nothing stored`);
  }
});

test('a Beds24 that never answers is given up on after the timeout', async () => {
  const db = openDb(':memory:');
  const hang = (url, opts) => new Promise((_, reject) => {
    const alive = setTimeout(() => {}, 10000);   // a real socket would keep the loop alive; here something must
    opts.signal.addEventListener('abort', () => { clearTimeout(alive); reject(opts.signal.reason); });
  });
  const client = new Beds24Client(db, hang, { timeoutMs: 50 });
  await assert.rejects(client.connect('x'), /didn't answer within/);
  setSetting(db, 'beds24_refresh_token', 'r');
  await assert.rejects(client.get('/properties'), /didn't answer within/);

  const f = fakeBeds24();
  const { client: ok } = await connected(f);
  await ok.get('/properties');
  assert.ok(f.calls.length >= 3 && f.calls.every(c => c.signal instanceof AbortSignal), 'every request has a deadline');
});

test('calls before connecting are refused with a 400, not a crash', async () => {
  const client = new Beds24Client(openDb(':memory:'), fakeBeds24().fetchImpl);
  await assert.rejects(client.get('/properties'), e => e.status === 400 && /Not connected/.test(e.message));
});

test('reconnecting starts over with a full sync', async () => {
  const f = fakeBeds24();
  f.bookings.push(f.stay(1, day(3), day(5)));
  const { db, client } = await connected(f);
  await syncBeds24(db, client);
  await syncBeds24(db, client);
  assert.ok(f.calls.filter(c => c.path === '/bookings').at(-1).q.modifiedFrom, 'the second sync is incremental');
  setSetting(db, 'messages_synced', '1');
  client.disconnect();
  await client.connect('second');
  for (const k of ['last_sync', 'messages_synced', 'last_full_check']) assert.equal(getSetting(db, k), null, k);
  f.calls.length = 0;
  await syncBeds24(db, client);
  const q = f.calls.find(c => c.path === '/bookings').q;
  assert.ok(q.departureFrom && !q.modifiedFrom, 'a full fetch, so the new connection\'s bookings are all loaded');
});

test('a booking deleted in Beds24 is marked deleted by the daily check and stops counting', async () => {
  const f = fakeBeds24();
  f.bookings.push(f.stay(1, day(5), day(8), { price: 900 }), f.stay(2, day(12), day(14), { price: 400 }));
  const { db, client } = await connected(f);
  await syncBeds24(db, client);
  assert.ok(getSetting(db, 'last_full_check'), 'the first sync counts as a full check');
  f.bookings.shift();   // deleted in Beds24: never modified again, so no incremental sync hears of it
  await syncBeds24(db, client);
  assert.equal(status(db, 1), 'confirmed', 'between daily checks nothing changes');
  stale(db);
  const r = await syncBeds24(db, client);
  assert.equal(r.deleted, 1);
  assert.equal(status(db, 1), 'deleted');
  assert.equal(status(db, 2), 'confirmed');
  assert.ok(f.calls.filter(c => c.path === '/bookings').at(-1).q.departureFrom, 'the check asks by departure date');
  assert.ok(Date.parse(getSetting(db, 'last_full_check')) > Date.now() - 60000, 'and is not repeated until tomorrow');

  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO calendar_days(room_id,date,price,override) VALUES(600,?,200,'none')").run(day(i));
  const open = availability(db, 500, { days: 20 }).filter(n => n.open).map(n => n.date);
  assert.ok([day(5), day(6), day(7)].every(d => open.includes(d)), 'the freed nights are for sale again');
  assert.ok(!open.includes(day(12)), 'the remaining stay still takes its nights');
  const s = summary(db, day(0));
  assert.deepEqual(s.upcoming.map(b => b.id), [2]);
  assert.equal(s.next30.revenue, 400);
});

test('the daily check leaves everything alone when Beds24 answers with an empty list or an error', async () => {
  const f = fakeBeds24();
  f.bookings.push(f.stay(1, day(5), day(8)));
  const { db, client } = await connected(f);
  await syncBeds24(db, client);
  const check = u => u.searchParams.get('departureFrom') && !u.searchParams.get('modifiedFrom');
  stale(db);
  f.override['/bookings'] = u => (check(u) ? f.json({ success: true, data: [], pages: {} }) : null);
  await syncBeds24(db, client);
  assert.equal(status(db, 1), 'confirmed', 'an empty answer with stays on file is a hiccup, not a mass deletion');
  assert.ok(Date.parse(getSetting(db, 'last_full_check')) < Date.now() - 24 * HOUR, 'so the check is tried again next sync');
  f.override['/bookings'] = u => (check(u) ? f.json({ success: false, error: 'Something went wrong' }, 500) : null);
  const before = getSetting(db, 'last_sync');
  await assert.rejects(syncBeds24(db, client), /Something went wrong/);
  assert.equal(status(db, 1), 'confirmed');
  assert.equal(getSetting(db, 'last_sync'), before, 'a failed sync keeps its watermark');
});
