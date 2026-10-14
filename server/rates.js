// Nightly prices, minimum stays and blocked dates: read from and written to the Beds24 calendar.
// Every write is planned first (so the person sees exactly what will change), then sent, then
// re-read from Beds24 to confirm it took effect.
import { addDays, diffDays, iso } from './sync.js';
import { doorSettings, localToday } from './doors.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
const money = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US');

/** Refresh the local calendar copy for [start, end] (inclusive) from Beds24. "Today" is the property's date, so tonight is refreshed too. */
export async function syncCalendar(db, client, start = localToday(doorSettings(db).tz), end = addDays(start, 365)) {
  const roomIds = db.prepare('SELECT id FROM rooms WHERE id > 0').all().map(r => r.id);
  if (!roomIds.length) return { rooms: 0 };
  const rows = await client.getAll('/inventory/rooms/calendar', {
    startDate: start, endDate: end, roomId: roomIds,
    includePrices: true, includeMinStay: true, includeNumAvail: true, includeOverride: true,
  });
  const del = db.prepare('DELETE FROM calendar_days WHERE room_id = ? AND date BETWEEN ? AND ?');
  const put = db.prepare(`INSERT OR REPLACE INTO calendar_days(room_id,date,price,min_stay,num_avail,override) VALUES(?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const id of roomIds) del.run(id, start, end);
    for (const r of rows) {
      for (const c of r.calendar || []) {
        // Beds24 returns ranges with inclusive from/to; expand to one row per night inside the window.
        let d = c.from > start ? c.from : start;
        const last = c.to < end ? c.to : end;
        for (; d <= last; d = addDays(d, 1)) {
          put.run(r.roomId, d, c.price1 ?? null, c.minStay ?? null, c.numAvail ?? null, c.override ?? null);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { rooms: rows.length };
}

/** One entry per night: the cached calendar values plus any booking occupying that night. */
export function readDays(db, roomId, start, days) {
  const end = addDays(start, days);
  const cal = new Map(db.prepare('SELECT * FROM calendar_days WHERE room_id = ? AND date >= ? AND date < ?')
    .all(roomId, start, end).map(r => [r.date, r]));
  const bookings = db.prepare(`SELECT id, status, channel, arrival, departure, guest_name FROM bookings
    WHERE room_id = ? AND status IN ('confirmed','new','request','block') AND arrival < ? AND departure > ?`).all(roomId, end, start);
  const out = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    const c = cal.get(d);
    const b = bookings.find(x => x.arrival <= d && x.departure > d);
    out.push({
      date: d, price: c?.price ?? null, minStay: c?.min_stay ?? null, numAvail: c?.num_avail ?? null,
      blocked: c?.override === 'blackout', known: !!c,
      booking: b ? { id: b.id, status: b.status, channel: b.channel, guest: b.guest_name, checkIn: b.arrival === d } : null,
    });
  }
  return out;
}

/** Validate a change request and work out exactly which nights change and how. Throws 400s for bad input. */
// "Today" is the property's date: in the evening in Wyoming the UTC date is already tomorrow, and tonight must
// still be editable.
export function planChanges(db, req, today = localToday(doorSettings(db).tz)) {
  const roomId = Number(req.roomId);
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ? AND id > 0').get(roomId)) throw userError('Choose a room that exists in Beds24.');
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(Date.parse(s)) === s;
  if (!isDate(req.from) || !isDate(req.to)) throw userError('Choose a start and end date.');
  if (req.to < req.from) throw userError('The end date is before the start date.');
  if (req.from < today) throw userError('Past dates can\'t be changed.');
  if (diffDays(req.from, req.to) >= 500) throw userError('Change at most 500 nights at a time.');

  const price = req.price === '' || req.price == null ? null : Number(req.price);
  if (price != null && !(price >= 1 && price <= 100000)) throw userError('Price must be between $1 and $100,000.');
  const minStay = req.minStay === '' || req.minStay == null ? null : Number(req.minStay);
  if (minStay != null && !(Number.isInteger(minStay) && minStay >= 1 && minStay <= 365)) throw userError('Minimum stay must be a whole number of nights from 1 to 365.');
  const block = req.block === 'block' ? true : req.block === 'unblock' ? false : null;
  if (price == null && minStay == null && block == null) throw userError('Enter a price, a minimum stay, or choose to block or open the dates.');
  const weekdays = Array.isArray(req.weekdays) && req.weekdays.length ? req.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  if (!weekdays.every(w => Number.isInteger(w) && w >= 0 && w <= 6)) throw userError('Invalid weekday selection.');

  const days = readDays(db, roomId, req.from, diffDays(req.from, req.to) + 1).filter(d => weekdays.includes(weekday(d.date)));
  if (!days.length) throw userError('None of the selected weekdays fall in that date range.');
  const rounded = price == null ? null : Math.round(price * 100) / 100;
  const changes = [];
  for (const d of days) {
    const after = {
      price: rounded ?? d.price, minStay: minStay ?? d.minStay, blocked: block ?? d.blocked,
    };
    const differs = !d.known || after.price !== d.price || after.minStay !== d.minStay || after.blocked !== d.blocked;
    if (differs) changes.push({ date: d.date, before: { price: d.price, minStay: d.minStay, blocked: d.blocked, known: d.known }, after, booked: d.booking?.guest || (d.booking ? 'Booked' : null) });
  }

  const warnings = [];
  const drops = changes.filter(c => c.before.price && c.after.price < c.before.price * 0.6);
  if (drops.length) warnings.push(`${drops.length} night${drops.length > 1 ? 's' : ''} would drop more than 40% (e.g. ${money(drops[0].before.price)} → ${money(drops[0].after.price)}). Double-check the amount.`);
  const booked = changes.filter(c => c.booked);
  if (booked.length) warnings.push(`${booked.length} of these nights ${booked.length > 1 ? 'are' : 'is'} already booked. Existing bookings keep their price, and blocking doesn't cancel them.`);
  if (changes.some(c => !c.before.known)) warnings.push('Current values for some nights haven\'t been loaded from Beds24 yet, so those nights will be sent as-is.');

  const parts = [];
  if (rounded != null) parts.push(`Price ${money(rounded)}`);
  if (minStay != null) parts.push(`Min stay ${minStay} night${minStay > 1 ? 's' : ''}`);
  if (block != null) parts.push(block ? 'Blocked' : 'Opened');
  if (weekdays.length < 7) parts.push(`(${weekdays.slice().sort().map(w => DAYS[w]).join(', ')} only)`);

  return {
    roomId, from: req.from, to: req.to, selected: days.length, changes, warnings, summary: parts.join(' · '),
    fields: { price: rounded, minStay, block },
  };
}

/** Group consecutive changed nights into the from/to ranges Beds24 expects. */
export function toCalendarRanges(plan) {
  const ranges = [];
  for (const c of plan.changes) {
    const fields = {};
    if (plan.fields.price != null) fields.price1 = plan.fields.price;
    if (plan.fields.minStay != null) fields.minStay = plan.fields.minStay;
    if (plan.fields.block != null) fields.override = plan.fields.block ? 'blackout' : 'none';
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.to, 1) === c.date) last.to = c.date;
    else ranges.push({ from: c.date, to: c.date, ...fields });
  }
  return ranges;
}

/** Send a planned change to Beds24, confirm it by re-reading the calendar, and log it. */
export async function applyChanges(db, client, req) {
  const plan = planChanges(db, req);
  if (!plan.changes.length) return { applied: 0, summary: plan.summary, warnings: ['Nothing to change: those nights already have these values.'] };
  const log = db.prepare(`INSERT INTO change_log(at,room_id,date_from,date_to,nights,summary,ok,error) VALUES(?,?,?,?,?,?,?,?)`);
  const at = new Date().toISOString();
  const first = plan.changes[0].date, last = plan.changes[plan.changes.length - 1].date;

  let response;
  try {
    response = await client.post('/inventory/rooms/calendar', [{ roomId: plan.roomId, calendar: toCalendarRanges(plan) }]);
    const items = Array.isArray(response) ? response : [response];
    const errors = items.flatMap(i => (i?.errors || []).map(e => e.message || e.field || 'error'));
    if (errors.length || items.some(i => i?.success === false)) throw new Error('Beds24 rejected the change: ' + (errors.join('; ') || 'unknown error'));
  } catch (e) {
    log.run(at, plan.roomId, first, last, plan.changes.length, plan.summary, 0, e.message);
    throw e;
  }

  const warnings = (Array.isArray(response) ? response : [response]).flatMap(i => (i?.warnings || []).map(w => `Beds24: ${w.message || w.field}`));
  // Re-read what Beds24 now holds for those nights, and flag anything that didn't come out as sent.
  try {
    await syncCalendar(db, client, first, last);
    const now = new Map(readDays(db, plan.roomId, first, diffDays(first, last) + 1).map(d => [d.date, d]));
    const off = plan.changes.filter(c => {
      const d = now.get(c.date);
      return !d || (plan.fields.price != null && d.price !== c.after.price) ||
        (plan.fields.minStay != null && d.minStay !== c.after.minStay) || (plan.fields.block != null && d.blocked !== c.after.blocked);
    });
    if (off.length) warnings.push(`Beds24 shows different values for ${off.length} night${off.length > 1 ? 's' : ''} than were sent (first: ${off[0].date}). A Beds24 rule, such as a linked or channel price, may be overriding them.`);
  } catch (e) {
    warnings.push(`The change was sent, but re-checking it in Beds24 failed: ${e.message}`);
  }
  log.run(at, plan.roomId, first, last, plan.changes.length, plan.summary, 1, warnings.length ? warnings.join(' ') : null);
  return { applied: plan.changes.length, summary: plan.summary, warnings };
}

export const recentChanges = (db, limit = 30) => db.prepare(
  `SELECT c.*, r.name room_name FROM change_log c LEFT JOIN rooms r ON r.id = c.room_id ORDER BY c.id DESC LIMIT ?`).all(limit);
