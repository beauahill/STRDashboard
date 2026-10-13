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
  for (const n of [4, 5, 6]) if (digits.length >= n) out.push(digits.slice(-n));
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

/** Refresh the lock list from Seam, keeping each lock's room assignment. */
export async function refreshLocks(db, seam) {
  const devices = (await seam.devices()).filter(d => d.can_program_online_access_codes === true || /lock/i.test(d.device_type || ''));
  const now = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO locks(device_id,name,online,battery,can_program,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET name=excluded.name, online=excluded.online, battery=excluded.battery,
    can_program=excluded.can_program, updated_at=excluded.updated_at`);
  for (const d of devices) {
    upsert.run(d.device_id, d.display_name || d.properties?.name || d.device_id, d.properties?.online ? 1 : 0,
      d.properties?.battery_level ?? null, d.can_program_online_access_codes === false ? 0 : 1, now);
  }
  const ids = devices.map(d => d.device_id);
  db.prepare(`DELETE FROM locks WHERE device_id NOT IN (${ids.map(() => '?').join(',') || "''"})`).run(...ids);
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
  const locks = db.prepare('SELECT * FROM locks WHERE room_id IS NOT NULL ORDER BY name').all();
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
      AND (b.arrival <= ? OR b.id IN (SELECT booking_id FROM door_codes))`).all(...rooms, today, addDays(today, s.lookahead));
  const targetIds = new Set(targets.map(b => b.id));

  // 1. Remove codes for stays that were cancelled, moved to a room without locks, or have ended.
  for (const row of db.prepare('SELECT * FROM door_codes').all()) {
    if (targetIds.has(row.booking_id)) continue;
    for (const dev of db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ?').all(row.booking_id)) {
      const stillThere = dev.access_code_id && lockCodes[dev.device_id]?.managed.some(c => c.access_code_id === dev.access_code_id);
      if (stillThere) {
        try { await seam.deleteCode(dev.access_code_id); result.removed++; }
        catch (e) { result.problems.push({ bookingId: row.booking_id, message: e.message }); continue; }
      }
      db.prepare('DELETE FROM door_code_devices WHERE booking_id = ? AND device_id = ?').run(row.booking_id, dev.device_id);
    }
    if (!db.prepare('SELECT 1 FROM door_code_devices WHERE booking_id = ?').get(row.booking_id)) {
      db.prepare('DELETE FROM door_codes WHERE booking_id = ?').run(row.booking_id);
    }
  }

  // 2. Create or update codes for each upcoming stay.
  for (const b of targets) {
    const roomLocks = locks.filter(l => l.room_id === b.room_id);
    const ours = new Set(db.prepare('SELECT access_code_id FROM door_code_devices WHERE booking_id = ?').all(b.id).map(r => r.access_code_id));
    const inUse = new Set(roomLocks.flatMap(l => [...lockCodes[l.device_id].managed.filter(c => !ours.has(c.access_code_id)), ...lockCodes[l.device_id].unmanaged])
      .map(c => c.code).filter(Boolean));
    let row = db.prepare('SELECT * FROM door_codes WHERE booking_id = ?').get(b.id);

    // A lock refusing the code as a duplicate (e.g. the same code exists on the lock but isn't visible to
    // Seam) means: pick the next option now, based on what Seam reports at this moment.
    const refused = roomLocks.some(l => lockCodes[l.device_id].managed.some(c => ours.has(c.access_code_id) &&
      (c.errors || []).some(e => /duplicate_code_on_device|code_constraints_violated/.test(e.error_code))));
    if (!row || refused || inUse.has(row.code)) {
      const code = codeCandidates(b).find(c => !inUse.has(c) && c !== row?.code);
      if (!code) { result.problems.push({ bookingId: b.id, message: 'No free door code could be found for this stay.' }); continue; }
      if (!row) {
        db.prepare('INSERT INTO door_codes(booking_id,code,created_at,updated_at) VALUES(?,?,?,?)').run(b.id, code, stamp, stamp);
      } else {
        db.prepare('UPDATE door_codes SET code = ?, updated_at = ? WHERE booking_id = ?').run(code, stamp, b.id);
      }
      row = db.prepare('SELECT * FROM door_codes WHERE booking_id = ?').get(b.id);
    }
    const startsAt = zonedTimeToUtc(b.arrival, s.checkin, s.tz), endsAt = zonedTimeToUtc(b.departure, s.checkout, s.tz);
    db.prepare('UPDATE door_codes SET starts_at = ?, ends_at = ? WHERE booking_id = ?').run(startsAt, endsAt, b.id);
    const name = `${(b.guest_name || 'Guest').slice(0, 24)} ${b.arrival}`;

    for (const lock of roomLocks) {
      const dev = db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ? AND device_id = ?').get(b.id, lock.device_id);
      const current = dev?.access_code_id && lockCodes[lock.device_id].managed.find(c => c.access_code_id === dev.access_code_id);
      let code = current, error = null;
      try {
        if (!current) {
          code = await seam.createCode({ device_id: lock.device_id, name, code: row.code, starts_at: startsAt, ends_at: endsAt });
          result.created++;
        } else if (current.code !== row.code || !sameTime(current.starts_at, startsAt) || !sameTime(current.ends_at, endsAt)) {
          await seam.updateCode({ access_code_id: current.access_code_id, code: row.code, starts_at: startsAt, ends_at: endsAt, name });
          code = { ...current, code: row.code, starts_at: startsAt, ends_at: endsAt, errors: [], status: 'setting' };
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

const sameTime = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);

/** How a booking's code stands on each lock: set, scheduled (normal before check-in), pending, error or missing. */
export function codeState(dev, startsAt, now = Date.now()) {
  if (!dev) return { state: 'missing', label: 'Not on lock yet' };
  const errors = JSON.parse(dev.errors || '[]');
  if (dev.error || errors.length) return { state: 'error', label: dev.error || errors.map(e => e.message || e.error_code).join('; ') };
  if (dev.status === 'set') return { state: 'set', label: 'On the lock' };
  if (startsAt && Date.parse(startsAt) > now) return { state: 'scheduled', label: dev.scheduled ? 'Scheduled on the lock' : 'Goes on the lock at check-in' };
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
 * Confirmed Beds24 stays arriving in the next `days` days (within the code window) at a room with a lock, that
 * don't yet have a working code on every lock. Empty when automatic guest codes are off.
 */
export function doorAlerts(db, { days = 3, now = Date.now() } = {}) {
  const ds = doorSettings(db);
  if (!ds.auto) return [];
  const today = localToday(ds.tz, now), limit = addDays(today, Math.min(days, ds.lookahead));
  const lockRooms = new Set(db.prepare('SELECT DISTINCT room_id FROM locks WHERE room_id IS NOT NULL').all().map(r => r.room_id));
  const soon = db.prepare(`SELECT id, guest_name, arrival, room_id, first_seen FROM bookings WHERE status IN ('confirmed','new')
    AND source = 'beds24' AND arrival >= ? AND arrival <= ? ORDER BY arrival`).all(today, limit).filter(b => lockRooms.has(b.room_id));
  const codes = doorCodesFor(db, soon.map(b => b.id), now);
  return soon.filter(b => !codes[b.id]?.ok).map(b => ({ id: b.id, guest: b.guest_name, arrival: b.arrival, firstSeen: b.first_seen,
    problem: codes[b.id]?.perLock.find(l => !['set', 'scheduled'].includes(l.state))?.label || 'No door code yet' }));
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
  const codes = await readLockCodes(seam, locks.map(l => l.device_id));
  const guestIds = new Set(db.prepare('SELECT access_code_id FROM door_code_devices WHERE access_code_id IS NOT NULL').all().map(r => r.access_code_id));
  const groups = new Map();
  for (const l of locks) {
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

/** Change the digits (and optionally name) of a non-guest code on every lock it's on. Yale-app codes are taken over by Seam first. */
export async function changeOtherCode(seam, entries, { code, name }) {
  if (!/^\d{4,8}$/.test(code || '')) throw userError('Door codes must be 4 to 8 digits.');
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
  if (!name?.trim()) throw userError('Give the code a name, e.g. "Cleaner".');
  if (!/^\d{4,8}$/.test(code || '')) throw userError('Door codes must be 4 to 8 digits.');
  if (!Array.isArray(deviceIds) || !deviceIds.length) throw userError('Choose at least one lock.');
  for (const id of deviceIds) if (!db.prepare('SELECT 1 FROM locks WHERE device_id = ?').get(id)) throw userError('Unknown lock.');
  if ((startsAt && !endsAt) || (!startsAt && endsAt)) throw userError('Give both a start and an end, or neither for a permanent code.');
  if (startsAt && !(Date.parse(endsAt) > Date.parse(startsAt))) throw userError('The end must be after the start.');
  for (const id of deviceIds) {
    await seam.createCode({ device_id: id, name: name.trim(), code, ...(startsAt && { starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() }) });
  }
}
