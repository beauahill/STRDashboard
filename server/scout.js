// Event scout: Claude searches the web for upcoming events that bring overnight visitors to the area (UW games
// and commencement, rodeos, festivals, concerts, conferences) and suggests them as pricing events with a price
// uplift. Suggestions wait for the owner: nothing changes prices until one is added. Runs on demand, or weekly
// when switched on.
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { getSetting, setSetting } from './db.js';
import { ask, aiStatus } from './ai.js';
import { listEvents, saveEvent } from './pricing.js';
import { addDays, diffDays } from './sync.js';

const userError = msg => Object.assign(new Error(msg), { status: 400 });
export const SCOUT_DEFAULTS = { auto: false, months: 6, area: '' };
export const CATEGORIES = ['university', 'sports', 'festival', 'concert', 'conference', 'holiday', 'other'];
export const IMPACTS = ['low', 'medium', 'high', 'very_high'];
const CONFIDENCE = ['confirmed', 'likely', 'estimated'];
const WEEK = 7 * 86400e3;

export function scoutSettings(db) {
  let s = {};
  try { s = JSON.parse(getSetting(db, 'scout') || '{}'); } catch { /* defaults */ }
  return { ...SCOUT_DEFAULTS, ...s, defaultArea: defaultArea(db) };
}
function defaultArea(db) {
  const city = db.prepare("SELECT city FROM properties WHERE id > 0 AND city IS NOT NULL AND city != '' ORDER BY name LIMIT 1").get()?.city;
  if (!city || /laramie/i.test(city)) return 'Laramie, Wyoming, plus Cheyenne and Fort Collins (each about an hour away)';
  return `${city} and towns within about an hour`;
}

export function saveScoutSettings(db, input = {}) {
  const s = scoutSettings(db);
  delete s.defaultArea;
  if (input.auto !== undefined) s.auto = !!input.auto;
  if (input.months !== undefined) {
    const m = Number(input.months);
    if (!(Number.isInteger(m) && m >= 1 && m <= 12)) throw userError('Look ahead between 1 and 12 months.');
    s.months = m;
  }
  if (input.area !== undefined) {
    const a = String(input.area || '').trim();
    if (a.length > 200) throw userError('Keep the area under 200 characters.');
    s.area = a;
  }
  setSetting(db, 'scout', JSON.stringify(s));
  return scoutStatus(db);
}

export function scoutStatus(db) {
  let last = null;
  try { last = JSON.parse(getSetting(db, 'scout_last') || 'null'); } catch { /* none */ }
  const s = scoutSettings(db);
  return { ...s, area: s.area || s.defaultArea, customArea: !!s.area, last, aiReady: aiStatus(db).configured,
    nextAuto: s.auto && last?.at ? new Date(Date.parse(last.at) + WEEK).toISOString() : null };
}

export const listSuggestions = (db, { status = 'new', today = null } = {}) =>
  db.prepare(`SELECT * FROM event_suggestions WHERE status = ? ${today ? 'AND end_date >= ?' : ''} ORDER BY start_date, id`).all(status, ...(today ? [today] : []));

const SYSTEM = `You find upcoming events that bring overnight visitors to a short-term rental's area, for the owner's pricing tool. Each event you report becomes a suggested price increase for the nights around it, which the owner reviews.

How to work:
- Search the web. Prefer official sources: university athletics schedules and academic calendars, event organizers, venue calendars, city and visitor-bureau event listings.
- Report only events that make people book a place to stay: college home games (especially football), commencement, orientation and move-in, homecoming and family weekends, big concerts, rodeos, festivals, conferences, tournaments, races, state championships. Skip small local events that don't fill lodging.
- Nights are the nights guests stay (check-in nights), inclusive: for a Saturday game, usually Friday and Saturday night; for a multi-day festival, the night before it starts through the night before it ends, unless people typically stay the last night too.
- Every event needs dates from a source you found. confidence: "confirmed" = an official current schedule; "likely" = a reliable source or organizer announcement; "estimated" = inferred from previous years' pattern (say so in the evidence).
- Suggested price change: very_high impact (sells out the town) 50-80%; high 25-50%; medium 10-25%; low 5-10%. Calibrate to the owner's existing events. suggested_min_stay: 2 for most weekend events, 3 for very high demand, 0 to leave the usual minimum.
- The owner's existing events are listed with ids. If one of them is the same event with the same nights, leave it out. If its nights are wrong, report it with matches_event_id and the corrected nights.
- When you're done, call report_events once with everything you found (an empty list if nothing qualifies).`;

/** Run the scout now. Returns what it found and how many suggestions are new. */
export async function scanEvents(db, { today, propertyId = null } = {}) {
  if (!today) throw new Error('today is required');
  const s = scoutSettings(db);
  const area = s.area || s.defaultArea;
  const end = addDays(today, Math.round(s.months * 30.5));
  const prop = db.prepare(`SELECT name, city FROM properties WHERE id > 0 ${propertyId ? 'AND id = ?' : ''} ORDER BY name LIMIT 1`).get(...(propertyId ? [propertyId] : []));
  const existing = listEvents(db).filter(e => e.end_date >= today && e.start_date <= end);
  const dismissed = listSuggestions(db, { status: 'dismissed', today });

  let reported = null;
  const report = {
    ...betaTool({
      name: 'report_events',
      description: 'Report the events found (call once, at the end). Dates are YYYY-MM-DD; first_night and last_night are the nights guests stay, inclusive.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['events', 'notes'],
        properties: {
          events: { type: 'array', items: { type: 'object', additionalProperties: false,
            required: ['name', 'first_night', 'last_night', 'city', 'category', 'impact', 'suggested_pct', 'suggested_min_stay', 'confidence', 'evidence', 'source_url', 'matches_event_id'],
            properties: {
              name: { type: 'string', description: 'Short name, e.g. "UW football vs Air Force"' },
              first_night: { type: 'string', format: 'date' },
              last_night: { type: 'string', format: 'date' },
              city: { type: 'string' },
              category: { type: 'string', enum: CATEGORIES },
              impact: { type: 'string', enum: IMPACTS },
              suggested_pct: { type: 'integer', description: 'Price change in percent' },
              suggested_min_stay: { type: 'integer', description: 'Nights; 0 = keep the usual minimum stay' },
              confidence: { type: 'string', enum: CONFIDENCE },
              evidence: { type: 'string', description: 'One sentence: where the dates come from and why it fills lodging' },
              source_url: { type: 'string', description: 'The page the dates came from' },
              matches_event_id: { type: 'integer', description: "An existing event's id if this corrects it, else 0" },
            } } },
          notes: { type: 'string', description: 'Anything the owner should know (e.g. schedules not out yet); may be empty' },
        },
      },
      run: async input => { reported = input; return `Received ${input.events?.length || 0} events. You're done; reply with one short sentence.`; },
    }),
    strict: true,
  };
  const content = [
    `Today is ${today}. Find events from ${today} to ${end} in or near: ${area}.`,
    prop ? `The rental: ${prop.name}${prop.city ? ` in ${prop.city}` : ''}.` : '',
    existing.length ? `<existing_events>\n${existing.map(e => `id ${e.id}: ${e.name}, nights ${e.start_date} to ${e.end_date}, ${e.pct > 0 ? '+' : ''}${e.pct}%${e.min_stay ? `, min stay ${e.min_stay}` : ''}${e.source ? ` (${e.source})` : ''}`).join('\n')}\n</existing_events>` : 'The owner has no events yet.',
    dismissed.length ? `<dismissed>\nThe owner already said no to these; don't report them again:\n${dismissed.map(d => `${d.name} (${d.start_date})`).join('\n')}\n</dismissed>` : '',
  ].filter(Boolean).join('\n\n');

  const started = new Date().toISOString();
  let res;
  try {
    res = await ask(db, 'event scout', {
      system: SYSTEM, messages: [{ role: 'user', content }], effort: 'medium', requireText: false, maxIterations: 14,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 }, report],
    });
  } catch (e) {
    setSetting(db, 'scout_last', JSON.stringify({ at: started, error: e.message }));
    throw e;
  }
  if (!reported) {
    const error = res.stopReason === 'max_tokens' ? 'The search ran too long before reporting. Try fewer months.' : 'Claude finished without reporting any events. Try again.';
    setSetting(db, 'scout_last', JSON.stringify({ at: started, error, cost: res.cost, searches: res.searches }));
    throw Object.assign(new Error(error), { status: 502 });
  }
  const r = store(db, reported.events || [], { today, end, existing, foundAt: started });
  const last = { at: started, found: r.found, added: r.added, updated: r.updated, skipped: r.skipped, cost: res.cost, searches: res.searches, notes: String(reported.notes || '').slice(0, 500) };
  setSetting(db, 'scout_last', JSON.stringify(last));
  return { ...last, suggestions: listSuggestions(db, { today }) };
}

// Same event? Compare names by their meaningful words (so "UW Football vs. Air Force" matches "UW football vs Air Force").
const STOP = new Set(['the', 'vs', 'v', 'at', 'and', 'of', 'a', 'weekend', 'game', 'night', 'nights', 'day', 'days', 'annual', 'event']);
const words = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
// Shared words over all the words in both names: "UW football vs Hawaii" and "UW football vs UNLV" share "uw football"
// but are different games, and a one-word name ("Thanksgiving") mustn't match everything that mentions it.
export function sameEvent(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both) >= 0.6;
}
const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
// The same event on other dates (a corrected or estimated date) is usually within a few weeks; a year apart it's next year's.
const near = (a1, a2, b1, b2) => overlaps(a1, a2, b1, b2) || Math.abs(diffDays(a1, b1)) <= 45;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Check, de-duplicate and save what the scout reported. */
export function store(db, events, { today, end, existing = listEvents(db), foundAt = new Date().toISOString() }) {
  let added = 0, updated = 0, skipped = 0;
  const all = db.prepare('SELECT * FROM event_suggestions').all();
  const ins = db.prepare(`INSERT INTO event_suggestions(name,start_date,end_date,city,category,impact,pct,min_stay,confidence,evidence,url,status,replaces_event_id,found_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?)`);
  const upd = db.prepare(`UPDATE event_suggestions SET name=?, start_date=?, end_date=?, city=?, category=?, impact=?, pct=?, min_stay=?, confidence=?, evidence=?, url=?,
    replaces_event_id=?, updated_at=? WHERE id=?`);
  for (const e of events) {
    const name = String(e.name || '').trim().slice(0, 120);
    const start = e.first_night, last = e.last_night;
    // Nights must be real, upcoming, in order, within the window (plus a little), and no longer than three weeks.
    if (!name || !isDate(start) || !isDate(last) || last < start || last < today || start > addDays(end, 31) || diffDays(start, last) > 21) { skipped++; continue; }
    const first = start < today ? today : start;   // an event already under way: only its remaining nights
    const pct = Math.round(Math.max(-30, Math.min(200, Number(e.suggested_pct) || 0)));
    const minStay = Number.isInteger(e.suggested_min_stay) && e.suggested_min_stay >= 1 && e.suggested_min_stay <= 14 ? e.suggested_min_stay : null;
    const url = /^https?:\/\/\S+$/i.test(String(e.source_url || '').trim()) ? String(e.source_url).trim().slice(0, 500) : null;
    const fields = [name, first, last, String(e.city || '').slice(0, 80) || null, CATEGORIES.includes(e.category) ? e.category : 'other',
      IMPACTS.includes(e.impact) ? e.impact : 'medium', pct, minStay, CONFIDENCE.includes(e.confidence) ? e.confidence : 'likely',
      String(e.evidence || '').trim().slice(0, 400) || null, url];
    // An existing event: skip it if the nights already match; otherwise this is a date correction. When Claude
    // names the event it means, that's used; otherwise names are compared. Nights are compared as reported, before
    // an event under way is trimmed to start today.
    const named = e.matches_event_id > 0 ? existing.find(x => x.id === e.matches_event_id) : null;
    const match = named || (e.matches_event_id > 0 ? null : existing.find(x => near(x.start_date, x.end_date, start, last) && sameEvent(x.name, name)));
    if (match && (match.start_date === start || (start < today && match.start_date <= today)) && match.end_date === last) { skipped++; continue; }
    const replaces = match ? match.id : null;
    // Already suggested (or dismissed, or added) before: refresh an open suggestion, leave the others alone.
    const prior = all.find(x => (x.replaces_event_id && x.replaces_event_id === replaces)
      || (near(x.start_date, x.end_date, first, last) && sameEvent(x.name, name)));
    if (prior) {
      if (prior.status !== 'new') { skipped++; continue; }
      upd.run(...fields, replaces, foundAt, prior.id); updated++;
      continue;
    }
    const id = Number(ins.run(...fields, replaces, foundAt, foundAt).lastInsertRowid); added++;
    all.push({ id, name, start_date: first, end_date: last, status: 'new', replaces_event_id: replaces });   // reported twice in one scan
  }
  return { found: events.length, added, updated, skipped };
}

/** Turn a suggestion into a pricing event (or correct the event it matches). The owner may adjust it first. */
export function addSuggestion(db, id, overrides = {}) {
  const sug = db.prepare('SELECT * FROM event_suggestions WHERE id = ?').get(Number(id));
  if (!sug) throw userError('That suggestion no longer exists.');
  if (sug.status !== 'new') throw userError('That suggestion was already handled.');
  const target = sug.replaces_event_id && db.prepare('SELECT * FROM pricing_events WHERE id = ?').get(sug.replaces_event_id);
  const ev = {
    id: target ? target.id : null,
    name: overrides.name ?? (target ? target.name : sug.name),
    start_date: overrides.start_date ?? sug.start_date, end_date: overrides.end_date ?? sug.end_date,
    pct: overrides.pct ?? (target ? target.pct : sug.pct), min_stay: overrides.min_stay ?? (target ? target.min_stay : sug.min_stay),
  };
  const source = `Event scout${sug.confidence === 'estimated' ? ' (estimated: check the date)' : ''}${sug.url ? ': ' + sug.url : ''}`;
  const eventId = saveEvent(db, ev, { source: source.slice(0, 300) });
  db.prepare("UPDATE event_suggestions SET status = 'added', event_id = ?, updated_at = ? WHERE id = ?").run(eventId, new Date().toISOString(), sug.id);
  return { eventId };
}

export function dismissSuggestion(db, id) {
  const r = db.prepare("UPDATE event_suggestions SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'new'").run(new Date().toISOString(), Number(id));
  if (!r.changes) throw userError('That suggestion was already handled.');
}

/** Weekly run, when switched on and Claude is set up. Returns null when it isn't due. */
export async function autoScan(db, today, now = Date.now()) {
  const st = scoutStatus(db);
  if (!st.auto || !st.aiReady || getSetting(db, 'demo') === '1') return null;
  if (st.last?.at && now - Date.parse(st.last.at) < (st.last.error ? 86400e3 : WEEK)) return null;   // retry a failed run after a day
  return scanEvents(db, { today });
}
