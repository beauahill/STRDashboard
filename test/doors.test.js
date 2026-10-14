import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertProperties, upsertBookings } from '../server/sync.js';
import {
  zonedTimeToUtc, codeCandidates, saveDoorSettings, doorSettings, refreshLocks, assignLock, reconcileDoorCodes,
  doorCodesFor, codeState, setBookingCode, lockOverview, changeOtherCode, deleteOtherCode, addCode, localToday,
} from '../server/doors.js';

/** In-memory Seam: devices, managed codes (ours) and unmanaged codes (set in the Yale app). */
class FakeSeam {
  constructor() {
    this.apiKey = 'seam_test_key_123';
    this.calls = [];
    this.devs = [
      { device_id: 'front', display_name: 'Front Door', device_type: 'yale_lock', can_program_online_access_codes: true, properties: { online: true, battery_level: 0.8 } },
      { device_id: 'back', display_name: 'Back Door', device_type: 'yale_lock', can_program_online_access_codes: true, properties: { online: true, battery_level: 0.55 } },
      { device_id: 'thermo', display_name: 'Thermostat', device_type: 'ecobee_thermostat', properties: { online: true } },
    ];
    this.managed = new Map();
    this.unmanaged = [
      { access_code_id: 'u-front', device_id: 'front', name: 'Cleaner', code: '0198', is_managed: false, status: 'set' },
      { access_code_id: 'u-back', device_id: 'back', name: 'Cleaner', code: '0198', is_managed: false, status: 'set' },
    ];
    this.n = 0;
    this.failCreate = null;
  }
  async devices() { return this.devs; }
  async accessCodes(id) { return [...this.managed.values()].filter(c => c.device_id === id); }
  async unmanagedCodes(id) { return this.unmanaged.filter(c => c.device_id === id); }
  async createCode(p) {
    this.calls.push(['create', p]);
    if (this.failCreate) throw new Error(this.failCreate);
    const dup = [...this.managed.values(), ...this.unmanaged].some(c => c.device_id === p.device_id && c.code === p.code);
    const c = { access_code_id: `ac${++this.n}`, is_managed: true, type: p.starts_at ? 'time_bound' : 'ongoing', status: 'unset', warnings: [],
      errors: dup ? [{ error_code: 'duplicate_code_on_device', message: 'Duplicate code on device' }] : [], ...p };
    this.managed.set(c.access_code_id, c);
    return c;
  }
  async updateCode(p) { this.calls.push(['update', p]); Object.assign(this.managed.get(p.access_code_id), p, { errors: [] }); return {}; }
  async deleteCode(id) { this.calls.push(['delete', id]); this.managed.delete(id); return {}; }
  async convertToManaged(id) {
    this.calls.push(['convert', id]);
    const i = this.unmanaged.findIndex(c => c.access_code_id === id);
    const [c] = this.unmanaged.splice(i, 1);
    this.managed.set(id, { ...c, is_managed: true, errors: [], warnings: [] });
  }
}

const TZ = 'America/Denver';
const today = localToday(TZ);
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);

async function setup({ auto = true } = {}) {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  const seam = new FakeSeam();
  await refreshLocks(db, seam);
  assignLock(db, 'front', 600); assignLock(db, 'back', 600);
  saveDoorSettings(db, { auto });
  const beds24 = { connected: true, posts: [], fail: null, async post(path, body) { this.posts.push([path, body]); if (this.fail) throw this.fail; return [{ success: true }]; } };
  return { db, seam, beds24 };
}
const book = (db, b) => upsertBookings(db, [{ propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', firstName: 'Pat', lastName: 'Doe', price: 500, ...b }]);
const devRows = (db, id) => db.prepare('SELECT * FROM door_code_devices WHERE booking_id = ? ORDER BY device_id').all(id);

test('local check-in/checkout times become the right UTC instants, across daylight saving', () => {
  assert.equal(zonedTimeToUtc('2026-07-01', '16:00', TZ), '2026-07-01T22:00:00.000Z');  // MDT, UTC-6
  assert.equal(zonedTimeToUtc('2026-12-01', '16:00', TZ), '2026-12-01T23:00:00.000Z');  // MST, UTC-7
  assert.equal(zonedTimeToUtc('2026-11-01', '11:00', TZ), '2026-11-01T18:00:00.000Z');  // DST ended at 2am
  assert.equal(zonedTimeToUtc('2026-03-08', '16:00', TZ), '2026-03-08T22:00:00.000Z');  // DST started at 2am
});

test('code candidates: last 4, 5, 6 phone digits, then stable non-trivial random codes', () => {
  const c = codeCandidates({ id: 1, phone: '+1 (307) 555-0198' });
  assert.deepEqual(c.slice(0, 3), ['0198', '50198', '550198']);
  const r = codeCandidates({ id: 7 });
  assert.equal(r.length, 60);
  assert.ok(r.every(x => /^\d{4}$/.test(x) && x !== '1234' && !/^(\d)\1+$/.test(x)));
  assert.deepEqual(codeCandidates({ id: 7 }), r, 'stable for the same booking');
});

test('settings are validated and automatic codes are off by default', async () => {
  const db = openDb(':memory:');
  assert.equal(doorSettings(db).auto, false);
  assert.equal(doorSettings(db).checkin, '16:00');
  assert.throws(() => saveDoorSettings(db, { checkin: '4pm' }), /16:00/);
  assert.throws(() => saveDoorSettings(db, { tz: 'Mars/Base' }), /time zone/);
  assert.throws(() => saveDoorSettings(db, { beds24Field: 11 }), /1 to 10/);
  const { db: db2, seam, beds24 } = await setup({ auto: false });
  book(db2, { id: 1, arrival: day(2), departure: day(5), phone: '3075550111' });
  const r = await reconcileDoorCodes(db2, seam, beds24);
  assert.match(r.skipped, /off/);
  assert.equal(seam.calls.length, 0);
});

test('only locks are imported from Seam, and they keep their room', async () => {
  const { db, seam } = await setup();
  assert.deepEqual(db.prepare('SELECT device_id, room_id FROM locks ORDER BY device_id').all().map(r => ({ ...r })),
    [{ device_id: 'back', room_id: 600 }, { device_id: 'front', room_id: 600 }]);
  await refreshLocks(db, seam);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM locks WHERE room_id = 600').get().n, 2);
});

test('a confirmed stay gets the same code on both locks, timed to the stay, saved to Beds24 once', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(2), departure: day(5), phone: '(307) 555-4242' });
  const r = await reconcileDoorCodes(db, seam, beds24);
  assert.equal(r.created, 2); assert.deepEqual(r.problems, []);
  const creates = seam.calls.filter(c => c[0] === 'create').map(c => c[1]);
  assert.deepEqual(creates.map(c => [c.device_id, c.code]).sort(), [['back', '4242'], ['front', '4242']]);
  assert.equal(creates[0].starts_at, zonedTimeToUtc(day(2), '16:00', TZ));
  assert.equal(creates[0].ends_at, zonedTimeToUtc(day(5), '11:00', TZ));
  assert.match(creates[0].name, /^Pat Doe /);
  assert.deepEqual(beds24.posts, [['/bookings', [{ id: 1, custom10: '4242' }]]]);

  const again = await reconcileDoorCodes(db, seam, beds24);
  assert.equal(again.created + again.updated + again.removed, 0, 'nothing changes on a second run');
  assert.equal(beds24.posts.length, 1);

  const info = doorCodesFor(db, [1])[1];
  assert.equal(info.code, '4242');
  assert.equal(info.ok, true, 'scheduled before check-in counts as fine');
  assert.deepEqual(info.perLock.map(l => l.state), ['scheduled', 'scheduled']);
  assert.equal(info.beds24.ok, true);
});

test('stays beyond the look-ahead window and Guesty-imported stays get no code', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(30), departure: day(33), phone: '3075550111' });
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,source) VALUES(-5,500,600,'confirmed','Airbnb',?,?,2,'guesty')`).run(day(1), day(3));
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(seam.calls.length, 0);
});

test("a guest whose last 4 digits match the cleaner's code gets the last 5 instead", async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '307-555-0198' });
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(doorCodesFor(db, [1])[1].code, '50198');
});

test('no phone number: a random code that is not in use', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3) });
  await reconcileDoorCodes(db, seam, beds24);
  const code = doorCodesFor(db, [1])[1].code;
  assert.match(code, /^\d{4}$/); assert.notEqual(code, '0198');
});

test('date changes move the code window; cancellation removes the code from both locks', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(2), departure: day(5), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  book(db, { id: 1, arrival: day(3), departure: day(6), phone: '3075554242' });
  const r = await reconcileDoorCodes(db, seam, beds24);
  assert.equal(r.updated, 2);
  const upd = seam.calls.filter(c => c[0] === 'update').map(c => c[1]);
  assert.ok(upd.every(u => u.code === '4242' && u.starts_at === zonedTimeToUtc(day(3), '16:00', TZ)));

  book(db, { id: 1, status: 'cancelled', arrival: day(3), departure: day(6), phone: '3075554242' });
  const c = await reconcileDoorCodes(db, seam, beds24);
  assert.equal(c.removed, 2);
  assert.equal(seam.managed.size, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM door_codes').get().n, 0);
});

test('the code stays through checkout day and is cleaned up the day after', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(-2), departure: day(0), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(seam.managed.size, 2, 'departure day: guest can still get in until checkout');
  const tomorrow = Date.now() + 86400000;
  const r = await reconcileDoorCodes(db, seam, beds24, tomorrow);
  assert.equal(r.removed, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM door_codes').get().n, 0);
});

test('a code added in the Yale app that clashes with a guest code moves the guest to their next code', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  seam.unmanaged.push({ access_code_id: 'u-x', device_id: 'back', name: 'Handyman', code: '4242', is_managed: false, status: 'set' });
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(doorCodesFor(db, [1])[1].code, '54242');
  assert.ok([...seam.managed.values()].every(c => c.code === '54242'), 'both locks moved to the new code together');
  assert.deepEqual(beds24.posts.at(-1), ['/bookings', [{ id: 1, custom10: '54242' }]]);
});

test('a lock reporting a duplicate it can see but Seam cannot gets a new code on the same run', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  [...seam.managed.values()].find(c => c.device_id === 'back').errors = [{ error_code: 'duplicate_code_on_device', message: 'Duplicate code on device' }];
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(doorCodesFor(db, [1])[1].code, '54242');
  assert.equal(doorCodesFor(db, [1])[1].ok, true);
});

test('Seam failures are recorded and shown, not thrown', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  seam.failCreate = 'Seam: device offline';
  const r = await reconcileDoorCodes(db, seam, beds24);
  assert.equal(r.problems.length, 2);
  const info = doorCodesFor(db, [1])[1];
  assert.equal(info.ok, false);
  assert.match(info.perLock[0].label, /device offline/);
  seam.failCreate = null;
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(doorCodesFor(db, [1])[1].ok, true, 'recovers on the next run');
});

test('Beds24 permission problems are reported clearly', async () => {
  const { db, seam, beds24 } = await setup();
  beds24.fail = Object.assign(new Error('forbidden'), { status: 403 });
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  assert.match(doorCodesFor(db, [1])[1].beds24.message, /write access to bookings/);
  beds24.fail = null;
  await reconcileDoorCodes(db, seam, beds24);
  assert.equal(doorCodesFor(db, [1])[1].beds24.ok, true, 'retried on the next run');
});

test('choosing a specific code for a booking updates both locks and Beds24', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  assert.throws(() => setBookingCode(db, 1, '12'), /4 to 8 digits/);
  assert.throws(() => setBookingCode(db, 1, '0198', [{ name: 'Cleaner', code: '0198' }]), /already used by "Cleaner"/);
  setBookingCode(db, 1, '808080');
  await reconcileDoorCodes(db, seam, beds24);
  assert.ok([...seam.managed.values()].every(c => c.code === '808080'));
  assert.deepEqual(beds24.posts.at(-1)[1], [{ id: 1, custom10: '808080' }]);
});

test('code state: scheduled before check-in, set, pending after start, error', () => {
  const future = new Date(Date.now() + 3600e3).toISOString(), past = new Date(Date.now() - 3600e3).toISOString();
  assert.equal(codeState(null, future).state, 'missing');
  assert.equal(codeState({ status: 'unset', errors: '[]' }, future).state, 'scheduled');
  assert.equal(codeState({ status: 'set', errors: '[]' }, past).state, 'set');
  assert.equal(codeState({ status: 'setting', errors: '[]' }, past).state, 'pending');
  assert.equal(codeState({ status: 'set', errors: JSON.stringify([{ message: 'Lock is offline' }]) }, past).label, 'Lock is offline');
});

test('Locks page: other codes grouped across locks; change, delete and add work on every lock', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 1, arrival: day(1), departure: day(3), phone: '3075554242' });
  await reconcileDoorCodes(db, seam, beds24);
  const o = await lockOverview(db, seam);
  assert.equal(o.locks.length, 2);
  assert.equal(o.otherCodes.length, 1, 'guest codes are not listed as "other" codes');
  const cleaner = o.otherCodes[0];
  assert.equal(cleaner.name, 'Cleaner'); assert.equal(cleaner.code, '0198');
  assert.deepEqual(cleaner.locks.map(l => l.lock).sort(), ['Back Door', 'Front Door']);

  await changeOtherCode(seam, cleaner.locks, { code: '7777' });
  assert.deepEqual(seam.calls.filter(c => c[0] === 'convert').map(c => c[1]).sort(), ['u-back', 'u-front'], 'Yale-app codes are taken over first');
  assert.ok(['u-front', 'u-back'].every(id => seam.managed.get(id).code === '7777'));
  await assert.rejects(changeOtherCode(seam, cleaner.locks, { code: '12a4' }), /4 to 8 digits/);

  const after = (await lockOverview(db, seam)).otherCodes[0];
  await deleteOtherCode(seam, after.locks);
  assert.ok(!seam.managed.has('u-front') && !seam.managed.has('u-back'));

  await assert.rejects(addCode(db, seam, { name: '', code: '1234', deviceIds: ['front'] }), /name/);
  await assert.rejects(addCode(db, seam, { name: 'X', code: '1234', deviceIds: ['nope'] }), /Unknown lock/);
  await assert.rejects(addCode(db, seam, { name: 'X', code: '1234', deviceIds: ['front'], startsAt: '2026-11-01T10:00' }), /both a start and an end/);
  await addCode(db, seam, { name: 'Plumber', code: '246810', deviceIds: ['front', 'back'], startsAt: '2026-11-01T09:00:00Z', endsAt: '2026-11-01T17:00:00Z' });
  const plumber = [...seam.managed.values()].filter(c => c.name === 'Plumber');
  assert.equal(plumber.length, 2);
  assert.equal(plumber[0].ends_at, '2026-11-01T17:00:00.000Z');
});

test('two stays with the same phone number get different codes that stay put, run after run', async () => {
  const { db, seam, beds24 } = await setup();
  book(db, { id: 81, arrival: day(2), departure: day(4), phone: '307-555-4242' });
  book(db, { id: 82, arrival: day(4), departure: day(6), phone: '307-555-4242' });
  const codes = () => Object.fromEntries(db.prepare('SELECT booking_id, code FROM door_codes').all().map(r => [r.booking_id, r.code]));
  await reconcileDoorCodes(db, seam, beds24);
  const first = codes();
  assert.equal(first[81], '4242', 'the earlier stay keeps the phone code');
  assert.notEqual(first[82], '4242');
  for (let i = 0; i < 3; i++) await reconcileDoorCodes(db, seam, beds24);
  assert.deepEqual(codes(), first, 'no flip-flopping between the two stays');
  assert.equal(beds24.posts.length, 2, 'each code written to Beds24 once');
});

test('a code comes off locks that no longer serve the stay (room change, lock unassigned)', async () => {
  const { db, seam, beds24 } = await setup();
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Unit 1', qty: 1 }, { id: 601, name: 'Unit 2', qty: 1 }] }]);
  assignLock(db, 'back', 601);
  book(db, { id: 83, arrival: day(1), departure: day(3) });
  await reconcileDoorCodes(db, seam, beds24);
  assert.deepEqual(devRows(db, 83).map(d => d.device_id), ['front']);
  const frontCode = devRows(db, 83)[0].access_code_id;
  book(db, { id: 83, roomId: 601, arrival: day(1), departure: day(3) });   // moved to Unit 2
  await reconcileDoorCodes(db, seam, beds24);
  assert.ok(seam.calls.some(c => c[0] === 'delete' && c[1] === frontCode), "Unit 1's lock no longer opens for this guest");
  assert.deepEqual(devRows(db, 83).map(d => d.device_id), ['back']);

  // The lock is unassigned, then the stay is cancelled: its code must still be deleted from that lock.
  const backCode = devRows(db, 83)[0].access_code_id;
  assignLock(db, 'back', null); assignLock(db, 'front', 601);
  book(db, { id: 83, roomId: 601, status: 'cancelled', arrival: day(1), departure: day(3) });
  await reconcileDoorCodes(db, seam, beds24);
  assert.ok(seam.calls.some(c => c[0] === 'delete' && c[1] === backCode));
  assert.deepEqual(devRows(db, 83), []);
});

test('right at check-in a code waiting for the lock is not reported as a problem yet', () => {
  const startsAt = new Date(Date.now() - 10 * 60e3).toISOString();
  assert.equal(codeState({ status: 'unset', errors: '[]' }, startsAt).state, 'scheduled');
  assert.equal(codeState({ status: 'unset', errors: '[]' }, new Date(Date.now() - 60 * 60e3).toISOString()).state, 'pending');
});

test('a timed code typed in local time is set for that time at the property, not UTC', async () => {
  const { db, seam } = await setup();
  await addCode(db, seam, { name: 'Cleaner Tuesday', code: '7531', deviceIds: ['front'], startsAt: '2026-12-01T10:00', endsAt: '2026-12-01T15:00' });
  const p = seam.calls.find(c => c[0] === 'create')[1];
  assert.equal(p.starts_at, '2026-12-01T17:00:00.000Z', '10:00 in Laramie (MST)');
  assert.equal(p.ends_at, '2026-12-01T22:00:00.000Z');
});
