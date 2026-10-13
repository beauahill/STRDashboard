// Analytics: trends over the whole booking history (Beds24 plus imported Guesty stays), always next to last year.
// Revenue is each booking's total spread evenly over its nights, the same as the Dashboard.
import { periodStats } from './stats.js';
import { addDays, diffDays } from './sync.js';

const ACTIVE = "status IN ('confirmed','new')";
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const monthAdd = (ym, n) => {
  const d = new Date(ym + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const first = ym => ym + '-01';
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const lead = b => (b.booked_at ? Math.max(0, diffDays(b.booked_at.slice(0, 10), b.arrival)) : null);
const bucket = (v, edges) => edges.findIndex(([lo, hi]) => v >= lo && v <= hi);

const LEAD_BUCKETS = [[0, 1, 'Same/next day'], [2, 7, '2–7 days'], [8, 14, '1–2 weeks'], [15, 30, '2–4 weeks'],
  [31, 60, '1–2 months'], [61, 90, '2–3 months'], [91, 1e9, '3+ months']];
const STAY_BUCKETS = [[1, 1, '1 night'], [2, 2, '2 nights'], [3, 3, '3 nights'], [4, 4, '4 nights'], [5, 6, '5–6 nights'],
  [7, 13, '1–2 weeks'], [14, 1e9, '2+ weeks']];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function stays(db, from, to, propertyId, statuses = ACTIVE) {
  return db.prepare(`SELECT * FROM bookings WHERE ${statuses} AND arrival >= ? AND arrival < ?
    ${propertyId ? 'AND property_id = ?' : ''}`).all(from, to, ...(propertyId ? [propertyId] : []));
}

function stat(p) {
  return { nights: p.nights, available: p.available, bookings: p.bookings, revenue: round(p.revenue),
    occupancy: round(p.occupancy, 4), adr: round(p.adr, 2), revpar: round(p.revpar, 2) };
}

/** Month by month, from the first month with data (at most `months` back) to 6 months ahead, each with last year's figure. */
export function monthly(db, today, propertyId = null, months = 24) {
  const firstArrival = db.prepare(`SELECT MIN(arrival) a FROM bookings WHERE ${ACTIVE} ${propertyId ? 'AND property_id = ?' : ''}`)
    .get(...(propertyId ? [propertyId] : [])).a;
  const now = today.slice(0, 7);
  let start = monthAdd(now, -(months - 1));
  if (firstArrival && firstArrival.slice(0, 7) > start) start = firstArrival.slice(0, 7);
  const out = [];
  for (let m = start; m <= monthAdd(now, 6); m = monthAdd(m, 1)) {
    const cur = stat(periodStats(db, first(m), first(monthAdd(m, 1)), propertyId));
    const ly = stat(periodStats(db, first(monthAdd(m, -12)), first(monthAdd(m, -11)), propertyId));
    out.push({ month: m, future: m > now, current: m === now, ...cur,
      lastYear: firstArrival && first(monthAdd(m, -12)) >= first(firstArrival.slice(0, 7)) ? ly : null });
  }
  return out;
}

/** Year to date versus the same dates last year, and the trailing 12 months versus the 12 before. */
export function headline(db, today, propertyId = null) {
  const year = today.slice(0, 4), ly = String(year - 1);
  const tomorrow = addDays(today, 1), lyToday = `${ly}-${today.slice(5) === '02-29' ? '02-28' : today.slice(5)}`;
  const firstArrival = db.prepare(`SELECT MIN(arrival) a FROM bookings WHERE status != 'block' ${propertyId ? 'AND property_id = ?' : ''}`)
    .get(...(propertyId ? [propertyId] : [])).a;
  // No bookings that early means no history to compare with, rather than a year of zeros.
  const pair = (from, to, lyFrom, lyTo) => ({ current: stat(periodStats(db, from, to, propertyId)),
    lastYear: firstArrival && firstArrival < lyTo ? stat(periodStats(db, lyFrom, lyTo, propertyId)) : null });
  return {
    ytd: { label: `${year} to date`, ...pair(`${year}-01-01`, tomorrow, `${ly}-01-01`, addDays(lyToday, 1)) },
    trailing12: { label: 'Last 12 months', ...pair(addDays(tomorrow, -365), tomorrow, addDays(tomorrow, -730), addDays(tomorrow, -365)) },
    next90: { label: 'Next 90 days (on the books)', ...pair(tomorrow, addDays(tomorrow, 90), addDays(tomorrow, -364), addDays(tomorrow, -274)) },
  };
}

/** Channel mix for stays in [from, to): share of nights and revenue, ADR, average lead time and length of stay. */
export function channels(db, from, to, propertyId = null) {
  const p = periodStats(db, from, to, propertyId);
  const list = stays(db, from, to, propertyId);
  return Object.entries(p.byChannel).map(([channel, c]) => {
    const mine = list.filter(b => b.channel === channel);
    const leads = mine.map(lead).filter(v => v != null);
    return { channel, bookings: c.bookings, nights: c.nights, revenue: round(c.revenue),
      nightShare: p.nights ? round(c.nights / p.nights, 4) : 0, revenueShare: p.revenue ? round(c.revenue / p.revenue, 4) : 0,
      adr: c.nights ? round(c.revenue / c.nights, 2) : 0,
      avgLead: leads.length ? round(leads.reduce((a, v) => a + v, 0) / leads.length) : null,
      avgStay: mine.length ? round(mine.reduce((a, b) => a + b.nights, 0) / mine.length, 1) : null };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** How far ahead guests book, and how long they stay, for stays arriving in [from, to). */
export function bookingWindow(db, from, to, propertyId = null) {
  const list = stays(db, from, to, propertyId);
  const leads = list.map(lead).filter(v => v != null);
  const leadRows = LEAD_BUCKETS.map(([, , label]) => ({ label, bookings: 0, nights: 0, revenue: 0 }));
  for (const b of list) {
    const l = lead(b); if (l == null) continue;
    const r = leadRows[bucket(l, LEAD_BUCKETS)]; r.bookings++; r.nights += b.nights; r.revenue += b.price;
  }
  const stayRows = STAY_BUCKETS.map(([, , label]) => ({ label, bookings: 0, revenue: 0, adr: 0 }));
  const stayNights = STAY_BUCKETS.map(() => 0);
  for (const b of list) {
    const i = bucket(b.nights, STAY_BUCKETS); if (i < 0) continue;
    stayRows[i].bookings++; stayRows[i].revenue += b.price; stayNights[i] += b.nights;
  }
  stayRows.forEach((r, i) => { r.revenue = round(r.revenue); r.adr = stayNights[i] ? round(r.revenue / stayNights[i], 2) : 0; });
  leadRows.forEach(r => { r.revenue = round(r.revenue); r.adr = r.nights ? round(r.revenue / r.nights, 2) : 0; });
  return {
    bookings: list.length, withBookingDate: leads.length,
    lead: { median: median(leads), average: leads.length ? round(leads.reduce((a, v) => a + v, 0) / leads.length) : null, buckets: leadRows },
    stay: { average: list.length ? round(list.reduce((a, b) => a + b.nights, 0) / list.length, 1) : null, median: median(list.map(b => b.nights)), buckets: stayRows },
    guests: { average: list.length ? round(list.reduce((a, b) => a + (b.adults || 0) + (b.children || 0), 0) / list.length, 1) : null,
      withChildren: list.filter(b => b.children > 0).length },
  };
}

/** Occupancy and ADR by night of the week for nights in [from, to). */
export function byWeekday(db, from, to, propertyId = null) {
  const rows = DOW.map(day => ({ day, nights: 0, available: 0, revenue: 0 }));
  const units = db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM rooms ${propertyId ? 'WHERE property_id = ?' : ''}`).get(...(propertyId ? [propertyId] : [])).n;
  for (let d = from; d < to; d = addDays(d, 1)) rows[new Date(d + 'T00:00:00Z').getUTCDay()].available += units;
  const list = db.prepare(`SELECT arrival, departure, nights, price FROM bookings WHERE ${ACTIVE} AND arrival < ? AND departure > ?
    ${propertyId ? 'AND property_id = ?' : ''}`).all(to, from, ...(propertyId ? [propertyId] : []));
  for (const b of list) {
    for (let d = b.arrival > from ? b.arrival : from; d < b.departure && d < to; d = addDays(d, 1)) {
      const r = rows[new Date(d + 'T00:00:00Z').getUTCDay()];
      r.nights++; r.revenue += b.nights ? b.price / b.nights : 0;
    }
  }
  return rows.map(r => ({ day: r.day, occupancy: r.available ? round(r.nights / r.available, 4) : 0, adr: r.nights ? round(r.revenue / r.nights, 2) : 0, nights: r.nights }));
}

/** Cancellations among bookings that were due to arrive in [from, to). */
export function cancellations(db, from, to, propertyId = null) {
  const all = stays(db, from, to, propertyId, "status IN ('confirmed','new','cancelled')");
  const cancelled = all.filter(b => b.status === 'cancelled');
  const notice = cancelled.filter(b => b.cancelled_at).map(b => diffDays(b.cancelled_at.slice(0, 10), b.arrival));
  const byChannel = {};
  for (const b of all) {
    const c = (byChannel[b.channel] ||= { channel: b.channel, bookings: 0, cancelled: 0, lostRevenue: 0 });
    c.bookings++; if (b.status === 'cancelled') { c.cancelled++; c.lostRevenue += b.price; }
  }
  return {
    bookings: all.length, cancelled: cancelled.length, rate: all.length ? round(cancelled.length / all.length, 4) : 0,
    lostRevenue: round(cancelled.reduce((a, b) => a + b.price, 0)),
    medianNoticeDays: median(notice),
    byChannel: Object.values(byChannel).map(c => ({ ...c, rate: round(c.cancelled / c.bookings, 4), lostRevenue: round(c.lostRevenue) }))
      .sort((a, b) => b.bookings - a.bookings),
  };
}

/** On the books for each of the next `months` months, versus what was on the books for the same month at this point last year. */
export function pace(db, today, propertyId = null, months = 6) {
  const lastYearToday = addDays(today, -364) + 'T23:59:59';
  const units = db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM rooms ${propertyId ? 'WHERE property_id = ?' : ''}`).get(...(propertyId ? [propertyId] : [])).n;
  const sum = (from, to, bookedBy) => db.prepare(`SELECT arrival, departure, nights, price FROM bookings
      WHERE arrival < ? AND departure > ? ${propertyId ? 'AND property_id = ?' : ''}
      ${bookedBy ? "AND booked_at IS NOT NULL AND booked_at <= ? AND (status IN ('confirmed','new') OR (status = 'cancelled' AND cancelled_at > ?))" : `AND ${ACTIVE}`}`)
    .all(to, from, ...(propertyId ? [propertyId] : []), ...(bookedBy ? [bookedBy, bookedBy] : []))
    .reduce((acc, b) => {
      const n = diffDays(b.arrival > from ? b.arrival : from, b.departure < to ? b.departure : to);
      acc.nights += n; acc.revenue += b.nights ? (b.price * n) / b.nights : 0; return acc;
    }, { nights: 0, revenue: 0 });
  const out = [];
  for (let i = 0; i < months; i++) {
    const m = monthAdd(today.slice(0, 7), i), from = i ? first(m) : today, to = first(monthAdd(m, 1));
    const lyFrom = addDays(from, -364), lyTo = addDays(to, -364);
    const now = sum(from, to), then = sum(lyFrom, lyTo, lastYearToday), final = sum(lyFrom, lyTo);
    const days = diffDays(from, to) * units;
    const hasHistory = !!db.prepare(`SELECT 1 FROM bookings WHERE status != 'block' AND arrival < ? AND departure > ? ${propertyId ? 'AND property_id = ?' : ''}`)
      .get(lyTo, lyFrom, ...(propertyId ? [propertyId] : []));
    out.push({ month: m, fromToday: i === 0,
      now: { nights: now.nights, occupancy: days ? round(now.nights / days, 4) : 0, revenue: round(now.revenue) },
      lastYearAtThisPoint: hasHistory ? { nights: then.nights, occupancy: days ? round(then.nights / days, 4) : 0, revenue: round(then.revenue) } : null,
      lastYearFinal: hasHistory ? { nights: final.nights, occupancy: days ? round(final.nights / days, 4) : 0, revenue: round(final.revenue) } : null });
  }
  return out;
}

export const RANGES = { '12m': 'Last 12 months', ytd: 'This year so far', ly: 'Last year', all: 'All time' };
/** [from, to) for a named range; stays are grouped by arrival date. */
export function rangeFor(db, today, range) {
  const tomorrow = addDays(today, 1), year = Number(today.slice(0, 4));
  if (range === 'ytd') return [`${year}-01-01`, tomorrow];
  if (range === 'ly') return [`${year - 1}-01-01`, `${year}-01-01`];
  if (range === 'all') {
    const firstArrival = db.prepare("SELECT MIN(arrival) a FROM bookings WHERE status != 'block'").get().a;
    return [firstArrival && firstArrival < tomorrow ? firstArrival : addDays(tomorrow, -365), tomorrow];
  }
  return [addDays(tomorrow, -365), tomorrow];
}

/** Everything the Analytics page shows. Stays are analysed over `range` (default: the trailing 12 months). */
export function analytics(db, today, { propertyId = null, range = '12m' } = {}) {
  if (!RANGES[range]) range = '12m';
  const [from, to] = rangeFor(db, today, range);
  return {
    today, from, to, range, ranges: RANGES,
    headline: headline(db, today, propertyId),
    monthly: monthly(db, today, propertyId),
    channels: channels(db, from, to, propertyId),
    window: bookingWindow(db, from, to, propertyId),
    weekdays: byWeekday(db, from, to, propertyId),
    cancellations: cancellations(db, from, to, propertyId),
    pace: pace(db, today, propertyId),
    sources: db.prepare(`SELECT source, COUNT(*) n, MIN(arrival) first FROM bookings WHERE status != 'block' GROUP BY source`).all(),
  };
}
