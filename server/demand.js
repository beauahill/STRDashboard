// Demand signals: how strong demand looks for each future night, in the spirit of AirDNA's market demand calendar
// but built from what this app can see. A 0-100 score combines the room's own history for that month and weekday,
// local events, booking pace versus last year, guests asking about the dates (inquiries and booking requests, kept
// even after they lapse), and stays booked unusually far ahead nearby. Inquiries and early pickup also nudge the
// recommended price (a capped, explained factor); the rest of the score is for the calendar and the numbers.
import { addDays, diffDays } from './sync.js';

export const LEVELS = [
  { min: 75, key: 'vhigh', label: 'Very high' },
  { min: 55, key: 'high', label: 'High' },
  { min: 35, key: 'mid', label: 'Moderate' },
  { min: 0, key: 'low', label: 'Low' },
];
export const levelOf = score => LEVELS.find(l => score >= l.min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SIGNAL_DAYS = 45;      // inquiries and requests count for this long after they arrive
const PICKUP_DAYS = 60;      // a booking counts as recent pickup for this long
const PICKUP_REACH = 3;      // nights either side of an early booking that feel its pull

/**
 * Remember every inquiry and booking request, so the demand they show survives the inquiry expiring or being
 * declined (Beds24 then marks it cancelled). Called after each sync.
 */
export function recordSignals(db, now = new Date()) {
  const rows = db.prepare(`SELECT b.id, b.status, b.room_id, b.arrival, b.departure, b.channel, b.first_seen, b.booked_at FROM bookings b
    WHERE b.status IN ('inquiry','request') AND b.id > 0 AND NOT EXISTS (SELECT 1 FROM demand_signals s WHERE s.booking_id = b.id)`).all();
  const add = db.prepare('INSERT INTO demand_signals(booking_id,kind,room_id,arrival,departure,channel,seen_at) VALUES(?,?,?,?,?,?,?)');
  for (const b of rows) add.run(b.id, b.status, b.room_id, b.arrival, b.departure, b.channel, b.first_seen || b.booked_at || now.toISOString());
  return rows.length;
}

/** Guests asking about dates: per night, the inquiries/requests seen in the last SIGNAL_DAYS days. */
function askedNights(db, roomId, today) {
  const since = addDays(today, -SIGNAL_DAYS);
  const rows = db.prepare(`SELECT s.booking_id, s.kind, s.arrival, s.departure, s.channel, s.seen_at FROM demand_signals s
    WHERE s.room_id = ? AND s.departure > ? AND substr(s.seen_at,1,10) >= ? ORDER BY s.seen_at DESC`).all(roomId, today, since);
  const byNight = new Map();
  for (const r of rows) for (let d = r.arrival > today ? r.arrival : today; d < r.departure; d = addDays(d, 1)) {
    if (!byNight.has(d)) byNight.set(d, []);
    byNight.get(d).push(r);
  }
  return { rows, byNight };
}

/** The room's usual lead time (median days from booking to arrival), from the last two years. */
export function usualLeadTime(db, roomId, today) {
  const leads = db.prepare(`SELECT arrival, booked_at FROM bookings WHERE room_id = ? AND status IN ('confirmed','new')
    AND booked_at IS NOT NULL AND arrival >= ? AND arrival <= ?`).all(roomId, addDays(today, -730), today)
    .map(b => diffDays(b.booked_at.slice(0, 10), b.arrival)).filter(n => n >= 0).sort((a, b) => a - b);
  return leads.length >= 6 ? { days: leads[Math.floor(leads.length / 2)], stays: leads.length } : { days: 30, stays: leads.length, assumed: true };
}

/** Stays booked recently and much further ahead than usual: someone saw a reason to lock those dates in early. */
function earlyPickup(db, roomId, today) {
  const usual = usualLeadTime(db, roomId, today);
  const threshold = Math.max(usual.days * 2, usual.days + 30);
  const rows = db.prepare(`SELECT id, arrival, departure, booked_at, channel FROM bookings WHERE room_id = ? AND status IN ('confirmed','new')
    AND booked_at IS NOT NULL AND substr(booked_at,1,10) >= ? AND arrival > ?`).all(roomId, addDays(today, -PICKUP_DAYS), today)
    .map(b => ({ ...b, lead: diffDays(b.booked_at.slice(0, 10), b.arrival) })).filter(b => b.lead >= threshold);
  const byNight = new Map();
  for (const b of rows) for (let d = addDays(b.arrival, -PICKUP_REACH); d < addDays(b.departure, PICKUP_REACH); d = addDays(d, 1)) {
    if (d >= b.arrival && d < b.departure) continue;   // the booked nights themselves aren't for sale
    if (!byNight.has(d)) byNight.set(d, b);
  }
  return { rows, byNight, usual, threshold };
}

/**
 * Baseline demand by month and weekday from the room's own last two years (occupancy, 0-100). Buckets with too
 * little history fall back to the pricing rules' season and weekday adjustments.
 */
export function historyBaseline(db, roomId, today, settings) {
  const from = addDays(today, -730);
  const booked = new Set();
  for (const b of db.prepare(`SELECT arrival, departure FROM bookings WHERE room_id = ? AND status IN ('confirmed','new')
      AND departure > ? AND arrival < ?`).all(roomId, from, today)) {
    for (let d = b.arrival > from ? b.arrival : from; d < b.departure && d < today; d = addDays(d, 1)) booked.add(d);
  }
  const first = db.prepare(`SELECT MIN(arrival) a FROM bookings WHERE room_id = ? AND status IN ('confirmed','new')`).get(roomId)?.a;
  // History starts with the room's first stay: empty months before it (or a brand-new listing) aren't low demand.
  const start = !first ? today : first > from ? first : from;
  const cells = Array.from({ length: 12 }, () => Array.from({ length: 7 }, () => ({ n: 0, b: 0 })));
  for (let d = start; d < today; d = addDays(d, 1)) {
    const c = cells[+d.slice(5, 7) - 1][new Date(d + 'T00:00:00Z').getUTCDay()];
    c.n++; if (booked.has(d)) c.b++;
  }
  const fromRules = (m, w) => clamp(50 + 0.8 * ((settings?.season?.[m] || 0) + (settings?.dow?.[w] || 0)), 5, 95);
  return {
    nights: booked.size,
    /** { value 0-100, from: 'history' | 'both' | 'rules' } */
    at(date) {
      const m = +date.slice(5, 7) - 1, w = new Date(date + 'T00:00:00Z').getUTCDay(), c = cells[m][w];
      // Four or more past nights of this weekday in this month: trust history, blended with the rules while thin.
      if (c.n >= 4) {
        const share = Math.min(1, c.n / 8);
        return { value: clamp(share * (c.b / c.n) * 100 + (1 - share) * fromRules(m, w), 0, 100), from: share === 1 ? 'history' : 'both' };
      }
      return { value: fromRules(m, w), from: 'rules' };
    },
  };
}

/**
 * Signals for every night in [start, end): inquiries and early pickup (with the price factor they justify) plus
 * the lists behind them, for the Pricing page.
 */
export function demandSignals(db, roomId, today, settings) {
  const asked = askedNights(db, roomId, today);
  const pickup = earlyPickup(db, roomId, today);
  const baseline = historyBaseline(db, roomId, today, settings);
  const per = settings?.demandStepPct ?? 5, cap = settings?.demandMax ?? 15;
  return {
    baseline, asked, pickup,
    /** The price factor for one unbooked night, or null. */
    factor(date) {
      if (settings && settings.demand === false) return null;
      const a = asked.byNight.get(date) || [], p = pickup.byNight.get(date);
      if (!a.length && !p) return null;
      const reasons = [];
      if (a.length) reasons.push(`${a.length} ${a.length === 1 ? 'guest' : 'guests'} asked about this night`);
      if (p) reasons.push(`a nearby stay was booked ${p.lead} days ahead (usually ${pickup.usual.days})`);
      return { label: `Demand: ${reasons.join('; ')}`, pct: Math.min(cap, per * a.length + (p ? per : 0)) };
    },
    /** The 0-100 demand score for one night and what made it. */
    score(date, { event = null, pace = null } = {}) {
      const parts = [];
      const { value: base, from } = baseline.at(date);
      parts.push({ label: { history: 'Your history for this month and weekday', both: 'Your history for this month and weekday, mixed with your pricing rules (little history yet)',
        rules: 'Season and weekday (from your pricing rules)' }[from], points: Math.round(base) });
      let s = base;
      if (event) { const p = Math.round(clamp(event.pct * 0.6, -20, 40)); s += p; parts.push({ label: `Event: ${event.name}`, points: p }); }
      if (pace && pace.lastYear != null) {
        const p = Math.round(clamp((pace.now - pace.lastYear) * 50, -15, 15));
        if (p) { s += p; parts.push({ label: `Booking pace (${Math.round(pace.now * 100)}% booked vs ${Math.round(pace.lastYear * 100)}% last year)`, points: p }); }
      }
      const a = (asked.byNight.get(date) || []).length;
      if (a) { const p = Math.min(30, 12 * a); s += p; parts.push({ label: `${a} inquir${a === 1 ? 'y' : 'ies'} or request${a === 1 ? '' : 's'} for this night`, points: p }); }
      if (pickup.byNight.get(date)) { s += 10; parts.push({ label: 'Booked unusually early nearby', points: 10 }); }
      const score = Math.round(clamp(s, 0, 100));
      return { score, level: levelOf(score).key, parts };
    },
  };
}

/**
 * AirDNA-style forward numbers for the next 30/60/90 days: occupancy, ADR and RevPAR on the books, and the same
 * window a year ago both at this point (pace) and how it finished.
 */
export function forwardStats(db, roomId, today, windows = [30, 60, 90]) {
  const blocked = new Set(db.prepare(`SELECT date FROM calendar_days WHERE room_id = ? AND override = 'blackout' AND date >= ?`).all(roomId, today).map(r => r.date));
  // "At this point last year" counts what was on the books then, including stays cancelled since.
  const stays = (from, to, bookedBy) => db.prepare(`SELECT arrival, departure, nights, price FROM bookings WHERE room_id = ? AND arrival < ? AND departure > ?
      ${bookedBy ? `AND booked_at IS NOT NULL AND substr(booked_at,1,10) <= ? AND (status IN ('confirmed','new') OR (status = 'cancelled' AND substr(cancelled_at,1,10) > ?))`
        : "AND status IN ('confirmed','new')"}`)
    .all(roomId, to, from, ...(bookedBy ? [bookedBy, bookedBy] : []));
  const measure = (from, to, bookedBy, skipBlocked) => {
    let nights = 0, revenue = 0;
    for (const b of stays(from, to, bookedBy)) {
      const n = diffDays(b.arrival > from ? b.arrival : from, b.departure < to ? b.departure : to);
      nights += n; revenue += b.nights ? (b.price || 0) * n / b.nights : 0;
    }
    let available = diffDays(from, to);
    if (skipBlocked) for (let d = from; d < to; d = addDays(d, 1)) if (blocked.has(d)) available--;
    available = Math.max(available, nights, 1);
    return { nights, available, occupancy: nights / available, adr: nights ? revenue / nights : null, revpar: revenue / available, revenue };
  };
  const anyHistory = !!db.prepare(`SELECT 1 FROM bookings WHERE room_id = ? AND status IN ('confirmed','new','cancelled') AND arrival < ?`).get(roomId, addDays(today, -300));
  return windows.map(days => {
    const to = addDays(today, days), lyFrom = addDays(today, -364), lyTo = addDays(to, -364);   // same weekdays last year
    return {
      days, now: measure(today, to, null, true),
      lastYearAtThisPoint: anyHistory ? measure(lyFrom, lyTo, lyFrom) : null,
      lastYearFinal: anyHistory ? measure(lyFrom, lyTo) : null,
    };
  });
}
