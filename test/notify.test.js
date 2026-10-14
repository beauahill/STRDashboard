import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { notifySettings, saveNotifySettings, publicNotify, regenerateTopic, collect, runNotifications, sendTest, fillMissingBookings, boot } from '../server/notify.js';

const NOW = Date.parse('2026-10-13T18:00:00Z');
const ago = min => new Date(NOW - min * 60e3).toISOString();

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name) VALUES(1,'Laramie House'); INSERT INTO rooms(id,property_id,name) VALUES(10,1,'Whole house');");
  saveNotifySettings(db, { enabled: true }, NOW - 60 * 60e3);   // switched on an hour ago
  boot.at = NOW - 2 * 3600e3;                                   // the app has been up for two hours
  return db;
}
const addBooking = (db, b) => db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,adults,children,price,booked_at,cancelled_at,first_seen,source)
  VALUES(?,1,10,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.id, b.status || 'confirmed', b.channel || 'Airbnb', b.arrival || '2026-10-16', b.departure || '2026-10-18', b.nights || 2,
  b.guest || 'Sam Rivers', b.adults ?? 2, b.children ?? 0, b.price ?? 600, b.booked_at ?? null, b.cancelled_at ?? null, b.first_seen ?? ago(5), b.source || 'beds24');
const addMessage = (db, id, bookingId, body, time, { source = 'guest', read = 0 } = {}) =>
  db.prepare('INSERT INTO messages(id,booking_id,source,body,time,read) VALUES(?,?,?,?,?,?)').run(id, bookingId, source, body, time, read);
function fakeFetch({ fail = false, retryAfter = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (!fail) return { ok: true, status: 200, text: async () => '' };
    return { ok: false, status: 429, text: async () => 'limit reached', headers: new Headers(retryAfter ? { 'retry-after': String(retryAfter) } : {}) };
  };
  return { fn, calls };
}

test('settings: random private topic, validation, token kept server-side, no backlog when switched on', () => {
  const db = openDb();
  const s = notifySettings(db);
  assert.match(s.topic, /^str-[A-Za-z0-9_-]{20}$/);
  assert.equal(notifySettings(db).topic, s.topic, 'the topic is kept');
  assert.equal(s.enabled, false);
  assert.notEqual(regenerateTopic(db).topic, s.topic);
  assert.throws(() => saveNotifySettings(db, { topic: 'short' }), /at least 12 characters/);
  assert.throws(() => saveNotifySettings(db, { topic: 'has spaces in it' }), /letters, numbers/);
  assert.throws(() => saveNotifySettings(db, { server: 'ntfy.sh' }), /web address/);
  saveNotifySettings(db, { server: 'https://ntfy.example.com/', token: 'tk_secret123' });
  const pub = publicNotify(notifySettings(db));
  assert.equal(pub.server, 'https://ntfy.example.com');
  assert.equal(pub.token, undefined);
  assert.equal(pub.tokenSet, true);
  assert.ok(!JSON.stringify(pub).includes('tk_secret123'));
  saveNotifySettings(db, { enabled: true }, NOW);
  assert.equal(notifySettings(db).enabledAt, new Date(NOW).toISOString());
  saveNotifySettings(db, { enabled: true, preview: false }, NOW + 1e6);
  assert.equal(notifySettings(db).enabledAt, new Date(NOW).toISOString(), 'saving again does not move the start time');
});

test('guest messages: grouped per conversation, only new and unread, preview optional', async () => {
  const db = setup();
  addBooking(db, { id: 1, booked_at: ago(60 * 24 * 30) });
  addBooking(db, { id: 2, status: 'inquiry', guest: 'Ivy Inquirer', booked_at: null });
  addMessage(db, 1, 1, 'Before notifications were on', ago(90));
  addMessage(db, 2, 1, 'Is there parking?', ago(10));
  addMessage(db, 3, 1, 'Also,   is the hot tub open?', ago(9));
  addMessage(db, 4, 1, 'Host reply', ago(8), { source: 'host' });
  addMessage(db, 5, 2, 'Do you allow dogs?', ago(7));
  addMessage(db, 6, 2, 'Already read in Beds24', ago(6), { read: 1 });
  process.env.RAILWAY_PUBLIC_DOMAIN = 'strdash.example.app';
  try {
    const items = collect(db, NOW);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Message from Sam Rivers (Airbnb)');
    assert.equal(items[0].message, '2 new messages. Latest: Also, is the hot tub open?\nOct 16 – Oct 18');
    assert.equal(items[0].click, 'https://strdash.example.app/#/inbox/1');
    assert.deepEqual(items[0].refs, [['message', 2], ['message', 3]]);
    assert.equal(items[1].title, 'Inquiry from Ivy Inquirer (Airbnb)');

    const f = fakeFetch();
    assert.deepEqual(await runNotifications(db, { now: NOW, fetchImpl: f.fn }), { sent: 2, failed: 0 });
    assert.equal(f.calls[0].url, 'https://ntfy.sh');
    assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['click', 'message', 'priority', 'tags', 'title', 'topic']);
    assert.equal(f.calls[0].body.topic, notifySettings(db).topic);
    assert.equal(f.calls[0].body.priority, 4);
    assert.deepEqual(await runNotifications(db, { now: NOW, fetchImpl: f.fn }), { sent: 0, failed: 0 }, 'each message is sent once');

    addMessage(db, 7, 1, 'One more thing', ago(1));
    saveNotifySettings(db, { preview: false });
    const [next] = collect(db, NOW);
    assert.equal(next.message, 'New message. Open the Inbox to read it.\nOct 16 – Oct 18');
  } finally { delete process.env.RAILWAY_PUBLIC_DOMAIN; }
});

test('bookings, requests and cancellations: only ones made after switching on', () => {
  const db = setup();
  addBooking(db, { id: 1, booked_at: ago(20), children: 1, price: 612.4 });
  addBooking(db, { id: 2, status: 'request', guest: 'Rae Request', booked_at: ago(15) });
  addBooking(db, { id: 3, booked_at: ago(60 * 24 * 40), first_seen: ago(2) });   // old booking, seen for the first time by a full sync
  addBooking(db, { id: 4, status: 'cancelled', guest: 'Cal Cancel', booked_at: ago(60 * 24 * 10), cancelled_at: ago(30) });
  addBooking(db, { id: 5, status: 'cancelled', booked_at: ago(60 * 24 * 10), cancelled_at: ago(120) });   // cancelled before switching on
  addBooking(db, { id: -6, booked_at: ago(10), source: 'guesty' });
  const items = collect(db, NOW);
  assert.deepEqual(items.map(i => i.title), ['Cancelled: Cal Cancel', 'New booking: Sam Rivers', 'Booking request from Rae Request: respond within 24 hours']);
  assert.equal(items[1].message, 'Airbnb · Oct 16 – Oct 18 (2 nights) · 3 guests · $612');
  assert.equal(items[2].priority, 4);
  saveNotifySettings(db, { bookings: false, cancellations: false });
  assert.equal(collect(db, NOW).length, 0);
  saveNotifySettings(db, { bookings: true, enabled: false });
  assert.equal(collect(db, NOW).length, 0, 'nothing while switched off');
  setSetting(db, 'demo', '1');
  saveNotifySettings(db, { enabled: true }, NOW - 60 * 60e3);
  assert.equal(collect(db, NOW).length, 0, 'never for demo data');
});

test('problems: failed automated message, door code not working before arrival, Beds24 not syncing', () => {
  const db = setup();
  addBooking(db, { id: 1, arrival: '2026-10-14', departure: '2026-10-16', first_seen: ago(60 * 24) });
  addBooking(db, { id: 2, arrival: '2026-10-14', departure: '2026-10-15', guest: 'Just Booked', first_seen: ago(5) });
  db.exec(`INSERT INTO automations(id,name,anchor,body) VALUES(1,'Check-in instructions','arrival','Hi');
    INSERT INTO automation_sends(automation_id,booking_id,key,status,error,updated_at) VALUES(1,1,'','failed','Beds24 rejected it','${ago(3)}');
    INSERT INTO locks(device_id,name,room_id) VALUES('d1','Front door',10);`);
  setSetting(db, 'door_auto', '1');
  setSetting(db, 'door_last_run', ago(10));
  setSetting(db, 'beds24_refresh_token', 'r');
  setSetting(db, 'last_sync', ago(90));
  setSetting(db, 'last_sync_error', 'Beds24 returned 500');
  const titles = collect(db, NOW).map(i => i.title);
  assert.ok(titles.includes('Automated message failed'));
  assert.ok(titles.includes('Door code problem: Sam Rivers arrives Oct 14'));
  assert.ok(!titles.some(t => t.includes('Just Booked')), 'a code still being set up right after booking is not a problem yet');
  const sync = collect(db, NOW).find(i => i.refs[0][0] === 'sync');
  assert.match(sync.message, /Beds24 returned 500/);
  saveNotifySettings(db, { problems: false });
  assert.equal(collect(db, NOW).length, 0);
});

test('failed sends are retried with growing gaps for a day and honour Retry-After; the test message uses the same settings', async () => {
  const db = setup();
  addBooking(db, { id: 1, booked_at: ago(5) });
  const bad = fakeFetch({ fail: true });
  const run = (min, f) => runNotifications(db, { now: NOW + min * 60e3, fetchImpl: f.fn });
  // Tried again after 1, 2, 5 and 10 minutes, then every 15.
  for (const [min, tried] of [[0, 1], [0.5, 0], [1, 1], [2, 0], [3, 1], [8, 1], [17, 0], [18, 1]]) assert.deepEqual(await run(min, bad), { sent: 0, failed: tried }, `at ${min} min`);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'notify_error'").get().value, 'ntfy answered 429: limit reached');
  const good = fakeFetch();
  assert.deepEqual(await run(20, good), { sent: 0, failed: 0 }, 'not every minute');
  assert.deepEqual(await run(48, good), { sent: 1, failed: 0 }, 'delivered once ntfy is back half an hour later');
  assert.equal(good.calls[0].body.title, 'New booking: Sam Rivers');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'notify_error'").get().value, null);

  // ntfy's own "come back in two minutes" is respected for everything.
  addBooking(db, { id: 2, guest: 'Later Guest', booked_at: ago(-60) });
  const limited = fakeFetch({ fail: true, retryAfter: 120 });
  assert.deepEqual(await run(60, limited), { sent: 0, failed: 1 });
  assert.deepEqual(await run(61, good), { sent: 0, failed: 0 }, 'holds off');
  assert.deepEqual(await run(62, good), { sent: 1, failed: 0 });
  // After about a day of failures it is dropped.
  db.prepare("UPDATE notification_log SET ok = 0, attempts = 100, at = ? WHERE ref = '2'").run(ago(-30));
  assert.deepEqual(await run(90, good), { sent: 0, failed: 0 }, 'given up');

  saveNotifySettings(db, { server: 'https://ntfy.example.com', token: 'tk_abc' });
  const probe = fakeFetch();
  await sendTest(db, probe.fn);
  assert.equal(probe.calls[0].url, 'https://ntfy.example.com');
  assert.equal(probe.calls[0].headers.authorization, 'Bearer tk_abc');
  assert.equal(probe.calls[0].body.title, 'STR Dashboard test');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'notify_error'").get().value, null);
});

test('messages for bookings not synced yet: the booking is fetched so the alert has a name', async () => {
  const db = setup();
  addMessage(db, 1, 77, 'Hi, is the house free next weekend?', ago(1));
  const asked = [];
  const client = { getAll: async (path, q) => { asked.push([path, q.id]); return [{ id: 77, propertyId: 1, roomId: 10, status: 'inquiry', arrival: '2026-10-23', departure: '2026-10-25', firstName: 'New', lastName: 'Guest', channel: 'airbnb' }]; } };
  assert.equal(await fillMissingBookings(db, client), 1);
  assert.deepEqual(asked, [['/bookings', [77]]]);
  assert.equal(collect(db, NOW)[0].title, 'Inquiry from New Guest (Airbnb)');
  assert.equal(await fillMissingBookings(db, client), 0, 'nothing to fetch once it is known');
  addMessage(db, 2, 88, 'From a booking Beds24 no longer has', ago(1));
  const none = { getAll: async (path, q) => { asked.push([path, q.id]); return []; } };
  await fillMissingBookings(db, none);
  await fillMissingBookings(db, none);
  assert.deepEqual(asked.slice(1), [['/bookings', [88]]], 'asked once, not every minute');
});

test('a door alert is sent again after the code was fine in between, and once more on check-in day', async () => {
  const db = setup();
  db.exec("INSERT INTO locks(device_id,name,room_id) VALUES('d1','Front door',10)");
  setSetting(db, 'door_auto', '1');
  setSetting(db, 'door_last_run', ago(5));
  addBooking(db, { id: 1, arrival: '2026-10-14', departure: '2026-10-16', first_seen: ago(60 * 24) });
  const f = fakeFetch();
  await runNotifications(db, { now: NOW, fetchImpl: f.fn });
  assert.deepEqual(f.calls.map(c => c.body.message), ['No door code yet']);
  // The code is created and scheduled: all fine, so the alert is forgotten.
  db.prepare("INSERT INTO door_codes(booking_id,code,starts_at,ends_at) VALUES(1,'4242','2026-10-14T22:00:00.000Z','2026-10-16T17:00:00.000Z')").run();
  const dev = errors => db.prepare("INSERT OR REPLACE INTO door_code_devices(booking_id,device_id,access_code_id,status,scheduled,errors,warnings) VALUES(1,'d1','ac1','unset',1,?,'[]')").run(errors);
  dev('[]');
  assert.deepEqual(await runNotifications(db, { now: NOW + 60e3, fetchImpl: f.fn }), { sent: 0, failed: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_log WHERE kind = 'door'").get().n, 0);
  // Check-in day, noon: the lock reports an error. A new problem, so it is pushed again.
  const checkin = NOW + 24 * 3600e3;
  dev(JSON.stringify([{ error_code: 'august_lock_temporarily_offline', message: 'Lock is offline' }]));
  await runNotifications(db, { now: checkin, fetchImpl: f.fn });
  assert.deepEqual(f.calls.map(c => [c.body.title, c.body.message]), [['Door code problem: Sam Rivers arrives Oct 14', 'No door code yet'], ['Door code problem: Sam Rivers arrives today', 'Lock is offline']]);
  await runNotifications(db, { now: checkin + 3600e3, fetchImpl: f.fn });
  assert.equal(f.calls.length, 2, 'the same problem is not repeated');

  // A problem pushed the day before and still there at check-in is said once more that day.
  const db2 = setup();
  db2.exec("INSERT INTO locks(device_id,name,room_id) VALUES('d1','Front door',10)");
  setSetting(db2, 'door_auto', '1'); setSetting(db2, 'door_last_run', ago(5));
  addBooking(db2, { id: 1, arrival: '2026-10-14', departure: '2026-10-16', first_seen: ago(60 * 24) });
  const g = fakeFetch();
  await runNotifications(db2, { now: NOW, fetchImpl: g.fn });
  await runNotifications(db2, { now: NOW + 3600e3, fetchImpl: g.fn });
  await runNotifications(db2, { now: checkin, fetchImpl: g.fn });
  await runNotifications(db2, { now: checkin + 3600e3, fetchImpl: g.fn });
  assert.deepEqual(g.calls.map(c => c.body.title), ['Door code problem: Sam Rivers arrives Oct 14', 'Door code problem: Sam Rivers arrives today']);
});

test('a changed booking is not reported as having no code until a door-code run has looked at it', () => {
  const db = setup();
  db.exec("INSERT INTO locks(device_id,name,room_id) VALUES('d1','Front door',10)");
  setSetting(db, 'door_auto', '1');
  addBooking(db, { id: 1, arrival: '2026-10-14', departure: '2026-10-16', first_seen: ago(60 * 24) });
  db.prepare('UPDATE bookings SET modified_at = ? WHERE id = 1').run(ago(1));   // dates just changed in Beds24
  const door = () => collect(db, NOW).filter(i => i.refs[0][0] === 'door');
  assert.deepEqual(door(), [], 'no run yet');
  setSetting(db, 'door_last_run', ago(5));
  assert.deepEqual(door(), [], 'the last run was before the change');
  setSetting(db, 'door_last_run', new Date(NOW).toISOString());
  assert.equal(door()[0].message, 'No door code yet');
});

test("a restart after downtime doesn't raise the 'Beds24 hasn't synced' alarm", () => {
  const db = setup();
  setSetting(db, 'beds24_refresh_token', 'r');
  setSetting(db, 'last_sync', ago(120));
  boot.at = NOW - 60e3;   // the app came back a minute ago
  assert.deepEqual(collect(db, NOW).filter(i => i.refs[0][0] === 'sync'), []);
  boot.at = NOW - 61 * 60e3;
  assert.equal(collect(db, NOW).filter(i => i.refs[0][0] === 'sync').length, 1, 'up for an hour without a sync is a problem');
});
