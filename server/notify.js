// Phone notifications through ntfy (https://ntfy.sh): new guest messages, new bookings and requests,
// cancellations, and problems that need a look. Each event is sent once, and nothing from before
// notifications were switched on (or older than a day) is ever sent.
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { doorAlerts } from './doors.js';
import { upsertBookings } from './sync.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
export const NOTIFY_DEFAULTS = {
  enabled: false, server: 'https://ntfy.sh', topic: '', token: '', preview: true,
  messages: true, bookings: true, cancellations: true, problems: true, enabledAt: null,
};
const MAX_AGE = 24 * 3600e3;   // never send about anything older than this (e.g. after the app was down)
const MAX_ATTEMPTS = 5;        // a notification that fails this often is given up on
const PER_RUN = 10;            // the rest wait for the next minute
const EVENTS = ['messages', 'bookings', 'cancellations', 'problems'];

// The topic is the only thing protecting a ntfy.sh topic, so it's long and random.
export const newTopic = () => 'str-' + randomBytes(15).toString('base64url');

export function notifySettings(db) {
  let s;
  try { s = { ...NOTIFY_DEFAULTS, ...JSON.parse(getSetting(db, 'notify') || '{}') }; } catch { s = { ...NOTIFY_DEFAULTS }; }
  if (!s.topic) { s.topic = newTopic(); setSetting(db, 'notify', JSON.stringify(s)); }
  return s;
}

/** What the browser may see: everything but the access token. */
export const publicNotify = s => ({ ...s, token: undefined, tokenSet: !!s.token });

export function saveNotifySettings(db, input = {}, now = Date.now()) {
  const s = notifySettings(db);
  if (input.server !== undefined) {
    const v = String(input.server || '').trim().replace(/\/+$/, '') || NOTIFY_DEFAULTS.server;
    if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(v)) throw userError('The ntfy server must be a web address like https://ntfy.sh.');
    s.server = v;
  }
  if (input.topic !== undefined) {
    const v = String(input.topic || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw userError('Topic names can only use letters, numbers, - and _ (64 at most).');
    if (s.server === NOTIFY_DEFAULTS.server && v.length < 12) throw userError('On ntfy.sh anyone who guesses the topic can read it; use at least 12 characters.');
    s.topic = v;
  }
  if (input.token !== undefined) {
    const v = String(input.token || '').trim();
    if (v.length > 200 || /\s/.test(v)) throw userError('That access token doesn\'t look right.');
    s.token = v;
  }
  for (const k of ['preview', ...EVENTS]) if (input[k] !== undefined) s[k] = !!input[k];
  if (input.enabled !== undefined) {
    if (input.enabled && !s.enabled) s.enabledAt = new Date(now).toISOString();
    s.enabled = !!input.enabled;
  }
  setSetting(db, 'notify', JSON.stringify(s));
  return s;
}

export function regenerateTopic(db) {
  const s = notifySettings(db);
  s.topic = newTopic();
  setSetting(db, 'notify', JSON.stringify(s));
  return s;
}

/** The app's public address, for "tap to open" links. Railway provides it; otherwise the last address used. */
export const appOrigin = db => process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : getSetting(db, 'app_origin');

/** Send one notification (ntfy's JSON publishing: POST to the server root). */
export async function publish(s, n, fetchImpl = fetch) {
  const res = await fetchImpl(s.server, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.token && { authorization: `Bearer ${s.token}` }) },
    body: JSON.stringify({ topic: s.topic, title: n.title, message: n.message, tags: n.tags, priority: n.priority, ...(n.click && { click: n.click }) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ntfy answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}

const short = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stay = b => b.arrival ? `${short(b.arrival)} – ${short(b.departure)}` : '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const at = v => (v ? Date.parse(v) : NaN);

/** Everything that should be sent now, oldest first. Each item lists the events (kind, ref) it covers. */
export function collect(db, now = Date.now()) {
  const s = notifySettings(db);
  if (!s.enabled || !s.topic || getSetting(db, 'demo') === '1') return [];
  const since = Math.max(at(s.enabledAt) || now, now - MAX_AGE);
  const origin = appOrigin(db);
  const link = path => (origin ? origin + path : undefined);
  const logged = db.prepare('SELECT ok, attempts FROM notification_log WHERE kind = ? AND ref = ?');
  const pending = (kind, ref) => { const r = logged.get(kind, String(ref)); return !r || (!r.ok && r.attempts < MAX_ATTEMPTS); };
  const out = [];

  if (s.messages) {
    const rows = db.prepare(`SELECT m.id, m.booking_id, m.body, m.attachment_name, m.time, b.guest_name, b.channel, b.status, b.arrival, b.departure
      FROM messages m LEFT JOIN bookings b ON b.id = m.booking_id WHERE m.source = 'guest' AND m.read = 0 ORDER BY m.time, m.id`).all()
      .filter(m => at(m.time) >= since && pending('message', m.id));
    const byBooking = new Map();
    for (const m of rows) byBooking.set(m.booking_id, [...(byBooking.get(m.booking_id) || []), m]);
    for (const [bookingId, list] of byBooking) {
      const last = list.at(-1), n = list.length;
      const text = (last.body || (last.attachment_name ? `(sent a file: ${last.attachment_name})` : '')).replace(/\s+/g, ' ').trim();
      out.push({
        title: `${last.status === 'inquiry' ? 'Inquiry' : 'Message'} from ${last.guest_name || 'a guest'}${last.channel ? ` (${last.channel})` : ''}`,
        message: [s.preview ? `${n > 1 ? `${n} new messages. Latest: ` : ''}${text.length > 300 ? text.slice(0, 300) + '…' : text}`
          : `${n > 1 ? `${n} new messages` : 'New message'}. Open the Inbox to read ${n > 1 ? 'them' : 'it'}.`, stay(last)].filter(Boolean).join('\n'),
        tags: ['speech_balloon'], priority: 4, click: link(`/#/inbox/${bookingId}`), refs: list.map(m => ['message', m.id]), time: at(last.time),
      });
    }
  }

  const booking = b => [b.channel, stay(b) && `${stay(b)} (${plural(b.nights, 'night')})`, (b.adults || 0) + (b.children || 0) ? plural((b.adults || 0) + (b.children || 0), 'guest') : '',
    b.price ? `$${Math.round(b.price).toLocaleString('en-US')}` : ''].filter(Boolean).join(' · ');
  if (s.bookings) {
    // Only bookings made since notifications were switched on: the first full sync never floods the phone.
    for (const b of db.prepare(`SELECT * FROM bookings WHERE source = 'beds24' AND id > 0 AND status IN ('confirmed','new','request') AND booked_at IS NOT NULL`).all()) {
      if (!(at(b.booked_at) >= since) || !pending('booking', b.id)) continue;
      const request = b.status === 'request';
      out.push({
        title: request ? `Booking request from ${b.guest_name || 'a guest'}: respond within 24 hours` : `New booking: ${b.guest_name || 'guest'}`,
        message: booking(b), tags: [request ? 'bell' : 'house'], priority: request ? 4 : 3, click: link('/#/bookings'), refs: [['booking', b.id]], time: at(b.booked_at),
      });
    }
  }
  if (s.cancellations) {
    for (const b of db.prepare(`SELECT * FROM bookings WHERE source = 'beds24' AND id > 0 AND status = 'cancelled' AND cancelled_at IS NOT NULL`).all()) {
      if (!(at(b.cancelled_at) >= since) || !pending('cancelled', b.id)) continue;
      out.push({ title: `Cancelled: ${b.guest_name || 'guest'}`, message: booking(b), tags: ['x'], priority: 3, click: link('/#/bookings'), refs: [['cancelled', b.id]], time: at(b.cancelled_at) });
    }
  }
  if (s.problems) {
    for (const f of db.prepare(`SELECT s.automation_id, s.booking_id, s.key, s.error, s.updated_at, a.name, b.guest_name FROM automation_sends s
        JOIN automations a ON a.id = s.automation_id LEFT JOIN bookings b ON b.id = s.booking_id WHERE s.status = 'failed'`).all()) {
      const ref = `${f.automation_id}:${f.booking_id}:${f.key}`;
      if (!(at(f.updated_at) >= since) || !pending('automation', ref)) continue;
      out.push({ title: 'Automated message failed', message: `${f.name} to ${f.guest_name || 'a guest'}: ${f.error || 'not sent'}`, tags: ['warning'], priority: 4,
        click: link('/#/automations'), refs: [['automation', ref]], time: at(f.updated_at) });
    }
    // A code still being programmed right after a booking isn't a problem yet; give it 30 minutes.
    for (const d of doorAlerts(db, { days: 2, now })) {
      const ref = `${d.id}:${d.arrival}`;
      if ((d.firstSeen && at(d.firstSeen) > now - 30 * 60e3) || !pending('door', ref)) continue;
      out.push({ title: `Door code problem: ${d.guest || 'guest'} arrives ${short(d.arrival)}`, message: d.problem, tags: ['key', 'warning'], priority: 4,
        click: link('/#/locks'), refs: [['door', ref]], time: now });
    }
    // If Beds24 stops syncing, messages stop arriving too, so say so (once a day).
    const lastSync = at(getSetting(db, 'last_sync'));
    const day = new Date(now).toISOString().slice(0, 10);
    if (getSetting(db, 'beds24_refresh_token') && lastSync && lastSync < now - 3600e3 && pending('sync', day)) {
      out.push({ title: 'Beds24 hasn\'t synced for over an hour', message: `New messages and bookings may be missing. ${getSetting(db, 'last_sync_error') || 'Open Settings to check the connection.'}`,
        tags: ['warning'], priority: 4, click: link('/#/settings'), refs: [['sync', day]], time: now });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function mark(db, n, ok, error, now) {
  const stmt = db.prepare(`INSERT INTO notification_log(kind, ref, at, title, ok, error, attempts) VALUES(?,?,?,?,?,?,1)
    ON CONFLICT(kind, ref) DO UPDATE SET at = excluded.at, title = excluded.title, ok = excluded.ok, error = excluded.error, attempts = attempts + 1`);
  for (const [kind, ref] of n.refs) stmt.run(kind, String(ref), new Date(now).toISOString(), n.title, ok ? 1 : 0, error);
}

/** Send everything pending. Failures are retried on later runs (up to MAX_ATTEMPTS), never thrown. */
export async function runNotifications(db, { now = Date.now(), fetchImpl = fetch } = {}) {
  const s = notifySettings(db);
  const items = collect(db, now).slice(0, PER_RUN);
  let sent = 0, failed = 0;
  for (const n of items) {
    try { await publish(s, n, fetchImpl); mark(db, n, true, null, now); sent++; }
    catch (e) { mark(db, n, false, e.message, now); failed++; setSetting(db, 'notify_error', e.message); }
  }
  if (sent && !failed) setSetting(db, 'notify_error', null);
  return { sent, failed };
}

export async function sendTest(db, fetchImpl = fetch) {
  const s = notifySettings(db);
  const origin = appOrigin(db);
  await publish(s, { title: 'STR Dashboard test', message: 'Notifications are working. New guest messages will arrive like this.', tags: ['white_check_mark'], priority: 3,
    click: origin ? `${origin}/#/settings` : undefined }, fetchImpl);
  setSetting(db, 'notify_error', null);
}

export const recentNotifications = db => db.prepare('SELECT kind, ref, at, title, ok, error, attempts FROM notification_log ORDER BY at DESC LIMIT 10').all();

/** Guest messages can arrive before the 15-minute booking sync has seen a new inquiry; fetch those bookings so alerts have a name. */
export async function fillMissingBookings(db, client) {
  const ids = db.prepare(`SELECT DISTINCT m.booking_id id FROM messages m LEFT JOIN bookings b ON b.id = m.booking_id
    WHERE b.id IS NULL AND m.source = 'guest' AND m.read = 0 LIMIT 20`).all().map(r => r.id);
  if (!ids.length) return 0;
  const rows = await client.getAll('/bookings', { id: ids, status: ['confirmed', 'new', 'request', 'cancelled', 'black', 'inquiry'] });
  upsertBookings(db, rows);
  return rows.length;
}
