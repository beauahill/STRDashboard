// Direct booking site: a public page per property with photos, the listing text, a live availability calendar
// with nightly prices and an estimate, and a "Book now" hand-off to the Beds24 booking page (which takes the
// payment through the owner's Stripe account and sends the guest Beds24's confirmation email).
// Only availability and prices are public: never guest names or booking details.
import { getSetting, setSetting } from './db.js';
import { addDays } from './sync.js';
import { doorSettings, localToday } from './doors.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'stay';

export const AGREEMENT_TEMPLATE = `By booking you agree to these terms. Please read them; if anything is unclear, ask before booking.

Guests and use: The home may be occupied by the registered guests only, up to the maximum number of guests in your booking. No parties or events.

Check-in and checkout: Check-in is from {check_in_time} and checkout is by {check_out_time}, unless agreed in writing.

House rules: Please follow the house rules shown on this page. No smoking or vaping inside. Pets only if agreed in writing before arrival.

Damage: You are responsible for damage caused during your stay beyond normal wear and tear. A refundable security deposit may be held on your card and released after checkout if there is no damage.

Cancellations: Cancellations are handled under the cancellation policy shown at booking.

Entry: We may enter the home in an emergency or with notice to carry out urgent repairs.

Liability: Use of the home and its amenities is at your own risk to the extent permitted by law.`;

// ---------- Settings ----------
function all(db) { try { return JSON.parse(getSetting(db, 'site') || '{}'); } catch { return {}; } }
const cachedListing = (db, pid) => { try { return JSON.parse(getSetting(db, `listing_cache_${pid}`) || 'null'); } catch { return null; } };

/** The site settings for a property, with blanks filled from the listing text read from Beds24. */
export function siteSettings(db, pid) {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(pid);
  if (!p) throw err('Unknown property.');
  const L = cachedListing(db, pid), t = L?.propertyText || {}, room = (L?.rooms || [])[0] || {};
  const saved = all(db)[pid] || {};
  const defaults = {
    enabled: false, slug: slugify(p.name), domain: '',
    bookingUrl: `https://beds24.com/booking2.php?propid=${pid}`,
    title: t.headline || p.name, intro: t.propertyDescription || '', highlights: '', houseRules: t.houseRules || '',
    neighbourhood: t.locationDescription || '', cancellation: t.cancellationPolicy || '', perk: 'Book direct for the best price.',
    contactEmail: '', contactPhone: '', maxGuests: Number(room.maxPeople) || 6, cleaningFee: Number(room.cleaningFee) || 0,
    agreement: AGREEMENT_TEMPLATE,
  };
  return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== '' && v != null)), enabled: !!saved.enabled, domain: saved.domain || '',
    propertyId: pid, propertyName: p.name, city: p.city || '', listingCached: !!L };
}

export function saveSite(db, pid, input = {}) {
  const cur = siteSettings(db, pid), out = { ...(all(db)[pid] || {}) };
  const text = (k, max) => { if (k in input) { const v = String(input[k] ?? '').replace(/\r\n/g, '\n'); if (v.length > max) throw err(`${k} is too long (${max} characters at most).`); out[k] = v.trim(); } };
  for (const [k, max] of [['title', 120], ['intro', 10000], ['highlights', 3000], ['houseRules', 5000], ['neighbourhood', 5000], ['cancellation', 5000],
    ['perk', 200], ['contactEmail', 200], ['contactPhone', 40], ['agreement', 20000]]) text(k, max);
  if ('slug' in input) {
    const v = slugify(input.slug);
    if (Object.entries(all(db)).some(([id, s]) => Number(id) !== pid && (s.slug || '') === v)) throw err('Another property already uses that web address.');
    out.slug = v;
  }
  if ('domain' in input) {
    const v = String(input.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (v && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) throw err('Enter a domain like book.example.com (no https://).');
    out.domain = v;
  }
  if ('bookingUrl' in input) {
    const v = String(input.bookingUrl || '').trim();
    if (v && !/^https:\/\/[^\s]+$/.test(v)) throw err('The booking page link must start with https://.');
    out.bookingUrl = v;
  }
  for (const [k, lo, hi] of [['maxGuests', 1, 50], ['cleaningFee', 0, 5000]]) {
    if (k in input) { const n = Number(input[k]); if (!Number.isFinite(n) || n < lo || n > hi) throw err(`${k === 'maxGuests' ? 'Max guests' : 'Cleaning fee'} must be between ${lo} and ${hi}.`); out[k] = n; }
  }
  if ('enabled' in input) out.enabled = !!input.enabled;
  if (out.enabled && !db.prepare('SELECT 1 FROM rooms WHERE property_id = ? AND id > 0').get(pid)) throw err('This property has no Beds24 room to book.');
  setSetting(db, 'site', JSON.stringify({ ...all(db), [pid]: out }));
  return { ...cur, ...siteSettings(db, pid) };
}

/** Which property a public request is for: by path slug, or by the custom domain the request came in on. */
export function siteFor(db, { slug, host }) {
  for (const { id } of db.prepare('SELECT id FROM properties WHERE id > 0').all()) {
    const settings = siteSettings(db, id);
    if ((slug && settings.slug === slug) || (host && settings.domain && settings.domain === host.toLowerCase().replace(/:\d+$/, ''))) return settings;
  }
  return null;
}

// ---------- Photos ----------
export const listPhotos = (db, pid) => db.prepare('SELECT id, caption, url, mime, sort FROM site_photos WHERE property_id = ? ORDER BY sort, id').all(pid);

export function addPhoto(db, pid, { dataUrl, url, caption = '' }) {
  siteSettings(db, pid);
  const count = db.prepare('SELECT COUNT(*) n FROM site_photos WHERE property_id = ?').get(pid).n;
  if (count >= 40) throw err('40 photos at most.');
  let mime = null, data = null;
  if (dataUrl) {
    const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw err('Upload a JPEG, PNG or WebP image.');
    data = Buffer.from(m[2], 'base64');
    if (data.length > 4e6) throw err('That image is too large (4 MB at most).');
    mime = m[1];
  } else if (!/^https:\/\/\S+$/.test(url || '')) throw err('No image.');
  const r = db.prepare('INSERT INTO site_photos(property_id, sort, caption, mime, data, url, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(pid, count, String(caption).slice(0, 200), mime, data, data ? null : url, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function updatePhotos(db, pid, { order, remove, captions } = {}) {
  if (Array.isArray(remove)) for (const id of remove) db.prepare('DELETE FROM site_photos WHERE id = ? AND property_id = ?').run(Number(id), pid);
  if (Array.isArray(order)) order.forEach((id, i) => db.prepare('UPDATE site_photos SET sort = ? WHERE id = ? AND property_id = ?').run(i, Number(id), pid));
  for (const [id, c] of Object.entries(captions || {})) db.prepare('UPDATE site_photos SET caption = ? WHERE id = ? AND property_id = ?').run(String(c).slice(0, 200), Number(id), pid);
  return listPhotos(db, pid);
}

/** Picture links Beds24 has for the property (the field isn't documented yet, so any image URLs under picture fields are taken). */
export async function importBeds24Photos(db, client, pid) {
  const res = await client.get('/properties', { id: [pid], includePictures: true, includeAllRooms: true });
  const urls = new Set();
  const walk = (v, inPictures) => {
    if (typeof v === 'string') { if (inPictures && /^https?:\/\/\S+$/i.test(v)) urls.add(v.replace(/^http:/, 'https:')); return; }
    if (Array.isArray(v)) return v.forEach(x => walk(x, inPictures));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, inPictures || /picture|image|photo/i.test(k));
  };
  walk(res?.data || [], false);
  const have = new Set(listPhotos(db, pid).map(p => p.url));
  let added = 0;
  for (const u of urls) if (!have.has(u)) { addPhoto(db, pid, { url: u }); added++; }
  return { found: urls.size, added };
}

export function photo(db, pid, id) {
  return db.prepare('SELECT * FROM site_photos WHERE id = ? AND property_id = ?').get(id, pid) || null;
}

// ---------- Availability ----------
/**
 * Each night from today for `days` days: open (no stay or block, not closed in Beds24, a price set), its price and
 * the minimum stay for arriving that night. Nothing about who has booked.
 */
export function availability(db, pid, { days = 365, now = Date.now() } = {}) {
  const today = localToday(doorSettings(db).tz, now), end = addDays(today, days);
  const rooms = db.prepare('SELECT id FROM rooms WHERE property_id = ? AND id > 0 ORDER BY id').all(pid).map(r => r.id);
  if (!rooms.length) return [];
  const room = rooms[0];
  const cal = Object.fromEntries(db.prepare('SELECT date, price, min_stay, num_avail, override FROM calendar_days WHERE room_id = ? AND date >= ? AND date < ?').all(room, today, end).map(c => [c.date, c]));
  const taken = new Set();
  for (const b of db.prepare(`SELECT arrival, departure FROM bookings WHERE room_id = ? AND status IN ('confirmed','new','request','block') AND departure > ? AND arrival < ?`).all(room, today, end)) {
    for (let d = b.arrival > today ? b.arrival : today; d < b.departure && d < end; d = addDays(d, 1)) taken.add(d);
  }
  const out = [];
  for (let d = today; d < end; d = addDays(d, 1)) {
    const c = cal[d];
    const open = !taken.has(d) && !!c && c.override !== 'blackout' && c.num_avail !== 0 && c.price > 0;
    out.push({ date: d, open, price: open ? Math.round(c.price) : null, minStay: c?.min_stay || 1 });
  }
  return out;
}

/** An estimate for a stay (the Beds24 booking page has the final price, taxes included). */
export function quote(nights, s, checkin, checkout, guests) {
  const byDate = Object.fromEntries(nights.map(n => [n.date, n]));
  const list = [];
  for (let d = checkin; d < checkout; d = addDays(d, 1)) list.push(byDate[d]);
  if (!list.length || list.length > 60) return { ok: false, reason: 'Choose your dates.' };
  if (list.some(n => !n?.open)) return { ok: false, reason: 'Some of those nights are booked.' };
  if (list.length < (byDate[checkin]?.minStay || 1)) return { ok: false, reason: `The minimum stay for those dates is ${byDate[checkin].minStay} nights.` };
  if (guests > s.maxGuests) return { ok: false, reason: `Up to ${s.maxGuests} guests.` };
  const rooms = list.reduce((a, n) => a + n.price, 0);
  return { ok: true, nights: list.length, rooms, cleaning: s.cleaningFee, total: rooms + s.cleaningFee };
}

export function checkoutUrl(s, { checkin, nights, adults = 2, children = 0 }) {
  const u = new URL(s.bookingUrl);
  u.searchParams.set('checkin', checkin); u.searchParams.set('numnight', String(nights));
  u.searchParams.set('numadult', String(adults)); if (children) u.searchParams.set('numchild', String(children));
  u.searchParams.set('referer', 'Direct site');
  return u.toString();
}

// ---------- The public page ----------
const paras = t => String(t || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export function renderSite(db, s, { base, preview = false, origin = '' }) {
  const photos = listPhotos(db, s.propertyId);
  const img = (p, cls = '') => `<img class="${cls}" src="${base}/photo/${p.id}" alt="${esc(p.caption || s.title)}" loading="lazy">`;
  const ds = doorSettings(db);
  const t = v => { const [h, m] = v.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const highlights = s.highlights.split('\n').map(x => x.trim()).filter(Boolean);
  const data = { base, maxGuests: s.maxGuests, cleaningFee: s.cleaningFee, bookingUrl: s.bookingUrl };
  const canonical = s.domain ? `https://${s.domain}/` : origin ? `${origin}${base}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}${s.city ? ` · ${esc(s.city)}` : ''}</title>
<meta name="description" content="${esc(s.intro.slice(0, 160))}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(s.title)}"><meta property="og:description" content="${esc(s.intro.slice(0, 200))}">
${photos[0] && origin ? `<meta property="og:image" content="${esc(origin + base)}/photo/${photos[0].id}">` : ''}
${preview ? '<meta name="robots" content="noindex">' : ''}
<style>
:root{--ink:#1b1f24;--mut:#667085;--line:#e4e7ec;--acc:#2563eb;--bg:#fff;--soft:#f6f7f9}
@media (prefers-color-scheme: dark){:root{--ink:#e8eaee;--mut:#9aa3b2;--line:#2a303a;--bg:#0f1216;--soft:#181c22}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:1120px;margin:0 auto;padding:20px 16px 60px}h1{font-size:30px;line-height:1.2;margin:8px 0 4px}h2{font-size:20px;margin:28px 0 8px}
.sub{color:var(--mut);font-size:14px}.preview{background:#fef3c7;color:#78350f;padding:8px 16px;text-align:center;font-size:14px}
.gallery{display:grid;gap:8px;grid-template-columns:2fr 1fr 1fr;grid-template-rows:200px 200px;border-radius:14px;overflow:hidden;margin:16px 0}
.gallery img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}.gallery img:first-child{grid-row:span 2}
.gallery.n1{grid-template-columns:1fr;grid-template-rows:420px}.gallery.n2,.gallery.n3,.gallery.n4{grid-template-columns:2fr 1fr}
@media (max-width:720px){.gallery{grid-template-columns:1fr;grid-template-rows:260px;overflow-x:auto;display:flex;scroll-snap-type:x mandatory;border-radius:12px}
.gallery img{flex:0 0 100%;height:260px;scroll-snap-align:start}}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:36px;align-items:start}@media (max-width:900px){.cols{grid-template-columns:minmax(0,1fr)}}
.box{border:1px solid var(--line);border-radius:14px;padding:18px;position:sticky;top:16px;background:var(--bg);box-shadow:0 6px 24px #0000000f}
.box .price{font-size:22px;font-weight:700}.perk{background:#2563eb14;color:var(--acc);border-radius:8px;padding:8px 10px;font-size:14px;margin:10px 0}
.row{display:flex;gap:8px}.row label{flex:1;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
input,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;margin-top:4px}
.btn{display:block;width:100%;text-align:center;background:var(--acc);color:#fff;border:0;border-radius:10px;padding:13px;font:inherit;font-weight:650;margin-top:12px;cursor:pointer;text-decoration:none}
.btn[aria-disabled=true]{opacity:.45;pointer-events:none}.lines{font-size:14px;margin-top:10px}.lines div{display:flex;justify-content:space-between;padding:3px 0}
.lines .tot{border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-weight:700}.err{color:#b91c1c;font-size:14px;margin-top:8px}
.hl{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 18px;padding:0;list-style:none}.hl li::before{content:"✓ ";color:var(--acc);font-weight:700}
.cal{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:20px}.mon h3{margin:0 0 8px;font-size:15px}
.days{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center;font-size:13px}.days .wd{color:var(--mut);font-size:11px}
.d{border-radius:8px;padding:5px 0 3px;cursor:pointer;border:1px solid transparent;min-height:46px}.d small{display:block;font-size:10px;color:var(--mut)}
.d.off{color:var(--mut);text-decoration:line-through;cursor:default;opacity:.55}.d.past{color:var(--mut);opacity:.35;cursor:default}.d.pad{visibility:hidden}.d.in{background:#2563eb1f}.d.end{background:var(--acc);color:#fff}.d.end small{color:#fff}
.d:not(.off):not(.pad):not(.past):hover{border-color:var(--acc)}.calnav{display:flex;gap:8px;justify-content:flex-end;margin:-36px 0 8px}.calnav button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:4px 10px;cursor:pointer}
footer{margin-top:40px;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:14px}a{color:var(--acc)}
dialog{border:0;padding:0;background:#000d;max-width:100vw;max-height:100vh;width:100vw;height:100vh}dialog img{width:100%;height:100%;object-fit:contain}
</style></head><body>
${preview ? `<div class="preview">Preview: ${s.enabled ? 'this site is live.' : 'this site is switched off, so only you can see it.'}</div>` : ''}
<div class="wrap">
<h1>${esc(s.title)}</h1><div class="sub">${esc([s.city, `Up to ${s.maxGuests} guests`].filter(Boolean).join(' · '))}</div>
${photos.length ? `<div class="gallery n${Math.min(photos.length, 5)}">${photos.slice(0, 5).map(p => img(p)).join('')}</div>` : ''}
<div class="cols"><div>
${paras(s.intro)}
${highlights.length ? `<h2>Highlights</h2><ul class="hl">${highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
<h2>Availability</h2><div class="calnav"><button id="prev" aria-label="Earlier">‹</button><button id="next" aria-label="Later">›</button></div><div class="cal" id="cal"><div class="sub">Loading…</div></div>
<div class="sub" style="margin-top:6px">Pick your check-in and checkout dates. Prices are per night.</div>
${s.neighbourhood ? `<h2>The neighbourhood</h2>${paras(s.neighbourhood)}` : ''}
${s.houseRules ? `<h2>House rules</h2>${paras(s.houseRules)}` : ''}
<h2>Check-in and checkout</h2><p>Check-in from ${t(ds.checkin)} · Checkout by ${t(ds.checkout)}</p>
${s.cancellation ? `<h2>Cancellation policy</h2>${paras(s.cancellation)}` : ''}
${photos.length > 5 ? `<h2>More photos</h2><div class="gallery" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));grid-template-rows:none;display:grid">${photos.slice(5).map(p => img(p)).join('')}</div>` : ''}
</div>
<aside class="box" id="book"><div class="price" id="headline">Book your stay</div>
${s.perk ? `<div class="perk">${esc(s.perk)}</div>` : ''}
<div class="row"><label>Check-in<input type="date" id="ci"></label><label>Checkout<input type="date" id="co"></label></div>
<div class="row" style="margin-top:8px"><label>Adults<select id="ad">${Array.from({ length: s.maxGuests }, (_, i) => `<option ${i === 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
<label>Children<select id="ch">${Array.from({ length: s.maxGuests }, (_, i) => `<option>${i}</option>`).join('')}</select></label></div>
<div class="lines" id="lines"></div><div class="err" id="why"></div>
<a class="btn" id="go" aria-disabled="true" href="#">Book now</a>
<div class="sub" style="margin-top:8px">You'll finish on our secure booking page, where taxes and the final total are shown before you pay.</div>
${s.contactEmail || s.contactPhone ? `<div class="sub" style="margin-top:10px">Questions? ${[s.contactEmail && `<a href="mailto:${esc(s.contactEmail)}">${esc(s.contactEmail)}</a>`, s.contactPhone && `<a href="tel:${esc(s.contactPhone.replace(/[^\d+]/g, ''))}">${esc(s.contactPhone)}</a>`].filter(Boolean).join(' · ')}</div>` : ''}
</aside></div>
<footer>${s.agreement ? `<a href="${base}/terms">Rental agreement</a> · ` : ''}${esc(s.title)}${s.city ? `, ${esc(s.city)}` : ''}</footer></div>
<dialog id="zoom"><img alt=""></dialog>
<script type="application/json" id="site-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('site-data').textContent);
  const $ = id => document.getElementById(id);
  const add = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  let nights = [], byDate = {}, month = null, sel = { ci: null, co: null };
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function draw() {
    const cal = $('cal'); if (!nights.length) { cal.innerHTML = '<div class="sub">No dates are open for booking right now.</div>'; return; }
    const first = month || nights[0].date.slice(0, 7) + '-01';
    let html = '';
    for (let k = 0; k < 2; k++) {
      const d0 = new Date(first + 'T00:00:00Z'); d0.setUTCMonth(d0.getUTCMonth() + k);
      const m = d0.toISOString().slice(0, 10), len = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).getUTCDate();
      let cells = ['S','M','T','W','T','F','S'].map(w => '<div class="wd">' + w + '</div>').join('') + '<div class="d pad"></div>'.repeat(d0.getUTCDay());
      for (let i = 1; i <= len; i++) {
        const date = m.slice(0, 8) + String(i).padStart(2, '0'), n = byDate[date];
        const inSel = sel.ci && sel.co && date > sel.ci && date < sel.co, end = date === sel.ci || date === sel.co;
        // A booked night can still be someone's checkout day, so it stays clickable right after a chosen check-in.
        const past = date < nights[0].date, canLeave = sel.ci && !sel.co && date > sel.ci && byDate[add(date, -1)]?.open;
        const off = !past && (!n || !n.open) && !canLeave && !end;
        cells += '<div class="d' + (past ? ' past' : '') + (off ? ' off' : '') + (inSel ? ' in' : '') + (end ? ' end' : '') + '" data-d="' + date + '">' + i + (n && n.open ? '<small>$' + n.price + '</small>' : '<small>&nbsp;</small>') + '</div>';
      }
      html += '<div class="mon"><h3>' + MONTHS[d0.getUTCMonth()] + ' ' + d0.getUTCFullYear() + '</h3><div class="days">' + cells + '</div></div>';
    }
    cal.innerHTML = html;
    cal.querySelectorAll('.d[data-d]:not(.off):not(.past)').forEach(el => el.onclick = () => pick(el.dataset.d));
  }
  function pick(d) {
    if (!sel.ci || sel.co || d <= sel.ci) sel = { ci: d, co: null }; else sel.co = d;
    $('ci').value = sel.ci || ''; $('co').value = sel.co || ''; draw(); update();
  }
  function update() {
    const ci = $('ci').value, co = $('co').value, ad = +$('ad').value, ch = +$('ch').value;
    const go = $('go'), why = $('why'), lines = $('lines');
    go.setAttribute('aria-disabled', 'true'); why.textContent = ''; lines.innerHTML = '';
    if (!ci || !co) return;
    if (co <= ci) { why.textContent = 'Checkout must be after check-in.'; return; }
    const list = []; for (let d = ci; d < co; d = add(d, 1)) list.push(byDate[d]);
    if (list.length > 60) { why.textContent = 'For stays over 60 nights, please contact us.'; return; }
    if (list.some(n => !n || !n.open)) { why.textContent = 'Some of those nights are booked. Try other dates.'; return; }
    const min = byDate[ci].minStay || 1;
    if (list.length < min) { why.textContent = 'The minimum stay for those dates is ' + min + ' nights.'; return; }
    if (ad + ch > D.maxGuests) { why.textContent = 'Up to ' + D.maxGuests + ' guests.'; return; }
    const rooms = list.reduce((a, n) => a + n.price, 0);
    lines.innerHTML = '<div><span>' + money(rooms / list.length) + ' × ' + list.length + ' night' + (list.length > 1 ? 's' : '') + '</span><span>' + money(rooms) + '</span></div>'
      + (D.cleaningFee ? '<div><span>Cleaning fee</span><span>' + money(D.cleaningFee) + '</span></div>' : '')
      + '<div class="tot"><span>Estimated total</span><span>' + money(rooms + D.cleaningFee) + '</span></div><div class="sub">Plus taxes, shown at checkout.</div>';
    $('headline').textContent = money(rooms / list.length) + ' / night';
    const u = new URL(D.bookingUrl);
    u.searchParams.set('checkin', ci); u.searchParams.set('numnight', list.length); u.searchParams.set('numadult', ad);
    if (ch) u.searchParams.set('numchild', ch); u.searchParams.set('referer', 'Direct site');
    go.href = u.toString(); go.setAttribute('aria-disabled', 'false');
  }
  ['ci', 'co', 'ad', 'ch'].forEach(id => $(id).addEventListener('change', () => { sel = { ci: $('ci').value || null, co: $('co').value || null }; draw(); update(); }));
  $('prev').onclick = () => { const d = new Date((month || nights[0].date.slice(0, 7) + '-01') + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); const m = d.toISOString().slice(0, 10); if (m >= nights[0].date.slice(0, 7) + '-01') { month = m; draw(); } };
  $('next').onclick = () => { const d = new Date((month || nights[0].date.slice(0, 7) + '-01') + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); month = d.toISOString().slice(0, 10); draw(); };
  document.querySelectorAll('.gallery img').forEach(im => im.onclick = () => { const z = $('zoom'); z.querySelector('img').src = im.src; z.showModal(); });
  $('zoom').onclick = () => $('zoom').close();
  fetch(D.base + '/availability.json').then(r => r.json()).then(j => {
    nights = j.nights; byDate = Object.fromEntries(nights.map(n => [n.date, n]));
    $('ci').min = $('co').min = nights[0]?.date || ''; draw(); update();
  }).catch(() => { $('cal').innerHTML = '<div class="sub">Couldn\\'t load availability. Please refresh.</div>'; });
})();
</script></body></html>`;
}

export function renderTerms(db, s, { base }) {
  const ds = doorSettings(db);
  const t = v => { const [h, m] = v.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const text = s.agreement.replaceAll('{check_in_time}', t(ds.checkin)).replaceAll('{check_out_time}', t(ds.checkout)).replaceAll('{property_name}', s.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rental agreement · ${esc(s.title)}</title>
<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#1b1f24}main{max-width:760px;margin:0 auto;padding:24px 16px 60px}a{color:#2563eb}
@media (prefers-color-scheme: dark){body{background:#0f1216;color:#e8eaee}}</style></head>
<body><main><p><a href="${base}">← ${esc(s.title)}</a></p><h1>Rental agreement</h1>${paras(text)}</main></body></html>`;
}
