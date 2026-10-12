import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
