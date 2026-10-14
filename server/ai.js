// AI assistant (Claude, through the owner's own Anthropic API key): drafts guest replies, writes listing copy,
// reviews pricing and answers questions about the numbers. Nothing it writes is sent to a guest or saved to
// Beds24 until the owner presses the usual Send / Save / Apply button.
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { getSetting, setSetting } from './db.js';
import { thread, savedReplies, fmtTime } from './messages.js';
import { recommend, listEvents } from './pricing.js';
import { FIELDS, fetchListing } from './listing.js';
import { doorSettings, localToday } from './doors.js';
import { periodStats } from './stats.js';
import { addDays, diffDays } from './sync.js';
import * as stats from './analytics.js';

export const MODEL = 'claude-opus-5-5';
// If Claude declines a request, the API retries it on Anthropic's recommended fallback model in the same call.
const BETAS = ['server-side-fallback-2026-07-01'];
// US$ per million tokens (and per web search), for the running cost estimate in Settings.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, search: 0.01 };
export const DEFAULT_BUDGET = 25;

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const keyOf = db => getSetting(db, 'anthropic_api_key') || process.env.ANTHROPIC_API_KEY || null;
const makeClient = apiKey => new Anthropic({ apiKey, timeout: 240e3, maxRetries: 1 });
const monthStart = () => new Date().toISOString().slice(0, 7) + '-01';

export function aiStatus(db) {
  const key = keyOf(db);
  const month = db.prepare('SELECT COUNT(*) requests, COALESCE(SUM(cost),0) cost FROM ai_usage WHERE at >= ?').get(monthStart());
  return {
    configured: !!key, keyHint: key ? `…${key.slice(-4)}` : null, fromEnv: !!key && !getSetting(db, 'anthropic_api_key'),
    model: MODEL, budget: budget(db), month: { requests: month.requests, cost: Math.round(month.cost * 100) / 100 },
    properties: db.prepare('SELECT id, name FROM properties WHERE id > 0 ORDER BY name').all().map(p => ({ ...p, notes: getSetting(db, `ai_notes_${p.id}`) || '' })),
  };
}
const budget = db => Number(getSetting(db, 'ai_budget') ?? DEFAULT_BUDGET);

/** Save (or remove, when empty) the API key, after checking with Anthropic that it works. The check is free. */
export async function saveKey(db, key) {
  key = String(key || '').trim();
  if (!key) { setSetting(db, 'anthropic_api_key', null); return aiStatus(db); }
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw err('That doesn\'t look like an Anthropic API key (they start with "sk-ant-").');
  try { await makeClient(key).models.retrieve(MODEL); } catch (e) { throw friendly(e); }
  setSetting(db, 'anthropic_api_key', key);
  return aiStatus(db);
}

export function saveAiSettings(db, { budget: b, notes } = {}) {
  if (b !== undefined) {
    const n = Number(b);
    if (!(Number.isFinite(n) && n >= 0 && n <= 10000)) throw err('The monthly limit must be between $0 and $10,000.');
    setSetting(db, 'ai_budget', n);
  }
  for (const [pid, text] of Object.entries(notes || {})) {
    if (!db.prepare('SELECT 1 FROM properties WHERE id = ?').get(Number(pid))) throw err('Unknown property.');
    if (String(text).length > 10000) throw err('House notes can be at most 10,000 characters.');
    setSetting(db, `ai_notes_${Number(pid)}`, String(text || '').trim() || null);
  }
  return aiStatus(db);
}

// Anthropic's errors, turned into something the owner can act on.
function friendly(e) {
  const detail = e?.error?.error?.message || e?.message || 'unknown error';
  if (e instanceof Anthropic.AuthenticationError) return err('Anthropic didn\'t accept the API key. Check it in Settings → AI assistant.');
  if (e instanceof Anthropic.PermissionDeniedError) return err(`Your Anthropic key isn't allowed to do this: ${detail}`);
  if (e instanceof Anthropic.NotFoundError) return err(`Your Anthropic account can't use ${MODEL}: ${detail}`);
  if (e instanceof Anthropic.RateLimitError) return err('Anthropic\'s rate limit was hit. Wait a minute and try again.', 429);
  if (e instanceof Anthropic.BadRequestError) return err(`Anthropic rejected the request: ${detail}`);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return err('Claude took too long to answer. Try again.', 504);
  if (e instanceof Anthropic.APIConnectionError) return err('Couldn\'t reach Anthropic. Try again in a moment.', 502);
  if (e instanceof Anthropic.APIError) return err(e.status === 529 ? 'Claude is overloaded right now. Try again in a minute.' : `Anthropic error (${e.status}): ${detail}`, 502);
  return e;
}

function record(db, task, u, error) {
  const cost = (u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6
    + (u.searches || 0) * PRICE.search;
  db.prepare(`INSERT INTO ai_usage(at,task,calls,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,cost,error)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString(), task, u.calls, u.input, u.output, u.cacheWrite, u.cacheRead, cost, error);
  return cost;
}

/**
 * One request to Claude (or a tool-use loop when `tools` are given). Returns the text of the final answer.
 * Refusals and cut-off answers become errors rather than half an answer. `requireText: false` is for tasks whose
 * result arrives through a tool call rather than the final text.
 */
export async function ask(db, task, { system, messages, tools = null, effort = 'medium', maxTokens = 16000, requireText = true, maxIterations = 10 }) {
  const key = keyOf(db);
  if (!key) throw err('Add your Anthropic API key in Settings → AI assistant first.');
  const spent = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM ai_usage WHERE at >= ?').get(monthStart()).c;
  if (spent >= budget(db)) throw err(`This month's AI limit ($${budget(db)}) is used up. Raise it in Settings → AI assistant.`);
  const client = makeClient(key);
  const params = {
    model: MODEL, max_tokens: maxTokens, betas: BETAS, fallbacks: 'default',
    thinking: { type: 'adaptive' }, output_config: { effort }, cache_control: { type: 'ephemeral' },
    system, messages,
  };
  const used = { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  const add = m => {
    used.calls++;
    used.searches += m.usage?.server_tool_use?.web_search_requests || 0;
    used.input += m.usage?.input_tokens || 0; used.output += m.usage?.output_tokens || 0;
    used.cacheWrite += m.usage?.cache_creation_input_tokens || 0; used.cacheRead += m.usage?.cache_read_input_tokens || 0;
  };
  let msg;
  try {
    if (tools) {
      const runner = client.beta.messages.toolRunner({ ...params, tools, max_iterations: maxIterations });
      for await (const m of runner) {
        add(m);
        // A long web-search turn can pause; the runner doesn't resume those on its own.
        if (m.stop_reason === 'pause_turn') runner.pushMessages({ role: 'assistant', content: m.content });
      }
      msg = await runner.done();
    } else {
      msg = await client.beta.messages.create(params);
      add(msg);
    }
  } catch (e) {
    record(db, task, used, e.message);
    throw friendly(e);
  }
  const cost = record(db, task, used, msg.stop_reason === 'refusal' ? 'refused' : null);
  if (msg.stop_reason === 'refusal') throw err('Claude declined to help with this one. Try rewording it.', 422);
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!requireText) return { text, stopReason: msg.stop_reason, cost: Math.round(cost * 1000) / 1000, searches: used.searches, model: msg.model };
  if (!text) throw err(msg.stop_reason === 'max_tokens' ? 'The answer got too long and was cut off. Try asking for something narrower.' : 'Claude didn\'t finish an answer. Try again or ask something narrower.', 502);
  return { text, truncated: msg.stop_reason === 'max_tokens', cost: Math.round(cost * 1000) / 1000, model: msg.model };
}

// ---------- Shared context ----------
const longDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const property = (db, id) => db.prepare('SELECT * FROM properties WHERE id = ?').get(id);

/** The last listing text read from Beds24 (saved whenever the Listing page loads, or a draft needs it). */
export const cacheListing = (db, listing) => setSetting(db, `listing_cache_${listing.id}`, JSON.stringify({ ...listing, cachedAt: new Date().toISOString() }));
function cachedListing(db, propertyId) {
  try { return JSON.parse(getSetting(db, `listing_cache_${propertyId}`) || 'null'); } catch { return null; }
}
/** The cached listing, re-read from Beds24 when there's no copy or it's over a day old. Never fails a draft. */
async function listingFor(db, client, propertyId) {
  const cached = cachedListing(db, propertyId);
  if (!client || !(propertyId > 0) || (cached && Date.now() - Date.parse(cached.cachedAt || 0) < 86400e3)) return cached;
  try { const fresh = await fetchListing(client, propertyId); cacheListing(db, fresh); return fresh; }
  catch { return cached; }
}
function listingText(listing, { access = true } = {}) {
  if (!listing) return '';
  const lines = [];
  for (const f of FIELDS.propertyText) {
    if (!access && f.key === 'directions') continue;
    const v = listing.propertyText?.[f.key];
    if (v) lines.push(`${f.label}: ${v}`);
  }
  for (const r of listing.rooms || []) {
    lines.push(`Room "${r.name}": up to ${r.maxPeople ?? '?'} guests${r.cleaningFee ? `, cleaning fee $${r.cleaningFee}` : ''}`);
    for (const f of FIELDS.roomText) if (r.text?.[f.key]) lines.push(`  ${f.label}: ${r.text[f.key]}`);
  }
  return lines.join('\n');
}

// ---------- Guest reply drafts ----------
const DRAFT_SYSTEM = `You draft replies to short-term-rental guests for the host. The host reads and edits every draft before sending it, so write it ready to send, as the host.

- Reply in the language of the guest's latest message.
- Answer what the guest actually asked, warmly and briefly: usually two to five sentences. Plain text only: no markdown, no subject line.
- Use only the facts given (stay details, house notes, listing text, saved replies). When the reply needs something you don't know, put a short placeholder in square brackets, such as [confirm: parking spot number], rather than guessing.
- Don't promise refunds, discounts, extra nights, early check-in or late checkout unless the house notes allow it; offer to check instead.
- Access details (door code, address, Wi-Fi) are only given to you for confirmed stays; include them only when the guest needs them now.
- On Airbnb, don't share email addresses, phone numbers or links to book elsewhere, and never ask the guest to pay outside Airbnb.
- Greet the guest by first name. Sign off simply; add a name only if the house notes give one.
- Return only the message text.`;

export async function draftReply(db, bookingId, { instructions = '', client = null } = {}) {
  const t = thread(db, bookingId);
  const b = t.booking;
  if (!b) throw err('This conversation has no booking details to draft from.');
  const ds = doorSettings(db);
  const confirmed = ['confirmed', 'new'].includes(b.status);
  const p = property(db, b.property_id);
  const notes = getSetting(db, `ai_notes_${b.property_id}`);
  const statusText = { confirmed: 'confirmed booking', new: 'confirmed booking', request: 'booking request (not yet accepted)', inquiry: 'inquiry (not booked)', cancelled: 'cancelled booking' }[b.status] || b.status;
  const stay = [
    `Today: ${longDate(localToday(ds.tz))}`,
    `Property: ${p?.name || b.property_name || ''}${p?.city ? ` (${p.city})` : ''}`,
    `Guest first name: ${t.vars.guest_first_name}`,
    `Status: ${statusText}, via ${b.channel}`,
    `Stay: ${longDate(b.arrival)} to ${longDate(b.departure)} (${b.nights} night${b.nights === 1 ? '' : 's'}), ${b.adults || 0} adult(s)${b.children ? `, ${b.children} child(ren)` : ''}`,
    `Check-in from ${fmtTime(ds.checkin)}, checkout by ${fmtTime(ds.checkout)}`,
  ];
  if (confirmed) {
    if (t.vars.door_code) stay.push(`Door code: ${t.vars.door_code} (works from check-in time to checkout time)`);
    for (const [k, v] of Object.entries(t.vars)) {
      if (v && !['guest_first_name', 'guest_name', 'check_in_date', 'check_out_date', 'check_in_time', 'check_out_time', 'nights', 'guests', 'property_name', 'door_code'].includes(k)) stay.push(`${k.replace(/_/g, ' ')}: ${v}`);
    }
  }
  const listing = await listingFor(db, client, b.property_id);
  const replies = savedReplies(db).map(r => `### ${r.title}\n${r.body}`).join('\n\n');
  const convo = t.messages.slice(-40).map(m => {
    const who = { guest: 'Guest', host: 'Host', internalNote: 'Host\'s private note (the guest can\'t see this)', system: 'Channel notice' }[m.source] || m.source;
    return `[${m.time.slice(0, 16).replace('T', ' ')}] ${who}: ${(m.body || (m.attachment_name ? `(attachment: ${m.attachment_name})` : '')).slice(0, 2000)}`;
  }).join('\n');
  const content = [
    `<stay>\n${stay.join('\n')}\n</stay>`,
    notes && `<house_notes>\n${notes}\n</house_notes>`,
    listing && `<listing>\n${listingText(listing, { access: confirmed })}\n</listing>`,
    replies && `<saved_replies>\nThe host's saved replies, with {fill-ins}. Use them for tone and facts.\n\n${replies}\n</saved_replies>`,
    `<conversation>\n${convo || '(no messages yet)'}\n</conversation>`,
    instructions.trim() && `<host_instructions>\n${instructions.trim().slice(0, 2000)}\n</host_instructions>`,
    'Draft the host\'s next message to this guest.',
  ].filter(Boolean).join('\n\n');
  return ask(db, 'draft', { system: DRAFT_SYSTEM, messages: [{ role: 'user', content }] });
}

// ---------- Listing copy ----------
const LISTING_SYSTEM = `You write listing copy for a short-term rental. The host reviews every suggestion before saving it; it's published on Airbnb, VRBO, Booking.com and a direct booking site through Beds24.

- Be specific: build on the details already in the listing. Never invent amenities, distances, views or features that aren't mentioned; if a detail would help but isn't known, leave it out.
- Plain text, no markdown. Short paragraphs. In descriptions, make the first two sentences count: they show before "read more".
- No emojis unless the current text uses them, no ALL CAPS, no superlatives the host can't back up, and nothing channels forbid (contact details, links, or asking guests to book or pay elsewhere).
- Stay within the character limit you're given.
- Return only the new text for the field, nothing else.`;

export async function writeListing(db, { propertyId, section, field, roomId = null, listing, instruction = '' }) {
  const defs = { propertyText: FIELDS.propertyText, roomText: FIELDS.roomText };
  const f = defs[section]?.find(x => x.key === field);
  if (!f) throw err('That field can\'t be written by the assistant.');
  const limit = f.key === 'headline' ? 50 : f.key === 'contentHeadline' ? 100 : f.max;
  const room = section === 'roomText' ? (listing?.rooms || []).find(r => Number(r.id) === Number(roomId)) : null;
  if (section === 'roomText' && !room) throw err('Choose a room.');
  const current = String((room ? room.text?.[field] : listing?.propertyText?.[field]) ?? '');
  const p = property(db, Number(propertyId));
  const context = { propertyText: listing?.propertyText || {}, rooms: (listing?.rooms || []).slice(0, 10) };
  const content = [
    `Property: ${listing?.property?.name || p?.name || ''}${listing?.property?.city || p?.city ? `, ${listing?.property?.city || p?.city}` : ''}${listing?.property?.state ? `, ${listing.property.state}` : ''}`,
    `<listing>\n${listingText(context).slice(0, 30000)}\n</listing>`,
    getSetting(db, `ai_notes_${propertyId}`) && `<house_notes>\n${getSetting(db, `ai_notes_${propertyId}`)}\n</house_notes>`,
    `Field: ${f.label}${room ? ` (room "${room.name || room.id}")` : ''}`,
    `Character limit: ${limit}${f.key === 'headline' ? ' (Airbnb shows 50 characters)' : ''}`,
    `Current text: ${current ? `\n${current}` : '(empty)'}`,
    instruction.trim() ? `What the host wants: ${instruction.trim().slice(0, 1000)}` : current ? 'Improve this text.' : 'Write this field.',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content }];
  let res = await ask(db, 'listing', { system: LISTING_SYSTEM, messages });
  // One retry if it ran over the limit.
  if (res.text.length > limit) {
    messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: `That's ${res.text.length} characters; the limit is ${limit}. Shorten it and return only the text.` });
    const again = await ask(db, 'listing', { system: LISTING_SYSTEM, messages });
    res = { ...again, cost: Math.round((again.cost + res.cost) * 1000) / 1000 };
  }
  return { ...res, limit, length: res.text.length };
}

// ---------- Pricing review ----------
const PRICING_SYSTEM = `You're a revenue manager advising the owner of a short-term rental in Laramie, Wyoming (home of the University of Wyoming). The owner's pricing tool recommends each unbooked night's price as a base price adjusted for day of week, month, local events, booking pace versus last year, demand signals (guests who asked about those dates, and stays booked unusually far ahead nearby), last-minute discount or far-ahead premium, and gap nights, kept between a floor and a ceiling. The owner applies prices to Beds24 themselves; you only advise.

- Be concrete: name dates, the current price, the recommended price, what you'd charge instead, and why.
- Ground it in the data given. Say when history is too thin to judge rather than guessing.
- Flag settings that look off (floor or ceiling, weekend or event uplift, minimum stay blocking gaps, last-minute discount too deep or shallow).
- If you think a local event is missing from the list, say so and mark it as something to verify.
- Keep it short: a two-sentence verdict, then a few bullet points. Use markdown bullets and **bold** sparingly.`;

export async function reviewPricing(db, roomId, { date = null, question = '' } = {}) {
  const today = localToday(doorSettings(db).tz);
  const room = db.prepare('SELECT r.*, p.name property_name, p.city FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id = ?').get(roomId);
  if (!room) throw err('Choose a room.');
  const start = date && date > today ? date : today;
  const rec = recommend(db, roomId, { start: addDays(start, -Math.min(diffDays(today, start), 14)), days: date ? 45 : 90, today });
  if (rec.needsBase) throw err('Set a base price on the Pricing page first.');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const nights = rec.nights.map(n => {
    const d = `${n.date} ${DOW[new Date(n.date + 'T00:00:00Z').getUTCDay()]}`;
    if (n.booked) return `${d} booked (${n.booking?.channel || ''})`;
    if (n.blocked) return `${d} blocked`;
    const f = (n.factors || []).filter(x => x.pct).map(x => `${x.label} ${x.pct > 0 ? '+' : ''}${Math.round(x.pct)}%`).join(', ');
    return `${d} open: Beds24 now ${n.current != null ? '$' + n.current : 'n/a'}, recommended $${n.price}, min stay ${n.minStay}${f ? ` | ${f}` : ''}${(n.notes || []).length ? ` | ${n.notes.join('; ')}` : ''}`;
  }).join('\n');
  const end = rec.nights.at(-1)?.date || addDays(start, 90);
  const events = listEvents(db).filter(e => e.end_date >= today && e.start_date <= addDays(end, 30))
    .map(e => `${e.start_date} to ${e.end_date}: ${e.name} (${e.pct > 0 ? '+' : ''}${e.pct}%${e.min_stay ? `, min stay ${e.min_stay}` : ''})${e.source ? ` [${e.source}]` : ''}`).join('\n');
  const months = stats.monthly(db, today, room.property_id).filter(m => m.month >= today.slice(0, 7)).slice(0, 4)
    .map(m => `${m.month}: on the books ${Math.round(m.occupancy * 100)}% at ADR $${Math.round(m.adr)}${m.lastYear ? `; same month last year (final) ${Math.round(m.lastYear.occupancy * 100)}% at $${Math.round(m.lastYear.adr)}` : '; no data last year'}`).join('\n');
  const pace = stats.pace(db, today, room.property_id, 4).map(p => `${p.month}: ${p.now.nights} nights now${p.lastYearAtThisPoint ? ` vs ${p.lastYearAtThisPoint.nights} at this point last year (finished at ${p.lastYearFinal.nights})` : ''}`).join('\n');
  const ly = periodStats(db, addDays(today, -365), today, room.property_id);
  const { auto, autoHorizon, autoThreshold, autoMaxChangePct, ...settings } = rec.settings;
  const content = [
    `Today: ${today}. Room: ${room.name} at ${room.property_name}${room.city ? `, ${room.city}` : ''}.`,
    `<settings>\n${JSON.stringify(settings)}\n(dow = Sun..Sat %, season = Jan..Dec %, rounding = round to nearest $)\n</settings>`,
    `<last_12_months>\n${Math.round(ly.occupancy * 100)}% occupancy, ADR $${Math.round(ly.adr)}, ${ly.bookings} stays\n</last_12_months>`,
    `<months_ahead>\n${months}\n</months_ahead>`,
    pace && `<pace>\n${pace}\n</pace>`,
    events && `<events>\n${events}\n</events>`,
    `<nights>\n${nights}\n</nights>`,
    question.trim() ? `Owner's question: ${question.trim().slice(0, 1000)}`
      : date ? `Explain the price for ${date} and whether it's right.`
      : 'Review the next 90 days of pricing. What looks off, and what would you change?',
  ].filter(Boolean).join('\n\n');
  return ask(db, 'pricing', { system: PRICING_SYSTEM, messages: [{ role: 'user', content }] });
}

// ---------- Questions about the numbers (tool use over the local database) ----------
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
function range({ from, to }, maxDays = 3660) {
  if (!isDate(from) || !isDate(to)) throw new Error('from and to must be dates like 2026-01-31.');
  if (from >= to) throw new Error('from must be before to (to is the day after the last night).');
  if (diffDays(from, to) > maxDays) throw new Error(`The range can be at most ${maxDays} days.`);
  return [from, to];
}
const CHANNELS = ['Airbnb', 'VRBO', 'Booking.com', 'Direct', 'Other'];
const schema = (properties = {}) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const dateProps = {
  from: { type: 'string', format: 'date', description: 'First night, YYYY-MM-DD' },
  to: { type: 'string', format: 'date', description: 'Day after the last night, YYYY-MM-DD (exclusive)' },
};

export function dataTools(db, propertyId, today) {
  const tool = (name, description, properties, run) => ({ ...betaTool({ name, description, inputSchema: schema(properties), run: async input => JSON.stringify(run(input)) }), strict: true });
  return [
    tool('period_stats', 'Occupancy, revenue, ADR, RevPAR, booked/available nights and number of stays for nights in [from, to), with a per-channel breakdown. Revenue is prorated by night, so stays crossing the range edges count partly.',
      dateProps, i => { const [f, t] = range(i); return periodStats(db, f, t, propertyId); }),
    tool('monthly_trend', 'Month by month for the last 24 months and the next 6 (on the books): nights, occupancy, revenue, ADR, RevPAR, each with the same month last year.',
      {}, () => stats.monthly(db, today, propertyId)),
    tool('list_bookings', 'Individual stays arriving in [from, to), oldest first: dates, nights, guests, channel, status, total price, when booked and cancelled. Use for questions about specific stays or guests.',
      { ...dateProps,
        status: { type: 'string', enum: ['active', 'cancelled', 'all'], description: 'active = confirmed stays' },
        channel: { type: 'string', enum: ['any', ...CHANNELS] },
        limit: { type: 'integer', description: 'Max rows, 1 to 200' } },
      i => {
        const [f, t] = range(i);
        const st = { active: "status IN ('confirmed','new')", cancelled: "status = 'cancelled'", all: "status IN ('confirmed','new','cancelled')" }[i.status] || "status IN ('confirmed','new')";
        const args = [f, t, ...(propertyId ? [propertyId] : []), ...(CHANNELS.includes(i.channel) ? [i.channel] : [])];
        return db.prepare(`SELECT id, guest_name, channel, status, arrival, departure, nights, adults, children, price, booked_at, cancelled_at, source
          FROM bookings WHERE ${st} AND arrival >= ? AND arrival < ? ${propertyId ? 'AND property_id = ?' : ''} ${CHANNELS.includes(i.channel) ? 'AND channel = ?' : ''}
          ORDER BY arrival LIMIT ${Math.max(1, Math.min(200, Number(i.limit) || 50))}`).all(...args);
      }),
    tool('booking_patterns', 'For stays arriving in [from, to): channel mix (share, ADR, lead time, length of stay), lead-time and length-of-stay distributions, party size, occupancy and ADR by night of week, and cancellations (rate, lost revenue, by channel).',
      dateProps, i => {
        const [f, t] = range(i);
        return { channels: stats.channels(db, f, t, propertyId), window: stats.bookingWindow(db, f, t, propertyId),
          weekdays: stats.byWeekday(db, f, t, propertyId), cancellations: stats.cancellations(db, f, t, propertyId) };
      }),
    tool('booking_pace', 'For each of the next 6 months: nights and revenue on the books now, what was on the books for the same month at this point last year, and how last year finished.',
      {}, () => stats.pace(db, today, propertyId)),
    tool('nightly_prices', 'Future nights in [from, to) (up to 180 days): the price and minimum stay set in Beds24, whether blocked, and whether booked.',
      dateProps, i => {
        const [f, t] = range(i, 180);
        const rooms = db.prepare(`SELECT id, name FROM rooms WHERE id > 0 ${propertyId ? 'AND property_id = ?' : ''}`).all(...(propertyId ? [propertyId] : []));
        return rooms.map(r => ({ room: r.name, nights: db.prepare(`SELECT c.date, c.price, c.min_stay, c.override = 'blackout' AS blocked,
            EXISTS(SELECT 1 FROM bookings b WHERE b.room_id = c.room_id AND b.status IN ('confirmed','new') AND b.arrival <= c.date AND b.departure > c.date) AS booked
            FROM calendar_days c WHERE c.room_id = ? AND c.date >= ? AND c.date < ? ORDER BY c.date`).all(r.id, f, t) }));
      }),
    tool('pricing_events', 'Local events and holidays the pricing tool adjusts for (dates inclusive, % uplift, minimum stay, source).',
      {}, () => listEvents(db)),
  ];
}

const QA_SYSTEM = `You answer the owner's questions about their short-term rental business using the tools, which read their booking data.

- Always look numbers up with the tools; never estimate them. For comparisons ("vs last year"), fetch both periods.
- Lead with the direct answer, then the supporting figures. A few sentences or a small markdown table; no long reports unless asked.
- Round money to whole dollars and percentages to whole numbers.
- Definitions: revenue is each booking's total as Beds24 records it, spread evenly over its nights (a stay crossing months counts partly in each); occupancy = booked nights / available nights; ADR = revenue / booked nights; RevPAR = revenue / available nights. Date ranges are [from, to): "to" is the day after the last night. Owner blocks aren't counted.
- If the data can't answer the question (expenses, reviews, competitors), say so in a sentence and suggest what would.`;

export async function askData(db, question, { history = [], propertyId = null } = {}) {
  const q = String(question || '').trim();
  if (!q) throw err('Ask a question first.');
  if (q.length > 2000) throw err('Keep the question under 2,000 characters.');
  const ds = doorSettings(db);
  const today = localToday(ds.tz);
  const props = db.prepare('SELECT p.id, p.name, p.city, COUNT(r.id) rooms FROM properties p LEFT JOIN rooms r ON r.property_id = p.id GROUP BY p.id ORDER BY p.name').all();
  const sources = db.prepare(`SELECT source, MIN(arrival) first, MAX(departure) last, COUNT(*) n FROM bookings WHERE status != 'block' GROUP BY source`).all();
  const context = [
    `Today is ${longDate(today)} (${ds.tz}).`,
    `Properties: ${props.map(p => `${p.name}${p.city ? ` (${p.city})` : ''}, ${p.rooms} room(s)`).join('; ') || 'none yet'}.`,
    propertyId ? `The owner is looking at ${props.find(p => p.id === propertyId)?.name || 'one property'} only; the tools are limited to it.` : 'The tools cover all properties together.',
    `Booking data: ${sources.map(s => `${s.source === 'guesty' ? 'imported from Guesty' : 'from Beds24'}: ${s.n} bookings, stays ${s.first} to ${s.last}`).join('; ') || 'none yet'}.`,
  ].join('\n');
  const prior = (Array.isArray(history) ? history : []).slice(-8)
    .filter(h => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string' && h.content.trim())
    .map(h => ({ role: h.role, content: h.content.slice(0, 6000) }));
  while (prior.length && prior[0].role !== 'user') prior.shift();
  if (prior.length && prior.at(-1).role === 'user') prior.pop();
  return ask(db, 'question', {
    system: `${QA_SYSTEM}\n\n${context}`,
    messages: [...prior, { role: 'user', content: q }],
    tools: dataTools(db, propertyId, today),
  });
}
