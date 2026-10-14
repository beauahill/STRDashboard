import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, getSetting } from '../server/db.js';
import { fakeAnthropic } from './fake-anthropic.js';
import { scanEvents, store, sameEvent, listSuggestions, addSuggestion, dismissSuggestion, saveScoutSettings, scoutStatus, autoScan } from '../server/scout.js';
import { listEvents, recommend, savePricingSettings } from '../server/pricing.js';
import { saveNotifySettings, collect } from '../server/notify.js';

const TODAY = '2026-10-14';
const KEY = 'sk-ant-api03-test-key-abcdefghijklmnop';

function setup() {
  const db = openDb();
  db.exec("INSERT INTO properties(id,name,city) VALUES(1,'Laramie House','Laramie'); INSERT INTO rooms(id,property_id,name) VALUES(10,1,'Whole house');");
  db.prepare("INSERT INTO pricing_events(id,name,start_date,end_date,pct,min_stay,source) VALUES(5,'UW Commencement weekend','2027-05-07','2027-05-08',50,2,'estimated: check the date')").run();
  db.prepare("INSERT INTO pricing_events(id,name,start_date,end_date,pct,min_stay,source) VALUES(6,'UW football vs Air Force','2026-10-23','2026-10-24',70,2,'gowyo.com')").run();
  return db;
}
const ev = (over = {}) => ({ name: 'Laramie Brewfest', first_night: '2026-11-13', last_night: '2026-11-14', city: 'Laramie', category: 'festival', impact: 'medium',
  suggested_pct: 20, suggested_min_stay: 2, confidence: 'confirmed', evidence: 'Organizer site lists the dates.', source_url: 'https://example.org/brewfest', matches_event_id: 0, ...over });

async function withFake(t, opts) {
  const f = await fakeAnthropic(opts);
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = f.url;
  t.after(() => { f.close(); if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev; });
  return f;
}

test('names match on their meaningful words', () => {
  assert.ok(sameEvent('UW Football vs. Air Force', 'UW football vs Air Force'));
  assert.ok(sameEvent('UW Commencement', 'UW Commencement weekend'));
  assert.ok(!sameEvent('UW football vs Air Force', 'UW football vs Boise State'));
  assert.ok(!sameEvent('Laramie Brewfest', 'Laramie Jubilee Days'));
});

test('storing finds: checked, de-duplicated against events and earlier suggestions, corrections flagged', () => {
  const db = setup();
  const r = store(db, [
    ev(),
    ev({ name: 'Bad dates', first_night: '2026-11-20', last_night: '2026-11-19' }),
    ev({ name: 'Already over', first_night: '2026-09-01', last_night: '2026-09-02' }),
    ev({ name: 'Far too long', first_night: '2026-11-01', last_night: '2026-12-31' }),
    ev({ name: 'UW football vs Air Force', first_night: '2026-10-23', last_night: '2026-10-24', matches_event_id: 6 }),   // same as the owner's
    ev({ name: 'UW Commencement', first_night: '2027-05-14', last_night: '2027-05-15', impact: 'very_high', suggested_pct: 60, matches_event_id: 0 }),
    ev({ name: 'Rodeo', source_url: 'javascript:alert(1)', suggested_pct: 900, suggested_min_stay: 40, category: 'rodeo', impact: 'huge' }),
  ], { today: TODAY, end: '2027-04-14' });
  assert.deepEqual(r, { found: 7, added: 3, updated: 0, skipped: 4 });
  const sug = Object.fromEntries(listSuggestions(db).map(s => [s.name, s]));
  assert.deepEqual(Object.keys(sug).sort(), ['Laramie Brewfest', 'Rodeo', 'UW Commencement']);
  assert.equal(sug['UW Commencement'].replaces_event_id, 5, 'a date correction for the estimated commencement');
  assert.deepEqual([sug.Rodeo.url, sug.Rodeo.pct, sug.Rodeo.min_stay, sug.Rodeo.category, sug.Rodeo.impact], [null, 200, null, 'other', 'medium'], 'cleaned up');

  // A later scan refreshes an open suggestion, and never brings back a dismissed one.
  dismissSuggestion(db, sug.Rodeo.id);
  const again = store(db, [ev({ suggested_pct: 25 }), ev({ name: 'Rodeo' })], { today: TODAY, end: '2027-04-14' });
  assert.deepEqual(again, { found: 2, added: 0, updated: 1, skipped: 1 });
  assert.equal(listSuggestions(db).find(s => s.name === 'Laramie Brewfest').pct, 25);
  assert.throws(() => dismissSuggestion(db, sug.Rodeo.id), /already handled/);
});

test('adding a suggestion makes a pricing event (or corrects one), and prices follow', () => {
  const db = setup();
  savePricingSettings(db, 10, { base: 100, rounding: 1, dow: [0, 0, 0, 0, 0, 0, 0], season: Array(12).fill(0), pacing: false, lastMinuteDays: 0, farOutPct: 0, demand: false });
  store(db, [ev(), ev({ name: 'UW Commencement', first_night: '2027-05-14', last_night: '2027-05-15', confidence: 'likely', matches_event_id: 5, source_url: '' })], { today: TODAY, end: '2027-05-30' });
  const [brew, comm] = ['Laramie Brewfest', 'UW Commencement'].map(n => listSuggestions(db).find(s => s.name === n));
  const { eventId } = addSuggestion(db, brew.id, { pct: 30, min_stay: '' });
  const made = listEvents(db).find(e => e.id === eventId);
  assert.deepEqual([made.name, made.start_date, made.end_date, made.pct, made.min_stay, made.source],
    ['Laramie Brewfest', '2026-11-13', '2026-11-14', 30, null, 'Event scout: https://example.org/brewfest']);
  assert.equal(recommend(db, 10, { start: '2026-11-13', days: 1, today: TODAY }).nights[0].price, 130);
  assert.throws(() => addSuggestion(db, brew.id), /already handled/);

  addSuggestion(db, comm.id);
  const fixed = listEvents(db).find(e => e.id === 5);
  assert.deepEqual([fixed.name, fixed.start_date, fixed.end_date, fixed.pct, fixed.source], ['UW Commencement weekend', '2027-05-14', '2027-05-15', 50, 'Event scout']);
  assert.equal(listEvents(db).length, 3, 'corrected in place, not duplicated');
  assert.deepEqual(listSuggestions(db), []);
  assert.equal(listSuggestions(db, { status: 'added' }).length, 2);
});

test('scan: Claude with web search and fetch reports through a strict tool; paused turns resume; cost includes searches', async t => {
  const reported = [ev(), ev({ name: 'UW basketball vs Colorado State', first_night: '2026-12-05', last_night: '2026-12-05', category: 'sports', impact: 'high', suggested_pct: 30 })];
  const f = await withFake(t, { pauseFirst: true, searches: 4, toolCall: () => ({ name: 'report_events', input: { events: reported, notes: 'Basketball schedule partly out.' } }) });
  const db = setup();
  await assert.rejects(scanEvents(db, { today: TODAY }), /Add your Anthropic API key/);
  setSetting(db, 'anthropic_api_key', KEY);
  saveScoutSettings(db, { months: 3, area: 'Laramie, WY' });

  const r = await scanEvents(db, { today: TODAY, propertyId: 1 });
  assert.deepEqual([r.found, r.added, r.searches], [2, 2, 12]);
  assert.equal(r.notes, 'Basketball schedule partly out.');
  assert.ok(r.cost > 0.1, 'three calls with four searches each');
  const calls = f.requests.filter(x => x.url.startsWith('/v1/messages'));
  assert.equal(calls.length, 3, 'paused turn, resumed turn (calls the tool), final reply');
  const body = calls[0].body;
  assert.deepEqual(body.tools.map(x => (x.type === 'custom' ? x.name : x.type)), ['web_search_20260209', 'web_fetch_20260209', 'report_events']);
  assert.equal(body.tools[0].max_uses, 12);
  const tool = body.tools.find(x => x.name === 'report_events');
  assert.equal(tool.strict, true);
  assert.equal(body.tool_choice, undefined, 'never forced');
  assert.match(body.messages[0].content, /from 2026-10-14 to 2027-01-14 in or near: Laramie, WY/);
  assert.match(body.messages[0].content, /id 6: UW football vs Air Force, nights 2026-10-23 to 2026-10-24/);
  assert.equal(calls[1].body.messages.at(-1).role, 'assistant', 'the paused turn is sent back to continue');
  assert.deepEqual(listSuggestions(db).map(s => s.name), ['Laramie Brewfest', 'UW basketball vs Colorado State']);
  const st = scoutStatus(db);
  assert.equal(st.last.added, 2);
  assert.equal(st.area, 'Laramie, WY');
  assert.equal(db.prepare("SELECT task FROM ai_usage ORDER BY id DESC LIMIT 1").get().task, 'event scout');

  // New finds reach the owner's phone once.
  saveNotifySettings(db, { enabled: true, topic: 'str-test-topic-abcdef' });
  db.prepare('UPDATE event_suggestions SET found_at = ?').run(new Date(Date.now() + 1000).toISOString());
  const note = collect(db).find(n => n.refs[0][0] === 'scout');
  assert.match(note.title, /Event scout found 2 events/);
  assert.match(note.message, /Nov 13: Laramie Brewfest\nDec 5: UW basketball vs Colorado State/);
});

test('scan: no report is an error the page can show', async t => {
  await withFake(t, { toolCall: () => null, reply: () => 'I looked around.' });
  const db = setup();
  setSetting(db, 'anthropic_api_key', KEY);
  await assert.rejects(scanEvents(db, { today: TODAY }), /finished without reporting/);
  assert.match(scoutStatus(db).last.error, /finished without reporting/);
});

test('scout settings and the weekly run', async t => {
  await withFake(t, { toolCall: () => ({ name: 'report_events', input: { events: [ev()], notes: '' } }) });
  const db = setup();
  assert.match(scoutStatus(db).area, /^Laramie, Wyoming, plus Cheyenne and Fort Collins/);
  assert.throws(() => saveScoutSettings(db, { months: 13 }), /between 1 and 12/);
  assert.throws(() => saveScoutSettings(db, { area: 'x'.repeat(201) }), /under 200/);
  assert.equal(await autoScan(db, TODAY), null, 'off by default');
  saveScoutSettings(db, { auto: true });
  assert.equal(await autoScan(db, TODAY), null, 'needs Claude set up');
  setSetting(db, 'anthropic_api_key', KEY);
  const r = await autoScan(db, TODAY);
  assert.equal(r.added, 1);
  assert.equal(await autoScan(db, TODAY), null, 'not again within a week');
  assert.ok(await autoScan(db, TODAY, Date.now() + 8 * 86400e3), 'a week later');
  setSetting(db, 'scout_last', JSON.stringify({ at: new Date(Date.now() - 2 * 86400e3).toISOString(), error: 'boom' }));
  assert.ok(await autoScan(db, TODAY), 'a failed run is retried after a day');
  setSetting(db, 'demo', '1');
  assert.equal(await autoScan(db, TODAY, Date.now() + 30 * 86400e3), null, 'never on demo data');
  assert.equal(getSetting(db, 'scout') && JSON.parse(getSetting(db, 'scout')).defaultArea, undefined, 'the default area is computed, not saved');
});
