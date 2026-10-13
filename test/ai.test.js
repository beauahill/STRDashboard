import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.js';
import { fakeAnthropic } from './fake-anthropic.js';
import { MODEL, aiStatus, saveKey, saveAiSettings, cacheListing, draftReply, writeListing, reviewPricing, askData, dataTools } from '../server/ai.js';
import { savePricingSettings } from '../server/pricing.js';

const KEY = 'sk-ant-api03-test-key-abcdefghijklmnop';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(1,'Laramie House','Laramie'); INSERT INTO rooms(id,property_id,name,qty) VALUES(10,1,'Whole house',1);");
  const add = db.prepare(`INSERT INTO bookings(id,property_id,room_id,status,channel,arrival,departure,nights,guest_name,phone,adults,children,price,booked_at,source)
    VALUES(?,1,10,?,?,?,?,?,?,?,?,?,?,?,'beds24')`);
  add.run(1, 'confirmed', 'Airbnb', '2026-10-16', '2026-10-18', 2, 'Sam Rivers', '+1 307 555 0142', 2, 1, 600, '2026-09-01T10:00:00Z');
  add.run(2, 'inquiry', 'Airbnb', '2026-11-06', '2026-11-08', 2, 'Ivy Inquirer', null, 2, 0, 0, null);
  add.run(3, 'confirmed', 'VRBO', '2026-01-09', '2026-01-12', 3, 'Jan Guest', null, 2, 0, 450, '2025-12-01T10:00:00Z');
  db.exec(`INSERT INTO messages(id,booking_id,source,body,time,read) VALUES
    (1,1,'guest','Hi! Is there parking for two cars?','2026-10-10T15:00:00Z',0),
    (2,2,'guest','Do you allow dogs?','2026-10-11T15:00:00Z',0);
    INSERT INTO door_codes(booking_id,code) VALUES(1,'0142');`);
  setSetting(db, 'vars_1', JSON.stringify({ wifi_password: 'cowboys2026' }));
  return db;
}

async function withFake(t, opts) {
  const f = await fakeAnthropic(opts);
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = f.url;
  t.after(() => { f.close(); if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev; });
  return f;
}
const messagesCalls = f => f.requests.filter(r => r.url.startsWith('/v1/messages'));

test('API key: checked with Anthropic before saving, never returned, removable', async t => {
  const f = await withFake(t);
  const db = setup();
  assert.equal(aiStatus(db).configured, false);
  await assert.rejects(saveKey(db, 'not-a-key'), /doesn't look like an Anthropic API key/);
  await assert.rejects(saveKey(db, 'sk-ant-bad-key-abcdefghijklmnopqrst'), /didn't accept the API key/);
  assert.equal(aiStatus(db).configured, false, 'a rejected key is not saved');
  const s = await saveKey(db, `  ${KEY}  `);
  assert.equal(s.configured, true);
  assert.equal(s.keyHint, '…mnop');
  assert.ok(!JSON.stringify(s).includes(KEY), 'the key itself is never returned');
  assert.equal(f.requests.at(-1).url, `/v1/models/${MODEL}`, 'checked by reading the model (free)');
  assert.equal(f.requests.at(-1).headers['x-api-key'], KEY);
  assert.equal((await saveKey(db, '')).configured, false);
  await assert.rejects(draftReply(db, 1), /Add your Anthropic API key/);
});

test('draft reply: request shape, stay details, access details only for confirmed guests', async t => {
  const f = await withFake(t);
  const db = setup();
  await saveKey(db, KEY);
  saveAiSettings(db, { notes: { 1: 'Parking: two spots in the driveway. No dogs. Sign off as Sam.' } });
  cacheListing(db, { id: 1, propertyText: { houseRules: 'Quiet hours 10pm to 7am', directions: 'Take exit 313' }, rooms: [] });

  const r = await draftReply(db, 1, { instructions: 'Mention the garage too' });
  assert.match(r.text, /^Draft for:/);
  const [req] = messagesCalls(f);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.deepEqual(req.body.thinking, { type: 'adaptive' });
  assert.equal(req.body.output_config.effort, 'medium');
  assert.deepEqual(req.body.cache_control, { type: 'ephemeral' });
  assert.equal(req.body.tool_choice, undefined, 'never forces a tool');
  const content = req.body.messages[0].content;
  for (const s of ['Sam', 'Is there parking for two cars?', 'Door code: 0142', 'wifi password: cowboys2026', 'two spots in the driveway', 'Quiet hours', 'Take exit 313', 'Mention the garage too', 'Early check-in request']) {
    assert.ok(content.includes(s), `prompt includes ${s}`);
  }
  assert.ok(!content.includes('555 0142'), 'guest phone number is not sent');

  await draftReply(db, 2);
  const inquiry = messagesCalls(f)[1].body.messages[0].content;
  assert.match(inquiry, /inquiry \(not booked\)/);
  assert.ok(inquiry.includes('Do you allow dogs?'));
  for (const s of ['Door code', 'cowboys2026', 'Take exit 313']) assert.ok(!inquiry.includes(s), `inquiry prompt leaves out ${s}`);

  const st = aiStatus(db);
  assert.equal(st.month.requests, 2);
  assert.equal(st.month.cost, 0.02, '1000 input + 200 output tokens at $4/$20 per million, twice');
  assert.equal(st.properties[0].notes, 'Parking: two spots in the driveway. No dogs. Sign off as Sam.');
});

test('refusals, the monthly limit and bad settings become clear errors', async t => {
  await withFake(t, { refuse: true });
  const db = setup();
  await saveKey(db, KEY);
  await assert.rejects(draftReply(db, 1), e => e.status === 422 && /declined/.test(e.message));
  assert.equal(db.prepare('SELECT error FROM ai_usage').get().error, 'refused');
  saveAiSettings(db, { budget: 0 });
  await assert.rejects(draftReply(db, 1), /limit \(\$0\) is used up/);
  assert.throws(() => saveAiSettings(db, { budget: -5 }), /between \$0 and \$10,000/);
  assert.throws(() => saveAiSettings(db, { notes: { 99: 'x' } }), /Unknown property/);
});

test('listing copy: retries once when it runs over the limit', async t => {
  const long = 'Walk to War Memorial Stadium: 3BR home with a big fenced yard near UW';
  const f = await withFake(t, { reply: req => req.messages.length === 1 ? long : 'Walk to UW games · 3BR with fenced yard' });
  const db = setup();
  await saveKey(db, KEY);
  const listing = { property: { name: 'Laramie House', city: 'Laramie' }, propertyText: { headline: 'Nice house', propertyDescription: 'Three bedrooms, fenced yard, 5 minutes to campus.' }, rooms: [{ id: 600, name: 'Whole house', maxPeople: 6, text: { roomDescription: '' } }] };
  const r = await writeListing(db, { propertyId: 1, section: 'propertyText', field: 'headline', listing, instruction: 'mention football' });
  assert.equal(r.text, 'Walk to UW games · 3BR with fenced yard');
  assert.equal(r.limit, 50);
  const calls = messagesCalls(f);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.messages[0].content, /Character limit: 50/);
  assert.match(calls[0].body.messages[0].content, /fenced yard, 5 minutes to campus/);
  assert.match(calls[1].body.messages.at(-1).content, /limit is 50/);

  await writeListing(db, { propertyId: 1, section: 'roomText', field: 'roomDescription', roomId: 600, listing });
  assert.match(messagesCalls(f)[2].body.messages[0].content, /room "Whole house"[\s\S]*Write this field/);
  await assert.rejects(writeListing(db, { propertyId: 1, section: 'property', field: 'name', listing }), /can't be written/);
  await assert.rejects(writeListing(db, { propertyId: 1, section: 'roomText', field: 'roomDescription', roomId: 1, listing }), /Choose a room/);
});

test('pricing review sends settings, events and the nights to review', async t => {
  const f = await withFake(t);
  const db = setup();
  await saveKey(db, KEY);
  await assert.rejects(reviewPricing(db, 10), /Set a base price/);
  savePricingSettings(db, 10, { base: 180 });
  db.exec("INSERT INTO pricing_events(name,start_date,end_date,pct,min_stay,source) VALUES('UW vs Boise State','2026-10-23','2026-10-24',40,2,'schedule')");
  await reviewPricing(db, 10);
  const content = messagesCalls(f)[0].body.messages[0].content;
  assert.match(content, /"base":180/);
  assert.match(content, /UW vs Boise State \(\+40%, min stay 2\)/);
  assert.match(content, /2026-10-16 Fri booked \(Airbnb\)/);
  assert.match(content, /Review the next 90 days/);
  assert.ok(!content.includes('"auto"'), 'auto-pricing internals are left out');
  await reviewPricing(db, 10, { date: '2026-10-23' });
  assert.match(messagesCalls(f)[1].body.messages[0].content, /Explain the price for 2026-10-23/);
});

test('questions about the numbers run a tool loop over the local data', async t => {
  const f = await withFake(t);
  const db = setup();
  await saveKey(db, KEY);
  const r = await askData(db, 'How did January do?', { history: [{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }] });
  assert.match(r.text, /From the data: .*"nights":3/);
  const calls = messagesCalls(f);
  assert.equal(calls.length, 2, 'tool call, then the answer');
  const first = calls[0].body;
  assert.deepEqual(first.messages.map(m => m.role), ['user', 'assistant', 'user'], 'history starts with a user turn');
  assert.ok(first.tools.length >= 6);
  for (const tool of first.tools) {
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.deepEqual(tool.input_schema.required, Object.keys(tool.input_schema.properties));
  }
  assert.match(first.system, /Today is Monday|Today is/);
  assert.equal(calls[1].body.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(aiStatus(db).month.requests, 1, 'one question = one usage row');
  assert.equal(db.prepare('SELECT calls FROM ai_usage').get().calls, 2);
  await assert.rejects(askData(db, '  '), /Ask a question/);
});

test('data tools validate input and respect the property filter', async () => {
  const db = setup();
  const tools = Object.fromEntries(dataTools(db, null, '2026-10-12').map(x => [x.name, x]));
  const stats = JSON.parse(await tools.period_stats.run({ from: '2026-01-01', to: '2026-02-01' }));
  assert.equal(stats.nights, 3);
  await assert.rejects(tools.period_stats.run({ from: '2026-02-01', to: '2026-01-01' }), /from must be before to/);
  await assert.rejects(tools.period_stats.run({ from: 'yesterday', to: '2026-01-01' }), /dates like/);
  const rows = JSON.parse(await tools.list_bookings.run({ from: '2026-01-01', to: '2027-01-01', status: 'active', channel: 'Airbnb', limit: 500 }));
  assert.deepEqual(rows.map(r => r.id), [1]);
  assert.ok(!('phone' in rows[0]) && !('email' in rows[0]), 'no contact details');
  await assert.rejects(tools.nightly_prices.run({ from: '2026-10-12', to: '2027-10-12' }), /at most 180 days/);
  const other = Object.fromEntries(dataTools(db, 99, '2026-10-12').map(x => [x.name, x]));
  assert.deepEqual(JSON.parse(await other.list_bookings.run({ from: '2026-01-01', to: '2027-01-01', status: 'all', channel: 'any', limit: 10 })), []);
});

test('draft reply reads the listing from Beds24 when there is no recent copy, and survives Beds24 errors', async t => {
  const f = await withFake(t);
  const db = setup();
  await saveKey(db, KEY);
  let gets = 0, fail = false;
  const client = { get: async (path, query) => {
    gets++;
    if (fail) throw new Error('Beds24 is down');
    assert.equal(path, '/properties'); assert.deepEqual(query.id, [1]);
    return { data: [{ id: 1, name: 'Laramie House', texts: [{ language: 'en', houseRules: 'No parties after 10pm' }], roomTypes: [] }] };
  } };
  await draftReply(db, 1, { client });
  assert.equal(gets, 1);
  assert.match(messagesCalls(f)[0].body.messages[0].content, /No parties after 10pm/);
  await draftReply(db, 1, { client });
  assert.equal(gets, 1, 'a copy under a day old is reused');
  // Make the copy stale, then have Beds24 fail: the old copy is still used and the draft still works.
  const cached = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'listing_cache_1'").get().value);
  setSetting(db, 'listing_cache_1', JSON.stringify({ ...cached, cachedAt: '2026-01-01T00:00:00Z' }));
  fail = true;
  await draftReply(db, 1, { client });
  assert.equal(gets, 2);
  assert.match(messagesCalls(f)[2].body.messages[0].content, /No parties after 10pm/);
});
