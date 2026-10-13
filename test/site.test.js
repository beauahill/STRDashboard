import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { siteSettings, saveSite, siteFor, addPhoto, listPhotos, updatePhotos, importBeds24Photos, availability, quote, checkoutUrl, renderSite, renderTerms, AGREEMENT_TEMPLATE } from '../server/site.js';

const NOW = Date.parse('2026-10-13T18:00:00Z');   // Oct 13 in Laramie
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(500,'Laramie Retreat','Laramie'); INSERT INTO rooms(id,property_id,name) VALUES(600,500,'Whole house');");
  setSetting(db, 'listing_cache_500', JSON.stringify({ id: 500, propertyText: { headline: 'Cozy 3BR near UW', propertyDescription: 'Bright house.\n\nBig yard.', houseRules: 'No parties.' },
    rooms: [{ id: 600, name: 'Whole house', maxPeople: 8, cleaningFee: 95, text: {} }] }));
  const day = db.prepare('INSERT INTO calendar_days(room_id,date,price,min_stay,num_avail,override) VALUES(600,?,?,?,1,?)');
  for (let i = 0; i < 20; i++) {
    const d = new Date(Date.UTC(2026, 9, 13 + i)).toISOString().slice(0, 10);
    day.run(d, i === 6 ? null : 150 + i, i === 10 ? 3 : 2, i === 8 ? 'blackout' : 'none');
  }
  db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,source) VALUES(1,500,600,'confirmed','Airbnb','2026-10-15','2026-10-17',2,'Secret Guest','beds24')`).run();
  return db;
}

test('settings start from the Beds24 listing text and validate changes', () => {
  const db = setup();
  const s = siteSettings(db, 500);
  assert.equal(s.title, 'Cozy 3BR near UW');
  assert.equal(s.slug, 'laramie-retreat');
  assert.equal(s.maxGuests, 8);
  assert.equal(s.cleaningFee, 95);
  assert.equal(s.bookingUrl, 'https://beds24.com/booking2.php?propid=500');
  assert.equal(s.enabled, false);
  assert.equal(s.agreement, AGREEMENT_TEMPLATE);
  assert.throws(() => saveSite(db, 500, { domain: 'https://book.example.com/x' }) && saveSite(db, 500, { domain: 'not a domain' }), /domain like/);
  assert.throws(() => saveSite(db, 500, { bookingUrl: 'http://beds24.com/x' }), /https/);
  assert.throws(() => saveSite(db, 500, { maxGuests: 0 }), /Max guests/);
  const saved = saveSite(db, 500, { enabled: true, slug: 'My Laramie Stay!', title: 'Walk to UW games', domain: 'Book.Example.com', title2: 'ignored' });
  assert.equal(saved.slug, 'my-laramie-stay');
  assert.equal(saved.domain, 'book.example.com');
  assert.equal(saved.title, 'Walk to UW games');
  saveSite(db, 500, { title: '' });
  assert.equal(siteSettings(db, 500).title, 'Cozy 3BR near UW', 'blank goes back to the listing text');
  assert.equal(siteFor(db, { slug: 'my-laramie-stay' }).propertyId, 500);
  assert.equal(siteFor(db, { host: 'book.example.com:443' }).propertyId, 500);
  assert.equal(siteFor(db, { slug: 'nope' }), null);
  db.exec("INSERT INTO properties(id,name) VALUES(501,'Other'); INSERT INTO rooms(id,property_id,name) VALUES(601,501,'R');");
  assert.throws(() => saveSite(db, 501, { slug: 'my-laramie-stay' }), /already uses that web address/);
  db.exec("INSERT INTO properties(id,name) VALUES(-1,'Guesty only')");
  assert.throws(() => saveSite(db, -1, { enabled: true }), /no Beds24 room/);
});

test('availability: only open, priced, unblocked nights; no booking details', () => {
  const db = setup();
  const nights = availability(db, 500, { days: 20, now: NOW });
  const by = Object.fromEntries(nights.map(n => [n.date, n]));
  assert.equal(nights.length, 20);
  assert.deepEqual(by['2026-10-13'], { date: '2026-10-13', open: true, price: 150, minStay: 2 });
  assert.equal(by['2026-10-15'].open, false, 'booked');
  assert.equal(by['2026-10-16'].open, false, 'booked');
  assert.equal(by['2026-10-17'].open, true, 'checkout day is free that night');
  assert.equal(by['2026-10-19'].open, false, 'no price set');
  assert.equal(by['2026-10-21'].open, false, 'blocked in Beds24');
  assert.equal(by['2026-10-23'].minStay, 3);
  assert.ok(!JSON.stringify(nights).includes('Secret'), 'never anything about guests');
  assert.equal(by['2026-10-15'].price, null, 'no price shown for booked nights');
});

test('quote and the hand-off link to the Beds24 booking page', () => {
  const db = setup();
  const s = siteSettings(db, 500), nights = availability(db, 500, { days: 20, now: NOW });
  assert.deepEqual(quote(nights, s, '2026-10-13', '2026-10-15', 2), { ok: true, nights: 2, rooms: 301, cleaning: 95, total: 396 });
  assert.match(quote(nights, s, '2026-10-14', '2026-10-16', 2).reason, /booked/);
  assert.match(quote(nights, s, '2026-10-23', '2026-10-25', 2).reason, /minimum stay for those dates is 3/);
  assert.match(quote(nights, s, '2026-10-13', '2026-10-15', 9).reason, /Up to 8 guests/);
  const u = new URL(checkoutUrl(s, { checkin: '2026-10-13', nights: 2, adults: 3, children: 1 }));
  assert.equal(u.origin + u.pathname, 'https://beds24.com/booking2.php');
  assert.deepEqual(Object.fromEntries(u.searchParams), { propid: '500', checkin: '2026-10-13', numnight: '2', numadult: '3', numchild: '1', referer: 'Direct site' });
});

test('photos: upload checks, order, captions, delete, import from Beds24', async () => {
  const db = setup();
  assert.throws(() => addPhoto(db, 500, { dataUrl: 'data:image/gif;base64,AAAA' }), /JPEG, PNG or WebP/);
  assert.throws(() => addPhoto(db, 500, {}), /No image/);
  const a = addPhoto(db, 500, { dataUrl: PNG, caption: 'Living room' });
  const b = addPhoto(db, 500, { dataUrl: PNG });
  assert.deepEqual(listPhotos(db, 500).map(p => p.id), [a, b]);
  updatePhotos(db, 500, { order: [b, a], captions: { [b]: 'Yard' } });
  assert.deepEqual(listPhotos(db, 500).map(p => [p.id, p.caption]), [[b, 'Yard'], [a, 'Living room']]);
  updatePhotos(db, 500, { remove: [a] });
  assert.deepEqual(listPhotos(db, 500).map(p => p.id), [b]);
  const client = { get: async () => ({ data: [{ id: 500, pictures: [{ url: 'http://media.beds24.com/a.jpg' }, { url: 'https://media.beds24.com/b.jpg' }], roomTypes: [{ images: ['https://media.beds24.com/b.jpg'] }], notes: 'https://example.com/not-a-picture' }] }) };
  assert.deepEqual(await importBeds24Photos(db, client, 500), { found: 2, added: 2 });
  assert.deepEqual(await importBeds24Photos(db, client, 500), { found: 2, added: 0 }, 'not added twice');
  assert.ok(listPhotos(db, 500).some(p => p.url === 'https://media.beds24.com/a.jpg'), 'upgraded to https');
});

test('the page escapes text, never shows bookings, and the terms fill in the times', () => {
  const db = setup();
  saveSite(db, 500, { title: 'Nice <script>alert(1)</script> house', highlights: 'Fenced yard\nFast Wi-Fi', perk: 'Save 10%', contactEmail: 'host@example.com' });
  addPhoto(db, 500, { dataUrl: PNG });
  const html = renderSite(db, siteSettings(db, 500), { base: '/stay/laramie-retreat', origin: 'https://str.example.app' });
  assert.ok(!html.includes('<script>alert(1)'), 'escaped');
  assert.ok(html.includes('Nice &lt;script&gt;'));
  assert.ok(html.includes('<li>Fenced yard</li>'));
  assert.ok(html.includes('Save 10%') && html.includes('mailto:host@example.com'));
  assert.ok(html.includes('"base":"/stay/laramie-retreat"'), 'the calendar loads from this site');
  assert.ok(html.includes('property="og:image" content="https://str.example.app/stay/laramie-retreat/photo/'));
  assert.ok(!html.includes('Secret Guest'));
  const terms = renderTerms(db, siteSettings(db, 500), { base: '/stay/laramie-retreat' });
  assert.match(terms, /Check-in is from 4 PM and checkout is by 11 AM/);
});
