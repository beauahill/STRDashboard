import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAnthropic } from './fake-anthropic.js';

const SERVER = new URL('../server/index.js', import.meta.url).pathname;
// PORT=0 lets the OS pick a free port; the server logs the one it got.
function start(env) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: { PATH: process.env.PATH, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', port;
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const ready = new Promise((ok, no) => {
    child.stdout.on('data', () => { const m = out.match(/STR Dashboard on http:\/\/[^:]+:(\d+)/); if (m) { port = m[1]; ok(); } });
    exited.then(code => no(new Error(`exited ${code}: ${out}`)));
  });
  ready.catch(() => {}); // tests that expect a startup failure never await this
  return { child, ready, exited, output: () => out, url: p => `http://127.0.0.1:${port}${p}` };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'str-'));

test('password-protected server: health, login, lockout, logout', async t => {
  const s = start({ APP_PASSWORD: 'hunter2', DB_PATH: join(tmp(), 'db.sqlite') });
  t.after(() => s.child.kill());
  await s.ready;

  assert.equal((await fetch(s.url('/healthz'))).status, 200);
  assert.equal((await fetch(s.url('/api/status'))).status, 401);

  const login = (password, ip = '1.1.1.1') => fetch(s.url('/api/login'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ password }),
  });

  const ok = await login('hunter2');
  assert.equal(ok.status, 200);
  const sid = ok.headers.get('set-cookie').split(';')[0];
  const status = await fetch(s.url('/api/status'), { headers: { cookie: sid } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).auth, true);
  assert.equal((await fetch(s.url('/api/status'), { headers: { cookie: 'sid=123.forged' } })).status, 401);

  for (let i = 0; i < 10; i++) assert.equal((await login('nope', '2.2.2.2')).status, 401);
  assert.equal((await login('hunter2', '2.2.2.2')).status, 429, 'locked out after 10 failures');
  assert.equal((await login('hunter2', '3.3.3.3')).status, 200, 'other IPs unaffected');

  const secure = await fetch(s.url('/api/login'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: '{"password":"hunter2"}',
  });
  assert.match(secure.headers.get('set-cookie'), /; Secure/);

  const out = await fetch(s.url('/api/logout'), { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('Railway: refuses to start without APP_PASSWORD', async () => {
  const s = start({ RAILWAY_PROJECT_ID: 'x', RAILWAY_VOLUME_MOUNT_PATH: tmp() });
  assert.equal(await s.exited, 1);
  assert.match(s.output(), /APP_PASSWORD is not set/);
});

test('Railway: refuses to start without a volume', async () => {
  const s = start({ RAILWAY_PROJECT_ID: 'x', APP_PASSWORD: 'pw' });
  assert.equal(await s.exited, 1);
  assert.match(s.output(), /No volume attached/);
});

test('Railway: stores the database on the volume', async t => {
  const vol = tmp();
  const s = start({ RAILWAY_PROJECT_ID: 'x', APP_PASSWORD: 'pw', RAILWAY_VOLUME_MOUNT_PATH: vol });
  t.after(() => s.child.kill());
  await s.ready;
  assert.equal((await fetch(s.url('/healthz'))).status, 200);
  assert.ok(existsSync(join(vol, 'str.db')));
});

test('shuts down cleanly on SIGTERM', async () => {
  const s = start({ DB_PATH: join(tmp(), 'db.sqlite') });
  await s.ready;
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 0);
});

function fakeBeds24() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = u.pathname.endsWith('/authentication/setup') ? { token: 't', refreshToken: 'r', expiresIn: 86400 }
      : u.pathname.endsWith('/properties') ? { data: [{ id: 555001, name: 'Real Cabin', roomTypes: [{ id: 777001, name: 'Main', qty: 1 }] }], pages: {} }
      : u.pathname.endsWith('/bookings') ? { data: [{ id: 88800001, propertyId: 555001, roomId: 777001, status: 'confirmed', channel: 'airbnb',
          arrival: '2026-10-01', departure: '2026-10-04', firstName: 'Real', lastName: 'Guest', price: 600 }], pages: {} }
      : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body || { error: 'nope' }));
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('connecting to Beds24 clears demo data and blocks reloading it', async t => {
  const beds = await fakeBeds24();
  t.after(() => beds.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.address().port}` });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body) => fetch(s.url(path), { method, headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));

  assert.equal((await call('/api/demo', 'POST')).status, 200);
  assert.equal((await call('/api/properties')).json.length, 3);

  const c = await call('/api/connect', 'POST', { inviteCode: 'abc' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const props = (await call('/api/properties')).json;
  assert.deepEqual(props.map(p => p.name), ['Real Cabin']);
  const bookings = (await call('/api/bookings')).json;
  assert.deepEqual(bookings.map(b => b.guest_name), ['Real Guest']);
  const st = (await call('/api/status')).json;
  assert.equal(st.connected, true); assert.equal(st.demo, false);

  assert.equal((await call('/api/demo', 'POST')).status, 400);
});

test('on startup, demo data left next to a Beds24 connection is removed', async t => {
  const { openDb, setSetting } = await import('../server/db.js');
  const { loadDemo } = await import('../server/demo.js');
  const path = join(tmp(), 'db.sqlite');
  const db = openDb(path);
  loadDemo(db);
  setSetting(db, 'beds24_refresh_token', 'r');
  db.close();

  const s = start({ APP_PASSWORD: 'pw', DB_PATH: path });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(s.url('/api/properties'), { headers: { cookie: sid } })).json(), []);
});

test('Guesty import endpoints: preview, import, bad file, remove', async t => {
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite') });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (path, body) => fetch(s.url(path), { method: 'POST', headers: { cookie: sid }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  const csv = 'CHECK-IN,CHECK-OUT,CONFIRMATION CODE,LISTING,GUEST,STATUS,SOURCE,ACCOMMODATION FARE\n' +
    '2025-06-01,2025-06-04,GY-1,Laramie House,Pat,Confirmed,Airbnb,450\n2025-07-01,2025-07-02,GY-2,Laramie House,Ina,Inquiry,Airbnb,\n';

  const prev = await call('/api/import/guesty/preview', { csv });
  assert.equal(prev.status, 200);
  assert.equal(prev.json.summary.imported, 1);
  assert.deepEqual(prev.json.rooms, []);
  assert.ok(!JSON.stringify(prev.json).includes('Pat'), 'preview carries no guest details');

  const bad = await call('/api/import/guesty/preview', { csv: 'a,b\n1,2' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Guesty/);

  const imp = await call('/api/import/guesty', { csv, mapping: { 'Laramie House': 'new' } });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const status = await (await fetch(s.url('/api/status'), { headers: { cookie: sid } })).json();
  assert.equal(status.guestyImported, 1);
  assert.equal(status.empty, false);

  assert.deepEqual((await call('/api/import/guesty/remove', {})).json, { removed: 1 });
  const big = await call('/api/import/guesty/preview', { csv: 'x'.repeat(31e6) });
  assert.equal(big.status, 413);
});

/** Fake Beds24 with a calendar that remembers writes, and configurable token scopes. */
function fakeBeds24WithCalendar(scopes) {
  const cal = new Map(), posts = [];
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    const send = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith('/authentication/setup')) return send(200, { token: 't', refreshToken: 'r', expiresIn: 86400 });
    if (u.pathname.endsWith('/authentication/details')) return send(200, { validToken: true, token: { scopes } });
    if (u.pathname.endsWith('/properties')) return send(200, { data: [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }], pages: {} });
    if (u.pathname.endsWith('/bookings')) return send(200, { data: [], pages: {} });
    if (u.pathname.endsWith('/inventory/rooms/calendar') && req.method === 'GET') {
      const calendar = [];
      for (let t = Date.parse(u.searchParams.get('startDate')); t <= Date.parse(u.searchParams.get('endDate')); t += 86400000) {
        calendar.push({ from: iso(t), to: iso(t), price1: 180, minStay: 2, numAvail: 1, override: 'none', ...cal.get(iso(t)) });
      }
      return send(200, { data: [{ roomId: 600, propertyId: 500, calendar }], pages: {} });
    }
    if (u.pathname.endsWith('/inventory/rooms/calendar') && req.method === 'POST') {
      if (!scopes.some(s => /^(write|all):inventory$/.test(s))) return send(403, { success: false, error: 'missing write:inventory scope' });
      const body = JSON.parse(raw); posts.push(body);
      for (const r of body[0].calendar) for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 86400000) {
        const { from, to, ...v } = r; cal.set(iso(t), { ...cal.get(iso(t)), ...v });
      }
      return send(201, [{ success: true, modified: {} }]);
    }
    send(404, { error: 'nope' });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, posts })));
}

async function connectedApp(t, scopes) {
  const beds = await fakeBeds24WithCalendar(scopes);
  t.after(() => beds.srv.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.srv.address().port}` });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (path, body) => fetch(s.url(path), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/connect', { inviteCode: 'abc' })).status, 200);
  return { call, posts: beds.posts };
}

test('Rates: prices load from Beds24, preview, save, and show in the change log', async t => {
  const { call, posts } = await connectedApp(t, ['all:bookings', 'all:inventory', 'read:properties']);
  const today = new Date().toISOString().slice(0, 10);
  const d = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);

  const rates = (await call(`/api/rates?start=${today}&days=10`)).json;
  assert.equal(rates.canWrite, true);
  assert.equal(rates.room.id, 600);
  assert.equal(rates.days[0].price, 180);
  assert.equal((await call('/api/status')).json.scopes.length, 3);

  const body = { roomId: 600, from: d(2), to: d(4), price: 225, minStay: 3 };
  const prev = await call('/api/rates/preview', body);
  assert.equal(prev.status, 200);
  assert.equal(prev.json.changes.length, 3);
  assert.equal(posts.length, 0, 'preview never writes');

  const saved = await call('/api/rates/apply', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.applied, 3);
  assert.deepEqual(saved.json.warnings, []);
  assert.deepEqual(posts[0], [{ roomId: 600, calendar: [{ from: d(2), to: d(4), price1: 225, minStay: 3 }] }]);

  const after = (await call(`/api/rates?start=${d(2)}&days=3`)).json;
  assert.deepEqual(after.days.map(x => [x.price, x.minStay]), [[225, 3], [225, 3], [225, 3]]);
  assert.equal(after.changes[0].summary, 'Price $225 · Min stay 3 nights');

  assert.equal((await call('/api/rates/preview', { ...body, from: d(-3) })).status, 400);
});

test('Rates: a read-only invite code can view but not save', async t => {
  const { call, posts } = await connectedApp(t, ['read:bookings', 'read:inventory']);
  const today = new Date().toISOString().slice(0, 10);
  const rates = (await call(`/api/rates?start=${today}&days=5`)).json;
  assert.equal(rates.canWrite, false);
  assert.equal(rates.days[0].price, 180, 'prices still visible');
  const res = await call('/api/rates/apply', { roomId: 600, from: today, to: today, price: 250 });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /write access to Inventory/);
  assert.equal(posts.length, 0);
});

/** Fake Seam HTTP API: two Yale locks with a cleaner code set in the Yale app. */
function fakeSeamServer() {
  const managed = new Map(), calls = [];
  const unmanaged = [
    { access_code_id: 'u-front', device_id: 'front', name: 'Cleaner', code: '0198', is_managed: false, status: 'set' },
    { access_code_id: 'u-back', device_id: 'back', name: 'Cleaner', code: '0198', is_managed: false, status: 'set' },
  ];
  let n = 0;
  const srv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, auth: req.headers.authorization, body });
    const send = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== 'Bearer seam_testkey_1234567') return send(401, { error: { type: 'unauthorized', message: 'bad key' } });
    switch (req.url) {
      case '/devices/list': return send(200, { devices: [
        { device_id: 'front', display_name: 'Front Door', device_type: 'yale_lock', can_program_online_access_codes: true, properties: { online: true, battery_level: 0.9 } },
        { device_id: 'back', display_name: 'Back Door', device_type: 'yale_lock', can_program_online_access_codes: true, properties: { online: false, battery_level: 0.2 } }] });
      case '/access_codes/list': return send(200, { access_codes: [...managed.values()].filter(c => c.device_id === body.device_id) });
      case '/access_codes/unmanaged/list': return send(200, { access_codes: unmanaged.filter(c => c.device_id === body.device_id) });
      case '/access_codes/create': { const c = { access_code_id: `ac${++n}`, status: 'unset', errors: [], warnings: [], is_managed: true, ...body }; managed.set(c.access_code_id, c); return send(200, { access_code: c }); }
      case '/access_codes/update': Object.assign(managed.get(body.access_code_id), body); return send(200, {});
      case '/access_codes/delete': managed.delete(body.access_code_id); return send(200, {});
      case '/access_codes/unmanaged/convert_to_managed': {
        const i = unmanaged.findIndex(c => c.access_code_id === body.access_code_id);
        managed.set(body.access_code_id, { ...unmanaged.splice(i, 1)[0], is_managed: true, errors: [] }); return send(200, {});
      }
      case '/connect_webviews/create': return send(200, { connect_webview: { connect_webview_id: 'cw1', url: 'https://connect.getseam.com/cw/abc', status: 'pending' } });
    }
    send(404, { error: { message: 'unknown route' } });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, managed })));
}

test('Locks: connect Seam, assign locks, automatic guest codes, change a Yale-app code', async t => {
  const seam = await fakeSeamServer();
  t.after(() => seam.srv.close());
  const { openDb } = await import('../server/db.js');
  const { upsertProperties, upsertBookings } = await import('../server/sync.js');
  const path = join(tmp(), 'db.sqlite');
  const db = openDb(path);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
  const d = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  upsertBookings(db, [{ id: 42, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival: d(1), departure: d(4), firstName: 'Pat', phone: '+1 307 555 4242', price: 500 }]);
  db.close();

  const s = start({ APP_PASSWORD: 'pw', DB_PATH: path, SEAM_BASE: `http://127.0.0.1:${seam.srv.address().port}` });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));

  assert.equal((await call('/api/locks')).json.configured, false);
  assert.equal((await call('/api/locks/key', { apiKey: 'not-a-key' })).status, 400);
  assert.deepEqual((await call('/api/locks/key', { apiKey: 'seam_testkey_1234567' })).json, { locks: 2 });
  assert.ok(seam.calls.every(c => c.auth === 'Bearer seam_testkey_1234567'));

  let L = (await call('/api/locks')).json;
  assert.equal(L.keyHint, '…4567');
  assert.ok(!JSON.stringify(L).includes('seam_testkey'), 'the API key is never sent back to the browser');
  assert.deepEqual(L.locks.map(l => [l.name, l.online]), [['Back Door', 0], ['Front Door', 1]]);
  assert.equal(L.otherCodes[0].name, 'Cleaner');

  for (const id of ['front', 'back']) assert.equal((await call('/api/locks/assign', { deviceId: id, roomId: 600 })).status, 200);
  assert.equal(seam.managed.size, 0, 'nothing is created while automatic codes are off');
  const on = await call('/api/locks/settings', { auto: true });
  assert.equal(on.json.doors.created, 2);
  assert.ok([...seam.managed.values()].every(c => c.code === '4242'));

  const sum = (await call('/api/summary')).json;
  assert.equal(sum.doors[42].code, '4242');
  assert.deepEqual(sum.doorAlerts, []);

  L = (await call('/api/locks')).json;
  assert.equal(L.guestCodes[0].door.code, '4242');
  assert.equal(L.guestCodes[0].phone, undefined, 'phone numbers are not sent to the Locks page');
  const cleaner = L.otherCodes.find(c => c.name === 'Cleaner');
  assert.equal((await call('/api/locks/code/change', { entries: cleaner.locks, code: '5150' })).status, 200);
  assert.ok(['u-front', 'u-back'].every(id => seam.managed.get(id).code === '5150'));
  assert.equal((await call('/api/locks/code/change', { entries: [{ deviceId: 'elsewhere', accessCodeId: 'x' }], code: '1111' })).status, 400);

  const clash = await call('/api/locks/booking-code', { bookingId: 42, code: '5150' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already used by "Cleaner"/);
  assert.equal((await call('/api/locks/booking-code', { bookingId: 42, code: '777888' })).status, 200);
  assert.ok([...seam.managed.values()].filter(c => c.name?.startsWith('Pat')).every(c => c.code === '777888'));

  assert.equal((await call('/api/locks/connect', {})).json.url, 'https://connect.getseam.com/cw/abc');
  assert.equal((await call('/api/locks/settings', { checkin: 'noon' })).status, 400);
});

/** Fake Beds24 with a message log (GET/POST/PATCH /bookings/messages). */
function fakeBeds24Messages() {
  const msgs = [{ id: 1, bookingId: 10, source: 'guest', message: 'Is there parking?', time: new Date(Date.now() - 3600e3).toISOString(), read: false }];
  const calls = [];
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    const send = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith('/bookings/messages')) calls.push({ method: req.method, query: Object.fromEntries(u.searchParams), body: raw && JSON.parse(raw) });
    if (u.pathname.endsWith('/authentication/setup')) return send(200, { token: 't', refreshToken: 'r', expiresIn: 86400 });
    if (u.pathname.endsWith('/authentication/details')) return send(200, { token: { scopes: ['all:bookings'] } });
    if (u.pathname.endsWith('/properties')) return send(200, { data: [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }], pages: {} });
    if (u.pathname.endsWith('/bookings/messages')) {
      if (req.method === 'GET') {
        const ids = u.searchParams.getAll('bookingId').map(Number);
        return send(200, { data: msgs.filter(m => !ids.length || ids.includes(m.bookingId)), pages: {} });
      }
      if (req.method === 'POST') {
        for (const m of JSON.parse(raw)) msgs.push({ id: msgs.length + 1, bookingId: m.bookingId, source: 'host', message: m.message, time: new Date().toISOString(), read: true });
        return send(201, [{ success: true }]);
      }
      if (req.method === 'PATCH') { for (const m of msgs) if (u.searchParams.getAll('bookingId').map(Number).includes(m.bookingId)) m.read = true; return send(200, {}); }
    }
    if (u.pathname.endsWith('/bookings')) return send(200, { data: [{ id: 10, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb',
      arrival: new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10), departure: new Date(Date.now() + 6 * 86400e3).toISOString().slice(0, 10), firstName: 'Jordan' }], pages: {} });
    if (u.pathname.endsWith('/inventory/rooms/calendar')) return send(200, { data: [], pages: {} });
    send(404, { error: 'nope' });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, msgs })));
}

test('Inbox: messages sync, unread badge, open marks read, reply sends, polling is rate-limited', async t => {
  const beds = await fakeBeds24Messages();
  t.after(() => beds.srv.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.srv.address().port}` });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/connect', { inviteCode: 'abc' })).status, 200);

  assert.equal((await call('/api/status')).json.unreadMessages, 1);
  const inbox = (await call('/api/inbox')).json;
  assert.equal(inbox.conversations[0].guest_name, 'Jordan');
  assert.equal(inbox.conversations[0].unread, 1);

  const th = (await call('/api/inbox/thread?booking=10')).json;
  assert.equal(th.messages[0].body, 'Is there parking?');
  assert.equal(th.canReply, true);

  assert.deepEqual((await call('/api/inbox/read', { bookingId: 10 })).json, { changed: 1 });
  assert.deepEqual(beds.calls.find(c => c.method === 'PATCH'), { method: 'PATCH', query: { bookingId: '10' }, body: { read: true } });
  assert.equal((await call('/api/status')).json.unreadMessages, 0);

  const sent = await call('/api/inbox/send', { bookingId: 10, message: 'Yes, two spots.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.deepEqual(beds.calls.find(c => c.method === 'POST').body, [{ bookingId: 10, message: 'Yes, two spots.' }]);
  assert.equal(sent.json.messages.at(-1).body, 'Yes, two spots.');
  assert.equal((await call('/api/inbox/send', { bookingId: 10, message: '' })).status, 400);

  beds.msgs.push({ id: 99, bookingId: 10, source: 'guest', message: 'Thanks!', time: new Date().toISOString(), read: false });
  const gets = () => beds.calls.filter(c => c.method === 'GET' && c.query.maxAge).length;
  const before = gets();
  assert.equal((await call('/api/inbox/refresh', {})).json.unread, 1);
  await call('/api/inbox/refresh', {});
  assert.equal(gets() - before, 1, 'a second refresh within 30 seconds does not call Beds24 again');

  const replies = (await call('/api/replies')).json;
  assert.equal(replies.length, 4);
  assert.equal((await call('/api/replies', { title: 'Wi-Fi', body: 'Network: LaramieGuest' })).status, 200);
  assert.equal((await call('/api/replies')).json.length, 5);
});

test('Turno feed URL works without login, only with the right secret, and stops after regenerating', async t => {
  const { openDb } = await import('../server/db.js');
  const { upsertProperties, upsertBookings } = await import('../server/sync.js');
  const path = join(tmp(), 'db.sqlite');
  const db = openDb(path);
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  const day = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  upsertBookings(db, [{ id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: day(2), departure: day(5), numAdult: 2 }]);
  db.close();
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: path });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const cl = await (await fetch(s.url('/api/cleaning'), { headers: { cookie: sid } })).json();
  const feedPath = new URL(cl.feeds[0].url).pathname;
  const ok = await fetch(s.url(feedPath));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/calendar/);
  assert.match(await ok.text(), /SUMMARY:Reserved \(2 guests\)/);
  assert.equal((await fetch(s.url(feedPath.replace(/\/cal\/[^/]+/, '/cal/wrongwrongwrongwrongwrong')))).status, 404);
  assert.equal((await fetch(s.url('/api/cleaning'))).status, 401, 'the cleaning page itself still needs login');
  await fetch(s.url('/api/cleaning/regenerate'), { method: 'POST', headers: { cookie: sid } });
  assert.equal((await fetch(s.url(feedPath))).status, 404, 'old link stops working');
});

test('Automations: a due message for a newly synced booking is sent through Beds24 once', async t => {
  const beds = await fakeBeds24Messages();
  t.after(() => beds.srv.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.srv.address().port}` });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));

  const list = (await call('/api/automations')).json;
  assert.equal(list.automations.length, 8);
  assert.equal((await call('/api/automations', { name: 'x', body: '', anchor: 'booked' })).status, 400);
  // Due 4 days before arrival, i.e. already in the past for this booking: it's sent only because the booking
  // first appears after the automation was switched on (a last-minute booking).
  const { json: { id } } = await call('/api/automations', { name: 'Hello', anchor: 'arrival', offset_days: -4, at_time: '00:00', body: 'Hi {guest_first_name}, see you soon at {property_name}!' });
  await call('/api/automations/enable', { id, enabled: true });
  assert.equal((await call('/api/connect', { inviteCode: 'abc' })).status, 200);   // first sync runs automations

  const posts = beds.calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(p => p.body), [[{ bookingId: 10, message: 'Hi Jordan, see you soon at Laramie Retreat!' }]]);
  await call('/api/automations/run', {});
  assert.equal(beds.calls.filter(c => c.method === 'POST').length, 1, 'not sent twice');
  const after = (await call('/api/automations')).json;
  assert.equal(after.history[0].status, 'sent');

  const pv = await call('/api/automations/preview', { body: 'Code {door_code}, Wi-Fi {wifi_password}', bookingId: 10 });
  assert.deepEqual(pv.json.missing, ['door_code', 'wifi_password']);
  assert.equal((await call('/api/property-vars', { propertyId: 500, vars: { wifi_password: 'pokes' } })).status, 200);
  assert.deepEqual((await call('/api/automations/preview', { body: 'Wi-Fi {wifi_password}', bookingId: 10 })).json, { text: 'Wi-Fi pokes', missing: [] });
});

function fakeBeds24Listing(scopes) {
  const prop = { id: 500, name: 'Laramie Retreat', propertyType: 'house', texts: [{ language: 'en', headline: 'Cozy house', propertyDescription: 'Three bedrooms.' }],
    roomTypes: [{ id: 600, name: 'Whole house', qty: 1, maxPeople: 6, texts: [{ language: 'en', roomDescription: 'Sleeps 6' }] }] };
  const posts = [];
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    const send = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith('/authentication/setup')) return send(200, { token: 't', refreshToken: 'r', expiresIn: 86400 });
    if (u.pathname.endsWith('/authentication/details')) return send(200, { token: { scopes } });
    if (u.pathname.endsWith('/properties') && req.method === 'GET') return send(200, { data: [prop], pages: {} });
    if (u.pathname.endsWith('/properties') && req.method === 'POST') {
      if (!scopes.some(s => /^(write|all):properties$/.test(s))) return send(403, { success: false, error: 'missing write:properties scope' });
      const [b] = JSON.parse(raw); posts.push(b);
      for (const t of b.texts || []) Object.assign(prop.texts[0], t);
      if (b.name) prop.name = b.name;
      return send(201, [{ success: true }]);
    }
    if (u.pathname.endsWith('/bookings') || u.pathname.endsWith('/calendar') || u.pathname.endsWith('/messages')) return send(200, { data: [], pages: {} });
    send(404, { error: 'nope' });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, posts })));
}

for (const [label, scopes, canSave] of [['write access', ['all:properties', 'all:bookings'], true], ['read-only', ['read:properties', 'read:bookings'], false]]) {
  test(`Listing editor over HTTP (${label})`, async t => {
    const beds = await fakeBeds24Listing(scopes);
    t.after(() => beds.srv.close());
    const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.srv.address().port}` });
    t.after(() => s.child.kill());
    await s.ready;
    const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
    const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, json: await r.json() }));
    await call('/api/connect', { inviteCode: 'abc' });
    const L = (await call('/api/listing')).json;
    assert.equal(L.canWrite, canSave);
    assert.equal(L.listing.propertyText.headline, 'Cozy house');
    const edited = { ...L.listing, propertyText: { ...L.listing.propertyText, headline: 'Walk to War Memorial Stadium' } };
    const pv = await call('/api/listing/preview', { propertyId: 500, edited });
    assert.deepEqual(pv.json.changes.map(c => [c.label, c.after]), [['Headline', 'Walk to War Memorial Stadium']]);
    const saved = await call('/api/listing/save', { propertyId: 500, edited });
    if (canSave) {
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      assert.deepEqual(beds.posts, [{ id: 500, texts: [{ language: 'en', headline: 'Walk to War Memorial Stadium' }] }]);
      assert.equal((await call('/api/listing')).json.log[0].ok, 1);
    } else {
      assert.equal(saved.status, 403);
      assert.match(saved.json.error, /write access to Properties/);
      assert.equal(beds.posts.length, 0);
    }
  });
}

test('Analytics and AI assistant over HTTP: key stays on the server, answers come back', async t => {
  const ai = await fakeAnthropic();
  t.after(() => ai.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), ANTHROPIC_BASE_URL: ai.url });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body) => fetch(s.url(path), { method, headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/demo', 'POST')).status, 200);

  const a = await call('/api/analytics?range=ytd');
  assert.equal(a.status, 200);
  assert.equal(a.json.range, 'ytd');
  assert.ok(a.json.monthly.length > 6 && a.json.channels.length > 0);

  assert.equal((await call('/api/status')).json.ai, false);
  const notSet = await call('/api/ai/ask', 'POST', { question: 'How was September?' });
  assert.equal(notSet.status, 400);
  assert.match(notSet.json.error, /Add your Anthropic API key/);

  const bad = await call('/api/ai/key', 'POST', { apiKey: 'sk-ant-bad-0000000000000000000000' });
  assert.equal(bad.status, 400, 'a rejected key is a 400, not a 401 that would look like a logged-out session');
  const key = 'sk-ant-api03-http-test-key-0000000000';
  const saved = await call('/api/ai/key', 'POST', { apiKey: key });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.keyHint, '…0000');
  for (const path of ['/api/ai', '/api/status', '/api/settings']) {
    const r = await fetch(s.url(path), { headers: { cookie: sid } }).then(r => r.text());
    assert.ok(!r.includes(key), `${path} never contains the key`);
  }
  assert.equal((await call('/api/status')).json.ai, true);

  const ask = await call('/api/ai/ask', 'POST', { question: 'How was January?', history: [] });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  assert.match(ask.json.text, /From the data/);
  const booking = (await call('/api/bookings?status=confirmed')).json[0];
  const draft = await call('/api/ai/draft', 'POST', { bookingId: booking.id, instructions: 'keep it short' });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.ok(ai.requests.every(r => r.headers['x-api-key'] === key || r.headers['x-api-key']?.includes('bad')));
  const usage = (await call('/api/ai')).json;
  assert.equal(usage.month.requests, 2);
});

test('Phone notifications: test message, then a new guest message is pushed to ntfy once', async t => {
  const beds = await fakeBeds24Messages();
  t.after(() => beds.srv.close());
  const pushes = [];
  const ntfy = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { pushes.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise(ok => ntfy.listen(0, '127.0.0.1', ok));
  t.after(() => ntfy.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), BEDS24_BASE: `http://127.0.0.1:${beds.srv.address().port}`, RAILWAY_PUBLIC_DOMAIN: 'str.example.app' });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/connect', { inviteCode: 'abc' })).status, 200);

  const n = (await call('/api/notify')).json;
  assert.equal(n.settings.enabled, false);
  assert.match(n.settings.topic, /^str-/);
  const saved = await call('/api/notify', { server: `http://127.0.0.1:${ntfy.address().port}`, token: 'tk_private' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.tokenSet, true);
  assert.ok(!JSON.stringify((await call('/api/notify')).json).includes('tk_private'), 'the token is never sent to the browser');

  assert.equal((await call('/api/notify/test', {})).status, 200);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].path, '/');
  assert.equal(pushes[0].auth, 'Bearer tk_private');
  assert.equal(pushes[0].body.topic, n.settings.topic);

  assert.equal((await call('/api/notify', { enabled: true })).status, 200);
  await call('/api/inbox/refresh', {});
  await new Promise(r => setTimeout(r, 300));
  assert.equal(pushes.length, 1, 'messages from before notifications were switched on are not sent');

  beds.msgs.push({ id: 100, bookingId: 10, source: 'guest', message: 'Can we check in early?', time: new Date(Date.now() + 1000).toISOString(), read: false });
  assert.equal((await call('/api/sync', {})).status, 200);   // the sync sends notifications before it returns
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].body.title, 'Message from Jordan (Airbnb)');
  assert.match(pushes[1].body.message, /^Can we check in early\?/);
  assert.equal(pushes[1].body.click, 'https://str.example.app/#/inbox/10');
  assert.equal((await call('/api/notify')).json.recent[0].ok, 1);
  assert.equal((await call('/api/sync', {})).status, 200);
  assert.equal(pushes.length, 2, 'not sent twice');
});

test('Smart home over HTTP: connect Home Assistant, status without the token, automations, refresh', async t => {
  const devices = [
    { entity_id: 'climate.living_room', state: 'heat', attributes: { friendly_name: 'Living room', current_temperature: 64, temperature: 62, hvac_modes: ['off', 'heat'] } },
    { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } },
    { entity_id: 'binary_sensor.kitchen_leak', state: 'off', attributes: { friendly_name: 'Kitchen leak', device_class: 'moisture' } },
  ];
  const calls = [];
  const ha = createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ha-token') { res.writeHead(401); return res.end('{"message":"Unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/config') return res.end(JSON.stringify({ unit_system: { temperature: '°F' }, location_name: 'Rental' }));
      if (req.url === '/api/states') return res.end(JSON.stringify(devices));
      calls.push([req.url, JSON.parse(b)]); res.end('[]');
    });
  });
  await new Promise(ok => ha.listen(0, '127.0.0.1', ok));
  t.after(() => ha.close());
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite') });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/demo', {})).status, 200);
  assert.equal((await call('/api/home')).json.configured, false);
  const url = `http://127.0.0.1:${ha.address().port}`;
  assert.equal((await call('/api/home/connect', { url, token: 'nope' })).status, 400);
  const c = await call('/api/home/connect', { url, token: 'ha-token' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.devices, 3);
  assert.equal((await call('/api/status')).json.home, true);
  const raw = await fetch(s.url('/api/home'), { headers: { cookie: sid } }).then(r => r.text());
  assert.ok(!raw.includes('ha-token'), 'the token is never sent to the browser');
  const home = JSON.parse(raw);
  assert.equal(home.devices.find(d => d.id === 'climate.living_room').current, 64);
  assert.deepEqual([home.tailscale.enabled, home.tailscale.used], [false, false], 'no TS_AUTHKEY: Tailscale stays off');
  const pid = home.properties[0].id;
  const saved = await call('/api/home/settings', { climate: { propertyId: pid, enabled: true, thermostats: ['climate.living_room'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.ok(calls.some(([u]) => u === '/api/services/climate/set_temperature'), 'the thermostat is set as soon as the schedule is switched on');
  assert.equal((await call('/api/home/refresh', {})).status, 200);
  const dev = (await call('/api/home/devices')).json;
  assert.equal(dev.devices.length, 3);
  assert.equal((await call('/api/home/devices', { entities: { 'lock.front_door': { role: 'lock', propertyId: pid } } })).status, 200);
  assert.deepEqual((await call('/api/home')).json.devices.map(d => d.id), ['lock.front_door']);
  assert.ok((await call('/api/summary')).json.home.locks.length === 1);
  assert.equal((await call('/api/home/disconnect', {})).status, 200);
  assert.equal((await call('/api/home')).json.configured, false);
});

test('Direct booking site: hidden until switched on, preview for the owner, live page, photos and custom domain', async t => {
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite') });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/demo', {})).status, 200);
  const site = (await call('/api/site')).json;
  const pid = site.site.propertyId, path = `/stay/${site.site.slug}`;
  assert.equal((await fetch(s.url(path))).status, 404, 'off: not public');
  const preview = await fetch(s.url(path), { headers: { cookie: sid } });
  assert.equal(preview.status, 200, 'the signed-in owner sees a preview');
  assert.match(await preview.text(), /only you can see it/);
  const up = await call('/api/site/photos', { propertyId: pid, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
  assert.equal(up.status, 200);
  assert.equal((await call('/api/site', { propertyId: pid, enabled: true, domain: 'book.example.com', perk: 'Best price here' })).status, 200);
  const live = await fetch(s.url(path));
  assert.equal(live.status, 200);
  const html = await live.text();
  assert.match(html, /Best price here/);
  assert.ok(!/only you can see it/.test(html));
  const av = await (await fetch(s.url(`${path}/availability.json`))).json();
  assert.ok(Array.isArray(av.nights) && av.nights.length === 365);
  assert.ok(!JSON.stringify(av).match(/guest|name/i), 'no guest details in the public data');
  const img = await fetch(s.url(`${path}/photo/${up.json.id}`));
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(s.url(`${path}/photo/999`))).status, 404);
  assert.match(await (await fetch(s.url(`${path}/terms`))).text(), /Rental agreement/);
  const byDomain = await fetch(s.url('/'), { headers: { 'x-forwarded-host': 'book.example.com' } });
  assert.match(await byDomain.text(), /Best price here/, 'the custom domain opens the site');
  assert.match(await (await fetch(s.url('/'))).text(), /STR Dashboard/, 'the app itself is unchanged on its own address');
});

test('Guidebook over HTTP: private link, online check-in for direct guests, ID only for the signed-in owner', async t => {
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite'), RAILWAY_PUBLIC_DOMAIN: 'str.example.app' });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/demo', {})).status, 200);
  const g = (await call('/api/guide')).json;
  const pid = g.guide.propertyId;
  assert.equal((await call('/api/guide', { propertyId: pid, requireDirect: true, welcome: 'Howdy from Laramie' })).status, 200);
  const stays = (await call(`/api/guide?property=${pid}`)).json.stays;
  const direct = stays.find(x => x.channel === 'Direct');
  assert.ok(direct, 'the demo data has an upcoming direct booking');
  assert.match(direct.url, /^https:\/\/str\.example\.app\/guide\/\d+-[\w-]{22}$/);
  const path = new URL(direct.url).pathname;
  const page = await fetch(s.url(path));
  assert.equal(page.status, 200, 'no login needed for the guest');
  assert.match(await page.text(), /Howdy from Laramie/);
  assert.equal((await fetch(s.url(path.replace(/-[\w-]{22}$/, '-' + 'x'.repeat(22))))).status, 404, 'a guessed link fails');
  {
    const bad = await fetch(s.url(path + '/checkin'), { method: 'POST', body: JSON.stringify({ name: 'Dee', agree: false }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(s.url(path + '/checkin'), { method: 'POST', body: JSON.stringify({ name: 'Dee Direct', agree: true,
      idDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }) });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(s.url(`/api/guide/id?booking=${direct.id}`))).status, 401, 'IDs are never public');
    const id = await fetch(s.url(`/api/guide/id?booking=${direct.id}`), { headers: { cookie: sid } });
    assert.equal(id.headers.get('content-type'), 'image/png');
  }
  const vars = await call(`/api/inbox/thread?booking=${direct.id}`);
  assert.equal(vars.status, 200);
  assert.equal(vars.json.vars.guidebook_link, direct.url, '{guidebook_link} fill-in');
});

test('Money over HTTP: profit and loss, expenses with receipts (owner only), payouts, tax', async t => {
  const s = start({ APP_PASSWORD: 'pw', DB_PATH: join(tmp(), 'db.sqlite') });
  t.after(() => s.child.kill());
  await s.ready;
  const sid = (await fetch(s.url('/api/login'), { method: 'POST', body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0];
  const call = (p, body) => fetch(s.url(p), { method: body ? 'POST' : 'GET', headers: { cookie: sid }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/demo', {})).status, 200);
  const before = (await call('/api/money')).json;
  assert.ok(before.pnl.total.gross > 0);
  const year = before.year;
  const add = await call('/api/money/expense', { date: `${year}-01-15`, category: 'Utilities', amount: 120.5, vendor: 'Rocky Mountain Power',
    receipt: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const after = (await call(`/api/money?year=${year}`)).json;
  assert.equal(after.pnl.months[0].expenses - before.pnl.months[0].expenses, 120.5);
  assert.equal((await fetch(s.url(`/api/money/receipt?id=${add.json.id}`))).status, 401, 'receipts are never public');
  assert.equal((await fetch(s.url(`/api/money/receipt?id=${add.json.id}`), { headers: { cookie: sid } })).headers.get('content-type'), 'image/png');
  const p = after.payouts[0];
  assert.ok(p, 'demo checkouts in the last 90 days');
  assert.equal((await call('/api/money/payout', { bookingId: p.id, amount: p.expected })).status, 200);
  assert.equal((await call('/api/money')).json.payouts.find(x => x.id === p.id).status, 'ok');
  assert.equal((await call('/api/money/settings', { taxes: [{ name: 'Lodging', pct: 5 }] })).status, 200);
  assert.ok((await call('/api/money')).json.tax.total.due > 0, 'direct and Booking.com stays are taxable by you');
});
