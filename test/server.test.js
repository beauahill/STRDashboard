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
