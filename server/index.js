import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from './db.js';
import { Beds24Client } from './beds24.js';
import { syncBeds24, iso } from './sync.js';
import { summary, calendar } from './stats.js';
import { loadDemo, clearDemo } from './demo.js';
import { readGuestyExport, importGuesty, dedupeImported, removeGuestyImport } from './guesty.js';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

// On Railway, refuse to start in a state that would be unreachable or lose data on redeploy.
const ON_RAILWAY = !!process.env.RAILWAY_PROJECT_ID;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (ON_RAILWAY && !PASSWORD) fail('APP_PASSWORD is not set. Add it under the service\'s Variables tab.');
if (ON_RAILWAY && !VOLUME && !process.env.DB_PATH) fail('No volume attached. Add a volume to this service mounted at /data.');
function fail(msg) { console.error(`\nSTARTUP ERROR: ${msg}\n`); process.exit(1); }

const db = openDb(process.env.DB_PATH || (VOLUME ? join(VOLUME, 'str.db') : 'data/str.db'));
const beds24 = new Beds24Client(db);

if (!getSetting(db, 'session_secret')) setSetting(db, 'session_secret', randomBytes(32).toString('hex'));
const secret = getSetting(db, 'session_secret');
// Sessions are bound to the current password, so changing APP_PASSWORD signs everyone out.
const sign = v => createHmac('sha256', secret).update(`${v}:${PASSWORD}`).digest('hex');
const makeSession = () => { const exp = Date.now() + 30 * 86400000; return `${exp}.${sign(String(exp))}`; };
const safeEqual = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && timingSafeEqual(a, b); };
function validSession(tok = '') {
  const [exp, mac] = tok.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
const clientIp = req => req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// Brute-force guard: 10 failed logins per IP per 15 minutes.
const failures = new Map();
function loginBlocked(ip) {
  const f = failures.get(ip);
  if (f && f.until < Date.now()) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: Date.now() + 15 * 60000 };
  f.count++; failures.set(ip, f);
}

let syncing = false;
async function runSync() {
  if (syncing || !beds24.connected) return null;
  syncing = true;
  try { const r = await syncBeds24(db, beds24); dedupeImported(db); return r; }
  catch (e) { setSetting(db, 'last_sync_error', e.message); throw e; }
  finally { syncing = false; }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
// Oversized bodies are drained and discarded (not kept in memory) so the client still gets a clean 413.
const readJson = (req, limit = 1e6) => new Promise((ok, no) => {
  let s = '', tooBig = false;
  req.on('data', c => { if (tooBig) return; s += c; if (s.length > limit) { tooBig = true; s = ''; } });
  req.on('end', () => {
    if (tooBig) return no(Object.assign(new Error('Upload too large'), { status: 413 }));
    try { ok(s ? JSON.parse(s) : {}); } catch { no(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
  });
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const prop = q.property ? Number(q.property) : null;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { password } = await readJson(req);
    if (!PASSWORD || typeof password !== 'string' || !safeEqual(sign(password), sign(PASSWORD))) {
      recordFailure(ip);
      return send(res, 401, { error: 'Wrong password' });
    }
    failures.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `sid=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/logout') {
    res.setHeader('set-cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (PASSWORD && !validSession(cookie(req).sid)) return send(res, 401, { error: 'Login required' });

  switch (route) {
    case 'GET /api/status':
      return send(res, 200, {
        connected: beds24.connected, auth: !!PASSWORD, demo: getSetting(db, 'demo') === '1', syncing,
        lastSync: getSetting(db, 'last_sync'), lastSyncError: getSetting(db, 'last_sync_error'),
        empty: db.prepare('SELECT COUNT(*) n FROM bookings').get().n === 0,
        guestyImported: db.prepare("SELECT COUNT(*) n FROM bookings WHERE source = 'guesty'").get().n,
      });
    case 'POST /api/connect': {
      const { inviteCode } = await readJson(req);
      if (!inviteCode) return send(res, 400, { error: 'Invite code required' });
      await beds24.connect(inviteCode);
      clearDemo(db);
      return send(res, 200, await runSync());
    }
    case 'POST /api/disconnect': beds24.disconnect(); return send(res, 200, { ok: true });
    case 'POST /api/sync':
      if (!beds24.connected) return send(res, 400, { error: 'Not connected to Beds24' });
      return send(res, 200, await runSync());
    case 'POST /api/demo':
      if (beds24.connected) return send(res, 400, { error: 'Demo data can\'t be loaded while connected to Beds24.' });
      return send(res, 200, loadDemo(db));
    case 'POST /api/demo/clear': return send(res, 200, clearDemo(db));
    case 'POST /api/import/guesty/preview': {
      const { csv } = await readJson(req, 30e6);
      const { summary } = readGuestyExport(csv || '');
      return send(res, 200, { summary, rooms: db.prepare(
        'SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id=r.property_id ORDER BY p.name, r.name').all() });
    }
    case 'POST /api/import/guesty': {
      const { csv, mapping } = await readJson(req, 30e6);
      const { bookings, summary } = readGuestyExport(csv || '');
      return send(res, 200, { ...importGuesty(db, bookings, mapping), summary });
    }
    case 'POST /api/import/guesty/remove': return send(res, 200, removeGuestyImport(db));
    case 'GET /api/properties':
      return send(res, 200, db.prepare('SELECT * FROM properties ORDER BY name').all().map(p => ({
        ...p, rooms: db.prepare('SELECT * FROM rooms WHERE property_id=? ORDER BY name').all(p.id) })));
    case 'GET /api/summary': return send(res, 200, summary(db, iso(Date.now()), prop));
    case 'GET /api/calendar':
      return send(res, 200, calendar(db, q.start || iso(Date.now()), Math.min(Number(q.days) || 30, 120), prop));
    case 'GET /api/bookings': {
      const where = [], args = [];
      if (prop) { where.push('b.property_id = ?'); args.push(prop); }
      for (const f of ['status', 'channel']) if (q[f]) { where.push(`b.${f} = ?`); args.push(q[f]); }
      if (q.from) { where.push('b.departure >= ?'); args.push(q.from); }
      if (q.to) { where.push('b.arrival <= ?'); args.push(q.to); }
      if (q.q) {
        where.push('(b.guest_name LIKE ? OR b.email LIKE ? OR b.channel_ref LIKE ? OR CAST(b.id AS TEXT) = ?)');
        args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, q.q);
      }
      return send(res, 200, db.prepare(
        `SELECT b.*, r.name room_name, p.name property_name FROM bookings b
         LEFT JOIN rooms r ON r.id=b.room_id LEFT JOIN properties p ON p.id=b.property_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.arrival DESC LIMIT 500`).all(...args));
    }
  }
  send(res, 404, { error: 'Not found' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'Not found', 'text/plain');
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

if (process.env.STR_DEMO && getSetting(db, 'demo') !== '1' && !beds24.connected) loadDemo(db);
// Demo data must never sit alongside real bookings (it skews every metric).
if (beds24.connected) clearDemo(db);

// No password configured -> only reachable from this machine.
const host = PASSWORD ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, host, () => {
  console.log(`STR Dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`);
  if (!PASSWORD) console.log('APP_PASSWORD not set: listening on localhost only. Set it before exposing this to a network.');
});

setInterval(() => runSync().catch(e => console.error('sync failed:', e.message)), 15 * 60000).unref();

// Railway sends SIGTERM on redeploy; close cleanly so SQLite isn't mid-write.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
});
