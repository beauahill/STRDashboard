import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from './db.js';
import { Beds24Client } from './beds24.js';
import { syncBeds24, iso } from './sync.js';
import { summary, calendar } from './stats.js';
import { loadDemo, clearDemo } from './demo.js';
import { readGuestyExport, importGuesty, dedupeImported, removeGuestyImport } from './guesty.js';
import { syncCalendar, readDays, planChanges, applyChanges, recentChanges } from './rates.js';
import { SeamClient } from './seam.js';
import { feedToken, icsForRoom, turnovers } from './cleaning.js';
import { FIELDS as LISTING_FIELDS, fetchListing, diffListing, saveListing, listingLog } from './listing.js';
import { analytics } from './analytics.js';
import { CATEGORIES, CHANNELS, moneySettings, saveMoneySettings, saveExpense, deleteExpense, receiptOf, listExpenses, pnl, payouts, markPayout, taxReport } from './money.js';
import { guideSettings, saveGuide, guideFor, renderGuide, bookingForToken, saveCheckin, checkinId, pruneCheckins, regenerateLinks, guideOverview } from './guide.js';
import { siteSettings, saveSite, siteFor, listPhotos, addPhoto, updatePhotos, importBeds24Photos, photo, availability, renderSite, renderTerms } from './site.js';
import {
  ROLES as HA_ROLES, haConfigured, haClient, connectHA, disconnectHA, discover, saveEntities, saveHASettings, pollHA, runClimate, homeStatus, homeBrief,
  stayList, stayRecord,
} from './ha.js';
import {
  notifySettings, saveNotifySettings, publicNotify, regenerateTopic, runNotifications, sendTest, recentNotifications, fillMissingBookings, appOrigin,
} from './notify.js';
import { startTailnet, tailnetStatus, routesViaTailnet } from './tailnet.js';
import { recordSignals, forwardStats, LEVELS } from './demand.js';
import { scoutStatus, saveScoutSettings, scanEvents, listSuggestions, addSuggestion, dismissSuggestion, autoScan } from './scout.js';
import { aiStatus, saveKey, saveAiSettings, cacheListing, draftReply, writeListing, reviewPricing, askData } from './ai.js';
import {
  seedAutomations, listAutomations, saveAutomation, setEnabled, deleteAutomation, describe, runAutomations, upcoming,
  skipSend, history, previewFor,
} from './automations.js';
import {
  pricingSettings, savePricingSettings, seedEvents, listEvents, saveEvent, deleteEvent, recommend, pendingChanges,
  applyNightly, autoPrice, suggestFromHistory,
} from './pricing.js';
import {
  syncMessages, unreadCount, conversations, thread, sendMessage, refreshThread, markRead, attachment,
  savedReplies, saveReply, deleteReply, propertyVars, savePropertyVars, BUILTIN_VARS,
} from './messages.js';
import {
  doorSettings, saveDoorSettings, refreshLocks, assignLock, reconcileDoorCodes, doorCodesFor, setBookingCode,
  lockOverview, changeOtherCode, deleteOtherCode, addCode, localToday, doorAlerts,
} from './doors.js';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

// On Railway, refuse to start in a state that would be unreachable or lose data on redeploy.
const ON_RAILWAY = !!process.env.RAILWAY_PROJECT_ID;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (ON_RAILWAY && !PASSWORD) fail('APP_PASSWORD is not set. Add it under the service\'s Variables tab.');
if (ON_RAILWAY && !VOLUME && !process.env.DB_PATH) fail('No volume attached. Add a volume to this service mounted at /data.');
function fail(msg) { console.error(`\nSTARTUP ERROR: ${msg}\n`); process.exit(1); }
if (PASSWORD && PASSWORD.length < 12) console.warn('WARNING: APP_PASSWORD is short. Use at least 12 characters (a passphrase): a short one can be guessed.');

const DB_PATH = process.env.DB_PATH || (VOLUME ? join(VOLUME, 'str.db') : 'data/str.db');
const db = openDb(DB_PATH);
const beds24 = new Beds24Client(db);
const seam = () => new SeamClient(getSetting(db, 'seam_api_key'));

if (!getSetting(db, 'session_secret')) setSetting(db, 'session_secret', randomBytes(32).toString('hex'));
const secret = getSetting(db, 'session_secret');
// Sessions are bound to the current password, so changing APP_PASSWORD signs everyone out. Each one is a random id,
// signed, and recorded in the database, so logging out (or "sign out everywhere") really revokes the cookie. They
// last 30 days, or 14 days unused.
const SESSION_MS = 30 * 86400000, IDLE_MS = 14 * 86400000;
const sign = v => createHmac('sha256', secret).update(`${v}:${PASSWORD}`).digest('hex');
const safeEqual = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && timingSafeEqual(a, b); };
const at = t => new Date(t).toISOString();
const endSession = tok => { const id = String(tok || '').split('.')[0]; if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id); };
function makeSession() {
  const now = Date.now(), id = randomBytes(16).toString('hex'), exp = now + SESSION_MS;
  db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(at(now - IDLE_MS), at(now - SESSION_MS));
  db.prepare('INSERT INTO sessions(id, created_at, last_seen) VALUES(?,?,?)').run(id, at(now), at(now));
  return `${id}.${exp}.${sign(`${id}.${exp}`)}`;
}
function validSession(tok = '') {
  const [id, exp, mac] = tok.split('.');
  if (!id || !exp || !mac || Number(exp) < Date.now() || !safeEqual(mac, sign(`${id}.${exp}`))) return false;
  const row = db.prepare('SELECT last_seen FROM sessions WHERE id = ?').get(id);
  if (!row) return false;
  const now = Date.now(), seen = Date.parse(row.last_seen);
  if (seen < now - IDLE_MS) { endSession(id); return false; }
  if (seen < now - 3600000) db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(at(now), id);
  return true;
}
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
// The client's address as seen by the proxy in front of the app (Railway adds it as the LAST X-Forwarded-For
// entry). Earlier entries, and X-Real-IP, can be set by the client, so they can't be trusted for the login guard.
const clientIp = req => {
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(h => h.trim()).filter(Boolean);
  return (hops.at(-1) || req.socket.remoteAddress || '').slice(0, 64);
};

// Brute-force guard: 10 failed logins per address per 15 minutes is a hard stop. Failures from everywhere together
// only slow wrong answers down (1.5 s each past 100 in the window): the right password always gets in, so a guess
// spread over many addresses can't lock the owner out.
const failures = new Map();
const FAIL_WINDOW = 15 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failureCount = k => failures.get(k)?.count || 0;
function loginBlocked(ip) {
  const now = Date.now();
  for (const [k, f] of failures) if (f.until < now) failures.delete(k);
  return failureCount(ip) >= 10;
}
function recordFailure(ip) {
  for (const k of ['*', ip]) {
    // Bounded: past a few thousand addresses in one window only the shared count keeps growing.
    if (k !== '*' && !failures.has(k) && failures.size > 5000) continue;
    const f = failures.get(k) || { count: 0, until: Date.now() + FAIL_WINDOW };
    f.count++; failures.set(k, f);
  }
}

let syncing = false;
async function runSync() {
  if (syncing || !beds24.connected) return null;
  syncing = true;
  try {
    const r = await syncBeds24(db, beds24);
    dedupeImported(db);
    try { recordSignals(db); } catch (e) { console.error('demand signals failed:', e.message); }
    if (beds24.scopes === null) await beds24.refreshScopes().catch(() => {});
    // Prices are a separate permission in Beds24; a read-only or bookings-only code shouldn't fail the whole sync.
    try { await syncCalendar(db, beds24); setSetting(db, 'calendar_error', null); }
    catch (e) { setSetting(db, 'calendar_error', e.message); }
    await runDoorCodes().catch(() => {});
    try { await autoPrice(db, beds24, localToday(doorSettings(db).tz)); setSetting(db, 'pricing_error', null); }
    catch (e) { setSetting(db, 'pricing_error', e.message); }
    try { await syncMessages(db, beds24); setSetting(db, 'messages_error', null); }
    catch (e) { setSetting(db, 'messages_error', e.message); }
    await runAutomationsSafely();
    await runNotificationsSafely();
    return r;
  }
  catch (e) { setSetting(db, 'last_sync_error', e.message); throw e; }
  finally { syncing = false; }
}

// Automated messages: checked every 5 minutes (and after each sync). Never throws. The run in flight is kept so a
// shutdown can wait for it (a message just sent must be recorded as sent, or it goes out again after the restart).
let automationsRunning = false, automationRun = null;
async function runAutomationsSafely() {
  if (automationsRunning || !beds24.connected) return null;
  automationsRunning = true;
  automationRun = (async () => {
    try { const r = await runAutomations(db, beds24); setSetting(db, 'automations_error', null); return r; }
    catch (e) { setSetting(db, 'automations_error', e.message); return { error: e.message }; }
    finally { automationsRunning = false; }
  })();
  return automationRun;
}

// Phone notifications: while they're on, new guest messages are checked every minute (the full sync runs every
// 15), then anything new is sent. Never throws.
let notifying = false;
async function runNotificationsSafely({ pollMessages = false } = {}) {
  if (notifying) return null;
  notifying = true;
  try {
    if (pollMessages && beds24.connected && !syncing && getSetting(db, 'messages_synced')) {
      try { await syncMessages(db, beds24, { maxAge: 1 }); setSetting(db, 'messages_error', null); }
      catch (e) { setSetting(db, 'messages_error', e.message); }
    }
    if (beds24.connected) await fillMissingBookings(db, beds24).catch(() => {});
    return await runNotifications(db);
  } catch (e) { setSetting(db, 'notify_error', e.message); return { error: e.message }; }
  finally { notifying = false; }
}

// Event scout runs (manual or weekly) one at a time.
let scouting = false;

// Home Assistant: every minute, read the devices, update alerts and run the thermostat / lock automations,
// then send any notifications. Never throws.
let haRunning = false;
async function runHASafely() {
  if (haRunning || !haConfigured(db)) return null;
  haRunning = true;
  try { return await pollHA(db); }
  catch (e) { return { error: e.message }; }
  finally { haRunning = false; runNotificationsSafely(); }
}

// Door codes run after every sync, after lock changes, and on their own timer. Failures are recorded, never thrown,
// so a Seam outage can't stop bookings from syncing. One run at a time: two overlapping runs would both create a
// code on the lock and track only one of them.
let doorChain = Promise.resolve();
function runDoorCodes() {
  // Each run waits for the one before it; even a run that fails to record its own error can't break the chain.
  doorChain = doorChain.catch(() => {}).then(async () => {
    try { const r = await reconcileDoorCodes(db, seam(), beds24); setSetting(db, 'door_error', null); return r; }
    catch (e) { try { setSetting(db, 'door_error', e.message); } catch {} return { error: e.message }; }
  });
  return doorChain;
}

// Lock-code entries sent back from the Locks page must point at locks we know about.
function checkEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw Object.assign(new Error('Nothing selected.'), { status: 400 });
  const known = new Set(db.prepare('SELECT device_id FROM locks').all().map(l => l.device_id));
  for (const e of entries) {
    if (!known.has(e.deviceId) || typeof e.accessCodeId !== 'string') throw Object.assign(new Error('Unknown lock code.'), { status: 400 });
  }
  return entries.map(e => ({ deviceId: e.deviceId, accessCodeId: e.accessCodeId, managed: !!e.managed }));
}

// The app's own address, remembered from the browser so notifications can link back to it (Railway also provides it).
function rememberOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || /^(localhost|127\.|\[::1\])/.test(host)) return null;
  const origin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`;
  if (getSetting(db, 'app_origin') !== origin) setSetting(db, 'app_origin', origin);
  return origin;
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
// Only a JSON object is accepted (routes read fields from it). An oversized body is refused the moment it's known to be
// too big (from Content-Length, or as the limit is passed mid-stream) and the rest is never read. The body is decoded
// once at the end: decoding chunk by chunk would break characters split across two chunks.
const readJson = (req, limit = 1e6) => new Promise((ok, no) => {
  const tooBig = () => no(Object.assign(new Error('Upload too large'), { status: 413, dropBody: true }));
  if (Number(req.headers['content-length']) > limit) return tooBig();
  let parts = [], size = 0;
  req.on('data', c => { if (!parts) return; size += c.length; if (size > limit) { parts = null; tooBig(); } else parts.push(c); });
  req.on('error', no);
  req.on('end', () => {
    if (!parts) return;
    let v;
    try { const s = Buffer.concat(parts).toString('utf8'); v = s ? JSON.parse(s) : {}; } catch { return no(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return no(Object.assign(new Error('Expected a JSON object'), { status: 400 }));
    ok(v);
  });
});
// Date query strings feed date arithmetic: anything that isn't a real YYYY-MM-DD is a 400, not a crash.
function dateParam(q, k) {
  const v = q[k];
  if (!v) return undefined;
  const t = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(t) || iso(t) !== v) throw Object.assign(new Error(`${k} must be a date like 2026-10-14.`), { status: 400 });
  return v;
}
const SYNC_BUSY = { error: 'A sync is already running. Try again in a minute.' };
// The page's own requests always say they're JSON and come from this host. A browser sends a cross-site request
// without asking first only as a "simple" one (never JSON), and always with the page's Origin.
const sameHost = (origin, req) => {
  let h; try { h = new URL(origin).host.toLowerCase(); } catch { return false; }
  return [req.headers.host, req.headers['x-forwarded-host']].some(x => x && x.toLowerCase() === h);
};
const CLEAR_COOKIE = 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const prop = q.property ? Number(q.property) : null;
  const route = `${req.method} ${url.pathname}`;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected a JSON body (content-type: application/json).' });
    if (req.headers.origin && !sameHost(req.headers.origin, req)) return send(res, 403, { error: 'Cross-site request refused.' });
  }
  // Without a password nothing else guards the API, so only this machine's own names may reach it (a web page that
  // pointed its own domain at 127.0.0.1 would otherwise read everything).
  if (!PASSWORD && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return send(res, 403, { error: `Open the app at http://localhost:${PORT}.` });

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { password } = await readJson(req);
    if (!PASSWORD || typeof password !== 'string' || !safeEqual(sign(password), sign(PASSWORD))) {
      const heavy = failureCount('*') >= 100;
      recordFailure(ip);
      if (heavy) await sleep(1500);
      return send(res, 401, { error: 'Wrong password' });
    }
    failures.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `sid=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/logout') {
    endSession(cookie(req).sid);
    res.setHeader('set-cookie', CLEAR_COOKIE);
    return send(res, 200, { ok: true });
  }
  if (PASSWORD && !validSession(cookie(req).sid)) return send(res, 401, { error: 'Login required' });

  switch (route) {
    case 'POST /api/logout-all':   // sign out everywhere: every browser, phone and copied cookie
      db.exec('DELETE FROM sessions');
      res.setHeader('set-cookie', CLEAR_COOKIE);
      return send(res, 200, { ok: true });
    case 'GET /api/status':
      return send(res, 200, {
        connected: beds24.connected, scopes: beds24.scopes, auth: !!PASSWORD, demo: getSetting(db, 'demo') === '1', syncing,
        lastSync: getSetting(db, 'last_sync'), lastSyncError: getSetting(db, 'last_sync_error'),
        empty: db.prepare('SELECT COUNT(*) n FROM bookings').get().n === 0,
        guestyImported: db.prepare("SELECT COUNT(*) n FROM bookings WHERE source = 'guesty'").get().n,
        unreadMessages: unreadCount(db), ai: aiStatus(db).configured, home: haConfigured(db), tz: doorSettings(db).tz,
      });
    case 'POST /api/connect': {
      if (syncing) return send(res, 409, SYNC_BUSY);
      const { inviteCode } = await readJson(req);
      if (!inviteCode) return send(res, 400, { error: 'Invite code required' });
      await beds24.connect(inviteCode);
      clearDemo(db);
      return send(res, 200, await runSync());
    }
    case 'POST /api/disconnect': beds24.disconnect(); return send(res, 200, { ok: true });
    case 'POST /api/sync':
      if (!beds24.connected) return send(res, 400, { error: 'Not connected to Beds24' });
      if (syncing) return send(res, 409, SYNC_BUSY);
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
    case 'GET /api/rates': {
      const start = dateParam(q, 'start');
      const rooms = db.prepare(`SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id
        WHERE r.id > 0 ${prop ? 'AND r.property_id = ?' : ''} ORDER BY p.name, r.name`).all(...(prop ? [prop] : []));
      const room = rooms.find(r => r.id === Number(q.room)) || rooms[0] || null;
      return send(res, 200, {
        rooms, room, connected: beds24.connected, canWrite: beds24.canWriteInventory,
        calendarError: getSetting(db, 'calendar_error'), lastSync: getSetting(db, 'last_sync'),
        days: room ? readDays(db, room.id, start || localToday(doorSettings(db).tz), Math.min(Number(q.days) || 62, 120)) : [],
        changes: recentChanges(db),
      });
    }
    case 'POST /api/rates/preview': return send(res, 200, planChanges(db, await readJson(req)));
    case 'GET /api/pricing': {
      const start = dateParam(q, 'start');
      const rooms = db.prepare(`SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id
        WHERE r.id > 0 ${prop ? 'AND r.property_id = ?' : ''} ORDER BY p.name, r.name`).all(...(prop ? [prop] : []));
      const room = rooms.find(r => r.id === Number(q.room)) || rooms[0] || null;
      if (!room) return send(res, 200, { rooms, room: null });
      const today = localToday(doorSettings(db).tz);
      const rec = recommend(db, room.id, { start, days: Math.min(Number(q.days) || 62, 400), today });
      const year = rec.needsBase ? null : recommend(db, room.id, { days: 365, today });
      const ahead = days => {
        const p = pendingChanges({ ...year, nights: year.nights.slice(0, days) }, { includeMinStay: q.minStay !== '0' });
        const set = p.filter(c => c.before != null);
        return { nights: p.length, priceChanges: p.filter(c => c.price !== c.before).length,
          avgNow: set.length ? Math.round(set.reduce((a, c) => a + c.before, 0) / set.length) : null,
          avgNew: p.length ? Math.round(p.reduce((a, c) => a + c.price, 0) / p.length) : null };
      };
      const slim = n => ({ date: n.date, price: n.price ?? null, current: n.current ?? null, booked: !!n.booked, blocked: !!n.blocked,
        score: n.demand?.score ?? null, level: n.demand?.level ?? null, event: n.event || null });
      return send(res, 200, {
        rooms, room, today, settings: rec.settings, needsBase: !!rec.needsBase, nights: rec.nights, pace: rec.pace || {},
        events: listEvents(db), pending: rec.needsBase ? null : { d30: ahead(30), d90: ahead(90), d365: ahead(365) },
        next90: year ? year.nights.slice(0, 90).map(slim) : [], forward: forwardStats(db, room.id, today), signals: rec.signals || null, levels: LEVELS,
        suggestions: listSuggestions(db, { today }), scout: scoutStatus(db),
        canWrite: beds24.connected && beds24.canWriteInventory !== false, connected: beds24.connected,
        lastAuto: getSetting(db, `pricing_auto_${room.id}`), error: getSetting(db, 'pricing_error'),
      });
    }
    case 'POST /api/pricing/settings': {
      const b = await readJson(req);
      return send(res, 200, savePricingSettings(db, Number(b.roomId), b));
    }
    case 'POST /api/pricing/suggest': {
      const { roomId } = await readJson(req);
      return send(res, 200, suggestFromHistory(db, Number(roomId), localToday(doorSettings(db).tz)));
    }
    case 'POST /api/pricing/events': return send(res, 200, { id: saveEvent(db, await readJson(req)) });
    case 'POST /api/pricing/scout': {
      if (scouting) return send(res, 409, { error: 'The event scout is already running. Try again in a few minutes.' });
      scouting = true;
      try { return send(res, 200, await scanEvents(db, { today: localToday(doorSettings(db).tz), propertyId: prop })); }
      finally { scouting = false; runNotificationsSafely(); }
    }
    case 'POST /api/pricing/scout/settings': return send(res, 200, saveScoutSettings(db, await readJson(req)));
    case 'POST /api/pricing/suggestions/add': {
      const { id, pct, min_stay } = await readJson(req);
      return send(res, 200, addSuggestion(db, id, { ...(pct !== undefined && pct !== '' && { pct }), ...(min_stay !== undefined && { min_stay }) }));
    }
    case 'POST /api/pricing/suggestions/dismiss': { const { id } = await readJson(req); dismissSuggestion(db, id); return send(res, 200, { ok: true }); }
    case 'POST /api/pricing/events/delete': { const { id } = await readJson(req); deleteEvent(db, Number(id)); return send(res, 200, { ok: true }); }
    case 'POST /api/pricing/apply': {
      if (!beds24.connected) return send(res, 400, { error: 'Connect Beds24 first.' });
      if (beds24.canWriteInventory === false) return send(res, 403, { error: 'Your Beds24 invite code can\'t change prices. Create one with write access to Inventory and paste it in Settings.' });
      const { roomId, days, includeMinStay = true } = await readJson(req);
      const n = Number(days);
      if (!(Number.isInteger(n) && n >= 1 && n <= 400)) return send(res, 400, { error: 'Choose how many days ahead to apply (1 to 400).' });
      // Recalculated here rather than trusting prices sent from the browser.
      const today = localToday(doorSettings(db).tz);
      const rec = recommend(db, Number(roomId), { days: n, today });
      if (rec.needsBase) return send(res, 400, { error: 'Set a base price first.' });
      return send(res, 200, await applyNightly(db, beds24, Number(roomId), pendingChanges(rec, { includeMinStay: !!includeMinStay }), { today }));
    }
    case 'GET /api/cleaning': {
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
      const token = feedToken(db);
      const rooms = db.prepare('SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id > 0 ORDER BY p.name, r.name').all();
      const roomIds = prop ? db.prepare('SELECT id FROM rooms WHERE property_id = ?').all(prop).map(r => r.id) : null;
      return send(res, 200, { turnovers: turnovers(db, { days: Math.min(Number(q.days) || 30, 120), roomIds }),
        feeds: rooms.map(r => ({ ...r, url: `${origin}/cal/${token}/${r.id}.ics` })) });
    }
    case 'POST /api/cleaning/regenerate': feedToken(db, true); return send(res, 200, { ok: true });
    case 'GET /api/automations': {
      const props = db.prepare('SELECT id, name FROM properties ORDER BY name').all();
      const soon = db.prepare(`SELECT id, guest_name, arrival, departure, channel FROM bookings WHERE source = 'beds24' AND id > 0
        AND status IN ('confirmed','new') AND departure >= ? ORDER BY arrival LIMIT 30`).all(localToday(doorSettings(db).tz));
      return send(res, 200, {
        automations: listAutomations(db).map(a => ({ ...a, when: describe(a) })), upcoming: upcoming(db), history: history(db),
        properties: props.map(p => ({ ...p, vars: propertyVars(db, p.id) })), builtins: BUILTIN_VARS, bookings: soon,
        connected: beds24.connected, error: getSetting(db, 'automations_error'), tz: doorSettings(db).tz,
      });
    }
    case 'POST /api/automations': return send(res, 200, { id: saveAutomation(db, await readJson(req)) });
    case 'POST /api/automations/enable': { const { id, enabled } = await readJson(req); setEnabled(db, Number(id), !!enabled); return send(res, 200, { ok: true }); }
    case 'POST /api/automations/delete': { const { id } = await readJson(req); deleteAutomation(db, Number(id)); return send(res, 200, { ok: true }); }
    case 'POST /api/automations/skip': {
      const { automationId, bookingId } = await readJson(req);
      if (!Number(automationId) || !Number(bookingId)) return send(res, 400, { error: 'automationId and bookingId are required.' });
      skipSend(db, Number(automationId), Number(bookingId)); return send(res, 200, { ok: true });
    }
    case 'POST /api/automations/preview': { const { body, bookingId } = await readJson(req); return send(res, 200, previewFor(db, body, Number(bookingId))); }
    case 'POST /api/automations/run': return send(res, 200, (await runAutomationsSafely()) || { skipped: true });
    case 'POST /api/property-vars': { const { propertyId, vars } = await readJson(req); return send(res, 200, savePropertyVars(db, Number(propertyId), vars)); }
    case 'GET /api/listing': {
      const props = db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all();
      const pid = props.some(p => p.id === Number(q.property)) ? Number(q.property) : props[0]?.id;
      const base = { properties: props, fields: LISTING_FIELDS, connected: beds24.connected, canWrite: beds24.canWriteProperties };
      if (!pid || !beds24.connected) return send(res, 200, base);
      const listing = await fetchListing(beds24, pid, q.lang || 'en');
      cacheListing(db, listing);  // what the AI assistant knows about the property when drafting replies
      return send(res, 200, { ...base, listing, log: listingLog(db, pid), ai: aiStatus(db).configured });
    }
    case 'POST /api/listing/preview': {
      const { propertyId, edited } = await readJson(req);
      const current = await fetchListing(beds24, Number(propertyId), edited?.lang || 'en');
      return send(res, 200, { changes: diffListing(current, edited || {}).changes });
    }
    case 'POST /api/listing/save': {
      if (!beds24.connected) return send(res, 400, { error: 'Connect Beds24 first.' });
      if (beds24.canWriteProperties === false) return send(res, 403, { error: 'Your Beds24 invite code can\'t change listing content. Create one with write access to Properties and paste it in Settings.' });
      const { propertyId, edited } = await readJson(req, 2e6);
      return send(res, 200, await saveListing(db, beds24, Number(propertyId), edited || {}));
    }
    case 'GET /api/analytics':
      return send(res, 200, analytics(db, localToday(doorSettings(db).tz), { propertyId: prop, range: q.range }));
    case 'GET /api/notify':
      return send(res, 200, { settings: publicNotify(notifySettings(db)), recent: recentNotifications(db), error: getSetting(db, 'notify_error'),
        linksWork: !!(appOrigin(db) || rememberOrigin(req)) });
    case 'POST /api/notify': {
      rememberOrigin(req);
      return send(res, 200, { settings: publicNotify(saveNotifySettings(db, await readJson(req))) });
    }
    case 'POST /api/notify/test': {
      rememberOrigin(req);
      const s = notifySettings(db);
      try { await sendTest(db); } catch (e) { throw Object.assign(new Error(`Couldn't send the test: ${e.message}`), { status: 502 }); }
      return send(res, 200, { ok: true, topic: s.topic });
    }
    case 'POST /api/notify/new-topic': return send(res, 200, { settings: publicNotify(regenerateTopic(db)) });
    case 'GET /api/site': {
      const props = db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all();
      const pid = props.some(p => p.id === Number(q.property)) ? Number(q.property) : props[0]?.id;
      if (!pid) return send(res, 200, { properties: props });
      const s = siteSettings(db, pid), origin = appOrigin(db) || rememberOrigin(req) || '';
      return send(res, 200, { properties: props, site: s, photos: listPhotos(db, pid), url: `${origin}/stay/${s.slug}`, connected: beds24.connected,
        openNights: availability(db, pid, { days: 90 }).filter(n => n.open).length });
    }
    case 'POST /api/site': { const b = await readJson(req); return send(res, 200, { site: saveSite(db, Number(b.propertyId), b) }); }
    case 'POST /api/site/photos': {
      const b = await readJson(req, 6e6);
      return send(res, 200, { id: addPhoto(db, Number(b.propertyId), { dataUrl: b.dataUrl, caption: b.caption }) });
    }
    case 'POST /api/site/photos/update': { const b = await readJson(req); return send(res, 200, { photos: updatePhotos(db, Number(b.propertyId), b) }); }
    case 'POST /api/site/photos/import': {
      if (!beds24.connected) return send(res, 400, { error: 'Connect Beds24 first.' });
      const { propertyId } = await readJson(req);
      return send(res, 200, await importBeds24Photos(db, beds24, Number(propertyId)));
    }
    case 'GET /api/money': {
      const today = localToday(doorSettings(db).tz), year = Number(q.year) || Number(today.slice(0, 4));
      const years = db.prepare(`SELECT DISTINCT substr(arrival,1,4) y FROM bookings WHERE status != 'block' UNION SELECT DISTINCT substr(date,1,4) FROM expenses ORDER BY 1 DESC`).all().map(r => Number(r.y));
      return send(res, 200, { year, years: [...new Set([Number(today.slice(0, 4)), ...years])].sort((a, b) => b - a), today, categories: CATEGORIES, channels: CHANNELS,
        settings: moneySettings(db), pnl: pnl(db, year, { propertyId: prop, today }), expenses: listExpenses(db, { year, propertyId: prop }),
        payouts: payouts(db, today, { propertyId: prop }), tax: taxReport(db, year, { propertyId: prop }),
        properties: db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all() });
    }
    case 'POST /api/money/settings': return send(res, 200, { settings: saveMoneySettings(db, await readJson(req)) });
    case 'POST /api/money/expense': return send(res, 200, { id: saveExpense(db, await readJson(req, 8e6)) });
    case 'POST /api/money/expense/delete': { const { id } = await readJson(req); deleteExpense(db, Number(id)); return send(res, 200, { ok: true }); }
    case 'GET /api/money/receipt': {
      const r = receiptOf(db, Number(q.id));
      if (!r) return send(res, 404, { error: 'No receipt.' });
      res.writeHead(200, { 'content-type': r.receipt_mime, 'cache-control': 'private, no-store', 'content-disposition': 'inline' });
      return res.end(r.receipt_data);
    }
    case 'POST /api/money/payout': { const b = await readJson(req); return send(res, 200, { payout: markPayout(db, Number(b.bookingId), b) }); }
    case 'GET /api/guide': {
      rememberOrigin(req);
      const props = db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all();
      const pid = props.some(p => p.id === Number(q.property)) ? Number(q.property) : props[0]?.id;
      if (!pid) return send(res, 200, { properties: props });
      return send(res, 200, { properties: props, guide: guideSettings(db, pid), stays: guideOverview(db, pid) });
    }
    case 'POST /api/guide': { const b = await readJson(req); return send(res, 200, { guide: saveGuide(db, Number(b.propertyId), b) }); }
    case 'POST /api/guide/regenerate': regenerateLinks(db); return send(res, 200, { ok: true });
    case 'GET /api/guide/id': {
      const id = checkinId(db, Number(q.booking));
      if (!id) return send(res, 404, { error: 'No ID on file for this booking.' });
      res.writeHead(200, { 'content-type': id.id_mime, 'cache-control': 'no-store', 'content-disposition': 'inline' });
      return res.end(id.id_data);
    }
    case 'GET /api/home': {
      const h = homeStatus(db);
      return send(res, 200, { ...h, tailscale: { ...tailnetStatus(), used: !!h.url && routesViaTailnet(h.url) }, stays: stayList(db, Date.now(), { propertyId: prop }) });
    }
    case 'POST /api/home/connect': {
      const { url, token } = await readJson(req);
      const s = await connectHA(db, { url, token });
      runHASafely();
      return send(res, 200, { ok: true, devices: Object.keys(s.entities).length });
    }
    case 'POST /api/home/disconnect': disconnectHA(db); return send(res, 200, { ok: true });
    case 'GET /api/home/devices': return send(res, 200, { devices: await discover(db), roles: HA_ROLES,
      properties: db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all() });
    case 'POST /api/home/devices': {
      const { entities } = await readJson(req);
      saveEntities(db, entities);
      await runHASafely();
      return send(res, 200, { ok: true });
    }
    case 'POST /api/home/settings': {
      saveHASettings(db, await readJson(req));
      await runHASafely();
      return send(res, 200, { ok: true });
    }
    case 'POST /api/home/refresh': {
      const r = await runHASafely();
      if (r?.error) return send(res, 502, { error: r.error });
      return send(res, 200, { ok: true });
    }
    case 'POST /api/home/climate/apply': {
      const { propertyId } = await readJson(req);
      const c = haClient(db);
      if (!c) return send(res, 400, { error: 'Connect Home Assistant first.' });
      return send(res, 200, { applied: await runClimate(db, c, Date.now(), { force: true, propertyId: Number(propertyId) }) });
    }
    case 'GET /api/home/stay': return send(res, 200, stayRecord(db, Number(q.booking)));
    case 'GET /api/ai': return send(res, 200, aiStatus(db));
    case 'POST /api/ai/key': { const { apiKey } = await readJson(req); return send(res, 200, await saveKey(db, apiKey)); }
    case 'POST /api/ai/settings': return send(res, 200, saveAiSettings(db, await readJson(req)));
    case 'POST /api/ai/draft': {
      const { bookingId, instructions } = await readJson(req);
      return send(res, 200, await draftReply(db, Number(bookingId), { instructions: String(instructions || ''), client: beds24.connected ? beds24 : null }));
    }
    case 'POST /api/ai/listing': {
      const b = await readJson(req, 2e6);
      return send(res, 200, await writeListing(db, { ...b, instruction: String(b.instruction || '') }));
    }
    case 'POST /api/ai/pricing': {
      const { roomId, date, question } = await readJson(req);
      return send(res, 200, await reviewPricing(db, Number(roomId), { date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : null, question: String(question || '') }));
    }
    case 'POST /api/ai/ask': {
      const { question, history } = await readJson(req);
      return send(res, 200, await askData(db, question, { history, propertyId: prop }));
    }
    case 'GET /api/inbox':
      return send(res, 200, { conversations: conversations(db, { filter: q.filter, q: q.q || '' }), unread: unreadCount(db),
        error: getSetting(db, 'messages_error'), connected: beds24.connected });
    case 'GET /api/inbox/thread': return send(res, 200, thread(db, Number(q.booking)));
    case 'POST /api/inbox/refresh': {
      // Polled every minute while the inbox is open; never hit Beds24 more than twice a minute.
      const last = Number(getSetting(db, 'messages_poll') || 0);
      if (beds24.connected && Date.now() - last > 30000) {
        setSetting(db, 'messages_poll', Date.now());
        try { await syncMessages(db, beds24); setSetting(db, 'messages_error', null); }
        catch (e) { setSetting(db, 'messages_error', e.message); }
        runNotificationsSafely();
      }
      return send(res, 200, { unread: unreadCount(db), error: getSetting(db, 'messages_error') });
    }
    case 'POST /api/inbox/send': {
      if (!beds24.connected) return send(res, 400, { error: 'Connect Beds24 first.' });
      const { bookingId, message } = await readJson(req);
      return send(res, 200, await sendMessage(db, beds24, Number(bookingId), message));
    }
    case 'POST /api/inbox/read': {
      const { bookingId } = await readJson(req);
      return send(res, 200, beds24.connected ? await markRead(db, beds24, Number(bookingId)) : { changed: 0 });
    }
    case 'POST /api/inbox/reload': {
      const { bookingId } = await readJson(req);
      if (beds24.connected) await refreshThread(db, beds24, Number(bookingId));
      return send(res, 200, thread(db, Number(bookingId)));
    }
    case 'GET /api/inbox/attachment': {
      // A guest chooses the file and its type. Only photos and PDFs open in the browser; anything else (HTML, SVG...)
      // downloads, and the sandbox stops a file from running script with the owner's session either way.
      const a = await attachment(db, beds24, Number(q.id));
      const viewable = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/i.test(a.mime || '');
      res.writeHead(200, { 'content-type': viewable ? a.mime : 'application/octet-stream', 'cache-control': 'private, no-store',
        'content-disposition': `${viewable ? 'inline' : 'attachment'}; filename="${String(a.name || 'file').replace(/[^\w.\- ]/g, '_')}"`,
        'content-security-policy': 'sandbox; default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'' });
      return res.end(a.data);
    }
    case 'GET /api/replies': return send(res, 200, savedReplies(db));
    case 'POST /api/replies': return send(res, 200, { id: saveReply(db, await readJson(req)) });
    case 'POST /api/replies/delete': { const { id } = await readJson(req); deleteReply(db, Number(id)); return send(res, 200, { ok: true }); }
    case 'GET /api/locks': {
      const key = getSetting(db, 'seam_api_key');
      const out = {
        configured: !!key, keyHint: key ? `…${key.slice(-4)}` : null, settings: doorSettings(db),
        rooms: db.prepare('SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id > 0 ORDER BY p.name, r.name').all(),
        lastRun: getSetting(db, 'door_last_run'), error: getSetting(db, 'door_error'),
        problems: JSON.parse(getSetting(db, 'door_last_problems') || '[]'),
        locks: db.prepare('SELECT * FROM locks ORDER BY name').all(), otherCodes: [], guestCodes: [],
      };
      const upcoming = db.prepare(`SELECT b.id, b.guest_name, b.arrival, b.departure, b.channel, b.phone FROM bookings b
        JOIN door_codes d ON d.booking_id = b.id ORDER BY b.arrival`).all();
      const codes = doorCodesFor(db, upcoming.map(b => b.id));
      out.guestCodes = upcoming.map(b => ({ ...b, phone: undefined, door: codes[b.id] }));
      if (key) {
        try { Object.assign(out, await lockOverview(db, seam())); }
        catch (e) { out.seamError = e.message; }
      }
      return send(res, 200, out);
    }
    case 'POST /api/locks/key': {
      const { apiKey } = await readJson(req);
      if (apiKey && !/^seam_\S{10,}$/.test(apiKey.trim())) return send(res, 400, { error: 'That doesn\'t look like a Seam API key (they start with "seam_").' });
      const previous = getSetting(db, 'seam_api_key');
      setSetting(db, 'seam_api_key', apiKey ? apiKey.trim() : null);
      if (!apiKey) { db.exec('DELETE FROM locks'); return send(res, 200, { removed: true }); }
      // A key Seam rejects, or one that lists no locks (wrong workspace), mustn't replace the one that works.
      try { return send(res, 200, { locks: await refreshLocks(db, seam()) }); }
      catch (e) { setSetting(db, 'seam_api_key', previous); throw e; }
    }
    case 'POST /api/locks/connect': {
      const wv = await seam().connectWebview();
      return send(res, 200, { url: wv.url });
    }
    case 'POST /api/locks/refresh': {
      const locks = await refreshLocks(db, seam());
      return send(res, 200, { locks, doors: await runDoorCodes() });
    }
    case 'POST /api/locks/assign': {
      const { deviceId, roomId } = await readJson(req);
      if (typeof deviceId !== 'string' || !deviceId) return send(res, 400, { error: 'deviceId is required.' });
      assignLock(db, deviceId, roomId == null || roomId === '' ? null : Number(roomId));
      return send(res, 200, { ok: true, doors: await runDoorCodes() });
    }
    case 'POST /api/locks/settings':
      return send(res, 200, { settings: saveDoorSettings(db, await readJson(req)), doors: await runDoorCodes() });
    case 'POST /api/locks/booking-code': {
      const { bookingId, code } = await readJson(req);
      setBookingCode(db, Number(bookingId), String(code || '').trim(), (await lockOverview(db, seam())).otherCodes);
      return send(res, 200, { ok: true, doors: await runDoorCodes() });
    }
    case 'POST /api/locks/code/change': {
      const { entries, code, name } = await readJson(req);
      await changeOtherCode(seam(), checkEntries(entries), { code: String(code || '').trim(), name: name?.trim() }, db);
      return send(res, 200, { ok: true });
    }
    case 'POST /api/locks/code/delete': {
      const { entries } = await readJson(req);
      await deleteOtherCode(seam(), checkEntries(entries));
      return send(res, 200, { ok: true });
    }
    case 'POST /api/locks/code/add': {
      const b = await readJson(req);
      await addCode(db, seam(), { ...b, code: String(b.code || '').trim() });
      return send(res, 200, { ok: true });
    }
    case 'POST /api/rates/apply': {
      if (!beds24.connected) return send(res, 400, { error: 'Connect Beds24 first.' });
      if (beds24.canWriteInventory === false) {
        return send(res, 403, { error: 'Your Beds24 invite code can\'t change prices. Create a new one with write access to Inventory and paste it in Settings.' });
      }
      return send(res, 200, await applyChanges(db, beds24, await readJson(req)));
    }
    case 'GET /api/properties':
      return send(res, 200, db.prepare('SELECT * FROM properties ORDER BY name').all().map(p => ({
        ...p, rooms: db.prepare('SELECT * FROM rooms WHERE property_id=? ORDER BY name').all(p.id) })));
    case 'GET /api/summary': {
      const sum = summary(db, localToday(doorSettings(db).tz), prop);
      sum.home = homeBrief(db);
      // Automated messages that failed recently, or are stuck waiting past their send time, need a look.
      sum.automationIssues = db.prepare(`SELECT s.status, s.error, a.name automation, b.guest_name FROM automation_sends s
        JOIN automations a ON a.id = s.automation_id LEFT JOIN bookings b ON b.id = s.booking_id
        WHERE (s.status = 'failed' AND s.updated_at >= ?) OR (s.status = 'waiting' AND s.scheduled_at <= ?)
        ORDER BY s.updated_at DESC LIMIT 5`).all(new Date(Date.now() - 7 * 86400e3).toISOString(), new Date(Date.now() - 3600e3).toISOString());
      if (doorSettings(db).auto) {
        sum.doors = doorCodesFor(db, [...sum.arrivals, ...sum.inHouse, ...sum.upcoming].map(b => b.id));
        // Guests in the house or arriving within 3 days without a working code on every lock (or no lock at all).
        sum.doorAlerts = doorAlerts(db, { days: 3 });
      }
      return send(res, 200, sum);
    }
    case 'GET /api/calendar': {
      const cal = calendar(db, dateParam(q, 'start') || localToday(doorSettings(db).tz), Math.min(Number(q.days) || 42, 120), prop);
      if (doorSettings(db).auto) cal.doors = doorCodesFor(db, cal.bookings.map(b => b.id));
      return send(res, 200, cal);
    }
    case 'GET /api/bookings': {
      const where = [], args = [];
      if (prop) { where.push('b.property_id = ?'); args.push(prop); }
      for (const f of ['status', 'channel']) if (q[f]) { where.push(`b.${f} = ?`); args.push(q[f]); }
      const from = dateParam(q, 'from'), to = dateParam(q, 'to');
      if (from) { where.push('b.departure >= ?'); args.push(from); }
      if (to) { where.push('b.arrival <= ?'); args.push(to); }
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
  // A malformed request target (e.g. "//a:b") makes URL throw; that must be a 400, not an unhandled rejection.
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('Bad request'); }
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  // Behind a TLS proxy (Railway), tell browsers to come back over HTTPS only.
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    // Cleaning calendar for Turno: no login (Turno can't sign in), protected by the secret in the URL.
    const feed = url.pathname.match(/^\/cal\/([\w-]{20,})\/(\d+)\.ics$/);
    if (feed) {
      const ics = safeEqual(feed[1], feedToken(db)) ? icsForRoom(db, Number(feed[2])) : null;
      if (!ics) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(ics);
    }
    // Guest guidebook (public, private link per booking).
    const gm = url.pathname.match(/^\/guide\/([\w-]+?)(\/checkin)?\/?$/);
    if (gm) {
      const bookingId = bookingForToken(db, gm[1]);
      if (bookingId == null) return send(res, 404, 'Not found', 'text/plain');
      if (gm[2] && req.method === 'POST') {
        const body = await readJson(req, 8e6);
        saveCheckin(db, bookingId, body, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
        return send(res, 200, { ok: true });
      }
      const html = renderGuide(guideFor(db, bookingId), { token: gm[1] });
      if (!html) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end(html);
    }
    // Direct booking site (public): /stay/<slug>[/...], or the root of its own domain.
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    const stay = url.pathname.match(/^\/stay\/([\w-]+)(\/.*)?$/);
    const byDomain = !stay && !url.pathname.startsWith('/api/') && siteFor(db, { host });
    const domainPath = byDomain && (['/', '/terms', '/availability.json'].includes(url.pathname) || /^\/photo\/\d+$/.test(url.pathname));
    if (stay || domainPath) {
      const site = stay ? siteFor(db, { slug: stay[1] }) : byDomain;
      const rest = stay ? stay[2] || '/' : url.pathname;
      const base = stay ? `/stay/${site?.slug}` : '';
      const preview = !!site && !site.enabled && (!PASSWORD || validSession(cookie(req).sid));
      // The rental agreement stays readable while the site is off: the guidebook's online check-in links to it.
      if (!site || (!site.enabled && !preview && rest !== '/terms')) return send(res, 404, 'Not found', 'text/plain');
      if (rest === '/' || rest === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(renderSite(db, site, { base, preview: preview || url.searchParams.has('preview'), origin: appOrigin(db) || '' }));
      }
      if (rest === '/terms') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(renderTerms(db, site, { base: base || '/' })); }
      if (rest === '/availability.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' });
        return res.end(JSON.stringify({ nights: availability(db, site.propertyId) }));
      }
      const ph = rest.match(/^\/photo\/(\d+)$/) && photo(db, site.propertyId, Number(rest.split('/')[2]));
      if (ph?.url) { res.writeHead(302, { location: ph.url, 'cache-control': 'public, max-age=3600' }); return res.end(); }
      if (ph?.data) { res.writeHead(200, { 'content-type': ph.mime, 'cache-control': 'public, max-age=86400' }); return res.end(ph.data); }
      return send(res, 404, 'Not found', 'text/plain');
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ECONNRESET' || e.message === 'aborted') return res.end();   // the client hung up mid-request
    const missing = ['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG'].includes(e.code);
    // The app's own errors (a plain Error, or one carrying a status) are for the owner to read. Anything else (a type
    // error, SQLite, the file system) would describe the server's insides: logged here, a generic answer to the client.
    const internal = !e.status && !missing && (!!e.code || e.constructor !== Error);
    if (!e.status && !missing) console.error(internal ? e : e.message);
    if (res.headersSent) return res.end();
    if (missing) return send(res, 404, 'Not found', 'text/plain');
    // A refused upload: answer, half-close so the client stops sending, then (a moment later, so the answer has been
    // read: a reset would make the client drop it) cut the connection rather than read the rest.
    if (e.dropBody) res.once('finish', () => { req.socket?.end(); setTimeout(() => { if (!req.complete) req.destroy(); }, 1000).unref(); });
    send(res, e.status || 500, { error: internal ? 'Something went wrong' : e.message });
  }
});
// Anything that still slips through is logged rather than taking the dashboard (and door codes) down.
process.on('unhandledRejection', e => console.error('unhandled rejection:', e));

if (process.env.STR_DEMO && getSetting(db, 'demo') !== '1' && !beds24.connected) loadDemo(db);
// Demo data must never sit alongside real bookings (it skews every metric).
if (beds24.connected) clearDemo(db);
seedEvents(db, localToday(doorSettings(db).tz));
seedAutomations(db);

// No password configured -> only reachable from this machine.
const host = PASSWORD ? '0.0.0.0' : '127.0.0.1';
// Headers within 30 s and the whole request within 60 s: nobody can hold a connection open for minutes.
server.headersTimeout = 30000;
server.requestTimeout = 60000;
server.listen(PORT, host, () => {
  console.log(`STR Dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`);
  if (!PASSWORD) console.log('APP_PASSWORD not set: listening on localhost only. Set it before exposing this to a network.');
  // Sync straight away (bookings, door codes and messages are current right after a deploy, and a restart after an
  // outage doesn't look like a broken Beds24 connection), then every 15 minutes.
  runSync().catch(e => console.error('sync failed:', e.message));
});

setInterval(() => runSync().catch(e => console.error('sync failed:', e.message)), 15 * 60000).unref();
setInterval(() => runAutomationsSafely(), 5 * 60000).unref();
setInterval(() => { if (notifySettings(db).enabled) runNotificationsSafely({ pollMessages: true }); }, 60000).unref();
setInterval(() => runHASafely(), 60000).unref();
// Guests' ID photos are deleted on schedule whether or not Beds24 is connected or syncing.
const pruneIds = () => { try { pruneCheckins(db, localToday(doorSettings(db).tz)); } catch (e) { console.error('ID cleanup failed:', e.message); } };
pruneIds();
setInterval(pruneIds, 3600e3).unref();
// Door codes also run every 10 minutes on their own (a failing Beds24 sync mustn't stall them), when locks are set up.
setInterval(() => { if (getSetting(db, 'seam_api_key')) runDoorCodes(); }, 10 * 60000).unref();
// Event scout: weekly when switched on (checked hourly; a failed run is retried the next day).
setInterval(async () => {
  if (scouting) return;
  scouting = true;
  try { if (await autoScan(db, localToday(doorSettings(db).tz))) runNotificationsSafely(); }
  catch (e) { console.error('event scout failed:', e.message); }
  finally { scouting = false; }
}, 3600e3).unref();
// Tailscale (only with TS_AUTHKEY): a private route to Home Assistant. Its identity lives next to the database.
const tailnet = startTailnet({ dataDir: dirname(DB_PATH) });

// Railway sends SIGTERM on redeploy: stop taking requests, let a door-code or message run that's mid-flight finish
// (up to 4 s, so a code Seam just made or a message just sent is recorded), then close SQLite cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  tailnet?.stop();
  const quit = () => { try { db.close(); } catch {} process.exit(0); };
  const settled = Promise.race([Promise.allSettled([doorChain, automationRun]), sleep(4000)]);
  server.close(() => settled.then(quit));
  setTimeout(quit, 5000).unref();
});
