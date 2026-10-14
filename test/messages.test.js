import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { Beds24Client } from '../server/beds24.js';
import { upsertProperties, upsertBookings, syncBeds24 } from '../server/sync.js';
import { localToday } from '../server/doors.js';
import {
  syncMessages, unreadCount, conversations, thread, sendMessage, markRead, attachment,
  savedReplies, saveReply, deleteReply, fillTemplate,
} from '../server/messages.js';

const today = new Date().toISOString().slice(0, 10);
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const at = h => new Date(Date.now() - h * 3600e3).toISOString();

/** Fake Beds24 message log. */
class FakeBeds24 {
  constructor() {
    this.msgs = [
      { id: 1, bookingId: 10, source: 'guest', message: 'Hi! Is there parking?', time: at(5), read: false },
      { id: 2, bookingId: 10, source: 'host', message: 'Yes, two spots in the driveway.', time: at(4), read: true },
      { id: 3, bookingId: 10, source: 'guest', message: 'Great, thanks', time: at(3), read: false, attachmentName: 'car.jpg', attachmentMimeType: 'image/jpeg', attachment: Buffer.from('JPEGDATA').toString('base64') },
      { id: 4, bookingId: 11, source: 'guest', message: 'Can we bring a dog?', time: at(30), read: true },
      { id: 5, bookingId: 12, source: 'guest', message: 'Is it available for Thanksgiving?', time: at(1), read: false },
    ];
    this.calls = [];
    this.nextId = 100;
    this.reject = null;
  }
  async getAll(path, q) {
    this.calls.push(['get', path, q]);
    let r = this.msgs;
    if (q.bookingId) r = r.filter(m => q.bookingId.includes(m.bookingId));
    if (q.id) r = r.filter(m => q.id.includes(m.id));
    if (q.maxAge) r = r.filter(m => Date.parse(m.time) >= Date.now() - q.maxAge * 86400e3);
    return r.map(m => ({ ...m }));
  }
  async post(path, body) {
    this.calls.push(['post', path, body]);
    if (this.reject) return [{ success: false, errors: [{ message: this.reject }] }];
    for (const m of body) this.msgs.push({ id: this.nextId++, bookingId: m.bookingId, source: 'host', message: m.message, time: new Date().toISOString(), read: true });
    return [{ success: true }];
  }
  async patch(path, query, body) {
    this.calls.push(['patch', path, query, body]);
    for (const m of this.msgs) if (query.bookingId.includes(m.bookingId)) m.read = body.read;
  }
}

function setup() {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);
  upsertBookings(db, [
    { id: 10, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'airbnb', arrival: day(3), departure: day(6), firstName: 'Jordan', lastName: 'Nguyen', numAdult: 2, phone: '555', email: 'j@x.com' },
    { id: 11, propertyId: 500, roomId: 600, status: 'confirmed', channel: 'vrbo', arrival: day(-20), departure: day(-17), firstName: 'Casey' },
    { id: 12, propertyId: 500, roomId: 600, status: 'inquiry', channel: 'airbnb', arrival: day(40), departure: day(43), firstName: 'Ina' },
  ]);
  return { db, client: new FakeBeds24() };
}

test('first sync looks back a year, later syncs a few days, and read state updates', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  await syncMessages(db, client);
  assert.deepEqual(client.calls.map(c => c[2].maxAge), [365, 3]);
  assert.equal(unreadCount(db), 3);
  client.msgs[0].read = true;
  await syncMessages(db, client);
  assert.equal(unreadCount(db), 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 5, 'no duplicates');
  assert.equal(db.prepare('SELECT attachment_name FROM messages WHERE id = 3').get().attachment_name, 'car.jpg');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE sql LIKE '%attachment %'").get().n, 0, 'attachment data itself is not stored');
});

test('conversations: one per booking, unread first, with filters and search', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  const all = conversations(db);
  assert.deepEqual(all.map(c => [c.booking_id, c.unread]), [[12, 1], [10, 2], [11, 0]]);
  assert.equal(all[1].last_body, 'Great, thanks');
  assert.equal(all[1].guest_name, 'Jordan Nguyen');
  assert.deepEqual(conversations(db, { filter: 'unread' }).map(c => c.booking_id), [12, 10]);
  assert.deepEqual(conversations(db, { filter: 'upcoming' }).map(c => c.booking_id), [12, 10]);
  assert.deepEqual(conversations(db, { filter: 'inquiries' }).map(c => c.booking_id), [12]);
  assert.deepEqual(conversations(db, { q: 'dog' }).map(c => c.booking_id), [11]);
  assert.deepEqual(conversations(db, { q: 'casey' }).map(c => c.booking_id), [11]);
});

test('thread: messages in order, stay details, fill-ins, and no contact details', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  setSetting(db, 'door_checkin', '15:30');
  db.prepare("INSERT INTO door_codes(booking_id, code) VALUES (10, '4242')").run();
  const th = thread(db, 10);
  assert.deepEqual(th.messages.map(m => m.id), [1, 2, 3]);
  assert.equal(th.canReply, true);
  assert.equal(th.booking.phone, undefined); assert.equal(th.booking.email, undefined);
  assert.equal(th.vars.guest_first_name, 'Jordan');
  assert.equal(th.vars.door_code, '4242');
  assert.equal(th.vars.check_in_time, '3:30 PM');
  assert.equal(th.vars.check_out_time, '11 AM');
  assert.match(th.vars.check_in_date, /^\w+day, \w+ \d+$/);
  assert.throws(() => thread(db, 999), e => e.status === 404);
});

test('sending: validated, posted to Beds24, and the sent message appears in the thread', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  await assert.rejects(sendMessage(db, client, 10, '   '), /Write a message/);
  await assert.rejects(sendMessage(db, client, 10, 'x'.repeat(5001)), /at most 5000/);
  db.prepare(`INSERT INTO bookings(id,status,channel,arrival,departure,nights,source) VALUES(-3,'confirmed','Airbnb','2025-01-01','2025-01-02',1,'guesty')`).run();
  await assert.rejects(sendMessage(db, client, -3, 'hi'), /only be sent on Beds24 bookings/);
  assert.equal(client.calls.filter(c => c[0] === 'post').length, 0);

  const th = await sendMessage(db, client, 10, '  See you Friday!  ');
  assert.deepEqual(client.calls.find(c => c[0] === 'post')[2], [{ bookingId: 10, message: 'See you Friday!' }]);
  assert.equal(th.messages.at(-1).body, 'See you Friday!');
  assert.equal(th.messages.at(-1).source, 'host');

  client.reject = 'Guest has blocked messages';
  await assert.rejects(sendMessage(db, client, 10, 'Hello?'), /didn't send the message: Guest has blocked messages/);
});

test('opening a conversation marks it read in Beds24 and locally, once', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  assert.deepEqual(await markRead(db, client, 10), { changed: 2 });
  assert.deepEqual(client.calls.find(c => c[0] === 'patch').slice(1), ['/bookings/messages', { bookingId: [10] }, { read: true }]);
  assert.equal(unreadCount(db), 1);
  assert.deepEqual(await markRead(db, client, 10), { changed: 0 });
  assert.equal(client.calls.filter(c => c[0] === 'patch').length, 1, 'no call when nothing is unread');
});

test('attachments are fetched from Beds24 when opened', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  const a = await attachment(db, client, 3);
  assert.equal(a.name, 'car.jpg'); assert.equal(a.mime, 'image/jpeg'); assert.equal(a.data.toString(), 'JPEGDATA');
  await assert.rejects(attachment(db, client, 1), e => e.status === 404);
});

test('saved replies: starters added once, edit, delete, and fill-ins', () => {
  const db = openDb(':memory:');
  const first = savedReplies(db);
  assert.equal(first.length, 4);
  deleteReply(db, first[0].id);
  assert.equal(savedReplies(db).length, 3, 'starters are not re-added after deleting one');
  assert.throws(() => saveReply(db, { title: '', body: 'x' }), /name and a message/);
  const id = saveReply(db, { title: 'Wi-Fi', body: 'Network {wifi_name}' });
  saveReply(db, { id, title: 'Wi-Fi details', body: 'Hi {guest_first_name}, code {door_code}' });
  assert.equal(savedReplies(db).find(r => r.id === id).title, 'Wi-Fi details');
  assert.throws(() => saveReply(db, { id: 9999, title: 'x', body: 'y' }), /no longer exists/);
  assert.equal(fillTemplate('Hi {guest_first_name}, code {door_code}, {unknown}', { guest_first_name: 'Pat', door_code: '' }),
    'Hi Pat, code {door_code}, {unknown}', 'blank or unknown fill-ins stay visible');
  assert.equal(fillTemplate('Hi {guest_name}', { guest_name: '{door_code} Smith' }), 'Hi door_code Smith', 'braces in a value never look like a fill-in');
});

test('Beds24 client PATCH sends query and JSON body; sync asks for inquiries too', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: new URL(url), ...opts });
    const ok = b => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes('/authentication/setup')) return ok({ token: 't', refreshToken: 'r', expiresIn: 86400 });
    return ok({ data: [], pages: {} });
  };
  const c = new Beds24Client(db, fetchImpl);
  await c.connect('code');
  await c.patch('/bookings/messages', { bookingId: [10] }, { read: true });
  const p = seen.find(s => s.method === 'PATCH');
  assert.equal(p.url.searchParams.get('bookingId'), '10');
  assert.deepEqual(JSON.parse(p.body), { read: true });
  await syncBeds24(db, c);
  const bookingsCall = seen.find(s => s.url.pathname.endsWith('/bookings'));
  assert.ok(bookingsCall.url.searchParams.getAll('status').includes('inquiry'));
});

test('after an outage, the sync looks back to the last successful pull', async () => {
  const { db, client } = setup();
  setSetting(db, 'messages_synced', new Date(Date.now() - 10 * 86400e3).toISOString());
  client.msgs.push({ id: 6, bookingId: 11, source: 'guest', message: 'Could we check in early?', time: at(5 * 24), read: false });
  await syncMessages(db, client);
  assert.ok(client.calls.at(-1)[2].maxAge >= 11, `asked for ${client.calls.at(-1)[2].maxAge} days`);
  assert.equal(db.prepare('SELECT body FROM messages WHERE id = 6').get()?.body, 'Could we check in early?');
  await syncMessages(db, client);
  assert.equal(client.calls.at(-1)[2].maxAge, 3, 'back to a few days once caught up');
});

test('the inbox "current/upcoming" filter uses the local date, not UTC', async () => {
  const { db, client } = setup();
  await syncMessages(db, client);
  // 01:00 UTC is still the evening before in Mountain time: a guest checking out on that local day is current.
  const now = Date.parse(day(0) + 'T01:00:00Z');
  const local = localToday('America/Denver', now);
  assert.equal(local, day(-1));
  db.prepare('UPDATE bookings SET departure = ? WHERE id = 11').run(local);
  assert.ok(conversations(db, { filter: 'upcoming', now }).some(c => c.booking_id === 11), 'checking out today (local) is still upcoming');
  db.prepare('UPDATE bookings SET departure = ? WHERE id = 11').run(day(-2));
  assert.ok(!conversations(db, { filter: 'upcoming', now }).some(c => c.booking_id === 11));
});
