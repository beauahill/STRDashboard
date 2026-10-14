// Automated guest messages. Each automation is "send this template at <anchor> + <offset>", where the anchor
// is the booking being made or cancelled, its dates changing, check-in or checkout. Rules that keep it safe:
//  - Turning an automation on never sends a backlog: only messages due from that moment on (plus last-minute
//    bookings first seen after that moment) are sent.
//  - Every message has a deadline; anything not sent by then (app down, missing fill-in) is marked failed.
//  - A message whose template still has an unfilled {placeholder} waits instead of sending.
//  - Each automation sends to each booking once (per date change for "dates changed").
import { addDays } from './sync.js';
import { doorSettings, zonedTimeToUtc } from './doors.js';
import { templateVars, fillTemplate, sendMessage } from './messages.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
const HOUR = 3600e3;
export const ANCHORS = ['booked', 'cancelled', 'dates_changed', 'arrival', 'departure'];
const CHANNELS = ['Airbnb', 'Booking.com', 'VRBO', 'Direct', 'Other'];

const STARTERS = [
  { name: 'Booking confirmation', anchor: 'booked', delay_minutes: 5,
    body: 'Hi {guest_first_name}, thank you for booking {property_name}! We\'re excited to host you from {check_in_date} to {check_out_date}. Check-in is from {check_in_time}; I\'ll send door code and arrival details a couple of days before. Let me know if you have any questions!' },
  { name: 'Check-in instructions', anchor: 'arrival', offset_days: -2, at_time: '10:00',
    body: 'Hi {guest_first_name}, your stay at {property_name} starts {check_in_date}!\n\nCheck-in: from {check_in_time}\nDoor code: {door_code} (works on both doors from check-in until {check_out_time} on {check_out_date})\n\nLet me know if you need anything before you arrive. Safe travels!' },
  { name: 'Check-in day', anchor: 'arrival', offset_days: 0, at_time: '09:00',
    body: 'Good morning {guest_first_name}! The house is ready for you from {check_in_time} today. Your door code is {door_code}. Enjoy Laramie!' },
  { name: 'Mid-stay check-in', anchor: 'arrival', offset_days: 1, at_time: '10:00', min_nights: 3,
    body: 'Hi {guest_first_name}, just checking in: is everything good at the house? Let me know if there\'s anything you need.' },
  { name: 'Checkout reminder', anchor: 'departure', offset_days: -1, at_time: '18:00',
    body: 'Hi {guest_first_name}, a quick reminder that checkout is tomorrow at {check_out_time}. Thanks so much for staying with us!' },
  { name: 'Review request', anchor: 'departure', offset_days: 1, at_time: '11:00',
    body: 'Hi {guest_first_name}, thanks again for staying at {property_name}! If you enjoyed it, a review would mean a lot to us. We\'d love to host you again.' },
  { name: 'Cancellation', anchor: 'cancelled', delay_minutes: 5,
    body: 'Hi {guest_first_name}, we\'re sorry your plans changed and your stay has been cancelled. We hope to host you another time!' },
  { name: 'Dates changed', anchor: 'dates_changed', delay_minutes: 5,
    body: 'Hi {guest_first_name}, your stay is now {check_in_date} to {check_out_date}. Check-in is from {check_in_time}. Your door code is {door_code}.' },
];

export function seedAutomations(db) {
  if (db.prepare('SELECT COUNT(*) n FROM automations').get().n) return;
  const add = db.prepare(`INSERT INTO automations(name,anchor,offset_days,at_time,delay_minutes,min_nights,body,sort,enabled) VALUES(?,?,?,?,?,?,?,?,0)`);
  STARTERS.forEach((a, i) => add.run(a.name, a.anchor, a.offset_days ?? 0, a.at_time ?? null, a.delay_minutes ?? 0, a.min_nights ?? null, a.body, i));
}

const parse = a => ({ ...a, channels: a.channels ? JSON.parse(a.channels) : null, enabled: !!a.enabled });
export const listAutomations = db => db.prepare('SELECT * FROM automations ORDER BY sort, id').all().map(parse);

export function saveAutomation(db, a) {
  const name = (a.name || '').trim(), body = (a.body || '').trim();
  if (!name || !body) throw userError('An automation needs a name and a message.');
  if (body.length > 5000) throw userError('Messages can be at most 5000 characters.');
  if (!ANCHORS.includes(a.anchor)) throw userError('Choose when the message is sent.');
  const timed = ['arrival', 'departure'].includes(a.anchor);
  const offset = timed ? Number(a.offset_days ?? 0) : 0;
  if (timed && !(Number.isInteger(offset) && offset >= -30 && offset <= 30)) throw userError('Days before/after must be between -30 and 30.');
  const at = timed ? a.at_time : null;
  if (timed && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at || '')) throw userError('Choose a send time like 10:00.');
  const delay = timed ? 0 : Number(a.delay_minutes ?? 0);
  if (!timed && !(Number.isInteger(delay) && delay >= 0 && delay <= 1440)) throw userError('Delay must be 0 to 1440 minutes.');
  const minNights = a.min_nights === '' || a.min_nights == null ? null : Number(a.min_nights);
  if (minNights != null && !(Number.isInteger(minNights) && minNights >= 1 && minNights <= 60)) throw userError('Minimum nights must be 1 to 60.');
  const channels = Array.isArray(a.channels) && a.channels.length && a.channels.length < CHANNELS.length ? a.channels.filter(c => CHANNELS.includes(c)) : null;
  const vals = [name, a.anchor, offset, at, delay, channels ? JSON.stringify(channels) : null, minNights, body];
  if (a.id) {
    const r = db.prepare('UPDATE automations SET name=?, anchor=?, offset_days=?, at_time=?, delay_minutes=?, channels=?, min_nights=?, body=? WHERE id=?').run(...vals, a.id);
    if (!r.changes) throw userError('That automation no longer exists.');
    return Number(a.id);
  }
  return Number(db.prepare('INSERT INTO automations(name,anchor,offset_days,at_time,delay_minutes,channels,min_nights,body,sort) VALUES(?,?,?,?,?,?,?,?,999)').run(...vals).lastInsertRowid);
}

/** Switching on stamps the time, so nothing due before this moment is sent. */
export function setEnabled(db, id, enabled, now = new Date()) {
  const r = db.prepare('UPDATE automations SET enabled = ?, enabled_at = CASE WHEN ? THEN ? ELSE enabled_at END WHERE id = ?')
    .run(enabled ? 1 : 0, enabled ? 1 : 0, now.toISOString(), id);
  if (!r.changes) throw userError('That automation no longer exists.');
}
export const deleteAutomation = (db, id) => { db.prepare('DELETE FROM automations WHERE id = ?').run(id); db.prepare('DELETE FROM automation_sends WHERE automation_id = ?').run(id); };

/** Human description of when an automation sends. */
export function describe(a) {
  const time = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const after = m => (m ? `${m} min after` : 'right after');
  if (a.anchor === 'booked') return `${after(a.delay_minutes)} a booking is made`;
  if (a.anchor === 'cancelled') return `${after(a.delay_minutes)} a booking is cancelled`;
  if (a.anchor === 'dates_changed') return `${after(a.delay_minutes)} a booking's dates change`;
  const what = a.anchor === 'arrival' ? 'check-in' : 'checkout';
  const n = Math.abs(a.offset_days);
  const when = a.offset_days === 0 ? `on ${what} day` : `${n} day${n === 1 ? '' : 's'} ${a.offset_days < 0 ? 'before' : 'after'} ${what}`;
  return `${when} at ${time(a.at_time)}`;
}

/** When this automation is due for this booking, and the last moment it's still worth sending. */
export function schedule(a, b, ds, eventAt = null) {
  const at = iso => new Date(iso);
  if (a.anchor === 'booked' || a.anchor === 'cancelled' || a.anchor === 'dates_changed') {
    const base = a.anchor === 'booked' ? (b.booked_at || b.first_seen) : a.anchor === 'cancelled' ? (b.cancelled_at || b.modified_at) : eventAt;
    if (!base) return null;
    const when = new Date(Date.parse(base) + (a.delay_minutes || 0) * 60e3);
    return { when, expires: new Date(when.getTime() + 48 * HOUR) };
  }
  const date = addDays(a.anchor === 'arrival' ? b.arrival : b.departure, a.offset_days);
  const when = at(zonedTimeToUtc(date, a.at_time, ds.tz));
  const checkIn = at(zonedTimeToUtc(b.arrival, ds.checkin, ds.tz)), checkOut = at(zonedTimeToUtc(b.departure, ds.checkout, ds.tz));
  let expires;
  if (a.anchor === 'arrival') expires = when <= checkIn ? new Date(checkIn.getTime() + 12 * HOUR) : checkOut;
  else expires = when <= checkOut ? new Date(checkOut.getTime() + HOUR) : new Date(when.getTime() + 72 * HOUR);
  return { when, expires };
}

const eligible = (a, b) => b.source === 'beds24' && b.id > 0 &&
  (a.anchor === 'cancelled' ? b.status === 'cancelled' : ['confirmed', 'new'].includes(b.status)) &&
  (!a.channels || a.channels.includes(b.channel)) && (!a.min_nights || b.nights >= a.min_nights);

/** Record date changes since the last run (the first sighting of a booking just takes a snapshot). */
function detectDateChanges(db, now) {
  const changes = [];
  const snap = db.prepare('SELECT * FROM booking_snapshots WHERE booking_id = ?');
  const put = db.prepare('INSERT OR REPLACE INTO booking_snapshots(booking_id, arrival, departure) VALUES(?,?,?)');
  for (const b of db.prepare("SELECT id, arrival, departure FROM bookings WHERE source = 'beds24' AND status IN ('confirmed','new')").all()) {
    const s = snap.get(b.id);
    if (s && (s.arrival !== b.arrival || s.departure !== b.departure)) changes.push({ bookingId: b.id, key: `${b.arrival}|${b.departure}`, at: now.toISOString() });
    if (!s || s.arrival !== b.arrival || s.departure !== b.departure) put.run(b.id, b.arrival, b.departure);
  }
  return changes;
}

/**
 * Send everything that's due. Safe to call often (every few minutes): each message is sent at most once.
 * `send` is injectable for tests; it defaults to sending through Beds24.
 */
export async function runAutomations(db, client, now = new Date(), send = (bookingId, text) => sendMessage(db, client, bookingId, text)) {
  const result = { sent: 0, waiting: 0, failed: 0 };
  const autos = listAutomations(db).filter(a => a.enabled);
  const changes = detectDateChanges(db, now);
  if (!autos.length) return result;
  const ds = doorSettings(db);
  const getSend = db.prepare('SELECT * FROM automation_sends WHERE automation_id = ? AND booking_id = ? AND key = ?');
  const putSend = db.prepare(`INSERT INTO automation_sends(automation_id,booking_id,key,status,scheduled_at,sent_at,error,body,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(automation_id,booking_id,key) DO UPDATE SET status=excluded.status, scheduled_at=excluded.scheduled_at, sent_at=excluded.sent_at,
    error=excluded.error, body=excluded.body, updated_at=excluded.updated_at`);
  // Stays near today (arrival/departure messages: offsets up to 30 days, plus up to 72 hours to send), and any stay
  // booked, cancelled or changed in the last few days whatever its dates (those messages are due right after the
  // event: within a day's delay, and stale 48 hours later). A confirmation for a stay months away must still go out.
  const today = now.toISOString().slice(0, 10);
  const horizon = addDays(today, 32), past = addDays(today, -35), recent = addDays(today, -4);
  const bookings = db.prepare(`SELECT b.*, p.name property_name FROM bookings b LEFT JOIN properties p ON p.id = b.property_id
    WHERE b.source = 'beds24' AND b.id > 0 AND ((b.departure >= ? AND b.arrival <= ?)
      OR substr(COALESCE(b.booked_at, b.first_seen, ''), 1, 10) >= ? OR substr(COALESCE(b.cancelled_at, b.modified_at, ''), 1, 10) >= ?)`)
    .all(past, horizon, recent, recent);
  const byId = new Map(bookings.map(b => [b.id, b]));
  const oneBooking = db.prepare('SELECT b.*, p.name property_name FROM bookings b LEFT JOIN properties p ON p.id = b.property_id WHERE b.id = ?');

  for (const a of autos) {
    const enabledAt = new Date(a.enabled_at || 0);
    let jobs;
    if (a.anchor === 'dates_changed') {
      // A date change is only noticed once, so it's recorded straight away as a pending message; later runs
      // send it when its delay is up (or once a missing fill-in arrives). If the dates change again before
      // it goes out, the old message is dropped in favour of the new one.
      for (const c of changes) {
        if (!getSend.get(a.id, c.bookingId, c.key) && Date.parse(c.at) >= enabledAt.getTime()) {
          const due = new Date(Date.parse(c.at) + (a.delay_minutes || 0) * 60e3).toISOString();
          putSend.run(a.id, c.bookingId, c.key, 'pending', due, null, null, null, now.toISOString());
        }
      }
      jobs = [];
      for (const w of db.prepare("SELECT * FROM automation_sends WHERE automation_id = ? AND status IN ('pending','waiting')").all(a.id)) {
        const b = byId.get(w.booking_id) || oneBooking.get(w.booking_id);
        if (!b) continue;
        if (w.key !== `${b.arrival}|${b.departure}`) { putSend.run(a.id, b.id, w.key, 'skipped', w.scheduled_at, null, 'Dates changed again', null, now.toISOString()); continue; }
        jobs.push({ b, key: w.key, eventAt: new Date(Date.parse(w.scheduled_at) - (a.delay_minutes || 0) * 60e3).toISOString() });
      }
    } else jobs = bookings.map(b => ({ b, key: '' }));
    for (const { b, key, eventAt } of jobs) {
      if (!eligible(a, b)) continue;
      const prev = getSend.get(a.id, b.id, key);
      if (prev && ['sent', 'failed', 'skipped'].includes(prev.status)) continue;
      const sch = schedule(a, b, ds, eventAt);
      if (!sch || now < sch.when) continue;
      // No backlog: due before the automation was switched on doesn't count, unless the booking itself only
      // appeared after both (a last-minute booking whose check-in message time had already passed).
      const firstSeen = b.first_seen ? new Date(b.first_seen) : null;
      const fresh = firstSeen && firstSeen > sch.when && firstSeen >= enabledAt;
      if (sch.when < enabledAt && !fresh) continue;
      const stamp = now.toISOString(), when = sch.when.toISOString();
      if (now > sch.expires) {
        if (prev) { putSend.run(a.id, b.id, key, 'failed', when, null, `Not sent before its deadline${prev.error ? ': ' + prev.error : ''}`, prev.body, stamp); result.failed++; }
        continue;
      }
      const text = fillTemplate(a.body, templateVars(db, b));
      const missing = [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
      if (missing.length) {
        putSend.run(a.id, b.id, key, 'waiting', when, null, `Waiting for: ${missing.map(m => `{${m}}`).join(', ')}`, null, stamp);
        result.waiting++;
        continue;
      }
      try {
        await send(b.id, text);
        putSend.run(a.id, b.id, key, 'sent', when, stamp, null, text, stamp);
        result.sent++;
      } catch (e) {
        // Keep retrying on later runs until the deadline.
        putSend.run(a.id, b.id, key, 'waiting', when, null, e.message, text, stamp);
        result.waiting++;
      }
    }
  }
  return result;
}

/** What will be sent in the next `days` days (date-based automations), and what each would say. */
export function upcoming(db, now = new Date(), days = 14) {
  const ds = doorSettings(db);
  const end = new Date(now.getTime() + days * 24 * HOUR);
  const bookings = db.prepare(`SELECT b.*, p.name property_name FROM bookings b LEFT JOIN properties p ON p.id = b.property_id
    WHERE b.source = 'beds24' AND b.id > 0 AND b.status IN ('confirmed','new') AND b.departure >= ? AND b.arrival <= ?`)
    .all(addDays(now.toISOString().slice(0, 10), -35), addDays(now.toISOString().slice(0, 10), days + 31));
  const out = [];
  for (const a of listAutomations(db).filter(x => x.enabled && ['arrival', 'departure'].includes(x.anchor))) {
    for (const b of bookings) {
      if (!eligible(a, b)) continue;
      const done = db.prepare("SELECT status FROM automation_sends WHERE automation_id = ? AND booking_id = ? AND key = ''").get(a.id, b.id);
      if (done && ['sent', 'skipped', 'failed'].includes(done.status)) continue;
      const sch = schedule(a, b, ds);
      if (sch.when > end || now > sch.expires) continue;
      if (sch.when < new Date(a.enabled_at || 0)) continue;
      const text = fillTemplate(a.body, templateVars(db, b));
      out.push({ automationId: a.id, automation: a.name, bookingId: b.id, guest: b.guest_name, channel: b.channel,
        when: sch.when.toISOString(), status: done?.status || 'scheduled', missing: [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]), preview: text });
    }
  }
  return out.sort((x, y) => x.when.localeCompare(y.when));
}

export function skipSend(db, automationId, bookingId) {
  db.prepare(`INSERT INTO automation_sends(automation_id,booking_id,key,status,updated_at) VALUES(?,?,'','skipped',?)
    ON CONFLICT(automation_id,booking_id,key) DO UPDATE SET status='skipped', updated_at=excluded.updated_at`).run(automationId, bookingId, new Date().toISOString());
}

export const history = (db, limit = 50) => db.prepare(`SELECT s.*, a.name automation, b.guest_name, b.channel FROM automation_sends s
  JOIN automations a ON a.id = s.automation_id LEFT JOIN bookings b ON b.id = s.booking_id
  ORDER BY s.updated_at DESC LIMIT ?`).all(limit);

/** Render an automation for one booking, for the editor's preview. */
export function previewFor(db, body, bookingId) {
  const b = db.prepare('SELECT b.*, p.name property_name FROM bookings b LEFT JOIN properties p ON p.id = b.property_id WHERE b.id = ?').get(bookingId);
  if (!b) throw userError('Choose a booking to preview with.');
  const text = fillTemplate(body || '', templateVars(db, b));
  return { text, missing: [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]))] };
}
