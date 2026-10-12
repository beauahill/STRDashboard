// Cleaning: a private calendar feed for Turno (which creates a cleaning at each checkout) and the list of
// upcoming turnovers. Turno has no public API, but subscribes to iCal links; unlike Beds24's own iCal link,
// this feed only contains real stays, so blocked dates never create cleanings.
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { addDays, diffDays } from './sync.js';
import { doorSettings, localToday } from './doors.js';

export function feedToken(db, regenerate = false) {
  let t = getSetting(db, 'cleaning_feed_token');
  if (!t || regenerate) { t = randomBytes(18).toString('base64url'); setSetting(db, 'cleaning_feed_token', t); }
  return t;
}

const STAY = "status IN ('confirmed','new')";
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = d => d.replace(/-/g, '');
/** Fold lines longer than 75 octets, as iCalendar requires. */
const fold = line => {
  const out = [];
  let rest = Buffer.from(line);
  while (rest.length > 75) {
    let cut = 75;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut--;  // don't split a UTF-8 character
    out.push(rest.subarray(0, cut).toString()); rest = Buffer.concat([Buffer.from(' '), rest.subarray(cut)]);
  }
  out.push(rest.toString());
  return out.join('\r\n');
};

/**
 * iCalendar feed of stays for one room: one all-day event per stay (arrival to departure), like Airbnb's own
 * feed, so Turno schedules the cleaning on the checkout day. No guest names or contact details.
 */
export function icsForRoom(db, roomId, now = new Date()) {
  const room = db.prepare('SELECT r.*, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id = ?').get(roomId);
  if (!room) return null;
  const since = addDays(now.toISOString().slice(0, 10), -30);
  const stays = db.prepare(`SELECT id, arrival, departure, nights, adults, children, channel FROM bookings
    WHERE room_id = ? AND ${STAY} AND departure >= ? ORDER BY arrival`).all(roomId, since);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//STR Dashboard//Cleaning feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${room.property_name} · ${room.name} (stays)`)}`];
  for (const s of stays) {
    const guests = (s.adults || 0) + (s.children || 0);
    const next = db.prepare(`SELECT arrival, adults, children FROM bookings WHERE room_id = ? AND ${STAY} AND arrival >= ? AND id != ? ORDER BY arrival LIMIT 1`)
      .get(roomId, s.departure, s.id);
    const desc = [`${s.nights} night${s.nights === 1 ? '' : 's'}${guests ? `, ${guests} guest${guests === 1 ? '' : 's'}` : ''}`,
      next ? (next.arrival === s.departure ? `Same-day turnover: next guests arrive ${s.departure}` : `Next check-in: ${next.arrival}`) : 'No next booking yet'];
    lines.push('BEGIN:VEVENT', `UID:stay-${s.id}@str-dashboard`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(s.arrival)}`, `DTEND;VALUE=DATE:${icsDate(s.departure)}`,
      `SUMMARY:${esc(`Reserved${guests ? ` (${guests} guest${guests === 1 ? '' : 's'})` : ''}`)}`,
      `DESCRIPTION:${esc(desc.join('\n'))}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Upcoming checkouts with the time available to clean before the next guests arrive. */
export function turnovers(db, { days = 30, roomIds = null } = {}) {
  const ds = doorSettings(db);
  const today = localToday(ds.tz);
  const end = addDays(today, days);
  const rooms = db.prepare(`SELECT r.id, r.name, p.name property_name FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id > 0
    ${roomIds ? `AND r.id IN (${roomIds.map(() => '?').join(',')})` : ''}`).all(...(roomIds || []));
  const out = [];
  for (const r of rooms) {
    const stays = db.prepare(`SELECT id, guest_name, arrival, departure, adults, children, channel FROM bookings
      WHERE room_id = ? AND ${STAY} AND departure >= ? AND departure <= ? ORDER BY departure`).all(r.id, today, end);
    for (const s of stays) {
      const next = db.prepare(`SELECT id, guest_name, arrival, departure, adults, children, channel FROM bookings
        WHERE room_id = ? AND ${STAY} AND arrival >= ? AND id != ? ORDER BY arrival LIMIT 1`).get(r.id, s.departure, s.id);
      const [coH, coM] = ds.checkout.split(':').map(Number), [ciH, ciM] = ds.checkin.split(':').map(Number);
      const hours = next ? diffDays(s.departure, next.arrival) * 24 + (ciH + ciM / 60) - (coH + coM / 60) : null;
      out.push({ room: r, checkout: s, next: next || null, sameDay: !!next && next.arrival === s.departure,
        windowHours: hours, checkoutTime: ds.checkout, checkinTime: ds.checkin });
    }
  }
  return out.sort((a, b) => a.checkout.departure.localeCompare(b.checkout.departure));
}
