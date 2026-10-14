import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertProperties } from '../server/sync.js';
import { fetchListing, diffListing, saveListing, listingLog } from '../server/listing.js';

/** Beds24 /properties stand-in that applies POSTed changes (including nested texts and rooms). */
class FakeProps {
  constructor() {
    this.p = { id: 500, name: 'Laramie Retreat', propertyType: 'house', city: 'Laramie', state: 'WY', checkInStart: '16:00', checkOutEnd: '11:00',
      texts: [{ language: 'en', headline: 'Cozy house near UW', propertyDescription: 'Three bedrooms.' }],
      roomTypes: [{ id: 600, name: 'Whole house', maxPeople: 6, cleaningFee: 95, texts: [{ language: 'en', roomDescription: 'Sleeps 6' }] }] };
    this.posts = []; this.ignore = false; this.reject = null;
  }
  async get(path, q) { assert.equal(path, '/properties'); assert.deepEqual(q.id, [500]); return { data: [structuredClone(this.p)] }; }
  async post(path, body) {
    this.posts.push(body);
    if (this.reject) return [{ success: false, errors: [{ message: this.reject }] }];
    if (this.ignore) return [{ success: true }];
    const { texts, roomTypes, id, ...fields } = body[0];
    Object.assign(this.p, fields);
    for (const t of texts || []) Object.assign(this.p.texts.find(x => x.language === t.language), t);
    for (const r of roomTypes || []) {
      const room = this.p.roomTypes.find(x => x.id === r.id);
      const { texts: rt, ...rf } = r; Object.assign(room, rf);
      for (const t of rt || []) Object.assign(room.texts.find(x => x.language === t.language), t);
    }
    return [{ success: true }];
  }
}

test('reads the listing into the editor shape', async () => {
  const L = await fetchListing(new FakeProps(), 500);
  assert.equal(L.property.name, 'Laramie Retreat');
  assert.equal(L.propertyText.headline, 'Cozy house near UW');
  assert.equal(L.propertyText.houseRules, '', 'missing texts come back empty');
  assert.equal(L.rooms[0].maxPeople, 6);
  assert.equal(L.rooms[0].text.roomDescription, 'Sleeps 6');
});

test('diff: only what changed, nested the way Beds24 expects', async () => {
  const cur = await fetchListing(new FakeProps(), 500);
  const edited = structuredClone(cur);
  edited.propertyText.headline = 'Walk to War Memorial Stadium';
  edited.property.checkInStart = '15:00';
  edited.rooms[0].maxPeople = '8';
  edited.rooms[0].text.roomDescription = 'Sleeps 8';
  const { changes, body } = diffListing(cur, edited);
  assert.deepEqual(changes.map(c => c.label), ['Check-in from', 'Headline', 'Max guests', 'Room description']);
  assert.deepEqual(body, { id: 500, checkInStart: '15:00', texts: [{ language: 'en', headline: 'Walk to War Memorial Stadium' }],
    roomTypes: [{ id: 600, maxPeople: 8, texts: [{ language: 'en', roomDescription: 'Sleeps 8' }] }] });
  assert.deepEqual(diffListing(cur, structuredClone(cur)).changes, [], 'no changes, no update');
});

test('diff: validation', async () => {
  const cur = await fetchListing(new FakeProps(), 500);
  const bad = patch => { const e = structuredClone(cur); patch(e); return () => diffListing(cur, e); };
  assert.throws(bad(e => { e.property.name = '  '; }), /can't be empty/);
  assert.throws(bad(e => { e.propertyText.headline = 'x'.repeat(201); }), /too long \(201\/200/);
  assert.throws(bad(e => { e.property.checkInStart = '4pm'; }), /valid check-in from/);
  assert.throws(bad(e => { e.rooms[0].maxPeople = 0; }), /between 1 and 50/);
  assert.throws(bad(e => { e.rooms[0].id = 999; }), /no longer exists/);
  assert.throws(bad(e => { e.rooms[0].maxPeople = ''; }), /Max guests is required/, 'clearing a value Beds24 has is refused');
  assert.deepEqual(diffListing(cur, (() => { const e = structuredClone(cur); e.rooms[0].securityDeposit = ''; return e; })()).changes, [],
    'a field Beds24 never had, left blank, is not a change');
});

test('save: sends the changes, confirms by re-reading, logs, and updates local names', async () => {
  const db = openDb(':memory:');
  upsertProperties(db, [{ id: 500, name: 'Laramie Retreat', roomTypes: [{ id: 600, name: 'Whole house' }] }]);
  const c = new FakeProps();
  const cur = await fetchListing(c, 500);
  const edited = structuredClone(cur);
  edited.property.name = 'Laramie Retreat on Grand';
  edited.propertyText.propertyDescription = 'Three bedrooms, two baths, five minutes to campus.';
  const r = await saveListing(db, c, 500, edited);
  assert.equal(r.applied, 2); assert.deepEqual(r.warnings, []);
  assert.equal(c.p.name, 'Laramie Retreat on Grand');
  assert.equal(db.prepare('SELECT name FROM properties WHERE id = 500').get().name, 'Laramie Retreat on Grand');
  assert.equal(listingLog(db, 500)[0].ok, 1);
  assert.match(listingLog(db, 500)[0].summary, /Property name.*Description/);

  c.ignore = true;
  edited.propertyText.headline = 'Changed but not stored';
  const r2 = await saveListing(db, c, 500, edited);
  assert.match(r2.warnings[0], /different values for: Headline/);
  c.ignore = false; c.reject = 'headline contains a phone number';
  edited.propertyText.headline = 'Call 307-555-0100';
  await assert.rejects(saveListing(db, c, 500, edited), /rejected the change: headline contains a phone number/);
  assert.equal(listingLog(db, 500)[0].ok, 0);
});

test('a number Beds24 returns as a string is not a change', async () => {
  const c = new FakeProps();
  Object.assign(c.p.roomTypes[0], { cleaningFee: '95.00', maxPeople: '6' });
  c.p.postcode = '02070';
  const cur = await fetchListing(c, 500);
  assert.deepEqual(diffListing(cur, structuredClone(cur)).changes, [], 'an untouched form has nothing to push');
  const edited = structuredClone(cur);
  edited.rooms[0].cleaningFee = '120';
  assert.deepEqual(diffListing(cur, edited).changes.map(x => [x.field, x.before, x.after]), [['cleaningFee', '95.00', 120]]);
  edited.rooms[0].cleaningFee = '95';
  edited.property.postcode = '2070';   // text stays text: a ZIP that lost its leading zero is a change
  assert.deepEqual(diffListing(cur, edited).changes.map(x => x.field), ['postcode']);
});
