import { getSetting, setSetting } from './db.js';

const DAY = 86400000, HOUR = 3600000;
export const iso = d => new Date(d).toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(s + 'T00:00:00Z').getTime() + n * DAY);
export const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
// Inquiries (questions before booking) are included so their messages appear in the inbox.
const STATUSES = ['confirmed', 'new', 'request', 'cancelled', 'black', 'inquiry'];

/** Beds24 channel codes vary; collapse them to the four we care about. */
export function normalizeChannel(b) {
  const raw = `${b.channel || ''} ${b.referer || ''}`.toLowerCase();
  if (raw.includes('airbnb')) return 'Airbnb';
  // Beds24's own booking page is channel "bookingpage": a direct booking, not Booking.com.
  if (/bookingpage|direct|beds24|manual/.test(raw)) return 'Direct';
  if (raw.includes('booking')) return 'Booking.com';
  if (/vrbo|homeaway/.test(raw)) return 'VRBO';
  if (!b.channel) return 'Direct';
  return 'Other';
}

export function mapBooking(b) {
  const status = b.status === 'black' ? 'block' : (b.status || 'confirmed');
  const name = [b.firstName, b.lastName].filter(Boolean).join(' ') || b.title || '';
  return {
    id: b.id, property_id: b.propertyId ?? null, room_id: b.roomId ?? null,
    status, channel: normalizeChannel(b),
    arrival: b.arrival, departure: b.departure, nights: Math.max(0, diffDays(b.arrival, b.departure)),
    guest_name: name, email: b.email || null, phone: b.phone || b.mobile || null,
    adults: b.numAdult || 0, children: b.numChild || 0,
    price: Number(b.price) || 0, currency: b.currency || null,
    commission: b.commission == null ? null : Number(b.commission) || 0, tax: b.tax == null ? null : Number(b.tax) || 0,
    notes: [b.notes, b.comments].filter(Boolean).join('\n') || null,
    channel_ref: b.apiReference || null,
    booked_at: b.bookingTime || null, modified_at: b.modifiedTime || null, cancelled_at: b.cancelTime || null,
  };
}

export function upsertProperties(db, props) {
  const p = db.prepare(`INSERT INTO properties(id,name,city,currency) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, city=excluded.city, currency=excluded.currency`);
  const r = db.prepare(`INSERT INTO rooms(id,property_id,name,qty) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET property_id=excluded.property_id, name=excluded.name, qty=excluded.qty`);
  db.exec('BEGIN');
  try {
    const seen = [];
    for (const x of props) {
      p.run(x.id, x.name, x.city || null, x.currency || 'USD');
      for (const room of x.roomTypes || x.rooms || []) {
        // qty 0 is a retired room type: kept as given, so it isn't counted as a sellable unit.
        r.run(room.id, x.id, room.name, room.qty == null || !Number.isFinite(Number(room.qty)) ? 1 : Number(room.qty));
        seen.push(room.id);
      }
    }
    // Rooms Beds24 no longer lists are retired, not deleted: their bookings still point at them. An empty reply is left alone.
    if (seen.length) db.prepare(`UPDATE rooms SET qty = 0 WHERE id > 0 AND id NOT IN (${seen.map(() => '?').join(',')})`).run(...seen);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function upsertBookings(db, list) {
  const cols = ['id','property_id','room_id','status','channel','arrival','departure','nights','guest_name','email',
    'phone','adults','children','price','commission','tax','currency','notes','channel_ref','booked_at','modified_at','cancelled_at'];
  // Update only Beds24's fields so app-side columns (first_seen) survive every sync.
  const stmt = db.prepare(`INSERT INTO bookings(${cols},first_seen) VALUES(${cols.map(() => '?')},?)
    ON CONFLICT(id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(', ')}`);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const b of list) {
      if (!b.id || !b.arrival || !b.departure) continue;
      const m = mapBooking(b);
      stmt.run(...cols.map(c => m[c]), now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * A booking deleted in Beds24 (removed, not cancelled) is never modified again, so no incremental sync hears of it.
 * Compare the ids Beds24 still holds from 30 days back with ours and mark the missing ones `deleted`: kept for
 * history, excluded from every count. `rows` is a fetch that already covers the window (the first, full sync).
 */
export async function reconcileDeleted(db, client, today = iso(Date.now()), rows = null) {
  const since = addDays(today, -30);
  const local = db.prepare(`SELECT id FROM bookings WHERE source = 'beds24' AND id > 0 AND departure >= ?
    AND status NOT IN ('cancelled','deleted')`).all(since).map(r => r.id);
  if (!local.length) return { deleted: 0, skipped: false };
  const remote = new Set((rows || await client.getAll('/bookings', { departureFrom: since, status: STATUSES })).map(b => b.id));
  // An empty answer with stays on file is a Beds24 hiccup until proven otherwise: never mass-delete on it.
  if (!remote.size) return { deleted: 0, skipped: true };
  const gone = local.filter(id => !remote.has(id));
  const mark = db.prepare("UPDATE bookings SET status = 'deleted', modified_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const id of gone) mark.run(now, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { deleted: gone.length, skipped: false };
}

/** Full sync on first run (1 year back), incremental via modifiedFrom afterwards. */
export async function syncBeds24(db, client) {
  const props = await client.getAll('/properties', { includeAllRooms: true });
  upsertProperties(db, props);

  const today = iso(Date.now());
  const last = getSetting(db, 'last_sync');
  const query = last
    ? { modifiedFrom: new Date(Date.parse(last) - 5 * 60000).toISOString().slice(0, 19) } // Beds24 wants YYYY-MM-DDTHH:MM:SS
    : { departureFrom: addDays(today, -365) };
  const bookings = await client.getAll('/bookings', { ...query, status: STATUSES });
  upsertBookings(db, bookings);

  // Deletions never show up as modifications: once a day (and on a fresh connection) check what is still there.
  const checked = getSetting(db, 'last_full_check');
  let deleted = 0;
  if (!checked || Date.parse(checked) < Date.now() - 24 * HOUR) {
    const r = await reconcileDeleted(db, client, today, last ? null : bookings);
    deleted = r.deleted;
    if (!r.skipped) setSetting(db, 'last_full_check', new Date().toISOString());
  }

  const now = new Date().toISOString();
  setSetting(db, 'last_sync', now);
  setSetting(db, 'last_sync_error', null);
  return { properties: props.length, bookings: bookings.length, deleted, at: now };
}
