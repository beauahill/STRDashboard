import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertProperties, upsertBookings, addDays } from '../server/sync.js';
import { feedToken, icsForRoom, turnovers } from '../server/cleaning.js';
import { localToday } from '../server/doors.js';

const today = localToday('America/Denver');
const d = n => addDays(today, n);

function setup() {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  upsertBookings(db, [
    { id: 1, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival: d(1), departure: d(4), firstName: 'Jordan', lastName: 'Secret', numAdult: 3, numChild: 1, email: 'j@x.com' },
    { id: 2, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'vrbo', arrival: d(4), departure: d(6), firstName: 'Casey', numAdult: 2 },
    { id: 3, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'booking', arrival: d(9), departure: d(11), firstName: 'Dee', numAdult: 1 },
    { id: 4, propertyId: 500, roomId: 600, status: 'black', arrival: d(12), departure: d(15), title: 'Owner block' },
    { id: 5, propertyId: 500, roomId: 600, status: 'cancelled', arrival: d(20), departure: d(22), firstName: 'Gone' },
    { id: 6, propertyId: 500, roomId: 600, status: 'request', arrival: d(25), departure: d(27), firstName: 'Maybe' },
  ]);
  return db;
}

test('Turno feed: real stays only, all-day events, guest counts, no names', () => {
  const db = setup();
  const raw = icsForRoom(db, 600);
  assert.ok(raw.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'long lines are folded');
  const ics = raw.replace(/\r\n /g, '');  // unfold, as calendar apps do
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3, 'no blocks, cancellations or unconfirmed requests');
  assert.ok(ics.includes(`DTSTART;VALUE=DATE:${d(1).replace(/-/g, '')}`));
  assert.ok(ics.includes(`DTEND;VALUE=DATE:${d(4).replace(/-/g, '')}`));
  assert.ok(ics.includes('SUMMARY:Reserved (4 guests)'));
  assert.ok(ics.includes(`Same-day turnover: next guests arrive ${d(4)}`));
  assert.ok(!/Jordan|Secret|j@x\.com|Casey|Owner block/.test(ics), 'no guest names or contact details');
  assert.equal(icsForRoom(db, 9999), null);
});

test('turnovers: time to clean between checkout and the next check-in', () => {
  const db = setup();
  const t = turnovers(db, { days: 30 });
  assert.deepEqual(t.map(x => x.checkout.id), [1, 2, 3]);
  assert.equal(t[0].sameDay, true); assert.equal(t[0].windowHours, 5, '11 AM checkout to 4 PM check-in');
  assert.equal(t[1].next.id, 3); assert.equal(t[1].windowHours, 3 * 24 + 5);
  assert.equal(t[2].next, null, 'blocks and requests are not next guests');
});

test('feed token is stable until regenerated', () => {
  const db = openDb(':memory:');
  const a = feedToken(db);
  assert.ok(a.length >= 20);
  assert.equal(feedToken(db), a);
  assert.notEqual(feedToken(db, true), a);
});
