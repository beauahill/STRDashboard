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
import { syncCalendar, readDays, planChanges, applyChanges, recentChanges } from './rates.js';
import { SeamClient } from './seam.js';
import { feedToken, icsForRoom, turnovers } from './cleaning.js';
import { FIELDS as LISTING_FIELDS, fetchListing, diffListing, saveListing, listingLog } from './listing.js';
import { analytics } from './analytics.js';
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
  lockOverview, changeOtherCode, deleteOtherCode, addCode, localToday,
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

const db = openDb(process.env.DB_PATH || (VOLUME ? join(VOLUME, 'str.db') : 'data/str.db'));
const beds24 = new Beds24Client(db);
const seam = () => new SeamClient(getSetting(db, 'seam_api_key'));

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
  try {
    const r = await syncBeds24(db, beds24);
    dedupeImported(db);
    if (beds24.scopes === null) await beds24.refreshScopes().catch(() => {});
    // Prices are a separate permission in Beds24; a read-only or bookings-only code shouldn't fail the whole sync.
    try { await syncCalendar(db, beds24); setSetting(db, 'calendar_error', null); }
    catch (e) { setSetting(db, 'calendar_error', e.message); }
    await runDoorCodes();
    try { await autoPrice(db, beds24, localToday(doorSettings(db).tz)); setSetting(db, 'pricing_error', null); }
    catch (e) { setSetting(db, 'pricing_error', e.message); }
    try { await syncMessages(db, beds24); setSetting(db, 'messages_error', null); }
    catch (e) { setSetting(db, 'messages_error', e.message); }
    await runAutomationsSafely();
    return r;
  }
  catch (e) { setSetting(db, 'last_sync_error', e.message); throw e; }
  finally { syncing = false; }
}

// Automated messages: checked every 5 minutes (and after each sync). Never throws.
let automationsRunning = false;
async function runAutomationsSafely() {
  if (automationsRunning || !beds24.connected) return null;
  automationsRunning = true;
  try { const r = await runAutomations(db, beds24); setSetting(db, 'automations_error', null); return r; }
  catch (e) { setSetting(db, 'automations_error', e.message); return { error: e.message }; }
  finally { automationsRunning = false; }
}

// Door codes run after every sync and after lock changes. Failures are recorded, never thrown, so a
// Seam outage can't stop bookings from syncing.
async function runDoorCodes() {
  try { const r = await reconcileDoorCodes(db, seam(), beds24); setSetting(db, 'door_error', null); return r; }
  catch (e) { setSetting(db, 'door_error', e.message); return { error: e.message }; }
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
        connected: beds24.connected, scopes: beds24.scopes, auth: !!PASSWORD, demo: getSetting(db, 'demo') === '1', syncing,
        lastSync: getSetting(db, 'last_sync'), lastSyncError: getSetting(db, 'last_sync_error'),
        empty: db.prepare('SELECT COUNT(*) n FROM bookings').get().n === 0,
        guestyImported: db.prepare("SELECT COUNT(*) n FROM bookings WHERE source = 'guesty'").get().n,
        unreadMessages: unreadCount(db), ai: aiStatus(db).configured,
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
    case 'GET /api/rates': {
      const rooms = db.prepare(`SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id
        WHERE r.id > 0 ${prop ? 'AND r.property_id = ?' : ''} ORDER BY p.name, r.name`).all(...(prop ? [prop] : []));
      const room = rooms.find(r => r.id === Number(q.room)) || rooms[0] || null;
      return send(res, 200, {
        rooms, room, connected: beds24.connected, canWrite: beds24.canWriteInventory,
        calendarError: getSetting(db, 'calendar_error'), lastSync: getSetting(db, 'last_sync'),
        days: room ? readDays(db, room.id, q.start || iso(Date.now()), Math.min(Number(q.days) || 62, 120)) : [],
        changes: recentChanges(db),
      });
    }
    case 'POST /api/rates/preview': return send(res, 200, planChanges(db, await readJson(req)));
    case 'GET /api/pricing': {
      const rooms = db.prepare(`SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id
        WHERE r.id > 0 ${prop ? 'AND r.property_id = ?' : ''} ORDER BY p.name, r.name`).all(...(prop ? [prop] : []));
      const room = rooms.find(r => r.id === Number(q.room)) || rooms[0] || null;
      if (!room) return send(res, 200, { rooms, room: null });
      const today = localToday(doorSettings(db).tz);
      const rec = recommend(db, room.id, { start: q.start, days: Math.min(Number(q.days) || 62, 400), today });
      const ahead = days => {
        const r = recommend(db, room.id, { days, today });
        const p = pendingChanges(r, { includeMinStay: q.minStay !== '0' });
        const set = p.filter(c => c.before != null);
        return { nights: p.length, priceChanges: p.filter(c => c.price !== c.before).length,
          avgNow: set.length ? Math.round(set.reduce((a, c) => a + c.before, 0) / set.length) : null,
          avgNew: p.length ? Math.round(p.reduce((a, c) => a + c.price, 0) / p.length) : null };
      };
      return send(res, 200, {
        rooms, room, today, settings: rec.settings, needsBase: !!rec.needsBase, nights: rec.nights, pace: rec.pace || {},
        events: listEvents(db), pending: rec.needsBase ? null : { d30: ahead(30), d90: ahead(90), d365: ahead(365) },
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
        AND status IN ('confirmed','new') AND departure >= ? ORDER BY arrival LIMIT 30`).all(iso(Date.now()));
      return send(res, 200, {
        automations: listAutomations(db).map(a => ({ ...a, when: describe(a) })), upcoming: upcoming(db), history: history(db),
        properties: props.map(p => ({ ...p, vars: propertyVars(db, p.id) })), builtins: BUILTIN_VARS, bookings: soon,
        connected: beds24.connected, error: getSetting(db, 'automations_error'), tz: doorSettings(db).tz,
      });
    }
    case 'POST /api/automations': return send(res, 200, { id: saveAutomation(db, await readJson(req)) });
    case 'POST /api/automations/enable': { const { id, enabled } = await readJson(req); setEnabled(db, Number(id), !!enabled); return send(res, 200, { ok: true }); }
    case 'POST /api/automations/delete': { const { id } = await readJson(req); deleteAutomation(db, Number(id)); return send(res, 200, { ok: true }); }
    case 'POST /api/automations/skip': { const { automationId, bookingId } = await readJson(req); skipSend(db, Number(automationId), Number(bookingId)); return send(res, 200, { ok: true }); }
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
      const a = await attachment(db, beds24, Number(q.id));
      res.writeHead(200, { 'content-type': a.mime, 'content-disposition': `inline; filename="${a.name.replace(/[^\w.\- ]/g, '_')}"`, 'cache-control': 'private, max-age=3600' });
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
      setSetting(db, 'seam_api_key', apiKey ? apiKey.trim() : null);
      if (!apiKey) { db.exec('DELETE FROM locks'); return send(res, 200, { removed: true }); }
      return send(res, 200, { locks: await refreshLocks(db, seam()) });
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
      await changeOtherCode(seam(), checkEntries(entries), { code: String(code || '').trim(), name: name?.trim() });
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
      const sum = summary(db, iso(Date.now()), prop);
      // Automated messages that failed recently, or are stuck waiting past their send time, need a look.
      sum.automationIssues = db.prepare(`SELECT s.status, s.error, a.name automation, b.guest_name FROM automation_sends s
        JOIN automations a ON a.id = s.automation_id LEFT JOIN bookings b ON b.id = s.booking_id
        WHERE (s.status = 'failed' AND s.updated_at >= ?) OR (s.status = 'waiting' AND s.scheduled_at <= ?)
        ORDER BY s.updated_at DESC LIMIT 5`).all(new Date(Date.now() - 7 * 86400e3).toISOString(), new Date(Date.now() - 3600e3).toISOString());
      const ds = doorSettings(db);
      if (ds.auto) {
        const soon = [...sum.arrivals, ...sum.inHouse, ...sum.upcoming];
        sum.doors = doorCodesFor(db, soon.map(b => b.id));
        // A guest arriving soon (within 3 days, and inside the code window) at a property with locks, without
        // a working code on every lock, needs attention now.
        const limit = iso(Date.parse(localToday(ds.tz)) + Math.min(3, ds.lookahead) * 86400000);
        const lockRooms = new Set(db.prepare('SELECT DISTINCT room_id FROM locks WHERE room_id IS NOT NULL').all().map(r => r.room_id));
        sum.doorAlerts = [...sum.arrivals, ...sum.upcoming].filter(b => b.source === 'beds24' && lockRooms.has(b.room_id) && b.arrival <= limit && !sum.doors[b.id]?.ok)
          .map(b => ({ id: b.id, guest: b.guest_name, arrival: b.arrival, problem: sum.doors[b.id]?.perLock.find(l => !['set', 'scheduled'].includes(l.state))?.label || 'No door code yet' }));
      }
      return send(res, 200, sum);
    }
    case 'GET /api/calendar': {
      const cal = calendar(db, q.start || iso(Date.now()), Math.min(Number(q.days) || 42, 120), prop);
      if (doorSettings(db).auto) cal.doors = doorCodesFor(db, cal.bookings.map(b => b.id));
      return send(res, 200, cal);
    }
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
    // Cleaning calendar for Turno: no login (Turno can't sign in), protected by the secret in the URL.
    const feed = url.pathname.match(/^\/cal\/([\w-]{20,})\/(\d+)\.ics$/);
    if (feed) {
      const ics = safeEqual(feed[1], feedToken(db)) ? icsForRoom(db, Number(feed[2])) : null;
      if (!ics) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(ics);
    }
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
seedEvents(db, localToday(doorSettings(db).tz));
seedAutomations(db);

// No password configured -> only reachable from this machine.
const host = PASSWORD ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, host, () => {
  console.log(`STR Dashboard on http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`);
  if (!PASSWORD) console.log('APP_PASSWORD not set: listening on localhost only. Set it before exposing this to a network.');
});

setInterval(() => runSync().catch(e => console.error('sync failed:', e.message)), 15 * 60000).unref();
setInterval(() => runAutomationsSafely(), 5 * 60000).unref();

// Railway sends SIGTERM on redeploy; close cleanly so SQLite isn't mid-write.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
});
