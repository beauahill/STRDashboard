// Guest messaging through Beds24, which relays to Airbnb, Booking.com and VRBO message threads.
import { getSetting, setSetting } from './db.js';
import { doorCodesFor, doorSettings } from './doors.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
export const MAX_MESSAGE = 5000;

/**
 * Pull messages from Beds24 into the local copy. The first run looks back a year; later runs only the last
 * few days (new messages and read-state changes). Attachments aren't stored; they're fetched when opened.
 */
export async function syncMessages(db, client, { maxAge } = {}) {
  const first = !getSetting(db, 'messages_synced');
  const rows = await client.getAll('/bookings/messages', { maxAge: maxAge ?? (first ? 365 : 3) });
  const put = db.prepare(`INSERT INTO messages(id,booking_id,source,body,time,read,attachment_name,attachment_mime)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET read=excluded.read, body=excluded.body`);
  db.exec('BEGIN');
  try {
    for (const m of rows) {
      if (!m.id || !m.bookingId) continue;
      put.run(m.id, m.bookingId, m.source || 'guest', m.message || '', m.time || new Date().toISOString(),
        m.read ? 1 : 0, m.attachmentName || null, m.attachmentMimeType || null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  setSetting(db, 'messages_synced', new Date().toISOString());
  return { fetched: rows.length };
}

export const unreadCount = db => db.prepare("SELECT COUNT(*) n FROM messages WHERE source = 'guest' AND read = 0").get().n;

/** One row per booking with messages, newest activity first. */
export function conversations(db, { filter = 'all', q = '' } = {}) {
  const rows = db.prepare(`
    SELECT m.booking_id, b.guest_name, b.channel, b.status, b.arrival, b.departure, p.name property_name,
      MAX(m.time) last_time,
      SUM(CASE WHEN m.source = 'guest' AND m.read = 0 THEN 1 ELSE 0 END) unread,
      (SELECT body FROM messages x WHERE x.booking_id = m.booking_id ORDER BY x.time DESC, x.id DESC LIMIT 1) last_body,
      (SELECT source FROM messages x WHERE x.booking_id = m.booking_id ORDER BY x.time DESC, x.id DESC LIMIT 1) last_source
    FROM messages m LEFT JOIN bookings b ON b.id = m.booking_id LEFT JOIN properties p ON p.id = b.property_id
    GROUP BY m.booking_id ORDER BY unread > 0 DESC, last_time DESC`).all();
  const today = new Date().toISOString().slice(0, 10);
  const needle = q.trim().toLowerCase();
  return rows.filter(r =>
    (filter !== 'unread' || r.unread > 0) &&
    (filter !== 'upcoming' || (r.departure && r.departure >= today)) &&
    (filter !== 'inquiries' || r.status === 'inquiry') &&
    (!needle || (r.guest_name || '').toLowerCase().includes(needle) || (r.last_body || '').toLowerCase().includes(needle) || String(r.booking_id) === needle));
}

/** A booking's thread plus what the reply box needs: stay details and template fill-ins. */
export function thread(db, bookingId) {
  const booking = db.prepare(`SELECT b.*, p.name property_name, r.name room_name FROM bookings b
    LEFT JOIN properties p ON p.id = b.property_id LEFT JOIN rooms r ON r.id = b.room_id WHERE b.id = ?`).get(bookingId) || null;
  const messages = db.prepare('SELECT * FROM messages WHERE booking_id = ? ORDER BY time, id').all(bookingId);
  if (!booking && !messages.length) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  const door = doorCodesFor(db, [bookingId])[bookingId] || null;
  const vars = templateVars(db, booking, door);
  return { booking: booking && { ...booking, phone: undefined, email: undefined }, messages, door, vars, canReply: !!booking && booking.id > 0 && booking.source === 'beds24' };
}

const fmtLong = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
export const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
export const BUILTIN_VARS = ['guest_first_name', 'guest_name', 'check_in_date', 'check_out_date', 'check_in_time', 'check_out_time', 'nights', 'guests', 'property_name', 'door_code'];

/** Fill-ins for a booking: stay details, door code, and the owner's property details (Wi-Fi, address...). */
export function templateVars(db, booking, door = undefined) {
  if (door === undefined && booking) door = doorCodesFor(db, [booking.id])[booking.id] || null;
  const ds = doorSettings(db);
  return {
    ...(booking?.property_id ? propertyVars(db, booking.property_id) : {}),
    guest_first_name: (booking?.guest_name || '').split(' ')[0] || 'there',
    guest_name: booking?.guest_name || '',
    check_in_date: fmtLong(booking?.arrival), check_out_date: fmtLong(booking?.departure),
    check_in_time: fmtTime(ds.checkin), check_out_time: fmtTime(ds.checkout),
    nights: booking?.nights ?? '', guests: booking ? (booking.adults || 0) + (booking.children || 0) || '' : '',
    property_name: booking?.property_name || (booking?.property_id ? db.prepare('SELECT name FROM properties WHERE id = ?').get(booking.property_id)?.name : '') || '',
    door_code: door?.code || '',
  };
}

/** Owner-defined fill-ins per property, e.g. {wifi_password}. */
export function propertyVars(db, propertyId) {
  try { return JSON.parse(getSetting(db, `vars_${propertyId}`) || '{}'); } catch { return {}; }
}

export function savePropertyVars(db, propertyId, vars) {
  if (!db.prepare('SELECT 1 FROM properties WHERE id = ?').get(propertyId)) throw userError('Unknown property.');
  const clean = {};
  for (const [k, v] of Object.entries(vars || {})) {
    const key = String(k).trim().toLowerCase();
    if (!key && !String(v || '').trim()) continue;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) throw userError(`"${k}" isn't a valid name: use lowercase letters, numbers and _ (e.g. wifi_password).`);
    if (BUILTIN_VARS.includes(key)) throw userError(`{${key}} is filled in automatically; choose another name.`);
    if (String(v).length > 1000) throw userError(`{${key}} is too long (1000 characters max).`);
    clean[key] = String(v ?? '').trim();
  }
  setSetting(db, `vars_${propertyId}`, JSON.stringify(clean));
  return clean;
}

/** Send a reply through Beds24, then re-read the thread so the stored copy has Beds24's id and time. */
export async function sendMessage(db, client, bookingId, text) {
  const body = (text || '').trim();
  if (!body) throw userError('Write a message first.');
  if (body.length > MAX_MESSAGE) throw userError(`Messages can be at most ${MAX_MESSAGE} characters.`);
  const b = db.prepare('SELECT id, source FROM bookings WHERE id = ?').get(bookingId);
  if (!b || b.id <= 0 || b.source !== 'beds24') throw userError('Replies can only be sent on Beds24 bookings.');
  const res = await client.post('/bookings/messages', [{ bookingId, message: body }]);
  const errors = (Array.isArray(res) ? res : [res]).flatMap(r => (r?.errors || []).map(e => e.message || e.field));
  if (errors.length || (Array.isArray(res) && res.some(r => r?.success === false))) {
    throw new Error('Beds24 didn\'t send the message: ' + (errors.join('; ') || 'unknown error'));
  }
  await refreshThread(db, client, bookingId);
  return thread(db, bookingId);
}

export async function refreshThread(db, client, bookingId) {
  const rows = await client.getAll('/bookings/messages', { bookingId: [bookingId] });
  const put = db.prepare(`INSERT INTO messages(id,booking_id,source,body,time,read,attachment_name,attachment_mime)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET read=excluded.read, body=excluded.body`);
  for (const m of rows) {
    if (m.id) put.run(m.id, m.bookingId || bookingId, m.source || 'guest', m.message || '', m.time || new Date().toISOString(),
      m.read ? 1 : 0, m.attachmentName || null, m.attachmentMimeType || null);
  }
}

/** Mark a booking's guest messages read, in Beds24 and locally. */
export async function markRead(db, client, bookingId) {
  if (!db.prepare("SELECT 1 FROM messages WHERE booking_id = ? AND source = 'guest' AND read = 0").get(bookingId)) return { changed: 0 };
  await client.patch('/bookings/messages', { bookingId: [bookingId] }, { read: true });
  const r = db.prepare("UPDATE messages SET read = 1 WHERE booking_id = ? AND source = 'guest' AND read = 0").run(bookingId);
  return { changed: Number(r.changes) };
}

/** Fetch one message's attachment from Beds24 (they're not stored locally). */
export async function attachment(db, client, messageId) {
  const local = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!local?.attachment_name) throw Object.assign(new Error('No attachment.'), { status: 404 });
  const [m] = await client.getAll('/bookings/messages', { id: [messageId] });
  if (!m?.attachment) throw Object.assign(new Error('Attachment not available.'), { status: 404 });
  return { name: m.attachmentName || local.attachment_name, mime: m.attachmentMimeType || local.attachment_mime || 'application/octet-stream',
    data: Buffer.from(m.attachment, 'base64') };
}

// ---------- Saved replies ----------
const STARTERS = [
  { title: 'Thanks for booking', body: 'Hi {guest_first_name}, thanks for booking {property_name}! We\'re looking forward to hosting you on {check_in_date}. Check-in is from {check_in_time}. Let me know if you have any questions before then.' },
  { title: 'Check-in details', body: 'Hi {guest_first_name}, your stay starts {check_in_date}. Check-in is from {check_in_time}, and your door code is {door_code} (it works on both doors from check-in until {check_out_time} on {check_out_date}). Have a safe trip!' },
  { title: 'Early check-in request', body: 'Hi {guest_first_name}, thanks for asking! We can\'t promise early check-in until the cleaners finish, but I\'ll message you the moment the house is ready. Your code {door_code} starts working at {check_in_time}.' },
  { title: 'Checkout reminder', body: 'Hi {guest_first_name}, just a reminder that checkout is at {check_out_time} tomorrow. Thanks so much for staying with us, safe travels!' },
];

export function savedReplies(db) {
  if (!getSetting(db, 'replies_seeded')) {
    const add = db.prepare('INSERT INTO saved_replies(title, body) VALUES(?, ?)');
    for (const r of STARTERS) add.run(r.title, r.body);
    setSetting(db, 'replies_seeded', '1');
  }
  return db.prepare('SELECT * FROM saved_replies ORDER BY title').all();
}

export function saveReply(db, { id, title, body }) {
  title = (title || '').trim(); body = (body || '').trim();
  if (!title || !body) throw userError('A saved reply needs a name and a message.');
  if (body.length > MAX_MESSAGE) throw userError(`Saved replies can be at most ${MAX_MESSAGE} characters.`);
  if (id) {
    const r = db.prepare('UPDATE saved_replies SET title = ?, body = ? WHERE id = ?').run(title, body, id);
    if (!r.changes) throw userError('That saved reply no longer exists.');
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO saved_replies(title, body) VALUES(?, ?)').run(title, body).lastInsertRowid);
}

export const deleteReply = (db, id) => db.prepare('DELETE FROM saved_replies WHERE id = ?').run(id);

/** Replace {variables}; unknown ones are left visible so they get noticed before sending. */
export const fillTemplate = (body, vars) => body.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] !== '' ? String(vars[k]) : m));
