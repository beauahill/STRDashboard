// Listing editor: read a property's content from Beds24, change it, and push only what changed back.
// Every save is previewed as a list of field changes, re-read from Beds24 afterwards, and logged.
const userError = msg => Object.assign(new Error(msg), { status: 400 });

const TIMES = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
const PROPERTY_TYPES = ['apartment', 'bedAndBreakfast', 'cabin', 'chalet', 'condo', 'cottage', 'farmhouse', 'guesthouse', 'house', 'lodge', 'loft', 'studio', 'townhome', 'villa'];

// What the editor shows and may change. `max` is a hard limit; `hint` is shown next to the counter.
export const FIELDS = {
  property: [
    { key: 'name', label: 'Property name', type: 'text', max: 100 },
    { key: 'propertyType', label: 'Property type', type: 'select', options: PROPERTY_TYPES },
    { key: 'address', label: 'Street address', type: 'text', max: 200 },
    { key: 'city', label: 'City', type: 'text', max: 100 },
    { key: 'state', label: 'State', type: 'text', max: 100 },
    { key: 'postcode', label: 'ZIP code', type: 'text', max: 20 },
    { key: 'checkInStart', label: 'Check-in from', type: 'select', options: TIMES },
    { key: 'checkInEnd', label: 'Check-in until', type: 'select', options: TIMES },
    { key: 'checkOutEnd', label: 'Checkout by', type: 'select', options: TIMES },
    { key: 'phone', label: 'Phone', type: 'text', max: 40 },
    { key: 'email', label: 'Email', type: 'text', max: 200 },
  ],
  propertyText: [
    { key: 'headline', label: 'Headline', type: 'text', max: 200, hint: 'Airbnb titles show up to 50 characters' },
    { key: 'propertyDescription', label: 'Description', type: 'textarea', max: 10000, hint: 'The first ~500 characters show before "read more" on most channels' },
    { key: 'locationDescription', label: 'The neighbourhood', type: 'textarea', max: 5000 },
    { key: 'directions', label: 'Getting there', type: 'textarea', max: 5000 },
    { key: 'houseRules', label: 'House rules', type: 'textarea', max: 5000 },
    { key: 'cancellationPolicy', label: 'Cancellation policy (text)', type: 'textarea', max: 5000 },
    { key: 'generalPolicy', label: 'Other policies', type: 'textarea', max: 5000 },
  ],
  room: [
    { key: 'name', label: 'Room name', type: 'text', max: 100 },
    { key: 'maxPeople', label: 'Max guests', type: 'int', min: 1, max: 50 },
    { key: 'maxAdult', label: 'Max adults', type: 'int', min: 1, max: 50, nullable: true },
    { key: 'maxChildren', label: 'Max children', type: 'int', min: 0, max: 50, nullable: true },
    { key: 'roomSize', label: 'Size (sq ft or m², as set in Beds24)', type: 'int', min: 0, max: 100000, nullable: true },
    { key: 'cleaningFee', label: 'Cleaning fee ($)', type: 'money', min: 0, max: 10000 },
    { key: 'securityDeposit', label: 'Security deposit ($)', type: 'money', min: 0, max: 100000 },
  ],
  roomText: [
    { key: 'displayName', label: 'Display name', type: 'text', max: 200 },
    { key: 'contentHeadline', label: 'Room headline', type: 'text', max: 200 },
    { key: 'roomDescription', label: 'Room description', type: 'textarea', max: 10000 },
    { key: 'contentDescription', label: 'Room content description', type: 'textarea', max: 10000 },
  ],
};

const textFor = (texts, lang) => (texts || []).find(t => (t.language || 'en') === lang) || {};
const numeric = f => f.type === 'int' || f.type === 'money';
const pick = (obj, fields) => Object.fromEntries(fields.map(f => [f.key, obj?.[f.key] ?? (numeric(f) ? null : '')]));

/** Current listing content from Beds24, in the editor's shape. */
export async function fetchListing(client, propertyId, lang = 'en') {
  const res = await client.get('/properties', { id: [propertyId], includeTexts: ['all'], includeAllRooms: true, includeLanguages: [lang] });
  const p = (res.data || [])[0];
  if (!p) throw Object.assign(new Error('Property not found in Beds24.'), { status: 404 });
  return {
    id: p.id, lang,
    property: pick(p, FIELDS.property),
    propertyText: pick(textFor(p.texts, lang), FIELDS.propertyText),
    rooms: (p.roomTypes || p.rooms || []).map(r => ({ id: r.id, ...pick(r, FIELDS.room), text: pick(textFor(r.texts, lang), FIELDS.roomText) })),
  };
}

function clean(f, v) {
  if (f.type === 'int' || f.type === 'money') {
    if (v === '' || v == null) { if (f.nullable) return null; throw userError(`${f.label} is required.`); }
    const n = Number(v);
    if (!Number.isFinite(n) || n < f.min || n > f.max || (f.type === 'int' && !Number.isInteger(n))) throw userError(`${f.label} must be between ${f.min} and ${f.max}.`);
    return f.type === 'money' ? Math.round(n * 100) / 100 : n;
  }
  const s = String(v ?? '').replace(/\r\n/g, '\n');
  if (f.type === 'select' && s && !f.options.includes(s)) throw userError(`Choose a valid ${f.label.toLowerCase()}.`);
  if (f.max && s.length > f.max) throw userError(`${f.label} is too long (${s.length}/${f.max} characters).`);
  if (f.key === 'name' && !s.trim()) throw userError(`${f.label} can't be empty.`);
  return f.type === 'textarea' ? s : s.trim();
}
// Beds24 may return a number as a string ("95.00"): numeric fields compare by value, text (a ZIP code) by spelling.
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const same = (a, b, byValue = false) => (byValue && Number.isFinite(num(a)) && Number.isFinite(num(b)) ? num(a) === num(b)
  : (a ?? '') === (b ?? '') || (a == null && b === '') || (b == null && a === ''));
// Beds24 doesn't return every field; a field that's blank both there and in the form isn't a change.
const blank = v => v == null || v === '';

/** Field-by-field differences, plus the Beds24 update that applies exactly those. Throws 400s for bad input. */
export function diffListing(current, edited) {
  const changes = [], body = { id: current.id };
  const add = (where, f, before, after) => changes.push({ where, field: f.key, label: f.label, before, after });
  for (const f of FIELDS.property) {
    if (!(f.key in (edited.property || {})) || (blank(edited.property[f.key]) && blank(current.property[f.key]))) continue;
    const v = clean(f, edited.property[f.key]);
    if (!same(v, current.property[f.key], numeric(f))) { body[f.key] = v; add('Property', f, current.property[f.key], v); }
  }
  const ptext = {};
  for (const f of FIELDS.propertyText) {
    if (!(f.key in (edited.propertyText || {})) || (blank(edited.propertyText[f.key]) && blank(current.propertyText[f.key]))) continue;
    const v = clean(f, edited.propertyText[f.key]);
    if (!same(v, current.propertyText[f.key], numeric(f))) { ptext[f.key] = v; add('Property', f, current.propertyText[f.key], v); }
  }
  if (Object.keys(ptext).length) body.texts = [{ language: current.lang, ...ptext }];
  const rooms = [];
  for (const er of edited.rooms || []) {
    const cr = current.rooms.find(r => r.id === Number(er.id));
    if (!cr) throw userError('A room in the edit no longer exists in Beds24. Reload and try again.');
    const rb = { id: cr.id }, rtext = {};
    for (const f of FIELDS.room) {
      if (!(f.key in er) || (blank(er[f.key]) && blank(cr[f.key]))) continue;
      const v = clean(f, er[f.key]);
      if (!same(v, cr[f.key], numeric(f))) { rb[f.key] = v; add(cr.name || `Room ${cr.id}`, f, cr[f.key], v); }
    }
    for (const f of FIELDS.roomText) {
      if (!(f.key in (er.text || {})) || (blank(er.text[f.key]) && blank(cr.text[f.key]))) continue;
      const v = clean(f, er.text[f.key]);
      if (!same(v, cr.text[f.key], numeric(f))) { rtext[f.key] = v; add(cr.name || `Room ${cr.id}`, f, cr.text[f.key], v); }
    }
    if (Object.keys(rtext).length) rb.texts = [{ language: current.lang, ...rtext }];
    if (Object.keys(rb).length > 1) rooms.push(rb);
  }
  if (rooms.length) body.roomTypes = rooms;
  return { changes, body };
}

/** Push the changes to Beds24, then re-read to confirm they took, and log the result. */
export async function saveListing(db, client, propertyId, edited) {
  const current = await fetchListing(client, propertyId, edited.lang || 'en');
  const { changes, body } = diffListing(current, edited);
  if (!changes.length) return { applied: 0, changes, warnings: ['Nothing changed.'] };
  const log = db.prepare('INSERT INTO listing_changes(at,property_id,summary,ok,error) VALUES(?,?,?,?,?)');
  const at = new Date().toISOString(), summary = changes.map(c => `${c.where}: ${c.label}`).join(', ');
  try {
    const res = await client.post('/properties', [body]);
    const errs = (Array.isArray(res) ? res : [res]).flatMap(r => (r?.errors || []).map(e => e.message || e.field));
    if (errs.length || (Array.isArray(res) && res.some(r => r?.success === false))) throw new Error('Beds24 rejected the change: ' + (errs.join('; ') || 'unknown error'));
  } catch (e) { log.run(at, propertyId, summary, 0, e.message); throw e; }
  const warnings = [];
  try {
    const after = await fetchListing(client, propertyId, current.lang);
    const off = diffListing(after, edited).changes;
    if (off.length) warnings.push(`Beds24 shows different values for: ${off.map(c => c.label).join(', ')}.`);
  } catch (e) { warnings.push(`Saved, but re-reading from Beds24 failed: ${e.message}`); }
  log.run(at, propertyId, summary, 1, warnings.join(' ') || null);
  // Keep the local names in step so the rest of the app shows the new ones straight away.
  if (body.name) db.prepare('UPDATE properties SET name = ? WHERE id = ?').run(body.name, propertyId);
  for (const r of body.roomTypes || []) if (r.name) db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(r.name, r.id);
  return { applied: changes.length, changes, warnings };
}

export const listingLog = (db, propertyId) => db.prepare('SELECT * FROM listing_changes WHERE property_id = ? ORDER BY id DESC LIMIT 20').all(propertyId);
