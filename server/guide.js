// Guest guidebook: a private page per booking (a link that only works for that booking) with check-in steps,
// the door code and address (only from N days before arrival until checkout), Wi-Fi, house rules, how things
// work, local tips and a checkout checklist. Direct guests can be asked to sign the rental agreement and upload
// an ID before the door code and address appear.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { addDays } from './sync.js';
import { doorCodesFor, doorSettings, localToday, zonedTimeToUtc } from './doors.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const longDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const paras = t => String(t || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
const jsonSetting = (db, k, d) => { try { return JSON.parse(getSetting(db, k) || 'null') ?? d; } catch { return d; } };

export const GUIDE_DEFAULTS = {
  welcome: 'Welcome! Everything you need for your stay is on this page. Message us any time if something isn\'t right.',
  arrival: '', parking: '', wifiName: '', wifiPassword: '', sections: [], places: [],
  checkout: 'Load and start the dishwasher\nPut used towels in the bathtub\nTake trash to the outside bins\nTurn off lights and lock the doors',
  phone: '', emergency: 'In an emergency call 911.', codeDaysBefore: 1, requireDirect: false, idRetentionDays: 30,
};

// ---------- Settings ----------
export function guideSettings(db, pid) {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(pid);
  if (!p) throw err('Unknown property.');
  const vars = jsonSetting(db, `vars_${pid}`, {});
  const saved = jsonSetting(db, `guide_${pid}`, {});
  return { ...GUIDE_DEFAULTS, wifiName: vars.wifi_name || vars.wifi || '', wifiPassword: vars.wifi_password || '', parking: vars.parking || '', ...saved, propertyId: pid, propertyName: p.name };
}

export function saveGuide(db, pid, input = {}) {
  guideSettings(db, pid);
  const out = { ...jsonSetting(db, `guide_${pid}`, {}) };
  for (const [k, max] of [['welcome', 3000], ['arrival', 5000], ['parking', 2000], ['wifiName', 100], ['wifiPassword', 100], ['checkout', 3000], ['phone', 40], ['emergency', 2000]]) {
    if (k in input) { const v = String(input[k] ?? '').replace(/\r\n/g, '\n'); if (v.length > max) throw err(`${k} is too long.`); out[k] = v.trim(); }
  }
  if ('sections' in input) {
    if (!Array.isArray(input.sections) || input.sections.length > 30) throw err('Up to 30 sections.');
    out.sections = input.sections.map(x => ({ title: String(x?.title || '').trim().slice(0, 100), body: String(x?.body || '').trim().slice(0, 5000) })).filter(x => x.title || x.body);
  }
  if ('places' in input) {
    if (!Array.isArray(input.places) || input.places.length > 60) throw err('Up to 60 places.');
    out.places = input.places.map(x => {
      const url = String(x?.url || '').trim();
      if (url && !/^https?:\/\/\S+$/.test(url)) throw err(`The link for "${x?.name || 'a place'}" must start with https://.`);
      return { name: String(x?.name || '').trim().slice(0, 100), category: String(x?.category || '').trim().slice(0, 40), note: String(x?.note || '').trim().slice(0, 500), url };
    }).filter(x => x.name);
  }
  for (const [k, lo, hi] of [['codeDaysBefore', 0, 14], ['idRetentionDays', 1, 365]]) {
    if (k in input) { const n = Number(input[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw err(`${k === 'codeDaysBefore' ? 'Days before check-in' : 'Days to keep IDs'} must be between ${lo} and ${hi}.`); out[k] = n; }
  }
  if ('requireDirect' in input) out.requireDirect = !!input.requireDirect;
  setSetting(db, `guide_${pid}`, JSON.stringify(out));
  return guideSettings(db, pid);
}

// ---------- Links (a signature of the booking id, so nothing needs storing; regenerating the secret revokes them all) ----------
function secret(db) {
  let s = getSetting(db, 'guide_secret');
  if (!s) { s = randomBytes(32).toString('hex'); setSetting(db, 'guide_secret', s); }
  return s;
}
const sign = (db, id) => createHmac('sha256', secret(db)).update(`guide:${id}`).digest('base64url').slice(0, 22);
export const guideToken = (db, bookingId) => `${bookingId}-${sign(db, bookingId)}`;
export function bookingForToken(db, token) {
  const m = String(token || '').match(/^(-?\d+)-([\w-]{22})$/);
  if (!m) return null;
  const a = Buffer.from(m[2]), b = Buffer.from(sign(db, Number(m[1])));
  return a.length === b.length && timingSafeEqual(a, b) ? Number(m[1]) : null;
}
export function regenerateLinks(db) { setSetting(db, 'guide_secret', randomBytes(32).toString('hex')); }

/** Where guests reach the app: the booking site's own domain if there is one, else the app's address. */
export function publicOrigin(db) {
  const site = jsonSetting(db, 'site', {});
  const domain = Object.values(site).find(s => s?.enabled && s?.domain)?.domain;
  if (domain) return `https://${domain}`;
  return process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : getSetting(db, 'app_origin') || '';
}
export const guideUrl = (db, bookingId) => { const o = publicOrigin(db); return o && bookingId > 0 ? `${o}/guide/${guideToken(db, bookingId)}` : ''; };

// ---------- Direct-guest check-in (agreement + ID) ----------
export const checkinFor = (db, bookingId) => db.prepare('SELECT booking_id, name, signed_at, id_mime IS NOT NULL AS has_id, id_deleted_at FROM guide_checkins WHERE booking_id = ?').get(bookingId) || null;

export function saveCheckin(db, bookingId, { name, agree, idDataUrl }, meta = {}, now = Date.now()) {
  const b = db.prepare('SELECT id, channel, status, departure FROM bookings WHERE id = ?').get(bookingId);
  if (!b || !['confirmed', 'new'].includes(b.status)) throw err('This booking can\'t be checked in.');
  // A signed check-in is a record: the link can't replace it (or bring back a deleted ID photo after the stay).
  if (checkinFor(db, bookingId)?.signed_at) throw err('You\'ve already checked in. Contact your host if anything needs changing.');
  const ds = doorSettings(db);
  if (now >= Date.parse(zonedTimeToUtc(b.departure, ds.checkout, ds.tz))) throw err('This stay is over.');
  const full = String(name || '').trim();
  if (full.length < 3 || full.length > 120) throw err('Type your full name as your signature.');
  if (!agree) throw err('Please agree to the rental agreement.');
  const m = String(idDataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw err('Add a photo of your ID (driver\'s license or passport).');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 5e6) throw err('That photo is too large (5 MB at most).');
  db.prepare(`INSERT INTO guide_checkins(booking_id, name, signed_at, ip, user_agent, id_mime, id_data, id_deleted_at) VALUES(?,?,?,?,?,?,?,NULL)
    ON CONFLICT(booking_id) DO UPDATE SET name = excluded.name, signed_at = excluded.signed_at, ip = excluded.ip, user_agent = excluded.user_agent,
    id_mime = excluded.id_mime, id_data = excluded.id_data, id_deleted_at = NULL`)
    .run(bookingId, full, new Date().toISOString(), String(meta.ip || '').slice(0, 64), String(meta.userAgent || '').slice(0, 300), m[1], data);
  return checkinFor(db, bookingId);
}

export const checkinId = (db, bookingId) => db.prepare('SELECT id_mime, id_data FROM guide_checkins WHERE booking_id = ? AND id_data IS NOT NULL').get(bookingId) || null;

/** ID photos are deleted a set number of days after checkout (the signature record stays). */
export function pruneCheckins(db, today) {
  let n = 0;
  for (const r of db.prepare(`SELECT c.booking_id, b.departure, b.property_id FROM guide_checkins c JOIN bookings b ON b.id = c.booking_id WHERE c.id_data IS NOT NULL`).all()) {
    const keep = guideSettings(db, r.property_id).idRetentionDays;
    if (addDays(r.departure, keep) < today) { db.prepare('UPDATE guide_checkins SET id_data = NULL, id_mime = NULL, id_deleted_at = ? WHERE booking_id = ?').run(new Date().toISOString(), r.booking_id); n++; }
  }
  return n;
}

// ---------- What a guest sees ----------
/** The guidebook for a booking right now: what's shown depends on the stay's dates and (for direct guests) check-in. */
export function guideFor(db, bookingId, now = Date.now()) {
  const b = db.prepare(`SELECT b.*, p.name property_name, p.city FROM bookings b LEFT JOIN properties p ON p.id = b.property_id WHERE b.id = ?`).get(bookingId);
  if (!b) return null;
  const g = guideSettings(db, b.property_id), ds = doorSettings(db);
  const today = localToday(ds.tz, now);
  const checkOutAt = Date.parse(zonedTimeToUtc(b.departure, ds.checkout, ds.tz));
  // Inquiries, pending requests and blocks never reach "access": no address or door code until the stay is booked.
  const confirmed = ['confirmed', 'new'].includes(b.status);
  const phase = b.status === 'cancelled' ? 'cancelled' : now >= checkOutAt ? 'after' : confirmed && today >= addDays(b.arrival, -g.codeDaysBefore) ? 'access' : 'before';
  const listing = jsonSetting(db, `listing_cache_${b.property_id}`, null), vars = jsonSetting(db, `vars_${b.property_id}`, {});
  const lp = listing?.property || {};
  const address = vars.address || [lp.address, lp.city, lp.state, lp.postcode].filter(Boolean).join(', ');
  const needsCheckin = confirmed && g.requireDirect && b.channel === 'Direct' && b.source === 'beds24' && !checkinFor(db, bookingId)?.signed_at;
  const access = phase === 'access' && !needsCheckin;
  const site = jsonSetting(db, 'site', {})[b.property_id];
  return {
    booking: { id: b.id, firstName: (b.guest_name || '').split(' ')[0] || 'there', arrival: b.arrival, departure: b.departure, nights: b.nights,
      guests: (b.adults || 0) + (b.children || 0), channel: b.channel },
    property: b.property_name, city: b.city, phase, needsCheckin: phase !== 'cancelled' && phase !== 'after' && needsCheckin,
    checkin: fmtTime(ds.checkin), checkout: fmtTime(ds.checkout), codeFrom: addDays(b.arrival, -g.codeDaysBefore),
    doorCode: access ? doorCodesFor(db, [bookingId], now)[bookingId]?.code || null : null,
    address: access ? address : null, guide: g, houseRules: listing?.propertyText?.houseRules || '',
    termsUrl: site?.slug ? `/stay/${site.slug}/terms` : null,
  };
}

export function renderGuide(G, { token }) {
  if (!G) return null;
  const g = G.guide, b = G.booking;
  const sec = (id, title, body) => body ? `<section id="${id}"><h2>${esc(title)}</h2>${body}</section>` : '';
  const checklist = g.checkout.split('\n').map(x => x.trim()).filter(Boolean);
  const byCat = {};
  for (const p of g.places) (byCat[p.category || 'Recommended'] ||= []).push(p);
  const nav = [['stay', 'Your stay'], ['arrive', 'Arriving'], ['wifi', 'Wi-Fi'], ['rules', 'House rules'], ['guide', 'House guide'], ['local', 'Local tips'], ['checkout', 'Checkout'], ['help', 'Help']]
    .filter(([id]) => ({ wifi: g.wifiName || g.wifiPassword, rules: G.houseRules, guide: g.sections.length, local: g.places.length, checkout: checklist.length })[id] ?? true);
  const access = G.phase === 'access' && !G.needsCheckin;
  const codeBox = G.phase === 'cancelled' ? '<div class="note">This booking was cancelled.</div>'
    : G.phase === 'after' ? '<div class="note">Thanks for staying with us! We hope to see you again.</div>'
    : G.needsCheckin ? `<div class="note warn">Before your door code appears, please complete check-in below.</div>`
    : access ? `<div class="code"><span>Door code</span>${G.doorCode ? `<b>${esc(G.doorCode)}</b>` : '<strong>Coming soon</strong>'}<small>${G.doorCode ? `Works from ${esc(G.checkin)} on ${esc(longDate(b.arrival))} until ${esc(G.checkout)} on ${esc(longDate(b.departure))}.` : 'We\'ll send it before you arrive.'}</small></div>`
    : `<div class="note">Your door code and the address appear here on ${esc(longDate(G.codeFrom))}.</div>`;
  const checkinForm = G.needsCheckin ? `<section id="checkin"><h2>Check in online</h2>
    <p>For direct bookings we ask every guest to accept the rental agreement and share a photo ID. It's kept privately and deleted after your stay.</p>
    <form id="ck"><label>Full name (your signature)<input name="fullname" autocomplete="name" required></label>
    <label class="chk"><input type="checkbox" name="agree" required> I agree to the ${G.termsUrl ? `<a href="${esc(G.termsUrl)}" target="_blank" rel="noopener">rental agreement</a>` : 'rental agreement'}</label>
    <label>Photo of your ID<input type="file" name="idphoto" accept="image/*" required></label>
    <button>Check in</button><div class="err" id="ckerr"></div></form></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Guidebook · ${esc(G.property)}</title>
<style>
:root{--ink:#1b1f24;--mut:#667085;--line:#e4e7ec;--acc:#2563eb;--bg:#f6f7f9;--card:#fff}
@media (prefers-color-scheme: dark){:root{--ink:#e8eaee;--mut:#9aa3b2;--line:#2a303a;--bg:#0f1216;--card:#181c22}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--acc);color:#fff;padding:22px 16px 18px}header h1{margin:0;font-size:24px}header p{margin:4px 0 0;opacity:.9}
nav{display:flex;gap:6px;overflow-x:auto;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0}
nav a{white-space:nowrap;padding:5px 10px;border-radius:99px;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:14px}
main{max-width:720px;margin:0 auto;padding:16px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
h2{margin:0 0 8px;font-size:18px}h3{margin:12px 0 4px;font-size:15px}p{margin:6px 0}.mut{color:var(--mut);font-size:14px}
.code{display:flex;flex-direction:column;align-items:center;gap:2px;background:#2563eb14;border-radius:12px;padding:14px}
.code span{font-size:13px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}.code b{font-size:40px;letter-spacing:.12em}.code strong{font-size:20px}.code small{color:var(--mut);text-align:center}
.note{background:#2563eb14;border-radius:12px;padding:12px 14px}.note.warn{background:#fef3c7;color:#78350f}
.wifi{display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;align-items:center}.wifi b{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
form button{background:var(--acc);color:#fff;border-color:var(--acc);padding:10px 16px;margin-top:6px}
ul.check{list-style:none;padding:0;margin:0}ul.check li{padding:6px 0;border-top:1px solid var(--line)}ul.check li:first-child{border-top:0}ul.check label{display:flex;gap:10px;align-items:flex-start}
.place{padding:6px 0;border-top:1px solid var(--line)}.place:first-child{border-top:0}
label{display:block;margin:8px 0;font-size:14px;color:var(--mut)}label input:not([type=checkbox]){display:block;width:100%;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px;margin-top:4px}
label.chk{display:flex;gap:8px;align-items:center;color:var(--ink)}.err{color:#b91c1c;font-size:14px}
</style></head><body>
<header><h1>${esc(G.property)}</h1><p>Hi ${esc(b.firstName)} · ${esc(longDate(b.arrival))} – ${esc(longDate(b.departure))}</p></header>
<nav>${nav.map(([id, l]) => `<a href="#${id}">${l}</a>`).join('')}</nav>
<main>
<section id="stay"><h2>Your stay</h2>${codeBox}${paras(g.welcome)}
<p class="mut">Check-in from ${esc(G.checkin)} · Checkout by ${esc(G.checkout)} · ${b.guests || ''} guest${b.guests === 1 ? '' : 's'}</p></section>
${checkinForm}
${sec('arrive', 'Arriving', `${access && G.address ? `<p><b>${esc(G.address)}</b> <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(G.address)}" target="_blank" rel="noopener">Directions</a></p>` : ''}${paras(g.arrival)}${g.parking ? `<h3>Parking</h3>${paras(g.parking)}` : ''}` || '<p class="mut">Arrival details coming soon.</p>')}
${g.wifiName || g.wifiPassword ? sec('wifi', 'Wi-Fi', `<div class="wifi">${g.wifiName ? `<span class="mut">Network</span><b>${esc(g.wifiName)}</b><span></span>` : ''}${g.wifiPassword ? `<span class="mut">Password</span><b id="wpw">${esc(g.wifiPassword)}</b><button type="button" data-copy="wpw">Copy</button>` : ''}</div>`) : ''}
${sec('rules', 'House rules', paras(G.houseRules))}
${sec('guide', 'House guide', g.sections.map(s => `${s.title ? `<h3>${esc(s.title)}</h3>` : ''}${paras(s.body)}`).join(''))}
${sec('local', 'Local tips', Object.entries(byCat).map(([cat, list]) => `<h3>${esc(cat)}</h3>${list.map(p => `<div class="place"><b>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</b>${p.note ? `<div class="mut">${esc(p.note)}</div>` : ''}</div>`).join('')}`).join(''))}
${checklist.length ? sec('checkout', 'Checkout', `<p class="mut">Checkout is by ${esc(G.checkout)} on ${esc(longDate(b.departure))}. Before you go:</p><ul class="check">${checklist.map((c, i) => `<li><label><input type="checkbox" data-i="${i}"> ${esc(c)}</label></li>`).join('')}</ul>`) : ''}
${sec('help', 'Help', `${g.phone ? `<p>Call or text: <a href="tel:${esc(g.phone.replace(/[^\d+]/g, ''))}">${esc(g.phone)}</a></p>` : ''}<p class="mut">Or message us in your ${esc(b.channel === 'Direct' ? 'booking' : b.channel)} conversation.</p>${paras(g.emergency)}`)}
</main>
<script>
(() => {
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); b.textContent = 'Copied'; } catch {} });
  const key = 'guide-check-${esc(token).slice(0, 12)}';
  let done = {}; try { done = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  document.querySelectorAll('ul.check input').forEach(c => { c.checked = !!done[c.dataset.i]; c.onchange = () => { done[c.dataset.i] = c.checked; try { localStorage.setItem(key, JSON.stringify(done)); } catch {} }; });
  const f = document.getElementById('ck');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById('ckerr'), btn = f.querySelector('button'); err.textContent = '';
    const file = f.elements.idphoto.files[0]; if (!file) return;
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const img = await createImageBitmap(file), scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const res = await fetch(location.pathname.replace(/\\/$/, '') + '/checkin', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: f.elements.fullname.value, agree: f.elements.agree.checked, idDataUrl: c.toDataURL('image/jpeg', 0.85) }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
      location.reload();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Check in'; }
  };
})();
</script></body></html>`;
}

/** Upcoming and current stays with their links and check-in status, for the owner. */
export function guideOverview(db, pid, now = Date.now()) {
  const today = localToday(doorSettings(db).tz, now);
  return db.prepare(`SELECT id, guest_name, channel, arrival, departure, source FROM bookings WHERE property_id = ? AND status IN ('confirmed','new')
      AND departure >= ? ORDER BY arrival LIMIT 30`).all(pid, today)
    .map(b => ({ ...b, url: b.id > 0 ? guideUrl(db, b.id) : '', checkin: checkinFor(db, b.id) }));
}
