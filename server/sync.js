import { getSetting, setSetting } from './db.js';

const DAY = 86400000;
export const iso = d => new Date(d).toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(s + 'T00:00:00Z').getTime() + n * DAY);
export const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Beds24 channel codes vary; collapse them to the four we care about. */
export function normalizeChannel(b) {
  const raw = `${b.channel || ''} ${b.referer || ''}`.toLowerCase();
  if (raw.includes('airbnb')) return 'Airbnb';
  if (raw.includes('booking')) return 'Booking.com';
  if (/vrbo|homeaway|expedia/.test(raw)) return 'VRBO';
  if (!b.channel || /direct|beds24|manual/.test(raw)) return 'Direct';
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
    notes: [b.notes, b.comments].filter(Boolean).join('\n') || null,
    channel_ref: b.apiReference || null,
    booked_at: b.bookingTime || null, modified_at: b.modifiedTime || null,
  };
}

export function upsertProperties(db, props) {
  const p = db.prepare(`INSERT INTO properties(id,name,city,currency) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, city=excluded.city, currency=excluded.currency`);
  const r = db.prepare(`INSERT INTO rooms(id,property_id,name,qty) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET property_id=excluded.property_id, name=excluded.name, qty=excluded.qty`);
  db.exec('BEGIN');
  try {
    for (const x of props) {
      p.run(x.id, x.name, x.city || null, x.currency || 'USD');
      for (const room of x.roomTypes || x.rooms || []) r.run(room.id, x.id, room.name, room.qty || 1);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function upsertBookings(db, list) {
  const cols = ['id','property_id','room_id','status','channel','arrival','departure','nights','guest_name','email',
    'phone','adults','children','price','currency','notes','channel_ref','booked_at','modified_at'];
  const stmt = db.prepare(`INSERT OR REPLACE INTO bookings(${cols}) VALUES(${cols.map(() => '?')})`);
  db.exec('BEGIN');
  try {
    for (const b of list) {
      if (!b.id || !b.arrival || !b.departure) continue;
      const m = mapBooking(b);
      stmt.run(...cols.map(c => m[c]));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Full sync on first run (1 year back), incremental via modifiedFrom afterwards. */
export async function syncBeds24(db, client) {
  const props = await client.getAll('/properties', { includeAllRooms: true });
  upsertProperties(db, props);

  const last = getSetting(db, 'last_sync');
  const query = last
    ? { modifiedFrom: new Date(Date.parse(last) - 5 * 60000).toISOString() }
    : { departureFrom: addDays(iso(Date.now()), -365) };
  const bookings = await client.getAll('/bookings', { ...query, status: ['confirmed', 'new', 'request', 'cancelled', 'black'] });
  upsertBookings(db, bookings);

  const now = new Date().toISOString();
  setSetting(db, 'last_sync', now);
  setSetting(db, 'last_sync_error', null);
  return { properties: props.length, bookings: bookings.length, at: now };
}
