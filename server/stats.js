import { addDays, diffDays, iso } from './sync.js';

const ACTIVE = "status IN ('confirmed','new')";

function units(db, propertyId) {
  const row = propertyId
    ? db.prepare('SELECT COALESCE(SUM(qty),0) n FROM rooms WHERE property_id=?').get(propertyId)
    : db.prepare('SELECT COALESCE(SUM(qty),0) n FROM rooms').get();
  return row.n;
}

/** Occupancy / revenue / ADR for [from, to) with revenue prorated per night across the range. */
export function periodStats(db, from, to, propertyId = null) {
  const days = diffDays(from, to);
  const rows = db.prepare(
    `SELECT * FROM bookings WHERE ${ACTIVE} AND arrival < ? AND departure > ?
     ${propertyId ? 'AND property_id = ?' : ''}`).all(to, from, ...(propertyId ? [propertyId] : []));
  let nights = 0, revenue = 0;
  const byChannel = {};
  for (const b of rows) {
    const n = diffDays(b.arrival > from ? b.arrival : from, b.departure < to ? b.departure : to);
    const rev = b.nights ? (b.price * n) / b.nights : 0;
    nights += n; revenue += rev;
    const c = (byChannel[b.channel] ||= { nights: 0, revenue: 0, bookings: 0 });
    c.nights += n; c.revenue += rev; c.bookings++;
  }
  const available = units(db, propertyId) * days;
  return {
    from, to, nights, available, bookings: rows.length,
    revenue: Math.round(revenue * 100) / 100,
    occupancy: available ? nights / available : 0,
    adr: nights ? revenue / nights : 0,
    revpar: available ? revenue / available : 0,
    byChannel,
  };
}

const monthStart = (s, offset) => {
  const d = new Date(s + 'T00:00:00Z');
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
};

export function summary(db, today = iso(Date.now()), propertyId = null) {
  const pf = propertyId ? 'AND b.property_id = ?' : '';
  const args = propertyId ? [propertyId] : [];
  const list = (where, extra = []) => db.prepare(
    `SELECT b.*, r.name room_name, p.name property_name FROM bookings b
     LEFT JOIN rooms r ON r.id=b.room_id LEFT JOIN properties p ON p.id=b.property_id
     WHERE b.status IN ('confirmed','new') AND ${where} ${pf} ORDER BY b.arrival, b.departure`).all(...extra, ...args);

  const arrivals = list('b.arrival = ?', [today]);
  const departures = list('b.departure = ?', [today]);
  const inHouse = list('b.arrival < ? AND b.departure > ?', [today, today]);
  const upcoming = list('b.arrival > ? AND b.arrival <= ?', [today, addDays(today, 14)]);
  const turnovers = departures.filter(d => arrivals.some(a => a.room_id === d.room_id));

  const months = [];
  for (let o = -5; o <= 6; o++) {
    const m = periodStats(db, monthStart(today, o), monthStart(today, o + 1), propertyId);
    months.push({ month: m.from.slice(0, 7), occupancy: m.occupancy, revenue: m.revenue, adr: m.adr, future: o > 0 });
  }
  const pending = db.prepare(`SELECT COUNT(*) n FROM bookings b WHERE b.status='request' ${pf}`).get(...args).n;

  return {
    today, arrivals, departures, inHouse, upcoming, turnovers, pending,
    thisMonth: periodStats(db, monthStart(today, 0), monthStart(today, 1), propertyId),
    next30: periodStats(db, today, addDays(today, 30), propertyId),
    last30: periodStats(db, addDays(today, -30), today, propertyId),
    months,
  };
}

export function calendar(db, start, days, propertyId = null) {
  const end = addDays(start, days);
  const rooms = db.prepare(
    `SELECT r.id, r.name, r.property_id, p.name property_name FROM rooms r JOIN properties p ON p.id=r.property_id
     ${propertyId ? 'WHERE r.property_id = ?' : ''} ORDER BY p.name, r.name`).all(...(propertyId ? [propertyId] : []));
  const bookings = db.prepare(
    `SELECT id, room_id, status, channel, arrival, departure, nights, guest_name, price FROM bookings
     WHERE status IN ('confirmed','new','request','block') AND arrival < ? AND departure > ?`).all(end, start);
  return { start, days, end, rooms, bookings };
}
