import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertProperties, upsertBookings } from '../server/sync.js';
import { zonedTimeToUtc } from '../server/doors.js';
import { templateVars, savePropertyVars } from '../server/messages.js';
import {
  seedAutomations, listAutomations, saveAutomation, setEnabled, describe, schedule, runAutomations, upcoming, skipSend, history,
} from '../server/automations.js';

const TZ = 'America/Denver';
const mt = (date, time) => new Date(zonedTimeToUtc(date, time, TZ));   // a Mountain-time moment

function setup() {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  seedAutomations(db);
  const sent = [];
  const send = async (bookingId, text) => { sent.push({ bookingId, text }); };
  return { db, sent, send };
}
const auto = (db, name) => listAutomations(db).find(a => a.name === name);
const book = (db, b, firstSeen) => {
  upsertBookings(db, [{ propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', firstName: 'Pat', lastName: 'Doe', numAdult: 2, ...b }]);
  if (firstSeen) db.prepare('UPDATE bookings SET first_seen = ? WHERE id = ?').run(firstSeen.toISOString(), b.id);
};
const enable = (db, name, at) => setEnabled(db, auto(db, name).id, true, at);

test('starters: eight automations, all off, described in plain words', () => {
  const { db } = setup();
  const a = listAutomations(db);
  assert.equal(a.length, 8);
  assert.ok(a.every(x => !x.enabled));
  assert.equal(describe(auto(db, 'Check-in instructions')), '2 days before check-in at 10 AM');
  assert.equal(describe(auto(db, 'Checkout reminder')), '1 day before checkout at 6 PM');
  assert.equal(describe(auto(db, 'Review request')), '1 day after checkout at 11 AM');
  assert.equal(describe(auto(db, 'Check-in day')), 'on check-in day at 9 AM');
  assert.equal(describe(auto(db, 'Booking confirmation')), '5 min after a booking is made');
  seedAutomations(db);
  assert.equal(listAutomations(db).length, 8, 'not seeded twice');
});

test('validation', () => {
  const { db } = setup();
  assert.throws(() => saveAutomation(db, { name: '', body: 'x', anchor: 'booked' }), /name and a message/);
  assert.throws(() => saveAutomation(db, { name: 'x', body: 'x', anchor: 'whenever' }), /when the message is sent/);
  assert.throws(() => saveAutomation(db, { name: 'x', body: 'x', anchor: 'arrival', offset_days: -2, at_time: '25:00' }), /send time/);
  assert.throws(() => saveAutomation(db, { name: 'x', body: 'x', anchor: 'arrival', offset_days: 90, at_time: '10:00' }), /-30 and 30/);
  const id = saveAutomation(db, { name: 'Wi-Fi', body: 'Wi-Fi: {wifi_name}', anchor: 'arrival', offset_days: 0, at_time: '16:30', channels: ['Airbnb', 'VRBO'] });
  assert.deepEqual(listAutomations(db).find(a => a.id === id).channels, ['Airbnb', 'VRBO']);
});

test('schedule: check-in instructions two days before at 10 AM Mountain, usable until the evening of arrival', () => {
  const { db } = setup();
  const s = schedule(auto(db, 'Check-in instructions'), { arrival: '2026-11-12', departure: '2026-11-15' }, { tz: TZ, checkin: '16:00', checkout: '11:00' });
  assert.equal(s.when.toISOString(), '2026-11-10T17:00:00.000Z');
  assert.equal(s.expires.toISOString(), new Date(mt('2026-11-12', '16:00').getTime() + 12 * 3600e3).toISOString());
});

test('sends once when due, never twice', async () => {
  const { db, sent, send } = setup();
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(await runAutomations(db, null, mt('2026-11-10', '09:55'), send), { sent: 0, waiting: 0, failed: 0 }, 'not yet due');
  const r = await runAutomations(db, null, mt('2026-11-10', '10:05'), send);
  assert.equal(r.sent, 1);
  assert.match(sent[0].text, /Hi Pat, your stay at Laramie Retreat starts Thursday, November 12!/);
  assert.match(sent[0].text, /Door code: 4242/);
  await runAutomations(db, null, mt('2026-11-10', '14:00'), send);
  assert.equal(sent.length, 1, 'not sent again');
  assert.equal(history(db)[0].status, 'sent');
});

test('turning an automation on never sends a backlog', async () => {
  const { db, sent, send } = setup();
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', mt('2026-11-11', '08:00'));   // switched on after the message was due
  await runAutomations(db, null, mt('2026-11-11', '08:05'), send);
  assert.equal(sent.length, 0);
});

test('a last-minute booking still gets its check-in message right away', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (2, '1111')").run();
  book(db, { id: 2, arrival: '2026-11-12', departure: '2026-11-14' }, mt('2026-11-11', '20:00'));  // booked the night before
  await runAutomations(db, null, mt('2026-11-11', '20:05'), send);
  assert.equal(sent.length, 1);
});

test('a missing fill-in waits, sends once available, and fails after the deadline', async () => {
  const { db, sent, send } = setup();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 2, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  const r = await runAutomations(db, null, mt('2026-11-10', '10:05'), send);
  assert.equal(r.waiting, 2); assert.equal(sent.length, 0);
  assert.match(history(db)[0].error, /Waiting for: \{door_code\}/);
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  await runAutomations(db, null, mt('2026-11-10', '12:00'), send);
  assert.deepEqual(sent.map(s => s.bookingId), [1]);
  const late = await runAutomations(db, null, mt('2026-11-13', '09:00'), send);   // past the arrival-evening deadline
  assert.equal(late.failed, 1);
  assert.match(history(db).find(h => h.booking_id === 2).error, /Not sent before its deadline/);
});

test('channel and minimum-night filters; Guesty and inquiry bookings are never messaged', async () => {
  const { db, sent, send } = setup();
  const a = auto(db, 'Mid-stay check-in');   // min 3 nights
  saveAutomation(db, { ...a, channels: ['Airbnb'] });
  enable(db, 'Mid-stay check-in', new Date('2026-11-01T00:00:00Z'));
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-16' }, new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 2, arrival: '2026-11-12', departure: '2026-11-14' }, new Date('2026-10-01T00:00:00Z'));          // 2 nights
  book(db, { id: 3, arrival: '2026-11-12', departure: '2026-11-16', channel: 'vrbo' }, new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 4, arrival: '2026-11-12', departure: '2026-11-16', status: 'inquiry' }, new Date('2026-10-01T00:00:00Z'));
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,source) VALUES(-9,500,600,'confirmed','Airbnb','2026-11-12','2026-11-16',4,'guesty')`).run();
  await runAutomations(db, null, mt('2026-11-13', '10:05'), send);
  assert.deepEqual(sent.map(s => s.bookingId), [1]);
});

test('booking made and booking cancelled', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Booking confirmation', mt('2026-11-01', '00:00'));
  enable(db, 'Cancellation', mt('2026-11-01', '00:00'));
  book(db, { id: 1, arrival: '2026-12-01', departure: '2026-12-03', bookingTime: '2026-11-05T15:00:00Z' }, new Date('2026-11-05T15:01:00Z'));
  book(db, { id: 2, arrival: '2026-12-01', departure: '2026-12-03', bookingTime: '2026-10-01T15:00:00Z' }, new Date('2026-10-01T15:01:00Z'));  // made before turning on
  await runAutomations(db, null, new Date('2026-11-05T15:03:00Z'), send);
  assert.equal(sent.length, 0, 'waits for the 5-minute delay');
  await runAutomations(db, null, new Date('2026-11-05T15:06:00Z'), send);
  assert.deepEqual(sent.map(s => s.bookingId), [1]);
  assert.match(sent[0].text, /thank you for booking Laramie Retreat/);
  book(db, { id: 1, status: 'cancelled', arrival: '2026-12-01', departure: '2026-12-03', bookingTime: '2026-11-05T15:00:00Z', cancelTime: '2026-11-07T09:00:00Z' });
  await runAutomations(db, null, new Date('2026-11-07T09:10:00Z'), send);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /stay has been cancelled/);
});

test('dates changed: noticed once, retried while waiting for the door code, dropped if dates change again', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Dates changed', new Date('2026-11-01T00:00:00Z'));
  book(db, { id: 1, arrival: '2026-12-01', departure: '2026-12-03' }, new Date('2026-10-01T00:00:00Z'));
  await runAutomations(db, null, new Date('2026-11-05T10:00:00Z'), send);   // first sighting: snapshot only
  book(db, { id: 1, arrival: '2026-12-02', departure: '2026-12-05' });
  await runAutomations(db, null, new Date('2026-11-05T10:15:00Z'), send);   // change noticed; 5-minute delay not up yet
  const r1 = await runAutomations(db, null, new Date('2026-11-05T10:21:00Z'), send);
  assert.equal(r1.waiting, 1, 'due now, but needs a door code');
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '5150')").run();
  await runAutomations(db, null, new Date('2026-11-05T10:25:00Z'), send);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /now Wednesday, December 2 to Saturday, December 5.*5150/s);
  book(db, { id: 1, arrival: '2026-12-03', departure: '2026-12-05' });
  await runAutomations(db, null, new Date('2026-11-06T10:00:00Z'), send);
  book(db, { id: 1, arrival: '2026-12-04', departure: '2026-12-06' });       // changed again before the first went out
  await runAutomations(db, null, new Date('2026-11-06T10:02:00Z'), send);
  await runAutomations(db, null, new Date('2026-11-06T10:10:00Z'), send);
  assert.equal(sent.length, 2, 'one message for the latest dates only');
  assert.match(sent[1].text, /Friday, December 4 to Sunday, December 6/);
  assert.ok(history(db).some(h => h.status === 'skipped' && /changed again/.test(h.error)));
});

test('send errors are retried until the deadline', async () => {
  const { db, sent } = setup();
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  let fail = true;
  const flaky = async (id, text) => { if (fail) throw new Error('Beds24 timeout'); sent.push({ id, text }); };
  await runAutomations(db, null, mt('2026-11-10', '10:05'), flaky);
  assert.match(history(db)[0].error, /Beds24 timeout/);
  fail = false;
  await runAutomations(db, null, mt('2026-11-10', '10:10'), flaky);
  assert.equal(sent.length, 1);
});

test('upcoming shows what will be sent and can be skipped', async () => {
  const { db, sent, send } = setup();
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 2, arrival: '2026-11-13', departure: '2026-11-15' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  const up = upcoming(db, mt('2026-11-09', '12:00'));
  assert.deepEqual(up.map(u => u.bookingId), [1, 2]);
  assert.match(up[0].preview, /Door code: 4242/);
  assert.deepEqual(up[1].missing, ['door_code']);
  skipSend(db, auto(db, 'Check-in instructions').id, 1);
  assert.deepEqual(upcoming(db, mt('2026-11-09', '12:00')).map(u => u.bookingId), [2]);
  await runAutomations(db, null, mt('2026-11-10', '10:05'), send);
  assert.equal(sent.length, 0, 'skipped one is not sent; the other waits for its code');
});

test('property details become fill-ins; built-in names are protected', () => {
  const { db } = setup();
  assert.throws(() => savePropertyVars(db, 500, { door_code: 'x' }), /filled in automatically/);
  assert.throws(() => savePropertyVars(db, 500, { 'Wi-Fi': 'x' }), /isn't a valid name/);
  savePropertyVars(db, 500, { wifi_name: 'LaramieGuest', wifi_password: 'pokes2026', '': '' });
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' });
  const v = templateVars(db, db.prepare('SELECT * FROM bookings WHERE id = 1').get());
  assert.equal(v.wifi_password, 'pokes2026');
  assert.equal(v.guests, 2);
  assert.equal(v.property_name, 'Laramie Retreat');
});

test('re-syncing a booking keeps when it was first seen, and records the cancellation time', () => {
  const { db } = setup();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15' });
  const first = db.prepare('SELECT first_seen FROM bookings WHERE id = 1').get().first_seen;
  assert.ok(first);
  book(db, { id: 1, status: 'cancelled', arrival: '2026-11-12', departure: '2026-11-15', cancelTime: '2026-11-02T10:00:00Z' });
  const after = db.prepare('SELECT first_seen, cancelled_at, status FROM bookings WHERE id = 1').get();
  assert.equal(after.first_seen, first);
  assert.equal(after.cancelled_at, '2026-11-02T10:00:00Z');
  assert.equal(after.status, 'cancelled');
});

test('a confirmation goes out for a stay months away, and late departure messages still send', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Booking confirmation', new Date('2026-10-01T00:00:00Z'));
  // Booked on Oct 14 for Dec 20: far outside the window of stays near today.
  book(db, { id: 70, arrival: '2026-12-20', departure: '2026-12-23', bookingTime: '2026-10-14T15:00:00Z' }, new Date('2026-10-14T15:00:00Z'));
  await runAutomations(db, null, new Date('2026-10-14T15:10:00Z'), send);
  assert.deepEqual(sent.map(s => s.bookingId), [70], 'sent within minutes of the booking');

  // A departure message a week after checkout (offsets go up to +30 days).
  saveAutomation(db, { name: 'One week later', anchor: 'departure', offset_days: 7, at_time: '10:00', body: 'Hope you made it home, {guest_first_name}!' });
  enable(db, 'One week later', new Date('2026-09-01T00:00:00Z'));
  book(db, { id: 71, arrival: '2026-09-28', departure: '2026-10-01', bookingTime: '2026-09-01T00:00:00Z' });
  await runAutomations(db, null, mt('2026-10-08', '10:05'), send);
  assert.ok(sent.some(s => s.bookingId === 71 && /made it home, Pat/.test(s.text)));
});

test('a message Beds24 accepted is not sent again when reading the thread back fails', async () => {
  const { db } = setup();
  enable(db, 'Booking confirmation', new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 72, arrival: '2026-11-20', departure: '2026-11-22', bookingTime: '2026-10-14T15:00:00Z' }, new Date('2026-10-14T15:00:00Z'));
  let posts = 0;
  const client = {
    post: async () => { posts++; return [{ success: true }]; },
    getAll: async () => { throw Object.assign(new Error('Beds24: too many requests'), { status: 429 }); },
  };
  for (const at of ['2026-10-14T15:10:00Z', '2026-10-14T15:15:00Z', '2026-10-14T15:20:00Z']) await runAutomations(db, client, new Date(at));
  assert.equal(posts, 1, 'sent once');
  assert.equal(db.prepare("SELECT status FROM automation_sends WHERE booking_id = 72").get().status, 'sent');
});

test('a cancellation message only goes to a guest who really had a booking', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Cancellation', new Date('2026-10-01T00:00:00Z'));
  book(db, { id: 1, status: 'inquiry', arrival: '2026-11-20', departure: '2026-11-22', bookingTime: '2026-10-13T15:00:00Z' });
  book(db, { id: 2, status: 'request', channel: 'vrbo', arrival: '2026-12-01', departure: '2026-12-04', bookingTime: '2026-10-13T16:00:00Z' });
  await runAutomations(db, null, new Date('2026-10-13T16:10:00Z'), send);
  // The inquiry expired and the request was declined: Beds24 reports both as cancelled. A booking cancelled long
  // before the app existed (no cancel time) is re-synced because something else about it changed.
  book(db, { id: 1, status: 'cancelled', arrival: '2026-11-20', departure: '2026-11-22', bookingTime: '2026-10-13T15:00:00Z', cancelTime: '2026-10-14T15:00:00Z' });
  book(db, { id: 2, status: 'cancelled', channel: 'vrbo', arrival: '2026-12-01', departure: '2026-12-04', bookingTime: '2026-10-13T16:00:00Z', cancelTime: '2026-10-14T16:00:00Z' });
  book(db, { id: 3, status: 'cancelled', arrival: '2026-03-01', departure: '2026-03-04', bookingTime: '2026-01-02T10:00:00Z', modifiedTime: '2026-10-14T12:00:00Z' });
  await runAutomations(db, null, new Date('2026-10-14T16:10:00Z'), send);
  assert.deepEqual(sent, []);
  assert.equal(schedule(auto(db, 'Cancellation'), { status: 'cancelled', modified_at: '2026-10-14T12:00:00Z' }, { tz: TZ }), null, 'no cancel time, no cancellation moment');
});

test('a booking request accepted late still gets its confirmation, once', async () => {
  const { db, sent, send } = setup();
  enable(db, 'Booking confirmation', new Date('2026-10-01T00:00:00Z'));
  // Asked on Oct 10, accepted on Oct 13: the message is due from the acceptance, not from the request.
  book(db, { id: 1, status: 'request', channel: 'bookingpage', arrival: '2026-11-20', departure: '2026-11-22', bookingTime: '2026-10-10T15:00:00Z' }, new Date('2026-10-10T15:01:00Z'));
  await runAutomations(db, null, new Date('2026-10-10T15:10:00Z'), send);
  assert.equal(sent.length, 0, 'a request is not a booking yet');
  book(db, { id: 1, status: 'confirmed', channel: 'bookingpage', arrival: '2026-11-20', departure: '2026-11-22', bookingTime: '2026-10-10T15:00:00Z', modifiedTime: '2026-10-13T09:00:00Z' });
  await runAutomations(db, null, new Date('2026-10-13T09:02:00Z'), send);
  assert.equal(sent.length, 0, 'the 5-minute delay runs from the acceptance');
  await runAutomations(db, null, new Date('2026-10-13T09:08:00Z'), send);
  assert.deepEqual(sent.map(s => s.bookingId), [1]);
  assert.match(sent[0].text, /thank you for booking/);
  await runAutomations(db, null, new Date('2026-10-13T09:20:00Z'), send);
  assert.equal(sent.length, 1, 'not again');
  assert.equal(db.prepare('SELECT status FROM booking_snapshots WHERE booking_id = 1').get().status, 'confirmed');
  // Accepted within the delay: one confirmation, not two.
  book(db, { id: 2, status: 'request', arrival: '2026-11-25', departure: '2026-11-27', bookingTime: '2026-10-14T10:00:00Z' }, new Date('2026-10-14T10:00:30Z'));
  await runAutomations(db, null, new Date('2026-10-14T10:01:00Z'), send);
  book(db, { id: 2, status: 'confirmed', arrival: '2026-11-25', departure: '2026-11-27', bookingTime: '2026-10-14T10:00:00Z' });
  for (const m of ['10:02', '10:06', '10:09', '10:30']) await runAutomations(db, null, new Date(`2026-10-14T${m}:00Z`), send);
  assert.deepEqual(sent.map(s => s.bookingId), [1, 2]);
});

test('a guest name shaped like a placeholder is sent as plain text, not treated as a missing fill-in', async () => {
  const { db, sent, send } = setup();
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (1, '4242')").run();
  book(db, { id: 1, arrival: '2026-11-12', departure: '2026-11-15', firstName: '{door_code}', lastName: 'Smith' }, new Date('2026-10-01T00:00:00Z'));
  enable(db, 'Check-in instructions', new Date('2026-11-01T00:00:00Z'));
  const r = await runAutomations(db, null, mt('2026-11-10', '10:05'), send);
  assert.deepEqual([r.sent, r.waiting], [1, 0]);
  assert.match(sent[0].text, /^Hi door_code, your stay at Laramie Retreat/);
  assert.match(sent[0].text, /Door code: 4242/);
});
