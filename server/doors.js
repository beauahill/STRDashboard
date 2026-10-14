// Door codes: one code per booking (last digits of the guest's phone), programmed on every lock of the
// booking's room for the length of the stay, kept in step with date changes and cancellations, and
// written onto the Beds24 booking so the check-in message can include it.
import { createHash } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { addDays } from './sync.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });

export const DOOR_DEFAULTS = { checkin: '16:00', checkout: '11:00', tz: 'America/Denver', lookahead: 14, beds24Field: 10, auto: false };

export function doorSettings(db) {
  const get = (k, d) => getSetting(db, `door_${k}`) ?? d;
  return {
    checkin: get('checkin', DOOR_DEFAULTS.checkin), checkout: get('checkout', DOOR_DEFAULTS.checkout),
    tz: get('tz', DOOR_DEFAULTS.tz), lookahead: Number(get('lookahead', DOOR_DEFAULTS.lookahead)),
    beds24Field: Number(get('beds24Field', DOOR_DEFAULTS.beds24Field)), auto: get('auto', '0') === '1',
  };
}

export function saveDoorSettings(db, s) {
  const time = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (s.checkin != null && !time(s.checkin)) throw userError('Check-in time must look like 16:00.');
  if (s.checkout != null && !time(s.checkout)) throw userError('Checkout time must look like 11:00.');
  if (s.tz != null) { try { new Intl.DateTimeFormat('en-US', { timeZone: s.tz }); } catch { throw userError(`Unknown time zone "${s.tz}".`); } }
  if (s.lookahead != null && !(Number.isInteger(+s.lookahead) && +s.lookahead >= 1 && +s.lookahead <= 60)) throw userError('Create codes 1 to 60 days before arrival.');
  if (s.beds24Field != null && !(Number.isInteger(+s.beds24Field) && +s.beds24Field >= 0 && +s.beds24Field <= 10)) throw userError('Beds24 field must be 1 to 10, or 0 for none.');
  for (const k of ['checkin', 'checkout', 'tz', 'lookahead', 'beds24Field']) if (s[k] != null) setSetting(db, `door_${k}`, String(s[k]));
  if (s.auto != null) setSetting(db, 'door_auto', s.auto ? '1' : '0');
  return doorSettings(db);
}

/** UTC instant for a wall-clock date and time in an IANA time zone (DST-aware). */
export function zonedTimeToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - tzOffset(t, tz);
  return new Date(t).toISOString();
}
function tzOffset(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
export const localToday = (tz, now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now));

const weak = c => /^(\d)\1+$/.test(c) || '01234567890'.includes(c) || '09876543210'.includes(c);

/** Code options for a booking, best first: last 4/5/6 phone digits, then stable random 4-digit codes. */
export function codeCandidates(booking) {
  const digits = (booking.phone || '').replace(/\D/g, '');
  const out = [];
  for (const n of [4, 5, 6]) if (digits.length >= n && !weak(digits.slice(-n))) out.push(digits.slice(-n));
  for (let i = 0; out.length < 60 && i < 500; i++) {
    const c = String(parseInt(createHash('sha256').update(`${booking.id}:${i}`).digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0');
    if (!weak(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

const locksForRoom = (db, roomId) => db.prepare('SELECT * FROM locks WHERE room_id = ? ORDER BY name').all(roomId);
const json = v => JSON.stringify(v || []);

/** Every code currently on a lock (ours and others), keyed by device. Used for conflicts and the Locks page. */
async function readLockCodes(seam, deviceIds) {
  const out = {};
  for (const id of deviceIds) {
    const [managed, unmanaged] = await Promise.all([seam.accessCodes(id), seam.unmanagedCodes(id).catch(() => [])]);
    out[id] = { managed, unmanaged };
  }
  return out;
}

/**
 * Refresh the lock list from Seam, keeping each lock's room assignment. A lock Seam stops listing is flagged `missing`
 * (and left alone) rather than deleted, and a list with no locks at all is refused while locks are known: a key for
 * another workspace, or a Yale account that came unlinked, mustn't wipe the setup and silence every door alert.
 */
export async function refreshLocks(db, seam) {
  const devices = (await seam.devices()).filter(d => d.can_program_online_access_codes === true || /lock/i.test(d.device_type || ''));
  if (!devices.length && db.prepare('SELECT 1 FROM locks').get()) throw userError('Seam listed no locks — is this the right workspace key, and is the Yale account still connected? Nothing was changed.');
  const now = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO locks(device_id,name,online,battery,can_program,missing,updated_at) VALUES(?,?,?,?,?,0,?)
    ON CONFLICT(device_id) DO UPDATE SET name=excluded.name, online=excluded.online, battery=excluded.battery,
    can_program=excluded.can_program, missing=0, updated_at=excluded.updated_at`);
  for (const d of devices) {
    upsert.run(d.device_id, d.display_name || d.properties?.name || d.device_id, d.properties?.online ? 1 : 0,
      d.properties?.battery_level ?? null, d.can_program_online_access_codes === false ? 0 : 1, now);
  }
  const ids = devices.map(d => d.device_id);
  db.prepare(`UPDATE locks SET missing = 1, online = 0 WHERE device_id NOT IN (${ids.map(() => '?').join(',') || "''"})`).run(...ids);
  return devices.length;
}

export function assignLock(db, deviceId, roomId) {
  if (!db.prepare('SELECT 1 FROM locks WHERE device_id = ?').get(deviceId)) throw userError('Unknown lock.');
  if (roomId != null && !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) throw userError('Unknown room.');
  db.prepare('UPDATE locks SET room_id = ? WHERE device_id = ?').run(roomId, deviceId);
}

/**
 * Bring every lock in line with the bookings. Safe to run repeatedly: it only changes what differs.
 * Returns counts plus any problems, which are also stored per booking for the dashboard.
 */
export async function reconcileDoorCodes(db, seam, beds24, now = Date.now()) {
  const s = doorSettings(db);
  const result = { created: 0, updated: 0, removed: 0, problems: [] };
  if (!s.auto || !seam?.apiKey) return { ...result, skipped: !s.auto ? 'automatic codes are off' : 'no Seam API key' };
  // A lock Seam has stopped listing keeps its room but is out of reach: nothing is written to it or removed from it.
  const assigned = db.prepare('SELECT * FROM locks WHERE room_id IS NOT NULL ORDER BY name').all();
  const locks = assigned.filter(l => !l.missing);
  const missing = new Set(db.prepare('SELECT device_id FROM locks WHERE missing = 1').all().map(l => l.device_id));
  if (!locks.length) return { ...result, skipped: 'no locks assigned to a room' };

  const today = localToday(s.tz, now);
  const lockCodes = await readLockCodes(seam, locks.map(l => l.device_id));
  const stamp = new Date(now).toISOString();
  const rooms = [...new Set(locks.map(l => l.room_id))];

  // Active Beds24 stays on rooms with locks: anything not yet checked out (departure day included, so the
  // code isn't removed before the checkout time) that starts within the window,
  // plus stays that already have a code (so a date change further out still updates rather than orphans it).
  const targets = db.prepare(`
    SELECT b.* FROM bookings b WHERE b.source = 'beds24' AND b.status IN ('confirmed','new')
      AND b.room_id IN (${rooms.map(() => '?').join(',')}) AND b.departure >= ?
      AND (b.arrival <= ? OR b.id IN (SELECT booking_id FROM door_codes)) ORDER BY b.arrival, b.id`).all(...rooms, today, addDays(today, s.lookahead));
  const targetIds = new Set(targets.map(b => b.id));
  const order = new Map(targets.map((b, i) => [b.id, i]));
  // Which guest each code on the locks belongs to: two guests' codes must never push each other around.
  const owner = new Map(db.prepare('SELECT access_code_id, booking_id FROM door_code_devices WHERE access_code_id IS NOT NULL').all()
    .map(r => [r.access_code_id, r.booking_id]));

  // Delete one booking's code from one lock. A lock no longer assigned to a room isn't in lockCodes, so its code is
  // deleted directly; Seam saying it's already gone counts as done. Returns false if it had to stay.
  const removeFromLock = async dev => {
    if (missing.has(dev.device_id)) return false;   // out of Seam's sight: the code comes off once the lock is listed again
    const known = lockCodes[dev.device_id];
    const there = dev.access_code_id && (known ? known.managed.some(c => c.access_code_id === dev.access_code_id) : true);
    if (there) {
      try { await seam.deleteCode(dev.access_code_id); result.removed++; }
      catch (e) {
        if (!/not_found/.test(e.seamType || '') && !/not found/i.test(e.message)) { result.problems.push({ bookingId: dev.booking_id, message: e.message }); return false; }
      }
    }
    db.prepare('DELETE FROM door_code_devices WHERE booking_id = ? AND device_id = ?').run(dev.booking_id, dev.device_id);
    return true;
  };

  // 1. Remove codes for stays that were cancelled (or gone from Beds24), moved to a room without locks, or have ended.
  for (const row of db.prepare('SELECT * FROM door_codes').all()) {
    if (targetIds.has(row.booking_id)) continue;
    for (const dev of db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ?').all(row.booking_id)) await removeFromLock(dev);
    if (!db.prepare('SELECT 1 FROM door_code_devices WHERE booking_id = ?').get(row.booking_id)) {
      db.prepare('DELETE FROM door_codes WHERE booking_id = ?').run(row.booking_id);
    }
  }
  // Codes with this app's naming that nothing tracks (a create whose answer was lost) are deleted once their window is over.
  for (const lock of locks) {
    const codes = lockCodes[lock.device_id];
    for (const c of codes.managed) {
      if (owner.has(c.access_code_id) || !OWN_NAME.test(c.name || '') || !c.ends_at || Date.parse(c.ends_at) > now) continue;
      try { await seam.deleteCode(c.access_code_id); result.removed++; codes.managed = codes.managed.filter(x => x !== c); }
      catch (e) { if (!/not_found/.test(e.seamType || '') && !/not found/i.test(e.message)) result.problems.push({ lock: lock.name, message: e.message }); }
    }
  }

  // 2. Create or update codes for each upcoming stay.
  for (const b of targets) {
    const roomLocks = locks.filter(l => l.room_id === b.room_id);
    // The stay moved to another room (or a lock was reassigned): its code comes off locks that no longer serve it.
    for (const dev of db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ?').all(b.id)) {
      if (!assigned.some(l => l.room_id === b.room_id && l.device_id === dev.device_id)) await removeFromLock(dev);
    }
    let row = db.prepare('SELECT * FROM door_codes WHERE booking_id = ?').get(b.id);
    const startsAt = zonedTimeToUtc(b.arrival, s.checkin, s.tz), endsAt = zonedTimeToUtc(b.departure, s.checkout, s.tz);
    const over = Date.parse(endsAt) <= now;
    if (!row && over) continue;   // checkout time has passed: nothing to put on the lock
    const name = `${(b.guest_name || 'Guest').slice(0, 24)} ${b.arrival}`;
    const ours = new Set(db.prepare('SELECT access_code_id FROM door_code_devices WHERE booking_id = ?').all(b.id).map(r => r.access_code_id));
    // Codes this stay must avoid, and whose they are: everything on its locks except other guests' codes (and a code of
    // its own whose creation went unrecorded, adopted below), plus every other stay's code on this room. When two stays
    // hold the same code the earlier arrival keeps it and the later one moves.
    const inUse = new Map();
    for (const l of roomLocks) {
      const { managed, unmanaged } = lockCodes[l.device_id];
      for (const c of [...managed.filter(c => !ours.has(c.access_code_id) && !owner.has(c.access_code_id) && !(c.name === name && c.code === row?.code)), ...unmanaged]) {
        if (c.code) inUse.set(c.code, c.name || 'another code');
      }
    }
    for (const r of db.prepare('SELECT d.booking_id, d.code, x.guest_name FROM door_codes d JOIN bookings x ON x.id = d.booking_id WHERE x.room_id = ? AND d.booking_id != ?').all(b.room_id, b.id)) {
      if (r.code !== row?.code || !order.has(r.booking_id) || order.get(r.booking_id) < order.get(b.id)) inUse.set(r.code, r.guest_name || 'another guest');
    }

    // A lock refusing the code as a duplicate (e.g. the same code exists on the lock but isn't visible to
    // Seam) means: pick the next option now, based on what Seam reports at this moment.
    const refused = roomLocks.some(l => lockCodes[l.device_id].managed.some(c => ours.has(c.access_code_id) &&
      (c.errors || []).some(e => /duplicate_code_on_device|code_constraints_violated/.test(e.error_code))));
    // A guest who already has the code (the stay has begun, or it's on the Beds24 booking with check-in within a day,
    // so the check-in message may have gone out) is never moved to another code behind their back: the owner is told
    // to change the other code instead, on the dashboard and the phone.
    const told = !!row && (Date.parse(startsAt) <= now || (row.beds24_written === row.code && b.arrival <= addDays(today, 1)));
    let clash = null;
    if (!row || refused || inUse.has(row.code)) {
      if (told) {
        clash = `Code ${row.code} clashes with ${inUse.has(row.code) ? `"${inUse.get(row.code)}"` : 'another code the lock can see'}; the guest already has it, so change the other code.`;
        result.problems.push({ bookingId: b.id, message: clash });
      } else {
        const code = codeCandidates(b).find(c => !inUse.has(c) && c !== row?.code);
        if (!code) { result.problems.push({ bookingId: b.id, message: 'No free door code could be found for this stay.' }); continue; }
        if (!row) {
          db.prepare('INSERT INTO door_codes(booking_id,code,created_at,updated_at) VALUES(?,?,?,?)').run(b.id, code, stamp, stamp);
        } else {
          db.prepare('UPDATE door_codes SET code = ?, updated_at = ? WHERE booking_id = ?').run(code, stamp, b.id);
        }
        row = db.prepare('SELECT * FROM door_codes WHERE booking_id = ?').get(b.id);
      }
    }
    db.prepare('UPDATE door_codes SET starts_at = ?, ends_at = ? WHERE booking_id = ?').run(startsAt, endsAt, b.id);
    // Seam wants a start in the future: a stay already under way starts a minute from now (the real time is kept above).
    const sendStart = new Date(Math.max(Date.parse(startsAt), now + 60e3)).toISOString();

    for (const lock of roomLocks) {
      const dev = db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ? AND device_id = ?').get(b.id, lock.device_id);
      const { managed } = lockCodes[lock.device_id];
      // A code this app created for the stay but never recorded (the answer was lost) is adopted, not made twice.
      const current = (dev?.access_code_id && managed.find(c => c.access_code_id === dev.access_code_id))
        || managed.find(c => c.name === name && c.code === row.code && !owner.has(c.access_code_id));
      let code = current, error = clash;
      try {
        if (!current) {
          if (over) continue;
          code = await seam.createCode({ device_id: lock.device_id, name, code: row.code, starts_at: sendStart, ends_at: endsAt });
          result.created++;
        } else if (current.code !== row.code || !sameTime(current.starts_at, startsAt, now + 60e3) || !sameTime(current.ends_at, endsAt)) {
          // A start that has passed isn't sent as a past instant either: the lock keeps the start it has, or gets "a minute from now".
          const start = Date.parse(startsAt) > now ? startsAt : Date.parse(current.starts_at) <= now ? current.starts_at : sendStart;
          await seam.updateCode({ access_code_id: current.access_code_id, code: row.code, starts_at: start, ends_at: endsAt, name });
          code = { ...current, code: row.code, starts_at: start, ends_at: endsAt, errors: [], status: 'setting' };
          result.updated++;
        }
      } catch (e) {
        error = e.message;
        result.problems.push({ bookingId: b.id, lock: lock.name, message: e.message });
      }
      db.prepare(`INSERT OR REPLACE INTO door_code_devices(booking_id,device_id,access_code_id,status,scheduled,errors,warnings,error,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(b.id, lock.device_id, code?.access_code_id ?? dev?.access_code_id ?? null, code?.status ?? null,
        code?.is_scheduled_on_device ? 1 : 0, json(code?.errors), json(code?.warnings), error, stamp);
      for (const e of code?.errors || []) result.problems.push({ bookingId: b.id, lock: lock.name, message: e.message || e.error_code });
    }

    // 3. Put the code on the Beds24 booking so the check-in message can include it.
    if (s.beds24Field && beds24?.connected && row.beds24_written !== row.code) {
      try {
        const res = await beds24.post('/bookings', [{ id: b.id, [`custom${s.beds24Field}`]: row.code }]);
        const errs = (Array.isArray(res) ? res : [res]).flatMap(r => (r?.errors || []).map(e => e.message || e.field));
        if (errs.length) throw new Error(errs.join('; '));
        db.prepare('UPDATE door_codes SET beds24_written = ?, beds24_error = NULL WHERE booking_id = ?').run(row.code, b.id);
      } catch (e) {
        const msg = e.status === 403 ? 'Beds24 invite code needs write access to bookings to save the door code.' : e.message;
        db.prepare('UPDATE door_codes SET beds24_error = ? WHERE booking_id = ?').run(msg, b.id);
        result.problems.push({ bookingId: b.id, message: msg });
      }
    }
  }
  setSetting(db, 'door_last_run', stamp);
  setSetting(db, 'door_last_problems', JSON.stringify(result.problems));
  return result;
}

// The same instant; or, given `by`, both at or before it (a start that has passed, or was sent as "a minute from now", needn't be re-sent).
const sameTime = (a, b, by) => !!a && !!b && (Date.parse(a) === Date.parse(b) || (by != null && Date.parse(a) <= by && Date.parse(b) <= by));
const OWN_NAME = /^.{1,24} \d{4}-\d{2}-\d{2}$/;   // how this app names its codes: guest name and arrival date

/** How a booking's code stands on each lock: set, scheduled (normal before check-in), pending, error or missing. */
export function codeState(dev, startsAt, now = Date.now()) {
  if (!dev) return { state: 'missing', label: 'Not on lock yet' };
  const errors = JSON.parse(dev.errors || '[]');
  if (dev.error || errors.length) return { state: 'error', label: dev.error || errors.map(e => e.message || e.error_code).join('; ') };
  if (dev.status === 'set') return { state: 'set', label: 'On the lock' };
  if (startsAt && Date.parse(startsAt) > now) return { state: 'scheduled', label: dev.scheduled ? 'Scheduled on the lock' : 'Goes on the lock at check-in' };
  // Right at check-in the stored status is still the one read before it; give the lock time to report "set".
  if (startsAt && Date.parse(startsAt) + 45 * 60e3 > now) return { state: 'scheduled', label: 'Going on the lock now' };
  return { state: 'pending', label: 'Being set on the lock' };
}

/** Door code + per-lock state for the given bookings, for the dashboard and Locks page. */
export function doorCodesFor(db, bookingIds, now = Date.now()) {
  const out = {};
  if (!bookingIds.length) return out;
  const locks = Object.fromEntries(db.prepare('SELECT device_id, name FROM locks').all().map(l => [l.device_id, l.name]));
  for (const row of db.prepare(`SELECT * FROM door_codes WHERE booking_id IN (${bookingIds.map(() => '?').join(',')})`).all(...bookingIds)) {
    const devs = db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ?').all(row.booking_id);
    const perLock = devs.map(d => ({ lock: locks[d.device_id] || d.device_id, ...codeState(d, row.starts_at, now) }));
    const ok = perLock.length > 0 && perLock.every(l => ['set', 'scheduled'].includes(l.state));
    out[row.booking_id] = { code: row.code, startsAt: row.starts_at, endsAt: row.ends_at, perLock, ok,
      beds24: row.beds24_error ? { ok: false, message: row.beds24_error } : { ok: row.beds24_written === row.code } };
  }
  return out;
}

/**
 * Confirmed Beds24 stays at a room with a lock that are under way or arrive in the next `days` days (within the code
 * window) and don't have a working code on every lock; or one alert when automatic codes are on, a guest is coming and
 * no lock is assigned to a room (or Seam no longer lists any). Empty when automatic guest codes are off.
 */
export function doorAlerts(db, { days = 3, now = Date.now() } = {}) {
  const ds = doorSettings(db);
  if (!ds.auto) return [];
  const today = localToday(ds.tz, now), limit = addDays(today, Math.min(days, ds.lookahead));
  const locks = db.prepare('SELECT room_id, missing FROM locks WHERE room_id IS NOT NULL').all();
  const lockRooms = new Set(locks.map(l => l.room_id)), present = new Set(locks.filter(l => !l.missing).map(l => l.room_id));
  const soon = db.prepare(`SELECT id, guest_name, arrival, departure, room_id, first_seen, modified_at FROM bookings WHERE status IN ('confirmed','new')
    AND source = 'beds24' AND departure >= ? AND arrival <= ? ORDER BY arrival, id`).all(today, limit)
    .filter(b => Date.parse(zonedTimeToUtc(b.departure, ds.checkout, ds.tz)) > now);   // checked out already: nothing to open
  const item = (b, problem) => ({ id: b.id, guest: b.guest_name, arrival: b.arrival, firstSeen: b.first_seen, inHouse: b.arrival < today, checkin: b.arrival === today, problem });
  if (!present.size) return soon.length ? [item(soon[0], lockRooms.size ? 'Seam no longer lists any lock' : 'No lock is assigned to a room')] : [];
  const stays = soon.filter(b => lockRooms.has(b.room_id));
  const codes = doorCodesFor(db, stays.map(b => b.id), now);
  // A stay changed since the last code run hasn't had its turn yet: no code isn't a problem until a run has looked.
  const lastRun = Date.parse(getSetting(db, 'door_last_run'));
  const looked = b => lastRun >= (Date.parse(b.modified_at) || Date.parse(b.first_seen) || 0);
  const out = [];
  for (const b of stays) {
    const c = codes[b.id];
    if (c?.ok) continue;
    const failing = c?.perLock.find(l => !['set', 'scheduled'].includes(l.state))?.label;
    if (failing) out.push(item(b, failing));
    else if (!present.has(b.room_id)) out.push(item(b, "Seam no longer lists this room's lock"));
    else if (looked(b)) out.push(item(b, 'No door code yet'));
  }
  return out;
}

/** Refuse a code that a current or upcoming guest has on a lock of the same room: it would be swapped from under them. */
function refuseGuestCode(db, code, deviceIds) {
  const g = db.prepare(`SELECT b.guest_name, b.arrival FROM door_codes d JOIN bookings b ON b.id = d.booking_id
    WHERE d.code = ? AND b.status IN ('confirmed','new') AND b.departure >= ? AND b.room_id IN
      (SELECT room_id FROM locks WHERE room_id IS NOT NULL AND device_id IN (${deviceIds.map(() => '?').join(',') || "''"}))`)
    .get(code, localToday(doorSettings(db).tz), ...deviceIds);
  if (g) throw userError(`${code} is ${g.guest_name || 'a guest'}'s door code (stay starting ${g.arrival}). Choose another code.`);
}

/**
 * Choose a specific code for one booking (e.g. the guest asked for a different one). Applied on the next
 * reconcile. `otherCodes` (from lockOverview) is used to refuse a code already used by someone else, which
 * would otherwise be swapped straight back out.
 */
export function setBookingCode(db, bookingId, code, otherCodes = []) {
  if (!/^\d{4,8}$/.test(code || '')) throw userError('Door codes must be 4 to 8 digits.');
  if (!db.prepare('SELECT 1 FROM door_codes WHERE booking_id = ?').get(bookingId)) throw userError('This booking has no door code yet.');
  const clash = otherCodes.find(c => c.code === code);
  if (clash) throw userError(`${code} is already used by "${clash.name}" on the locks. Choose another code.`);
  if (db.prepare('SELECT 1 FROM door_codes WHERE code = ? AND booking_id != ?').get(code, bookingId)) throw userError(`${code} is already another guest's code. Choose another code.`);
  db.prepare('UPDATE door_codes SET code = ?, updated_at = ? WHERE booking_id = ?').run(code, new Date().toISOString(), bookingId);
}

/** Everything on each assigned lock, with guest codes linked to their booking and other codes grouped across locks. */
export async function lockOverview(db, seam) {
  const locks = db.prepare(`SELECT l.*, r.name room_name FROM locks l LEFT JOIN rooms r ON r.id = l.room_id ORDER BY l.name`).all();
  const codes = await readLockCodes(seam, locks.filter(l => !l.missing).map(l => l.device_id));
  const guestIds = new Set(db.prepare('SELECT access_code_id FROM door_code_devices WHERE access_code_id IS NOT NULL').all().map(r => r.access_code_id));
  const groups = new Map();
  for (const l of locks) {
    if (!codes[l.device_id]) continue;   // missing from Seam: nothing to read
    for (const c of [...codes[l.device_id].managed, ...codes[l.device_id].unmanaged]) {
      if (guestIds.has(c.access_code_id)) continue;
      const key = `${c.name || ''}|${c.code || ''}`;
      if (!groups.has(key)) groups.set(key, { name: c.name || '(no name)', code: c.code || null, startsAt: c.starts_at || null, endsAt: c.ends_at || null, locks: [] });
      groups.get(key).locks.push({ deviceId: l.device_id, lock: l.name, accessCodeId: c.access_code_id, managed: c.is_managed !== false,
        status: c.status, errors: (c.errors || []).map(e => e.message || e.error_code) });
    }
  }
  return { locks, otherCodes: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Change the digits (and optionally name) of a non-guest code on every lock it's on. Yale-app codes are taken over by
 * Seam first. With `db`, a guest's current code is refused.
 */
export async function changeOtherCode(seam, entries, { code, name }, db = null) {
  if (!/^\d{4,8}$/.test(code || '')) throw userError('Door codes must be 4 to 8 digits.');
  if (db) refuseGuestCode(db, code, entries.map(e => e.deviceId));
  for (const e of entries) {
    if (!e.managed) await seam.convertToManaged(e.accessCodeId);
    await seam.updateCode({ access_code_id: e.accessCodeId, code, ...(name && { name }) });
  }
}

export async function deleteOtherCode(seam, entries) {
  for (const e of entries) {
    if (!e.managed) await seam.convertToManaged(e.accessCodeId);
    await seam.deleteCode(e.accessCodeId);
  }
}

/** Add a code (permanent, or between two times) to one or more locks. */
export async function addCode(db, seam, { name, code, deviceIds, startsAt, endsAt }) {
  // A date and time without a zone (from a datetime-local field) is the property's local time, not the server's UTC.
  const local = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v) ? zonedTimeToUtc(v.slice(0, 10), v.slice(11, 16), doorSettings(db).tz) : v);
  startsAt = local(startsAt); endsAt = local(endsAt);
  if (!name?.trim()) throw userError('Give the code a name, e.g. "Cleaner".');
  if (!/^\d{4,8}$/.test(code || '')) throw userError('Door codes must be 4 to 8 digits.');
  if (!Array.isArray(deviceIds) || !deviceIds.length) throw userError('Choose at least one lock.');
  for (const id of deviceIds) if (!db.prepare('SELECT 1 FROM locks WHERE device_id = ?').get(id)) throw userError('Unknown lock.');
  refuseGuestCode(db, code, deviceIds);
  if ((startsAt && !endsAt) || (!startsAt && endsAt)) throw userError('Give both a start and an end, or neither for a permanent code.');
  if (startsAt && !(Date.parse(endsAt) > Date.parse(startsAt))) throw userError('The end must be after the start.');
  for (const id of deviceIds) {
    await seam.createCode({ device_id: id, name: name.trim(), code, ...(startsAt && { starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() }) });
  }
}
