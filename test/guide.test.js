import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { guideSettings, saveGuide, guideToken, bookingForToken, regenerateLinks, guideUrl, guideFor, renderGuide, saveCheckin, checkinFor, checkinId, pruneCheckins, guideOverview } from '../server/guide.js';
import { templateVars } from '../server/messages.js';

const T = s => Date.parse(s);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(500,'Laramie Retreat','Laramie'); INSERT INTO rooms(id,property_id,name) VALUES(600,500,'Whole house');");
  setSetting(db, 'vars_500', JSON.stringify({ wifi_name: 'Retreat-5G', wifi_password: 'cowboys2026', address: '1234 Grand Ave, Laramie, WY' }));
  setSetting(db, 'listing_cache_500', JSON.stringify({ id: 500, propertyText: { houseRules: 'No parties.' }, rooms: [] }));
  const add = db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,adults,source) VALUES(?,500,600,?,?,?,?,2,?,2,'beds24')`);
  add.run(1, 'confirmed', 'Airbnb', '2026-10-20', '2026-10-22', 'Sam Rivers');
  add.run(2, 'confirmed', 'Direct', '2026-10-20', '2026-10-22', 'Dee Direct');
  add.run(3, 'cancelled', 'VRBO', '2026-10-20', '2026-10-22', 'Cal Cancel');
  db.exec("INSERT INTO door_codes(booking_id, code) VALUES(1, '0142'), (2, '7788')");
  return db;
}

test('links only open their own booking, and can all be revoked', () => {
  const db = setup();
  const tok = guideToken(db, 1);
  assert.match(tok, /^1-[\w-]{22}$/);
  assert.equal(bookingForToken(db, tok), 1);
  assert.equal(bookingForToken(db, tok.replace(/^1-/, '2-')), null, 'another booking id with the same signature fails');
  assert.equal(bookingForToken(db, '1-abc'), null);
  regenerateLinks(db);
  assert.equal(bookingForToken(db, tok), null, 'old links stop working');
  assert.equal(guideUrl(db, 1), '', 'no link until the app knows its address');
  setSetting(db, 'app_origin', 'https://str.example.app');
  assert.equal(guideUrl(db, 1), `https://str.example.app/guide/${guideToken(db, 1)}`);
  setSetting(db, 'site', JSON.stringify({ 500: { enabled: true, domain: 'book.example.com' } }));
  assert.match(guideUrl(db, 1), /^https:\/\/book\.example\.com\/guide\//, 'the booking site\'s domain is used when there is one');
  assert.equal(templateVars(db, db.prepare('SELECT * FROM bookings WHERE id = 1').get()).guidebook_link, guideUrl(db, 1));
});

test('door code and address only from N days before check-in until checkout', () => {
  const db = setup();
  const before = guideFor(db, 1, T('2026-10-18T18:00:00Z'));
  assert.equal(before.phase, 'before');
  assert.equal(before.doorCode, null);
  assert.equal(before.address, null);
  assert.equal(before.codeFrom, '2026-10-19');
  const access = guideFor(db, 1, T('2026-10-19T15:00:00Z'));
  assert.equal(access.phase, 'access');
  assert.equal(access.doorCode, '0142');
  assert.equal(access.address, '1234 Grand Ave, Laramie, WY');
  assert.equal(access.guide.wifiPassword, 'cowboys2026', 'Wi-Fi comes from the property fill-ins');
  const after = guideFor(db, 1, T('2026-10-22T17:01:00Z'));   // after 11 AM checkout in Laramie
  assert.equal(after.phase, 'after');
  assert.equal(after.doorCode, null);
  assert.equal(guideFor(db, 3, T('2026-10-19T15:00:00Z')).phase, 'cancelled');
  saveGuide(db, 500, { codeDaysBefore: 3 });
  assert.equal(guideFor(db, 1, T('2026-10-17T15:00:00Z')).doorCode, '0142');
});

test('direct guests sign and upload an ID before the code appears; others are never asked', () => {
  const db = setup();
  saveGuide(db, 500, { requireDirect: true, idRetentionDays: 10 });
  const at = T('2026-10-19T15:00:00Z');
  assert.equal(guideFor(db, 1, at).needsCheckin, false, 'Airbnb guests are not asked');
  const d = guideFor(db, 2, at);
  assert.equal(d.needsCheckin, true);
  assert.equal(d.doorCode, null);
  assert.equal(d.address, null);
  assert.throws(() => saveCheckin(db, 2, { name: 'D', agree: true, idDataUrl: PNG }), /full name/);
  assert.throws(() => saveCheckin(db, 2, { name: 'Dee Direct', agree: false, idDataUrl: PNG }), /agree/);
  assert.throws(() => saveCheckin(db, 2, { name: 'Dee Direct', agree: true, idDataUrl: 'data:text/plain;base64,AAAA' }), /photo of your ID/);
  assert.throws(() => saveCheckin(db, 3, { name: 'Cal Cancel', agree: true, idDataUrl: PNG }), /can't be checked in/);
  saveCheckin(db, 2, { name: 'Dee Direct', agree: true, idDataUrl: PNG }, { ip: '1.2.3.4', userAgent: 'test' });
  assert.equal(checkinFor(db, 2).name, 'Dee Direct');
  assert.equal(guideFor(db, 2, at).doorCode, '7788', 'code shows once checked in');
  assert.equal(checkinId(db, 2).id_mime, 'image/png');
  assert.equal(pruneCheckins(db, '2026-11-01'), 0, 'kept 10 days after checkout');
  assert.equal(pruneCheckins(db, '2026-11-02'), 1);
  assert.equal(checkinId(db, 2), null, 'ID photo deleted');
  assert.ok(checkinFor(db, 2).signed_at, 'the signature record stays');
  setSetting(db, 'app_origin', 'https://str.example.app');
  const o = guideOverview(db, 500, T('2026-10-19T15:00:00Z'));
  assert.deepEqual(o.map(s => s.id), [1, 2]);
  assert.ok(o[1].checkin.id_deleted_at);
});

test('settings validation and the page itself', () => {
  const db = setup();
  assert.throws(() => saveGuide(db, 500, { places: [{ name: 'Coal Creek', url: 'javascript:alert(1)' }] }), /must start with https/);
  assert.throws(() => saveGuide(db, 500, { codeDaysBefore: 30 }), /between 0 and 14/);
  saveGuide(db, 500, { welcome: 'Hi <b>there</b>', sections: [{ title: 'Heating', body: 'Nest in the hall.' }, { title: '', body: '' }],
    places: [{ name: 'Coal Creek Coffee', category: 'Coffee', note: 'Best latte', url: 'https://example.com/coal' }], phone: '307-555-0100' });
  const g = guideSettings(db, 500);
  assert.equal(g.sections.length, 1, 'empty sections dropped');
  const page = renderGuide(guideFor(db, 1, T('2026-10-19T15:00:00Z')), { token: guideToken(db, 1) });
  assert.match(page, /noindex/);
  assert.match(page, /Hi &lt;b&gt;there&lt;\/b&gt;/);
  assert.match(page, /<b>0142<\/b>/);
  assert.match(page, /Coal Creek Coffee/);
  assert.match(page, /Nest in the hall/);
  assert.match(page, /cowboys2026/);
  assert.match(page, /No parties/);
  const early = renderGuide(guideFor(db, 1, T('2026-10-10T15:00:00Z')), { token: 'x' });
  assert.ok(!early.includes('0142') && !early.includes('1234 Grand'), 'nothing secret before the window');
  assert.match(early, /appear here on Monday, October 19/);
});
