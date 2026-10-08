import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from './db.js';
import { Beds24Client } from './beds24.js';
import { syncBeds24, iso } from './sync.js';
import { summary, calendar } from './stats.js';
import { loadDemo } from './demo.js';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const db = openDb(process.env.DB_PATH || 'data/str.db');
const beds24 = new Beds24Client(db);

if (!getSetting(db, 'session_secret')) setSetting(db, 'session_secret', randomBytes(32).toString('hex'));
const secret = getSetting(db, 'session_secret');
const sign = v => createHmac('sha256', secret).update(v).digest('hex');
const makeSession = () => { const exp = Date.now() + 30 * 86400000; return `${exp}.${sign(String(exp))}`; };
function validSession(tok = '') {
  const [exp, mac] = tok.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));

let syncing = false;
async function runSync() {
  if (syncing || !beds24.connected) return null;
  syncing = true;
  try { return await syncBeds24(db, beds24); }
  catch (e) { setSetting(db, 'last_sync_error', e.message); throw e; }
  finally { syncing = false; }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readJson = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const prop = q.property ? Number(q.property) : null;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/login') {
    const { password } = await readJson(req);
    const ok = PASSWORD && password && password.length === PASSWORD.length &&
      timingSafeEqual(Buffer.from(password), Buffer.from(PASSWORD));
    if (!ok) return send(res, 401, { error: 'Wrong password' });
    res.setHeader('set-cookie', `sid=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return send(res, 200, { ok: true });
  }
  if (PASSWORD && !validSession(cookie(req).sid)) return send(res, 401, { error: 'Login required' });

  switch (route) {
    case 'GET /api/status':
      return send(res, 200, {
        connected: beds24.connected, demo: getSetting(db, 'demo') === '1', syncing,
        lastSync: getSetting(db, 'last_sync'), lastSyncError: getSetting(db, 'last_sync_error'),
        empty: db.prepare('SELECT COUNT(*) n FROM bookings').get().n === 0,
      });
    case 'POST /api/connect': {
      const { inviteCode } = await readJson(req);
      if (!inviteCode) return send(res, 400, { error: 'Invite code required' });
      await beds24.connect(inviteCode);
      setSetting(db, 'demo', null);
      return send(res, 200, await runSync());
    }
    case 'POST /api/disconnect': beds24.disconnect(); return send(res, 200, { ok: true });
    case 'POST /api/sync':
      if (!beds24.connected) return send(res, 400, { error: 'Not connected to Beds24' });
      return send(res, 200, await runSync());
    case 'POST /api/demo': return send(res, 200, loadDemo(db));
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
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'Not found', 'text/plain');
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

if (process.env.STR_DEMO && getSetting(db, 'demo') !== '1' && !beds24.connected) loadDemo(db);

// No password configured -> only reachable from this machine.
const host = PASSWORD ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, host, () => {
  console.log(`STR Dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${PORT}`);
  if (!PASSWORD) console.log('APP_PASSWORD not set: listening on localhost only. Set it before exposing this to a network.');
});

setInterval(() => runSync().catch(e => console.error('sync failed:', e.message)), 15 * 60000).unref();
