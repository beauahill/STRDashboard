const $ = s => document.querySelector(s);
const view = $('#view');
const money = n => '$' + Math.round(n).toLocaleString();
const pct = n => (n * 100).toFixed(0) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString(undefined, {
  month: 'short', day: 'numeric', timeZone: 'UTC', ...(s.slice(0, 4) !== String(new Date().getFullYear()) && { year: 'numeric' }) });
const tag = t => `<span class="tag ${esc(t)}">${esc(t)}</span>`;
// A booking removed in Beds24 keeps its row with its own muted label; it is never shown like a confirmed stay.
const statusTag = s => s === 'deleted' ? '<span class="tag deleted">Deleted in Beds24</span>' : tag(s);
let status = {};

// Each page render gets a number. A page load (GET) that finishes after the owner has moved to another page is
// dropped ("stale") instead of drawing the old page over the new one.
let renderSeq = 0;
// Same for reloads within a page (‹ ›, a year or room select): each gets a number per page, and a slower earlier
// load finds it is no longer the latest and draws nothing.
const pageSeq = {};
const stamp = k => { const n = pageSeq[k] = (pageSeq[k] || 0) + 1; return () => pageSeq[k] === n; };
// A failed request in a handler that has no page of its own to draw into: show it, unless the owner was signed
// out (the login form is already up) or has moved on.
const fail = err => { if (!['login', 'stale'].includes(err.message)) banner(err.message, true); };
async function api(path, opts = {}) {
  const seq = renderSeq, load = !opts.method || opts.method === 'GET';
  const res = await fetch('/api' + path, { ...opts, body: opts.body && JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'Login required') { showLogin(); throw new Error('login'); }
  if (load && seq !== renderSeq) throw new Error('stale');
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}${res.statusText ? ' ' + res.statusText : ''})`);
  return data;
}
const prop = () => $('#prop').value;
const q = (extra = {}) => new URLSearchParams({ ...(prop() && { property: prop() }), ...extra }).toString();

// kind: true/'err' = problem, 'ok' = success, otherwise a neutral notice.
function banner(msg, kind) { if (msg === 'stale') return; const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; b.className = kind === true || kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''; }
// What the banner goes back to after a page change: a failed sync stays up until the next one; everything else
// (a page that didn't load, "Saved.") belongs to the page it was shown on.
let stickyBanner = '';

// Re-rendering after a change rebuilds the page's forms from the server. Fields the owner has changed and not saved
// (an open automation editor, a half-filled lock or pricing form) are carried over, so toggling a switch next to
// them can't wipe ten minutes of typing. Taken when the change starts, put back once the page has redrawn.
let drafts = null;
const routeOf = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
const formKey = f => f.id || `${f.className}:${f.dataset.form ?? f.dataset.prop ?? f.dataset.pid ?? ''}`;
const fieldKey = el => el.type === 'checkbox' || el.type === 'radio' ? `${el.name}=${el.value}` : el.name;
const defaultOf = el => el.tagName === 'SELECT' ? ([...el.options].find(o => o.defaultSelected) || el.options[0])?.value : el.defaultValue;
function takeDrafts(except) {
  drafts = { route: routeOf()[0], forms: {} };
  for (const f of view.querySelectorAll('form')) {
    if (f === except) continue;
    for (const el of f.elements) {
      if (!el.name || ['file', 'submit', 'button', 'reset'].includes(el.type)) continue;
      const box = el.type === 'checkbox' || el.type === 'radio';
      if (box ? el.checked !== el.defaultChecked : el.value !== defaultOf(el)) (drafts.forms[formKey(f)] ||= {})[fieldKey(el)] = box ? el.checked : el.value;
    }
  }
}
function restoreDrafts(route) {
  if (!drafts || drafts.route !== route) return;
  for (const f of view.querySelectorAll('form')) for (const [k, v] of Object.entries(drafts.forms[formKey(f)] || {})) {
    const el = [...f.elements].find(x => fieldKey(x) === k);
    if (!el) continue;
    if (typeof v === 'boolean') el.checked = v; else el.value = v;
    el.dispatchEvent(new Event(el.tagName === 'INPUT' && !['checkbox', 'radio'].includes(el.type) || el.tagName === 'TEXTAREA' ? 'input' : 'change', { bubbles: true }));
  }
  drafts = null;
}
// A form being submitted is the one change act() must not carry a draft for: its saved values come back from the server.
let submitting = null;
view.addEventListener('submit', e => { submitting = e.target; queueMicrotask(() => { submitting = null; }); }, true);

function showLogin() {
  clearInterval(pageTimer); pageTimer = null;   // a poll would redraw the form under a half-typed password
  banner('');                                   // "Working…" from a change that hit the expired session
  document.body.classList.add('signed-out');
  view.innerHTML = `<form class="card stack login"><h3>Sign in</h3><input type="password" name="password" placeholder="Password" autofocus><button class="primary">Sign in</button><div class="sub" id="lerr"></div></form>`;
  view.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { password: e.target.password.value } }); boot(); }
    catch (err) { $('#lerr').textContent = err.message; }
  };
}

let doorInfo = {};
const doorBadge = b => {
  const d = doorInfo[b.id];
  if (!d) return '';
  const bad = d.perLock.filter(l => !['set', 'scheduled'].includes(l.state));
  return ` <span class="code ${d.ok ? '' : 'bad'}" title="${esc(d.perLock.map(l => `${l.lock}: ${l.label}`).join('\n'))}">🔑 ${esc(d.code)}${d.ok ? '' : ' ⚠'}</span>`;
};
const personRow = b => `<li><span>${esc(b.guest_name || 'Guest')} ${tag(b.channel)}${doorBadge(b)}<br><span class="sub">${esc(b.property_name)} · ${esc(b.room_name)}</span></span><span class="sub">${fmtDate(b.arrival)} → ${fmtDate(b.departure)}</span></li>`;
const listCard = (title, rows) => `<div class="card"><h3>${title} (${rows.length})</h3>${rows.length ? `<ul class="list">${rows.map(personRow).join('')}</ul>` : '<div class="empty">None</div>'}</div>`;
const kpi = (title, big, sub) => `<div class="card"><h3>${title}</h3><div class="big">${big}</div><div class="sub">${sub}</div></div>`;

async function dashboard() {
  const s = await api('/summary?' + q());
  doorInfo = s.doors || {};
  const max = Math.max(...s.months.map(m => m.revenue), 1);
  const ch = Object.entries(s.thisMonth.byChannel).sort((a, b) => b[1].revenue - a[1].revenue);
  view.innerHTML = `
    ${s.automationIssues?.length ? `<div class="notice bad-notice"><b>Automated messages need attention</b> <a href="#/automations">Open Automations</a><ul>${s.automationIssues.map(i =>
      `<li>${esc(i.automation)} to ${esc(i.guest_name || 'a guest')}: ${esc(i.error || i.status)}</li>`).join('')}</ul></div>` : ''}
    ${s.doorAlerts?.length ? `<div class="notice bad-notice"><b>Door codes need attention</b> <a href="#/locks">Open Locks</a><ul>${s.doorAlerts.map(a =>
      `<li>${esc(a.guest || 'Guest')} arriving ${fmtDate(a.arrival)}: ${esc(a.problem)}</li>`).join('')}</ul></div>` : ''}
    <div class="grid">
      ${kpi('Occupancy · this month', pct(s.thisMonth.occupancy), `${s.thisMonth.nights} of ${s.thisMonth.available} nights`)}
      ${kpi('Revenue · this month', money(s.thisMonth.revenue), `ADR ${money(s.thisMonth.adr)} · RevPAR ${money(s.thisMonth.revpar)}`)}
      ${kpi('Next 30 days', pct(s.next30.occupancy), `${money(s.next30.revenue)} on the books`)}
      ${kpi('Last 30 days', pct(s.last30.occupancy), money(s.last30.revenue))}
      ${s.pending ? kpi('Pending requests', s.pending, 'Need a response') : ''}
      ${status.unreadMessages ? `<a class="card kpi-link" href="#/inbox"><h3>Unread messages</h3><div class="big">${status.unreadMessages}</div><div class="sub">Open the inbox →</div></a>` : ''}
    </div>
    <div class="cols">
      ${listCard('Arriving today', s.arrivals)}${listCard('Departing today', s.departures)}
      ${listCard('In house', s.inHouse)}${listCard('Arrivals · next 14 days', s.upcoming)}
      <div class="card"><h3>Same-day turnovers (${s.turnovers.length})</h3>${s.turnovers.length ? `<ul class="list">${s.turnovers.map(personRow).join('')}</ul>` : '<div class="empty">None today</div>'}</div>
      <div class="card"><h3>Revenue by month (faded = forecast)</h3><div class="bars">${s.months.map(m =>
        `<div class="bar ${m.future ? 'future' : ''}" title="${m.month}: ${money(m.revenue)}, ${pct(m.occupancy)} occ"><i style="height:${(m.revenue / max) * 100}%"></i>${m.month.slice(5)}</div>`).join('')}</div></div>
      ${s.home ? `<a class="card kpi-link home-card" href="#/home"><h3>Smart home</h3>${s.home.alerts.length ? `<ul class="list bad">${s.home.alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<div class="ok sub">No alerts</div>'}
        ${s.home.error ? `<div class="sub bad">${esc(s.home.error)}</div>` : ''}
        <ul class="list">${s.home.thermostats.map(t => `<li><span>${esc(t.name)}</span><span>${t.current != null ? Math.round(t.current) + '°F' : '—'} <span class="sub">set ${t.target != null ? Math.round(t.target) + '°' : t.low != null ? `${Math.round(t.low)}–${Math.round(t.high)}°` : esc(t.state)}</span></span></li>`).join('')}
        ${s.home.temps.map(t => `<li><span>${esc(t.name)}</span><span>${t.value != null ? Math.round(t.value) + '°F' : '—'}</span></li>`).join('')}
        ${s.home.locks.map(l => `<li><span>${esc(l.name)}</span><span class="chip ${l.state === 'locked' ? 'set' : 'error'}">${esc(l.state || '—')}</span></li>`).join('')}</ul></a>` : ''}
      <div class="card"><h3>This month by channel</h3>${ch.length ? `<ul class="list">${ch.map(([c, v]) =>
        `<li><span>${tag(c)}</span><span>${money(v.revenue)} <span class="sub">· ${v.nights} nights</span></span></li>`).join('')}</ul>` : '<div class="empty">No bookings</div>'}</div>
    </div>`;
}

// ---------- Calendar: month grid, bookings as bars across the nights they occupy ----------
const calState = { month: null, room: '', selected: null };
const addDaysISO = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

async function calendarView() {
  const today = todayISO();
  calState.month ||= today.slice(0, 8) + '01';
  const first = calState.month, next = addMonths(first, 1);
  const gridStart = addDaysISO(first, -new Date(first + 'T00:00:00Z').getUTCDay());
  const weeks = Math.ceil(daysBetween(gridStart, next) / 7);
  const live = stamp('calendar');
  const c = await api('/calendar?' + q({ start: gridStart, days: weeks * 7 }));
  if (!live()) return;
  const rooms = c.rooms;
  if (calState.room && !rooms.some(r => String(r.id) === calState.room)) calState.room = '';
  const inView = calState.room ? rooms.filter(r => String(r.id) === calState.room) : rooms;
  const roomIds = new Set(inView.map(r => r.id));
  const bookings = c.bookings.filter(b => roomIds.has(b.room_id) && b.status !== 'deleted');   // gone from Beds24: those nights are open
  const doors = c.doors || {};
  // Prices only make sense when one room is in view.
  const priceRoom = inView.length === 1 ? inView[0].id : null;
  const night = Object.fromEntries(c.nights.filter(n => n.room_id === priceRoom).map(n => [n.date, n]));

  // Month summary for the rooms in view: booked nights and revenue inside this month (prorated).
  let booked = 0, revenue = 0;
  for (const b of bookings) {
    if (!['confirmed', 'new'].includes(b.status)) continue;
    const n = daysBetween(b.arrival > first ? b.arrival : first, b.departure < next ? b.departure : next);
    if (n > 0) { booked += n; revenue += b.nights ? b.price * n / b.nights : 0; }
  }
  const available = daysBetween(first, next) * inView.length;

  let html = '';
  for (let w = 0; w < weeks; w++) {
    const ws = addDaysISO(gridStart, w * 7), we = addDaysISO(ws, 7);
    // Bars run from the middle of the arrival day to the middle of the departure day, so a same-day
    // turnover sits in one lane without overlapping. Positions are in half-days within the week.
    const segs = bookings.filter(b => b.arrival < we && b.departure > ws).map(b => {
      const startsHere = b.arrival >= ws;
      const s0 = startsHere ? daysBetween(ws, b.arrival) * 2 + 1 : 0;
      const e0 = b.departure < we ? daysBetween(ws, b.departure) * 2 + 1 : 14;
      return { b, s0, e0, startsHere, endsHere: b.departure <= we };
    }).sort((x, y) => x.s0 - y.s0 || y.e0 - x.e0);
    const laneEnd = [];
    for (const sg of segs) {
      let lane = laneEnd.findIndex(e => e <= sg.s0);
      if (lane === -1) { lane = laneEnd.length; laneEnd.push(0); }
      laneEnd[lane] = sg.e0; sg.lane = lane;
    }
    const cells = Array.from({ length: 7 }, (_, i) => {
      const d = addDaysISO(ws, i), n = night[d];
      const cls = ['mday', d.slice(0, 7) !== first.slice(0, 7) && 'other', d === today && 'today', d < today && 'past', n?.blocked && 'blocked'].filter(Boolean).join(' ');
      return `<div class="${cls}"><span class="dn">${+d.slice(8)}</span>${n?.price != null ? `<span class="pr">${money(n.price)}</span>` : ''}</div>`;
    }).join('');
    const bars = segs.map(({ b, s0, e0, startsHere, endsHere, lane }) => {
      const cls = ['mbar', b.status === 'block' ? 'block' : b.channel, b.status === 'request' && 'request', !startsHere && 'cont-l', !endsHere && 'cont-r',
        calState.selected === b.id && 'sel'].filter(Boolean).join(' ');
      const roomTag = inView.length > 1 ? ` · ${rooms.find(r => r.id === b.room_id)?.name || ''}` : '';
      const label = (b.status === 'block' ? 'Blocked' : `${b.guest_name || 'Guest'}${doors[b.id] ? ' · 🔑' + doors[b.id].code : ''}`) + roomTag;
      return `<div class="${cls}" data-bid="${b.id}" role="button" tabindex="0" style="left:${s0 / 14 * 100}%;width:${(e0 - s0) / 14 * 100}%;top:${26 + lane * 24}px"
        title="${esc(`${b.status === 'block' ? 'Blocked' : b.guest_name || 'Guest'} · ${fmtDate(b.arrival)} → ${fmtDate(b.departure)}`)}">${esc(label)}</div>`;
    }).join('');
    html += `<div class="mweek" style="min-height:${Math.max(84, 34 + laneEnd.length * 24)}px"><div class="mdays">${cells}</div>${bars}</div>`;
  }

  const sel = bookings.find(b => b.id === calState.selected);
  view.innerHTML = `<div class="card">
    <div class="toolbar">
      <button id="cprev" aria-label="Previous month">‹</button><button id="ctoday">Today</button><button id="cnext" aria-label="Next month">›</button>
      <h3 style="margin:0 8px;font-size:16px;text-transform:none;letter-spacing:0;color:var(--ink)">${new Date(first + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
      <input type="month" id="cmonth" value="${first.slice(0, 7)}" aria-label="Jump to month">
      ${rooms.length > 1 ? `<select id="croom" aria-label="Room"><option value="">All rooms</option>${rooms.map(r => `<option value="${r.id}" ${String(r.id) === calState.room ? 'selected' : ''}>${esc(r.property_name)} · ${esc(r.name)}</option>`).join('')}</select>` : ''}
      <span class="sub" style="margin-left:auto">${booked} of ${available} nights booked (${available ? Math.round(booked / available * 100) : 0}%) · ${money(revenue)}</span>
    </div>
    <div class="mcal"><div class="mhead">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>${html}</div>
    <div class="legend sub">${['Airbnb', 'Booking.com', 'VRBO', 'Direct', 'Other'].map(ch => `<span><i class="sw ${ch}"></i>${ch}</span>`).join('')}
      <span><i class="sw block"></i>Blocked</span><span><i class="sw request"></i>Request</span>${Object.keys(night).length ? '<span>Nightly prices from the Rates page</span>' : ''}</div>
  </div>
  ${sel ? `<div class="card" style="margin-top:14px" id="cdetail">
    <div class="toolbar" style="margin:0"><h3 style="margin:0">${sel.status === 'block' ? 'Blocked dates' : esc(sel.guest_name || 'Guest')}</h3>${sel.status === 'block' ? '' : tag(sel.channel) + ' ' + statusTag(sel.status)}<button id="cclose" style="margin-left:auto">Close</button></div>
    <ul class="list"><li><span>Stay</span><span>${fmtDate(sel.arrival)} → ${fmtDate(sel.departure)} · ${sel.nights} night${sel.nights === 1 ? '' : 's'}</span></li>
      ${sel.status === 'block' ? '' : `<li><span>Guests</span><span>${sel.adults || 0} adult${sel.adults === 1 ? '' : 's'}${sel.children ? `, ${sel.children} child${sel.children === 1 ? '' : 'ren'}` : ''}</span></li>
      <li><span>Total</span><span>${money(sel.price)}${sel.nights ? ` <span class="sub">(${money(sel.price / sel.nights)}/night)</span>` : ''}</span></li>`}
      ${doors[sel.id] ? `<li><span>Door code</span><span><b class="code">${esc(doors[sel.id].code)}</b> ${doors[sel.id].perLock.map(l => `<span class="chip ${l.state}" title="${esc(l.label)}">${esc(l.lock)}</span>`).join(' ')}</span></li>` : ''}
      ${rooms.length > 1 ? `<li><span>Room</span><span>${esc(rooms.find(r => r.id === sel.room_id)?.name || '')}</span></li>` : ''}
      ${sel.source === 'guesty' ? '<li><span>Source</span><span class="sub">Imported from Guesty history</span></li>' : ''}</ul></div>` : ''}`;

  const go = m => { calState.month = m; calState.selected = null; calendarView(); };
  $('#cprev').onclick = () => go(addMonths(first, -1));
  $('#cnext').onclick = () => go(addMonths(first, 1));
  $('#ctoday').onclick = () => go(today.slice(0, 8) + '01');
  $('#cmonth').onchange = e => e.target.value && go(e.target.value + '-01');
  if ($('#croom')) $('#croom').onchange = e => { calState.room = e.target.value; calendarView(); };
  view.querySelectorAll('.mbar[data-bid]').forEach(el => {
    const pick = key => {
      const id = +el.dataset.bid;
      calState.selected = calState.selected === id ? null : id;
      calendarView().then(() => { if (key) view.querySelector(`.mbar[data-bid="${id}"]`)?.focus({ preventScroll: true }); $('#cdetail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    };
    el.onclick = () => pick(false); el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true); } };
  });
  if ($('#cclose')) $('#cclose').onclick = () => { calState.selected = null; calendarView(); };
}

async function bookingsView() {
  view.innerHTML = `<div class="toolbar"><input id="bq" placeholder="Search guest, email, ref…" aria-label="Search bookings" size="28">
    <select id="bs" aria-label="Status"><option value="">Any status</option><option>confirmed</option><option>new</option><option>request</option><option>inquiry</option><option>cancelled</option><option>block</option><option value="deleted">deleted in Beds24</option></select>
    <select id="bc" aria-label="Channel"><option value="">Any channel</option><option>Airbnb</option><option>Booking.com</option><option>VRBO</option><option>Direct</option></select></div>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>Guest</th><th>Property / room</th><th>Dates</th><th>Nights</th><th>Guests</th><th>Channel</th><th>Status</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  const load = async () => {
    const live = stamp('bookings');
    const rows = await api('/bookings?' + q({ q: $('#bq').value, status: $('#bs').value, channel: $('#bc').value }));
    if (!live() || !$('#rows')) return;
    $('#rows').innerHTML = rows.map(b => `<tr title="${esc(b.notes || '')}"><td>${esc(b.guest_name || '—')}<div class="sub">${esc(b.email || '')}</div></td>
      <td>${esc(b.property_name)}<div class="sub">${esc(b.room_name)}</div></td><td>${fmtDate(b.arrival)} → ${fmtDate(b.departure)}</td><td>${b.nights}</td>
      <td>${b.adults + b.children}</td><td>${tag(b.channel)}${b.source === 'guesty' ? ' <span class="sub" title="Imported from Guesty history">Guesty</span>' : ''}</td><td>${statusTag(b.status)}</td><td>${money(b.price)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No bookings</td></tr>';
  };
  let t; $('#bq').oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); };
  $('#bs').onchange = $('#bc').onchange = () => load().catch(fail);
  await load();
}

async function settingsView() {
  status = await api('/status');
  const [AI, N] = await Promise.all([api('/ai'), api('/notify')]);
  const NS = N.settings;
  view.innerHTML = `<div class="card stack"><h3>Beds24 connection</h3>
    <div>${status.connected ? '✅ Connected' : 'Not connected'}${status.demo ? ' · <b>demo data loaded</b>' : ''}</div>
    <div class="sub">Last sync: ${status.lastSync ? new Date(status.lastSync).toLocaleString() : 'never'}${status.lastSyncError ? ' · error: ' + esc(status.lastSyncError) : ''}</div>
    <form class="stack" id="cf"><div class="sub">In Beds24: Settings → Apps &amp; Integrations → API → Invite codes. Create a code with access to properties, bookings (including guest personal and financial details, or names and totals come back blank) and inventory, then paste it here. Give <b>write</b> access to inventory (to change prices on the Rates page) and to bookings (to save door codes on bookings). Pasting a new code replaces the old one.</div>
      ${status.scopes ? `<div class="sub">Current permissions: ${esc(status.scopes.join(', ') || 'none reported')}</div>` : ''}
      <input name="code" placeholder="Invite code" autocomplete="off"><button class="primary">Connect &amp; sync</button></form>
    ${status.connected ? '<button id="dc">Disconnect</button>' : ''}
    ${status.demo ? '<hr><button id="cleardemo">Clear demo data</button>'
      : status.connected ? '' : '<hr><button id="demo">Load demo data</button><div class="sub">Fills the app with sample properties and bookings so you can try it before connecting. Connecting to Beds24 removes it automatically.</div>'}
    ${status.auth ? '<hr><div class="toolbar" style="margin:0"><button id="lo">Sign out</button><button id="loall">Sign out everywhere</button></div><div class="sub">Everywhere: every phone and browser signed in to this dashboard has to sign in again.</div>' : ''}</div>
    <div class="card stack" style="margin-top:14px"><h3>Phone notifications</h3>
      <div>${NS.enabled ? '✅ On' : 'Off'}${N.error ? ` · <span class="bad">Last send failed: ${esc(N.error)}</span>` : ''}</div>
      <div class="sub">Alerts on your phones through the free <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> app, within about a minute of a guest message. Tap one to open that conversation.</div>
      <ol class="sub steps">
        <li>Install <b>ntfy</b> on each phone (<a href="https://docs.ntfy.sh/subscribe/phone/" target="_blank" rel="noopener">App Store and Google Play links</a>).</li>
        <li>In ntfy, tap <b>+</b> and subscribe to the topic <code class="code" id="ntopic">${esc(NS.topic)}</code> <button type="button" id="ncopy" class="linkbtn">Copy</button>${NS.server !== 'https://ntfy.sh' ? ` on the server <code class="code">${esc(NS.server)}</code>` : ' (leave the server as ntfy.sh)'}. Allow notifications when the phone asks.</li>
        <li>Press <b>Send test</b>. When it arrives, tick <b>Send notifications</b> and save.</li>
      </ol>
      <form id="nform" class="stack" style="max-width:none">
        <label><input type="checkbox" name="enabled" ${NS.enabled ? 'checked' : ''}> <b>Send notifications</b></label>
        <div class="sub">Notify about:</div>
        <label class="sub"><input type="checkbox" name="messages" ${NS.messages ? 'checked' : ''}> New guest messages and inquiries</label>
        <label class="sub"><input type="checkbox" name="bookings" ${NS.bookings ? 'checked' : ''}> New bookings and booking requests</label>
        <label class="sub"><input type="checkbox" name="cancellations" ${NS.cancellations ? 'checked' : ''}> Cancellations</label>
        <label class="sub"><input type="checkbox" name="problems" ${NS.problems ? 'checked' : ''}> Problems: a failed automated message, a door code not working before arrival, Beds24 not syncing</label>
        ${status.home ? `<label class="sub"><input type="checkbox" name="home" ${NS.home ? 'checked' : ''}> Home Assistant: leaks, alarms, freeze risk, air quality, doors left unlocked, low batteries, offline devices</label>` : ''}
        <label class="sub"><input type="checkbox" name="pricing" ${NS.pricing ? 'checked' : ''}> Event scout: new local events that may raise prices</label>
        <label class="sub"><input type="checkbox" name="preview" ${NS.preview ? 'checked' : ''}> Include the guest's message text (otherwise just "New message from …")</label>
        <details><summary class="sub">Advanced</summary><div class="stack" style="max-width:none;margin-top:8px">
          <label class="sub">ntfy server <input name="server" value="${esc(NS.server)}" style="width:100%"></label>
          <label class="sub">Access token (only for a private or self-hosted ntfy server)${NS.tokenSet ? ' · one is saved' : ''} <input name="token" type="password" autocomplete="off" placeholder="${NS.tokenSet ? 'Leave blank to keep it' : 'tk_…'}" style="width:100%"></label>
          <div><button type="button" id="nnew">New topic name</button> <span class="sub">Stops alerts to phones subscribed to the old one; subscribe again with the new name.</span></div></div></details>
        <div class="toolbar" style="margin:0"><button class="primary">Save</button><button type="button" id="ntest">Send test</button></div></form>
      <div class="sub">On ntfy.sh, anyone who knows the topic name can read these alerts, so keep it private (it's long and random for that reason).</div>
      ${N.recent.length ? `<details><summary class="sub">Recently sent</summary><ul class="list">${N.recent.map(x => `<li><span>${x.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(x.title || x.kind)}${x.error ? `<div class="sub">${esc(x.error)}</div>` : ''}</span><span class="sub">${new Date(x.at).toLocaleString()}</span></li>`).join('')}</ul></details>` : ''}</div>
    <div class="card stack" style="margin-top:14px"><h3>AI assistant</h3>
      <div>${AI.configured ? `✅ Anthropic API key saved (${esc(AI.keyHint)})${AI.fromEnv ? ' from the ANTHROPIC_API_KEY variable' : ''}` : 'Not set up'}</div>
      <div class="sub">Claude drafts guest replies (Inbox), writes listing text (Listing), reviews prices (Pricing) and answers questions about your numbers (Analytics).
        Nothing is sent to a guest or saved to Beds24 until you press Send, Save or Apply. It uses your own key from console.anthropic.com → API keys, and usage is billed to that Anthropic account (typically one to a few cents per request).</div>
      <form class="toolbar" id="aikey" style="margin:0"><input name="key" type="password" placeholder="sk-ant-…" autocomplete="off" style="flex:1;min-width:0">
        <button class="primary">${AI.configured ? 'Replace key' : 'Save key'}</button>${AI.configured && !AI.fromEnv ? '<button type="button" id="airm">Remove</button>' : ''}</form>
      ${AI.configured ? `<div class="sub">This month: ${AI.month.requests} request${AI.month.requests === 1 ? '' : 's'}, about $${AI.month.cost.toFixed(2)} (estimate; your Anthropic console has the exact bill). Model: ${esc(AI.model)}.</div>
      <form class="stack" id="aiset" style="max-width:none">
        <label class="sub">Monthly spending limit ($): requests stop once the month's estimate reaches it <input name="budget" type="number" min="0" max="10000" step="1" value="${AI.budget}" style="width:7em"></label>
        ${AI.properties.map(p => `<label class="sub">House notes for <b>${esc(p.name)}</b>: facts the assistant may use in guest replies, such as parking, pets, quiet hours, early check-in or late checkout policy, local tips, and your name for signing off
          <textarea name="note_${p.id}" rows="5" maxlength="10000" placeholder="Parking: two spots in the driveway. No pets. Early check-in possible if no one checks out that day; ask me first. Sign off as Sam.">${esc(p.notes)}</textarea></label>`).join('')}
        <div><button class="primary">Save</button></div></form>` : ''}</div>
    <div class="card stack" style="margin-top:14px"><h3>Import history from Guesty</h3>
      <div class="sub">In Guesty: Reservation report → Columns (turn everything on) → download CSV (it arrives by email). Choose that file here; you'll see a preview before anything is saved.
        Guest addresses, IDs and door key codes in the file are ignored.</div>
      ${status.guestyImported ? `<div>${status.guestyImported} bookings imported from Guesty. <button id="rmg">Remove Guesty import</button></div>` : ''}
      <input type="file" id="gfile" accept=".csv,text/csv"><div id="gprev"></div></div>`;
  $('#cf').onsubmit = async e => { e.preventDefault(); await act(() => api('/connect', { method: 'POST', body: { inviteCode: e.target.code.value } })); };
  if ($('#demo')) $('#demo').onclick = () => act(() => api('/demo', { method: 'POST' }));
  if ($('#cleardemo')) $('#cleardemo').onclick = () => act(() => api('/demo/clear', { method: 'POST' }));
  const signOut = path => async () => { try { await api(path, { method: 'POST' }); showLogin(); } catch (err) { fail(err); } };
  if ($('#lo')) $('#lo').onclick = signOut('/logout');
  if ($('#loall')) $('#loall').onclick = () => confirm('Sign out on every phone and browser? Each one has to sign in again.') && signOut('/logout-all')();
  if ($('#dc')) $('#dc').onclick = () => act(() => api('/disconnect', { method: 'POST' }));
  $('#ncopy').onclick = async () => {
    try { await navigator.clipboard.writeText(NS.topic); $('#ncopy').textContent = 'Copied'; }
    catch { getSelection().selectAllChildren($('#ntopic')); }
  };
  $('#nform').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, body = Object.fromEntries(['enabled', 'messages', 'bookings', 'cancellations', 'problems', 'home', 'pricing', 'preview'].filter(k => f.elements[k]).map(k => [k, f.elements[k].checked]));
    body.server = f.server.value;
    if (f.token.value.trim()) body.token = f.token.value.trim();
    try { await api('/notify', { method: 'POST', body }); await settingsView(); banner(body.enabled ? 'Notifications are on.' : 'Notification settings saved.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  $('#ntest').onclick = async () => {
    const b = $('#ntest'); b.disabled = true; b.textContent = 'Sending…';
    try { await api('/notify/test', { method: 'POST' }); banner('Test sent. It should appear on every phone subscribed to the topic within a few seconds.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
    b.disabled = false; b.textContent = 'Send test';
  };
  $('#nnew').onclick = async () => {
    if (!confirm('Make a new topic name? Phones subscribed to the current one will stop getting alerts until they subscribe to the new one.')) return;
    try { await api('/notify/new-topic', { method: 'POST' }); await settingsView(); banner('New topic created. Subscribe to it in ntfy on each phone.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  $('#aikey').onsubmit = async e => {
    e.preventDefault();
    const key = e.target.key.value.trim();
    if (!key) return;
    const btn = e.target.querySelector('.primary'); btn.disabled = true; btn.textContent = 'Checking…';
    try { await api('/ai/key', { method: 'POST', body: { apiKey: key } }); await boot(true); banner('Anthropic API key saved. AI features are on.', 'ok'); }
    catch (err) { if (err.message !== 'login') { banner(err.message, true); btn.disabled = false; btn.textContent = 'Save key'; } }
  };
  if ($('#airm')) $('#airm').onclick = () => confirm('Remove the Anthropic API key? AI features will switch off.') && act(() => api('/ai/key', { method: 'POST', body: { apiKey: '' } }));
  if ($('#aiset')) $('#aiset').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const notes = Object.fromEntries(AI.properties.map(p => [p.id, f.elements[`note_${p.id}`].value]));
    try { await api('/ai/settings', { method: 'POST', body: { budget: f.budget.value, notes } }); banner('AI settings saved.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  if ($('#rmg')) $('#rmg').onclick = () => confirm('Remove all bookings imported from Guesty?') && act(() => api('/import/guesty/remove', { method: 'POST' }));
  $('#gfile').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const csv = await file.text();
    try { renderGuestyPreview(csv, await api('/import/guesty/preview', { method: 'POST', body: { csv } })); }
    catch (err) { $('#gprev').innerHTML = `<div class="sub" style="color:#b91c1c">${esc(err.message)}</div>`; }
  };
}

function renderGuestyPreview(csv, { summary: s, rooms }) {
  const counts = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} (${n})`).join(', ') || 'none';
  const listings = Object.keys(s.listings);
  const select = name => `<select data-listing="${esc(name)}">${rooms.map(r =>
      `<option value="${r.id}">${esc(r.property_name)} · ${esc(r.name)}</option>`).join('')}
    <option value="new" ${rooms.length ? '' : 'selected'}>Keep as its own property</option></select>`;
  $('#gprev').innerHTML = `<ul class="list">
      <li><span>Rows in file</span><b>${s.total}</b></li>
      <li><span>Stays to import</span><b>${s.imported}${s.first ? ` <span class="sub">(${fmtDate(s.first)} → ${fmtDate(s.last)})</span>` : ''}</b></li>
      <li><span>Skipped</span><span class="sub">${counts(s.skipped)}</span></li>
      <li><span>Channels</span><span class="sub">${counts(s.channels)}</span></li>
      <li><span>Statuses in file</span><span class="sub">${counts(s.statuses)}</span></li>
      ${s.nightsMismatch ? `<li><span>Night counts that didn't match dates</span><span class="sub">${s.nightsMismatch} (dates were used)</span></li>` : ''}
    </ul>
    ${listings.map(l => `<label class="sub">Guesty listing <b>${esc(l)}</b> (${s.listings[l]}) belongs to: ${select(l)}</label>`).join('')}
    <button class="primary" id="gimp" ${s.imported ? '' : 'disabled'}>Import ${s.imported} stays</button>`;
  $('#gimp').onclick = () => {
    const mapping = Object.fromEntries([...document.querySelectorAll('[data-listing]')].map(x => [x.dataset.listing, x.value]));
    act(async () => {
      const r = await api('/import/guesty', { method: 'POST', body: { csv, mapping } });
      alert(`Imported ${r.imported} stays from Guesty.` + (r.duplicates ? ` ${r.duplicates} were already in Beds24 and were skipped.` : ''));
    });
  };
}

// ---------- Rates: view and change nightly price, minimum stay and blocked dates ----------
const ratesState = { start: null, room: null, from: null, to: null };
// The property's date (its time zone), not UTC: in a Wyoming evening UTC is already tomorrow.
const todayISO = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: status.tz || undefined }).format(new Date()); } catch { return new Date().toLocaleDateString('en-CA'); } };
const addMonths = (m, n) => { const d = new Date(m + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

async function ratesView() {
  const today = todayISO();
  ratesState.start ||= today.slice(0, 8) + '01';
  const live = stamp('rates');
  const r = await api('/rates?' + q({ start: ratesState.start, days: 62, ...(ratesState.room && { room: ratesState.room }) }));
  if (!live()) return;
  if (!r.room) {
    view.innerHTML = `<div class="card empty">${r.connected ? 'No rooms found in Beds24 yet. Set up your property and room in Beds24, then press Sync.' : 'Connect Beds24 in Settings to see and change your prices.'}</div>`;
    return;
  }
  ratesState.room = r.room.id;
  const months = [ratesState.start, addMonths(ratesState.start, 1)];
  const byDate = Object.fromEntries(r.days.map(d => [d.date, d]));
  const inSel = d => ratesState.from && d >= ratesState.from && d <= (ratesState.to || ratesState.from);
  const monthHtml = m => {
    const first = new Date(m + 'T00:00:00Z'), y = first.getUTCFullYear(), mo = first.getUTCMonth();
    const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let cells = Array.from({ length: first.getUTCDay() }, () => '<div class="day pad"></div>').join('');
    for (let i = 1; i <= len; i++) {
      const date = `${m.slice(0, 8)}${String(i).padStart(2, '0')}`, d = byDate[date] || {};
      const cls = ['day', date < today && 'past', d.blocked && 'blocked', d.booking && `booked ${d.booking.status === 'block' ? '' : d.booking.channel}`, inSel(date) && 'sel'].filter(Boolean).join(' ');
      const who = d.booking ? (d.booking.status === 'block' ? 'Block' : (d.booking.guest || 'Booked').split(' ')[0]) : d.blocked ? 'Blocked' : '';
      cells += `<div class="${cls}" data-date="${date}" ${date < today ? '' : 'role="button" tabindex="0"'} title="${esc(d.booking ? `${d.booking.guest || 'Booking'} (${d.booking.channel})` : '')}">
        <div class="n">${i}</div><div class="p">${d.price != null ? money(d.price) : '—'}</div>${d.minStay ? `<div class="m">${d.minStay}n min</div>` : ''}<div class="g">${esc(who)}</div></div>`;
    }
    return `<div class="month"><h4>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h4>
      <div class="mgrid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div></div>`;
  };
  const notice = !r.connected ? 'Connect Beds24 in Settings to change prices.'
    : r.canWrite === false ? 'Your Beds24 invite code can read prices but not change them. In Beds24 go to Settings → Apps &amp; Integrations → API, create a new invite code with <b>write access to Inventory</b>, and paste it in Settings here.'
    : r.calendarError ? `Prices couldn't be loaded from Beds24: ${esc(r.calendarError)}` : '';
  const f = ratesState.form || {};
  view.innerHTML = `${notice ? `<div class="notice">${notice}</div>` : ''}
    <div class="rates"><div class="card">
      <div class="toolbar">
        ${r.rooms.length > 1 ? `<select id="rroom" aria-label="Room">${r.rooms.map(x => `<option value="${x.id}" ${x.id === r.room.id ? 'selected' : ''}>${esc(x.property_name)} · ${esc(x.name)}</option>`).join('')}</select>` : `<b>${esc(r.room.property_name)}</b>`}
        <button id="rprev" aria-label="Previous month">‹</button><button id="rtoday">Today</button><button id="rnext" aria-label="Next month">›</button>
        <span class="sub">Click a night, then another, to select a range.</span></div>
      <div class="months">${months.map(monthHtml).join('')}</div></div>
    <div class="card stack" style="max-width:none"><h3>Change selected nights</h3>
      <form class="stack" id="rform" style="max-width:none">
        <div class="toolbar" style="margin:0"><label class="sub">From<br><input type="date" name="from" value="${ratesState.from || ''}" min="${today}"></label>
          <label class="sub">To<br><input type="date" name="to" value="${ratesState.to || ratesState.from || ''}" min="${today}"></label></div>
        <div class="wdays">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w, i) =>
          `<label>${w}<input type="checkbox" name="wd" value="${i}" ${!f.weekdays || f.weekdays.includes(i) ? 'checked' : ''}></label>`).join('')}</div>
        <label class="sub">Nightly price ($)<br><input name="price" type="number" min="1" step="1" value="${f.price ?? ''}" placeholder="leave as is"></label>
        <label class="sub">Minimum stay (nights)<br><input name="minStay" type="number" min="1" step="1" value="${f.minStay ?? ''}" placeholder="leave as is"></label>
        <div class="sub">Availability:
          <label><input type="radio" name="block" value="" ${!f.block ? 'checked' : ''}> leave as is</label>
          <label><input type="radio" name="block" value="block" ${f.block === 'block' ? 'checked' : ''}> block</label>
          <label><input type="radio" name="block" value="unblock" ${f.block === 'unblock' ? 'checked' : ''}> open</label></div>
        <button class="primary">Preview changes</button></form>
      <div id="rprev-out"></div></div></div>
    <div class="card" style="margin-top:14px"><h3>Recent changes</h3>${r.changes.length ? `<ul class="list">${r.changes.map(c =>
      `<li><span>${c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(c.summary)} <span class="sub">· ${fmtDate(c.date_from)} → ${fmtDate(c.date_to)} · ${c.nights} night${c.nights > 1 ? 's' : ''}${c.error ? ' · ' + esc(c.error) : ''}</span></span>
       <span class="sub">${new Date(c.at).toLocaleString()}</span></li>`).join('')}</ul>` : '<div class="empty">No changes made from this app yet.</div>'}</div>`;

  const shift = n => { ratesState.start = addMonths(ratesState.start, n); ratesView(); };
  $('#rprev').onclick = () => shift(-1); $('#rnext').onclick = () => shift(1);
  $('#rtoday').onclick = () => { ratesState.start = today.slice(0, 8) + '01'; ratesView(); };
  if ($('#rroom')) $('#rroom').onchange = e => { ratesState.room = Number(e.target.value); ratesView(); };
  const form = $('#rform');
  const readForm = () => ({
    roomId: ratesState.room, from: form.from.value, to: form.to.value || form.from.value,
    weekdays: [...form.querySelectorAll('[name=wd]:checked')].map(x => Number(x.value)),
    price: form.price.value, minStay: form.minStay.value, block: form.block.value,
  });
  view.querySelectorAll('.day[data-date]').forEach(el => {
    const pick = key => {
      const d = el.dataset.date;
      if (d < today) return;
      ratesState.form = readForm();
      if (!ratesState.from || ratesState.to) { ratesState.from = d; ratesState.to = null; }
      else if (d < ratesState.from) { ratesState.to = ratesState.from; ratesState.from = d; }
      else ratesState.to = d;
      ratesView().then(() => key && view.querySelector(`.day[data-date="${d}"]`)?.focus({ preventScroll: true }));
    };
    el.onclick = () => pick(false); el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true); } };
  });
  form.onsubmit = async e => {
    e.preventDefault();
    const body = readForm();
    ratesState.form = body; ratesState.from = body.from; ratesState.to = body.to;
    const out = $('#rprev-out');
    try { renderRatesPreview(out, body, await api('/rates/preview', { method: 'POST', body }), r.connected && r.canWrite !== false); }
    catch (err) { if (err.message !== 'login') out.innerHTML = `<div class="bad">${esc(err.message)}</div>`; }
  };
}

function renderRatesPreview(out, body, p, canSave) {
  const val = (v, kind) => v == null ? '—' : kind === 'price' ? money(v) : kind === 'blocked' ? (v ? 'blocked' : 'open') : v;
  const cell = (c, k) => c.before[k] === c.after[k] ? val(c.after[k], k) : `${val(c.before[k], k)} → <b>${val(c.after[k], k)}</b>`;
  out.innerHTML = `<p><b>${p.changes.length}</b> of ${p.selected} selected night${p.selected > 1 ? 's' : ''} will change: ${esc(p.summary)}</p>
    ${p.warnings.map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
    ${p.changes.length ? `<div style="max-height:260px;overflow:auto"><table class="pv"><tr><th>Night</th><th>Price</th><th>Min</th><th>Avail.</th></tr>
      ${p.changes.map(c => `<tr><td>${fmtDate(c.date)}${c.booked ? ' <span class="sub">(booked)</span>' : ''}</td><td>${cell(c, 'price')}</td><td>${cell(c, 'minStay')}</td><td>${cell(c, 'blocked')}</td></tr>`).join('')}
      </table></div>
      <button class="primary" id="rsave" ${canSave ? '' : 'disabled'}>Save ${p.changes.length} night${p.changes.length > 1 ? 's' : ''} to Beds24</button>
      <div class="sub">Once Beds24 is connected to Airbnb, VRBO and Booking.com, saved changes reach them within minutes.</div>` : ''}`;
  if ($('#rsave')) $('#rsave').onclick = async () => {
    $('#rsave').disabled = true; $('#rsave').textContent = 'Saving…';
    try {
      const res = await api('/rates/apply', { method: 'POST', body });
      ratesState.from = ratesState.to = null; ratesState.form = null;
      banner(`Saved: ${res.summary} on ${res.applied} night${res.applied === 1 ? '' : 's'}.${res.warnings.length ? ' ' + res.warnings.join(' ') : ''}`, res.warnings.length ? '' : 'ok');
      await ratesView();
    } catch (err) {
      if (err.message === 'login') return;
      out.insertAdjacentHTML('beforeend', `<p class="bad">${esc(err.message)}</p>`);
      $('#rsave').disabled = false; $('#rsave').textContent = 'Try again';
    }
  };
}

// ---------- Locks: Seam / Yale door codes ----------
async function locksView() {
  const L = await api('/locks');
  if (!L.configured) {
    view.innerHTML = `<div class="card stack" style="max-width:620px"><h3>Set up door codes</h3>
      <ol class="sub" style="line-height:1.7;padding-left:18px">
        <li>Create an account at <b>seam.co</b>. Start in a <b>sandbox</b> workspace to test with virtual Yale locks, then make a production workspace for your real locks.</li>
        <li>In the Seam console, create an <b>API key</b> and paste it below.</li>
        <li>Click <b>Connect Yale account</b> and sign in to Yale Access. Your Yale password goes to Seam, never to this app.</li>
        <li>Choose which property each lock belongs to.</li></ol>
      <form class="stack" id="kf"><input name="key" placeholder="seam_..." autocomplete="off"><button class="primary">Save API key</button></form></div>`;
    $('#kf').onsubmit = e => { e.preventDefault(); act(() => api('/locks/key', { method: 'POST', body: { apiKey: e.target.key.value } })); };
    return;
  }
  const st = L.settings;
  const stateIcon = l => ({ set: '✓', scheduled: '⏱', pending: '…', error: '⚠', missing: '–' })[l.state];
  const roomOpts = sel => `<option value="">Not used</option>` + L.rooms.map(r => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.property_name)} · ${esc(r.name)}</option>`).join('');
  const window_ = c => c.startsAt ? `${new Date(c.startsAt).toLocaleString()} → ${new Date(c.endsAt).toLocaleString()}` : 'Permanent';
  view.innerHTML = `
    ${L.seamError ? `<div class="notice">Couldn't reach Seam: ${esc(L.seamError)}</div>` : ''}
    ${L.error ? `<div class="notice">Door code update failed: ${esc(L.error)}</div>` : ''}
    <div class="cols">
    <div class="card" style="overflow-x:auto"><h3>Locks</h3>
      ${L.locks.length ? `<table><tr><th>Lock</th><th>Status</th><th>Battery</th><th>Opens</th></tr>${L.locks.map(l => `<tr>
        <td>${esc(l.name)}</td><td>${l.missing ? '<span class="sub">not listed by Seam</span>' : l.online ? '<span class="ok">● Online</span>' : '<span class="bad">● Offline</span>'}</td>
        <td>${l.battery != null ? Math.round(l.battery * 100) + '%' : '—'}</td>
        <td><select data-lock="${esc(l.device_id)}">${roomOpts(l.room_id)}</select></td></tr>`).join('')}</table>`
        : '<div class="empty">No locks yet. Connect your Yale account, then refresh.</div>'}
      <div class="toolbar" style="margin-top:10px"><button id="lconnect">Connect Yale account</button><button id="lrefresh">Refresh locks</button>
        <span class="sub">Seam key ${esc(L.keyHint)} · <a href="#" id="lkey">change</a></span></div></div>

    <div class="card stack" style="max-width:none"><h3>Automatic guest codes</h3>
      <label><input type="checkbox" id="dauto" ${st.auto ? 'checked' : ''}> <b>Create a code for every confirmed booking</b></label>
      <div class="sub">Leave this off until switch day. Guesty still makes codes until then, and running both could clash.</div>
      <form id="dform" class="stack" style="max-width:none">
        <div class="toolbar" style="margin:0">
          <label class="sub">Check-in<br><input type="time" name="checkin" value="${st.checkin}"></label>
          <label class="sub">Checkout<br><input type="time" name="checkout" value="${st.checkout}"></label>
          <label class="sub">Time zone<br><input name="tz" value="${esc(st.tz)}" size="16"></label>
          <label class="sub">Create codes<br><input type="number" name="lookahead" min="1" max="60" value="${st.lookahead}" style="width:5em"> days ahead</label></div>
        <label class="sub">Save the code on the Beds24 booking in custom question
          <input type="number" name="beds24Field" min="0" max="10" value="${st.beds24Field}" style="width:4em"> (0 = don't)</label>
        ${st.beds24Field ? `<div class="sub">In your Beds24 check-in Auto Action, write <code>[GUESTCUSTOMQ${st.beds24Field}]</code> where the door code should appear.
          Set the Auto Action to send no earlier than ${st.lookahead} days before arrival, so the code exists by then.</div>` : ''}
        <button class="primary">Save settings</button></form>
      <div class="sub">Each guest gets the last 4 digits of their phone number (or the last 5 or 6 if that clashes with another code; a random code if there's no phone), on every lock of their property, from check-in to checkout time.
        ${L.lastRun ? `Last checked ${new Date(L.lastRun).toLocaleString()}.` : ''}</div>
      ${L.problems.length ? `<div class="warn">${L.problems.slice(0, 5).map(p => `⚠ ${esc(p.lock ? p.lock + ': ' : '')}${esc(p.message)}`).join('<br>')}</div>` : ''}
    </div></div>

    <div class="card" style="margin-top:14px;overflow-x:auto"><h3>Guest codes</h3>
      ${L.guestCodes.length ? `<table><tr><th>Guest</th><th>Stay</th><th>Code</th><th>Locks</th><th>Beds24</th><th></th></tr>${L.guestCodes.map(g => `<tr>
        <td>${esc(g.guest_name || 'Guest')} ${tag(g.channel)}</td><td>${fmtDate(g.arrival)} → ${fmtDate(g.departure)}</td>
        <td><b class="code">${esc(g.door.code)}</b></td>
        <td>${g.door.perLock.map(l => `<span class="chip ${l.state}" title="${esc(l.label)}">${stateIcon(l)} ${esc(l.lock)}</span>`).join(' ') || '<span class="sub">–</span>'}</td>
        <td>${g.door.beds24.ok ? '<span class="ok">✓ saved</span>' : g.door.beds24.message ? `<span class="bad" title="${esc(g.door.beds24.message)}">⚠ not saved</span>` : '<span class="sub">–</span>'}</td>
        <td><button data-gcode="${g.id}" data-cur="${esc(g.door.code)}">Change</button></td></tr>`).join('')}</table>`
        : `<div class="empty">${st.auto ? 'No upcoming stays need a code yet.' : 'Automatic guest codes are off.'}</div>`}
      <div class="sub">✓ on the lock · ⏱ goes on the lock at check-in · … being set · ⚠ problem (hover for details)</div></div>

    <div class="card stack" style="margin-top:14px;max-width:none;overflow-x:auto"><h3>Other codes on the locks</h3>
      <div class="sub">Cleaner, owner and other codes, including ones set in the Yale Access app. Changes apply to every lock the code is on.</div>
      ${L.otherCodes.length ? `<table><tr><th>Name</th><th>Code</th><th>Locks</th><th>When</th><th></th></tr>${L.otherCodes.map((c, i) => `<tr>
        <td>${esc(c.name)}</td><td><b class="code">${esc(c.code || '••••')}</b></td>
        <td>${c.locks.map(l => `<span class="chip ${l.errors.length ? 'error' : ''}" title="${esc(l.errors.join('; '))}">${esc(l.lock)}${l.managed ? '' : ' <span class="sub">(Yale app)</span>'}</span>`).join(' ')}</td>
        <td class="sub">${window_(c)}</td>
        <td><button data-ochange="${i}">Change</button> <button data-odel="${i}">Delete</button></td></tr>`).join('')}</table>` : '<div class="empty">No other codes.</div>'}
      <form id="aform" class="toolbar" style="margin:6px 0 0">
        <input name="name" placeholder="Name, e.g. Cleaner" size="16"><input name="code" placeholder="Code (4–8 digits)" size="14" inputmode="numeric">
        ${L.locks.filter(l => !l.missing).map(l => `<label class="sub"><input type="checkbox" name="dev" value="${esc(l.device_id)}" checked> ${esc(l.name)}</label>`).join('')}
        <label class="sub">From <input type="datetime-local" name="startsAt"></label><label class="sub">To <input type="datetime-local" name="endsAt"></label>
        <button class="primary">Add code</button><span class="sub">Leave From/To empty for a permanent code.</span></form></div>`;

  $('#lconnect').onclick = async () => {
    try { const { url } = await api('/locks/connect', { method: 'POST' }); window.open(url, '_blank', 'noopener'); banner('Sign in to Yale in the new tab, then click "Refresh locks".'); }
    catch (e) { if (e.message !== 'login') banner(e.message, true); }
  };
  $('#lrefresh').onclick = () => act(() => api('/locks/refresh', { method: 'POST' }));
  $('#lkey').onclick = e => { e.preventDefault(); const k = prompt('New Seam API key (leave empty to disconnect Seam):'); if (k !== null) act(() => api('/locks/key', { method: 'POST', body: { apiKey: k } })); };
  view.querySelectorAll('[data-lock]').forEach(sel => sel.onchange = () => act(() => api('/locks/assign', { method: 'POST', body: { deviceId: sel.dataset.lock, roomId: sel.value } })));
  $('#dauto').onchange = e => {
    if (e.target.checked && !confirm('Turn on automatic guest codes? Every confirmed booking will get a code on your locks.')) { e.target.checked = false; return; }
    act(() => api('/locks/settings', { method: 'POST', body: { auto: e.target.checked } }));
  };
  $('#dform').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    act(() => api('/locks/settings', { method: 'POST', body: { checkin: f.checkin.value, checkout: f.checkout.value, tz: f.tz.value.trim(), lookahead: Number(f.lookahead.value), beds24Field: Number(f.beds24Field.value) } }));
  };
  view.querySelectorAll('[data-gcode]').forEach(b => b.onclick = () => {
    const code = prompt('New door code for this guest (4–8 digits). It replaces the current code on every lock and in Beds24. If the check-in message already went out, tell the guest.', b.dataset.cur);
    if (code) act(() => api('/locks/booking-code', { method: 'POST', body: { bookingId: Number(b.dataset.gcode), code } }));
  });
  view.querySelectorAll('[data-ochange]').forEach(b => b.onclick = () => {
    const c = L.otherCodes[b.dataset.ochange];
    const code = prompt(`New code for "${c.name}" on ${c.locks.map(l => l.lock).join(' and ')}:`, c.code || '');
    if (code) act(() => api('/locks/code/change', { method: 'POST', body: { entries: c.locks, code } }));
  });
  view.querySelectorAll('[data-odel]').forEach(b => b.onclick = () => {
    const c = L.otherCodes[b.dataset.odel];
    if (confirm(`Delete "${c.name}" (${c.code || 'code'}) from ${c.locks.map(l => l.lock).join(' and ')}?`)) act(() => api('/locks/code/delete', { method: 'POST', body: { entries: c.locks } }));
  });
  $('#aform').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    act(() => api('/locks/code/add', { method: 'POST', body: { name: f.name.value, code: f.code.value,
      deviceIds: [...f.querySelectorAll('[name=dev]:checked')].map(x => x.value), startsAt: f.startsAt.value || null, endsAt: f.endsAt.value || null } }));
  };
}

// ---------- Inbox: guest messages through Beds24 ----------
const inbox = { booking: null, filter: 'all', q: '', drafts: {}, replies: null, manage: false };
let pageTimer = null;
const setUnread = n => { const b = $('#unread'); b.hidden = !n; b.textContent = n; status.unreadMessages = n; };
const timeAgo = t => {
  const s = (Date.now() - Date.parse(t)) / 1000;
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : s < 604800 ? `${Math.round(s / 86400)}d` : new Date(t).toLocaleDateString();
};
const fill = (body, vars) => body.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== '' ? String(vars[k]) : m));

async function inboxView() {
  const seq = renderSeq;
  view.innerHTML = `<div class="inbox ${inbox.booking ? 'has-thread' : ''}">
    <div class="card convs"><div class="toolbar" style="margin-bottom:6px">
      <select id="ifilter" aria-label="Show">${[['all', 'All'], ['unread', 'Unread'], ['upcoming', 'Current & upcoming'], ['inquiries', 'Inquiries']].map(([v, l]) => `<option value="${v}" ${inbox.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="iq" placeholder="Search" aria-label="Search messages" value="${esc(inbox.q)}" style="flex:1;min-width:0"></div>
      <div id="ilist"></div></div>
    <div class="card tpane" id="ithread">${inbox.booking ? '' : '<div class="empty" style="padding:40px;text-align:center">Choose a conversation</div>'}</div></div>`;
  $('#ifilter').onchange = e => { inbox.filter = e.target.value; loadList().catch(fail); };
  let t; $('#iq').oninput = e => { clearTimeout(t); t = setTimeout(() => { inbox.q = e.target.value; loadList().catch(fail); }, 250); };
  await loadList();
  if (inbox.booking) await openThread(inbox.booking);
  if (seq !== renderSeq) return;   // the owner left while the thread was loading: no poll for a page that's gone
  // Check for new messages every minute while the inbox is open and visible.
  pageTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const before = status.unreadMessages;
      const r = await api('/inbox/refresh', { method: 'POST' });
      setUnread(r.unread);
      await loadList();
      if (inbox.booking && r.unread !== before) await loadThreadMessages(inbox.booking);
    } catch { /* next tick will retry */ }
  }, 60000);
}

async function loadList() {
  const r = await api('/inbox?' + new URLSearchParams({ filter: inbox.filter, q: inbox.q }));
  setUnread(r.unread);
  const list = $('#ilist');
  if (!list) return;
  list.innerHTML = (r.error ? `<div class="warn sub">Couldn't fetch new messages: ${esc(r.error)}</div>` : '') + (r.conversations.length ? r.conversations.map(c => `
    <button class="conv ${c.booking_id === inbox.booking ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-conv="${c.booking_id}">
      <span class="top"><b>${esc(c.guest_name || `Booking ${c.booking_id}`)}</b> ${c.channel ? tag(c.channel) : ''}${c.status === 'inquiry' ? ' <span class="tag request">inquiry</span>' : c.status === 'deleted' ? ' ' + statusTag(c.status) : ''}<span class="sub when">${timeAgo(c.last_time)}</span></span>
      <span class="sub">${c.arrival ? `${fmtDate(c.arrival)} → ${fmtDate(c.departure)}` : ''}${c.unread ? ` · <b class="ucount">${c.unread} new</b>` : ''}</span>
      <span class="snip">${c.last_source === 'host' ? 'You: ' : ''}${esc((c.last_body || '').slice(0, 90))}</span></button>`).join('')
    : `<div class="empty" style="padding:20px">${r.connected ? 'No messages yet. New guest messages from Airbnb, Booking.com and VRBO appear here.' : 'Connect Beds24 in Settings to see guest messages.'}</div>`);
  list.querySelectorAll('[data-conv]').forEach(el => el.onclick = () => openThread(+el.dataset.conv));
}

async function openThread(id) {
  inbox.booking = id;
  // The thread gets its own address and history entry, so a phone's back gesture (or ‹) returns to the list and a
  // reload reopens what was on screen. Moving between threads replaces the entry: back always means the list.
  if (location.hash !== '#/inbox/' + id) {
    const inThread = /^#\/inbox\/\d+/.test(location.hash);
    history[inThread ? 'replaceState' : 'pushState'](inThread ? history.state : { list: true }, '', '#/inbox/' + id);
  }
  document.querySelector('.inbox')?.classList.add('has-thread');
  document.querySelectorAll('.conv').forEach(el => el.classList.toggle('on', +el.dataset.conv === id));
  let th;
  try {
    th = await api('/inbox/thread?booking=' + id);
    inbox.replies ||= await api('/replies');
  } catch (err) {
    if (['login', 'stale'].includes(err.message) || inbox.booking !== id) return;
    const pane = $('#ithread');   // never leave another guest's thread on screen under this one's name
    if (pane) pane.innerHTML = `<div class="empty" style="padding:30px"><span class="bad">${esc(err.message)}</span></div>`;
    return;
  }
  if (inbox.booking !== id) return;   // another conversation was opened meanwhile
  renderThread(th);
  markRead(id, th);
}

// A guest message the owner has on screen (in a visible tab) counts as read, whether it was there when the thread
// opened or arrived with the minute poll.
function markRead(id, th) {
  if (document.hidden || !th.messages.some(m => m.source === 'guest' && !m.read)) return;
  api('/inbox/read', { method: 'POST', body: { bookingId: id } }).then(loadList).catch(() => {});
}

async function loadThreadMessages(id) {
  const th = await api('/inbox/thread?booking=' + id);
  if (inbox.booking !== id || !$('#imsgs')) return;
  $('#imsgs').innerHTML = messagesHtml(th); scrollThread();
  markRead(id, th);
}

const scrollThread = () => { const m = $('#imsgs'); if (m) m.scrollTop = m.scrollHeight; };
const messagesHtml = th => th.messages.map(m => {
  const who = { guest: th.booking?.guest_name?.split(' ')[0] || 'Guest', host: 'You', system: 'Channel notice', internalNote: 'Internal note' }[m.source] || m.source;
  const att = m.attachment_name ? `<a class="att" href="/api/inbox/attachment?id=${m.id}" target="_blank" rel="noopener">📎 ${esc(m.attachment_name)}</a>` : '';
  return `<div class="msg ${esc(m.source)}"><div class="bubble">${esc(m.body).replace(/\n/g, '<br>')}${att}</div>
    <div class="meta">${esc(who)} · ${new Date(m.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>`;
}).join('') || '<div class="empty" style="text-align:center;padding:20px">No messages in this conversation yet.</div>';

function renderThread(th) {
  // The booking this pane shows. Send, reload, drafts and AI drafts use it, never whichever conversation is
  // selected by the time a button is pressed: a reply must reach the guest whose thread is on screen.
  const b = th.booking, pane = $('#ithread'), id = th.bookingId ?? b?.id ?? inbox.booking;
  if (!pane) return;
  const channelNote = !b ? '' : b.channel === 'Booking.com' ? 'Booking.com doesn\'t allow links in messages.'
    : b.channel === 'Direct' ? 'Direct bookings: Beds24 may not notify the guest of this message. Email or text them if it\'s urgent.'
    : `Sent to the guest's ${esc(b.channel)} message thread.`;
  pane.innerHTML = `
    <div class="thead"><button class="back" id="iback" aria-label="Back to conversations">‹</button>
      <div><b>${esc(b?.guest_name || `Booking ${id}`)}</b> ${b ? tag(b.channel) + ' ' + statusTag(b.status) : ''}
      <div class="sub">${b ? `${fmtDate(b.arrival)} → ${fmtDate(b.departure)} · ${b.nights} night${b.nights === 1 ? '' : 's'}${(b.adults || 0) + (b.children || 0) ? ` · ${(b.adults || 0) + (b.children || 0)} guests` : ''}${b.property_name ? ' · ' + esc(b.property_name) : ''}` : ''}
        ${th.door ? ` · 🔑 <b class="code">${esc(th.door.code)}</b>` : ''}</div></div>
      <button id="ireload" title="Check for new messages" style="margin-left:auto">↻</button></div>
    <div class="msgs" id="imsgs">${messagesHtml(th)}</div>
    ${th.canReply ? `<div class="composer">
      <div class="toolbar" style="margin:0 0 6px"><select id="ireply"><option value="">Insert saved reply…</option>${inbox.replies.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select>
        <a href="#" id="imanage" class="sub">${inbox.manage ? 'Hide saved replies' : 'Edit saved replies'}</a></div>
      ${status.ai ? `<div class="toolbar" style="margin:0 0 6px"><input id="iaihint" placeholder="Anything the draft should say? (optional)" style="flex:1;min-width:0" maxlength="2000">
        <button type="button" id="iai">✨ Draft reply</button></div>` : ''}
      <textarea id="itext" rows="4" maxlength="5000" placeholder="Write a reply…">${esc(inbox.drafts[id] || '')}</textarea>
      <div class="toolbar" style="margin:6px 0 0"><span class="sub" id="inote">${channelNote}</span>
        <span class="sub" id="icount" style="margin-left:auto"></span><button class="primary" id="isend">Send</button></div>
      <div id="imgr"></div></div>`
    : `<div class="sub" style="padding:10px">${b ? 'Replies can only be sent on Beds24 bookings (this one was imported from Guesty).' : 'This booking isn\'t in the app yet; press Sync.'}</div>`}`;
  scrollThread();
  // Back through history when the list is the previous entry (opened from it); a deep link from a notification has
  // nothing behind it, so go to the list directly. Either way the hash change redraws the inbox without a thread.
  $('#iback').onclick = () => { if (history.state?.list) history.back(); else location.hash = '#/inbox'; };
  $('#ireload').onclick = async () => {
    try { const t2 = await api('/inbox/reload', { method: 'POST', body: { bookingId: id } }); if (inbox.booking === id && $('#imsgs')) { $('#imsgs').innerHTML = messagesHtml(t2); scrollThread(); } }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  if (!th.canReply) return;
  const ta = $('#itext');
  const count = () => { $('#icount').textContent = ta.value.length > 4000 ? `${ta.value.length}/5000` : ''; inbox.drafts[id] = ta.value; };
  ta.oninput = count; count();
  // Unfilled {placeholders} are left visible so they get noticed before sending.
  $('#ireply').onchange = e => {
    const r = inbox.replies.find(x => x.id === +e.target.value);
    if (r) { ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n\n' : '') + fill(r.body, th.vars); count(); ta.focus(); }
    e.target.value = '';
  };
  ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#isend').click(); };
  // AI draft: replaces the reply box (with undo); nothing is sent until Send is pressed.
  if ($('#iai')) $('#iai').onclick = async () => {
    const btn = $('#iai'), booking = id, before = ta.value;
    btn.disabled = true; btn.textContent = 'Drafting…';
    try {
      const r = await api('/ai/draft', { method: 'POST', body: { bookingId: booking, instructions: $('#iaihint').value } });
      if (inbox.booking !== booking || !$('#itext')) return;
      $('#itext').value = r.text; $('#itext').dispatchEvent(new Event('input'));
      $('#inote').innerHTML = `✨ AI draft${aiCost(r)}. Read it, and fill in anything in [brackets], before sending.${before.trim() ? ' <a href="#" id="iundo">Undo</a>' : ''}`;
      if ($('#iundo')) $('#iundo').onclick = e => { e.preventDefault(); $('#itext').value = before; $('#itext').dispatchEvent(new Event('input')); $('#inote').textContent = ''; };
    } catch (err) { if (err.message !== 'login' && $('#inote')) $('#inote').innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
    finally { if ($('#iai')) { $('#iai').disabled = false; $('#iai').textContent = '✨ Draft reply'; } }
  };
  $('#isend').onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (/\{\w+\}/.test(text) && !confirm('The message still has a {placeholder} in it. Send anyway?')) return;
    if (/\[(confirm|check|add|insert)\b[^\]]*\]/i.test(text) && !confirm('The message still has a [bracketed] note to fill in. Send anyway?')) return;
    const sendBtn = $('#isend');
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      const t2 = await api('/inbox/send', { method: 'POST', body: { bookingId: id, message: text } });
      inbox.drafts[id] = '';
      if (inbox.booking === id) {
        renderThread(t2);
        if (t2.refreshFailed) $('#inote').textContent = 'Sent. It will show here after the next sync.';
      }
      loadList().catch(() => {});
    } catch (err) {
      if (err.message === 'login' || inbox.booking !== id) return;
      $('#inote').innerHTML = `<span class="bad">${esc(err.message)}</span>`;
      sendBtn.disabled = false; sendBtn.textContent = 'Try again';
    }
  };
  $('#imanage').onclick = e => { e.preventDefault(); inbox.manage = !inbox.manage; renderThread(th); };
  if (inbox.manage) renderReplyManager(th);
}

function renderReplyManager(th) {
  const box = $('#imgr');
  box.innerHTML = `<div class="replies"><h3>Saved replies</h3>
    <div class="sub">Fill-ins: ${Object.keys(th.vars).map(k => `<code>{${k}}</code>`).join(' ')}</div>
    ${inbox.replies.map(r => `<div class="reply"><b>${esc(r.title)}</b> <a href="#" data-redit="${r.id}">edit</a> · <a href="#" data-rdel="${r.id}">delete</a>
      <div class="sub">${esc(r.body.slice(0, 140))}${r.body.length > 140 ? '…' : ''}</div></div>`).join('')}
    <form id="rform" class="stack" style="max-width:none"><input type="hidden" name="id"><input name="title" placeholder="Name, e.g. Wi-Fi details">
      <textarea name="body" rows="3" placeholder="Hi {guest_first_name}, …"></textarea><button class="primary">Save reply</button></form></div>`;
  const f = $('#rform');
  const reload = async () => { inbox.replies = await api('/replies'); renderThread(th); };
  f.onsubmit = async e => {
    e.preventDefault();
    try { await api('/replies', { method: 'POST', body: { id: f.id.value ? +f.id.value : null, title: f.title.value, body: f.body.value } }); await reload(); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  box.querySelectorAll('[data-redit]').forEach(a => a.onclick = e => {
    e.preventDefault(); const r = inbox.replies.find(x => x.id === +a.dataset.redit);
    f.id.value = r.id; f.title.value = r.title; f.body.value = r.body; f.title.focus();
  });
  box.querySelectorAll('[data-rdel]').forEach(a => a.onclick = async e => {
    e.preventDefault(); const r = inbox.replies.find(x => x.id === +a.dataset.rdel);
    if (!confirm(`Delete the saved reply "${r.title}"?`)) return;
    try { await api('/replies/delete', { method: 'POST', body: { id: r.id } }); await reload(); } catch (err) { fail(err); }
  });
}

// ---------- Pricing tool ----------
// Laid out like a market dashboard: forward numbers, a demand calendar, the next 90 days of prices against demand,
// upcoming events (with the event scout's finds) and the demand signals behind the recommendations.
const pr = { month: null, room: null, selected: null, win: 30, open: { settings: false, events: false, table: false }, ai: { html: '', busy: false }, scanning: false };
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pctStr = v => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`;
const LEVEL_LABEL = { low: 'Low', mid: 'Moderate', high: 'High', vhigh: 'Very high' };
const IMPACT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', very_high: 'Very high' };
const IMPACT_LEVEL = { low: 'low', medium: 'mid', high: 'high', very_high: 'vhigh' };
const dayLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const nightsLabel = (a, b) => a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;

// One tooltip for the page's chart and calendar. Text goes in with textContent (event names come from the web).
function showTip(x, y, rows) {
  let tip = $('#ptip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'ptip'; tip.className = 'ptip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
  tip.replaceChildren(...rows.map(([value, label, key]) => {
    const r = document.createElement('div'); r.className = 'tr';
    if (key) { const k = document.createElement('span'); k.className = 'tk ' + key; r.append(k); }
    const v = document.createElement('b'); v.textContent = value; r.append(v);
    if (label) { const l = document.createElement('span'); l.textContent = ' ' + label; r.append(l); }
    return r;
  }));
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 14)) + 'px';
  tip.style.top = Math.max(8, y - h - 12 < 8 ? y + 18 : y - h - 12) + window.scrollY + 'px';
}
const hideTip = () => { const t = $('#ptip'); if (t) t.hidden = true; };

/** The next 90 nights: recommended price and Beds24's price (one $ axis), with a demand strip underneath. */
function priceChart(box, nights) {
  const W = Math.max(300, box.clientWidth), H = 250, padL = 44, padR = 12, top = 12, plotH = 160, stripY = top + plotH + 14, stripH = 14;
  const prices = nights.flatMap(n => (n.booked || n.blocked ? [] : [n.price, n.current])).filter(v => v != null);
  if (!prices.length) { box.innerHTML = '<div class="empty">No open nights in the next 90 days.</div>'; return; }
  const step = v => [5, 10, 20, 25, 50, 100, 200, 250, 500].find(s => v / s <= 5) || 1000;
  const lo0 = Math.min(...prices), hi0 = Math.max(...prices), st = step((hi0 - lo0) || hi0 / 2 || 50);
  const lo = Math.max(0, Math.floor((lo0 - st * 0.3) / st) * st), hi = Math.ceil((hi0 + st * 0.3) / st) * st;
  const xw = (W - padL - padR) / nights.length, x = i => padL + xw * (i + 0.5), y = v => top + plotH - (v - lo) / (hi - lo) * plotH;
  // Runs of open nights become lines; a single open night between bookings becomes a dot.
  const series = key => {
    const runs = []; let run = [];
    nights.forEach((n, i) => {
      const v = n.booked || n.blocked ? null : n[key];
      if (v == null) { if (run.length) runs.push(run); run = []; } else run.push([x(i), y(v)]);
    });
    if (run.length) runs.push(run);
    return `<path d="${runs.filter(r => r.length > 1).map(r => r.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join('')}" class="ln ${key === 'price' ? 'rec' : 'now'}"/>`
      + runs.filter(r => r.length === 1).map(([[px, py]]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" class="dot ${key === 'price' ? 'rec' : 'now'}"/>`).join('');
  };
  const ticks = []; for (let v = lo; v <= hi + 0.01; v += st) ticks.push(v);
  const months = nights.map((n, i) => [n, i]).filter(([n, i]) => i === 0 || n.date.endsWith('-01'));
  box.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Recommended and current nightly price for the next 90 nights, with demand">
    ${ticks.map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">$${v >= 1000 ? (v / 1000) + 'K' : v}</text>`).join('')}
    ${months.map(([n, i]) => `<text x="${x(i) - xw / 2}" y="${H - 8}" class="axis">${MONTHS[+n.date.slice(5, 7) - 1]} ${+n.date.slice(8)}</text>`).join('')}
    ${series('current')}${series('price')}
    ${nights.map((n, i) => `<rect x="${(x(i) - xw / 2 + 1).toFixed(1)}" y="${stripY}" width="${Math.max(1, xw - 2).toFixed(1)}" height="${stripH}" rx="2"
      class="${n.booked ? 'sbooked' : n.blocked ? 'sblocked' : 'lv-' + n.level}"/>${n.event && !n.booked ? `<circle cx="${x(i).toFixed(1)}" cy="${stripY - 5}" r="2" class="evmark"/>` : ''}`).join('')}
    <line class="xhair" y1="${top}" y2="${stripY + stripH}" hidden/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${stripY + stripH + 4}" fill="transparent" class="hit" tabindex="0"/></svg>`;
  const svg = box.querySelector('svg'), hair = svg.querySelector('.xhair'), hit = svg.querySelector('.hit');
  const at = i => {
    const n = nights[i];
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.removeAttribute('hidden');
    const r = svg.getBoundingClientRect();
    showTip(r.left + x(i), r.top + top + 20, [
      [dayLabel(n.date), ''],
      ...(n.booked ? [['Booked', '']] : n.blocked ? [['Blocked', '']] : [[money(n.price), 'recommended', 'rec'], [n.current != null ? money(n.current) : '—', 'in Beds24 now', 'now']]),
      [`${LEVEL_LABEL[n.level] || '—'} demand`, n.score != null ? `(${n.score}/100)` : ''],
      ...(n.event ? [[n.event, '']] : []),
    ]);
  };
  let idx = 0;
  hit.onpointermove = e => { const r = svg.getBoundingClientRect(); idx = Math.max(0, Math.min(nights.length - 1, Math.floor((e.clientX - r.left - padL) / xw))); at(idx); };
  hit.onpointerleave = () => { hair.setAttribute('hidden', ''); hideTip(); };
  hit.onfocus = () => at(idx); hit.onblur = hit.onpointerleave;
  hit.onkeydown = e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); idx = Math.max(0, Math.min(nights.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1))); at(idx); } };
}

function kpiTiles(P) {
  const f = P.forward.find(w => w.days === pr.win) || P.forward[0];
  const ly = f.lastYearAtThisPoint, now = f.now;
  const delta = (cur, prev, kind) => {
    if (prev == null || cur == null || (kind !== 'pts' && !prev)) return '<div class="tdelta sub">No history for last year</div>';
    const d = kind === 'pts' ? (cur - prev) * 100 : (cur / prev - 1) * 100;
    if (Math.abs(d) < 0.5) return '<div class="tdelta sub">Same as this time last year</div>';
    const up = d > 0;
    return `<div class="tdelta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(Math.round(d))}${kind === 'pts' ? ' pts' : '%'} <span class="sub">vs this time last year</span></div>`;
  };
  const open = P.next90.slice(0, pr.win).filter(n => !n.booked && !n.blocked);
  const hot = open.filter(n => n.level === 'high' || n.level === 'vhigh');
  const evs = new Set(P.next90.slice(0, pr.win).map(n => n.event).filter(Boolean));
  const recAvg = open.length ? open.reduce((a, n) => a + n.price, 0) / open.length : null;
  const set = open.filter(n => n.current != null), curAvg = set.length ? set.reduce((a, n) => a + n.current, 0) / set.length : null;
  return `<div class="kpis">
    <div class="tile"><div class="tlabel">Occupancy on the books</div><div class="tval">${Math.round(now.occupancy * 100)}%</div>
      ${delta(now.occupancy, ly?.occupancy, 'pts')}<div class="sub">${now.nights} of ${now.available} nights${f.lastYearFinal ? ` · last year finished at ${Math.round(f.lastYearFinal.occupancy * 100)}%` : ''}</div></div>
    <div class="tile"><div class="tlabel">Average daily rate</div><div class="tval">${now.adr != null ? money(now.adr) : '—'}</div>
      ${delta(now.adr, ly?.adr, 'pct')}<div class="sub">Booked nights in the next ${pr.win} days</div></div>
    <div class="tile"><div class="tlabel">RevPAR</div><div class="tval">${money(now.revpar)}</div>
      ${delta(now.revpar, ly?.revpar, 'pct')}<div class="sub">Revenue per available night</div></div>
    <div class="tile"><div class="tlabel">High-demand nights still open</div><div class="tval">${hot.length}</div>
      <div class="tdelta sub">of ${open.length} open night${open.length === 1 ? '' : 's'}${evs.size ? ` · ${evs.size} event${evs.size === 1 ? '' : 's'}` : ''}</div>
      <div class="sub">${recAvg != null ? `Recommended avg ${money(recAvg)}${curAvg != null ? ` · Beds24 avg ${money(curAvg)}` : ''}` : 'Fully booked'}</div></div></div>`;
}

function eventsPanel(P) {
  const S = P.scout, today = P.today, horizon = P.next90.at(-1)?.date || today;
  const sug = P.suggestions;
  const upcoming = P.events.filter(e => e.end_date >= today && e.start_date <= horizon);
  const scanLine = S.last ? (S.last.error ? `<span class="bad">Last scan failed: ${esc(S.last.error)}</span>`
    : `Last scan ${timeAgo(S.last.at)}: ${S.last.found} found, ${S.last.added} new${S.last.cost != null ? ` · about $${Math.max(0.01, S.last.cost).toFixed(2)}` : ''}`) : 'Not run yet.';
  return `<div class="card"><div class="toolbar" style="margin:0 0 8px"><h3 style="margin:0">Upcoming events</h3><span style="margin-left:auto"></span>
      ${S.aiReady ? `<button id="pscan" ${pr.scanning ? 'disabled' : ''}>${pr.scanning ? 'Searching the web…' : '🔎 Scan for events'}</button>` : ''}</div>
    ${S.aiReady ? `<div class="sub">${pr.scanning ? 'The event scout is searching official schedules and event calendars. This takes a minute or two.' : scanLine}</div>`
      : aiSetup('The event scout uses Claude with web search to find games, festivals, concerts and conferences near you and suggests price increases for them.')}
    ${S.last?.notes && !S.last.error ? `<div class="sub" style="margin-top:4px">${esc(S.last.notes)}</div>` : ''}
    ${sug.length ? `<div class="sugs">${sug.map(s => {
      const replaced = s.replaces_event_id && P.events.find(e => e.id === s.replaces_event_id);
      return `<div class="sug" data-sug="${s.id}"><div class="sdate"><b>${MONTHS[+s.start_date.slice(5, 7) - 1]}</b><span>${+s.start_date.slice(8)}</span></div>
        <div class="sbody"><div><b>${esc(s.name)}</b> <span class="impact"><span class="sw lv-${IMPACT_LEVEL[s.impact] || 'mid'}"></span>${IMPACT_LABEL[s.impact] || ''} impact</span>
          ${s.confidence === 'estimated' ? '<span class="warn">⚠ estimated date</span>' : s.confidence === 'confirmed' ? '<span class="sub">✓ confirmed</span>' : '<span class="sub">likely</span>'}</div>
          <div class="sub">${nightsLabel(s.start_date, s.end_date)}${s.city ? ` · ${esc(s.city)}` : ''}${s.category ? ` · ${esc(s.category)}` : ''}</div>
          ${replaced ? `<div class="sub">Corrects your event "${esc(replaced.name)}" (now ${nightsLabel(replaced.start_date, replaced.end_date)})</div>` : ''}
          ${s.evidence ? `<div class="sub">${esc(s.evidence)}${s.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</div>` : ''}
          <div class="toolbar" style="margin:6px 0 0"><label class="sub">Price <input type="number" class="spct" value="${replaced ? replaced.pct : s.pct}" style="width:5em">%</label>
            <label class="sub">Min stay <input type="number" class="smin" min="1" max="30" value="${(replaced ? replaced.min_stay : s.min_stay) || ''}" style="width:4em"></label>
            <button class="primary" data-sadd="${s.id}">${replaced ? 'Update event' : 'Add to pricing'}</button><button data-sdis="${s.id}">Dismiss</button></div></div></div>`;
    }).join('')}</div>` : ''}
    <div class="sub" style="margin:12px 0 4px"><b>Your events, next 90 days</b></div>
    ${upcoming.length ? `<ul class="list evlist">${upcoming.map(e => `<li><span><span class="evdot">●</span> ${esc(e.name)}</span><span class="sub">${nightsLabel(e.start_date, e.end_date)} · ${pctStr(e.pct)}</span></li>`).join('')}</ul>`
      : '<div class="empty">None in the next 90 days.</div>'}
    <details id="pscoutset" style="margin-top:8px"><summary class="sub">Scout settings</summary>
      <form id="pscoutform" class="stack" style="max-width:none;margin-top:8px">
        <label class="sub">Area to search<br><input name="area" value="${esc(S.customArea ? S.area : '')}" placeholder="${esc(S.defaultArea)}" style="width:100%" maxlength="200"></label>
        <div class="toolbar" style="margin:0"><label class="sub">Look ahead <input name="months" type="number" min="1" max="12" value="${S.months}" style="width:4em"> months</label>
          <label class="sub"><input name="auto" type="checkbox" ${S.auto ? 'checked' : ''}> Scan automatically every week</label><button>Save</button></div>
        <div class="sub">Each scan runs up to 12 web searches (about a cent each) plus Claude's time, typically well under $1. Nothing changes prices until you add an event.</div></form></details></div>`;
}

function signalsPanel(P) {
  const G = P.signals || { asked: [], pickup: [] };
  const seen = new Set(), asked = G.asked.filter(a => !seen.has(a.booking_id) && seen.add(a.booking_id));
  return `<div class="card"><h3>Demand signals</h3>
    <div class="sub">Guests asking about dates and stays booked unusually early both point to demand. Each nudges those nights up ${P.settings.demand === false ? '(switched off under Pricing rules)' : `${P.settings.demandStepPct}%, up to ${P.settings.demandMax}%`}.</div>
    <div class="sub" style="margin:10px 0 4px"><b>Guests asking</b> <span class="sub">(inquiries and booking requests, last 45 days)</span></div>
    ${asked.length ? `<ul class="list">${asked.map(a => `<li><span>${nightsLabel(a.arrival, addDaysISO(a.departure, -1))} ${tag(a.channel || 'Other')}</span><span class="sub">${a.kind === 'request' ? 'Request' : 'Inquiry'} · ${timeAgo(a.seen_at)}</span></li>`).join('')}</ul>`
      : '<div class="empty">None right now. Inquiries that didn\'t book still count here.</div>'}
    <div class="sub" style="margin:10px 0 4px"><b>Booked unusually early</b> <span class="sub">(${G.usualLead ? `usually ${G.usualLead.days} days ahead${G.usualLead.assumed ? ', assumed until there\'s more history' : ''}` : ''})</span></div>
    ${G.pickup.length ? `<ul class="list">${G.pickup.map(b => `<li><span>${nightsLabel(b.arrival, addDaysISO(b.departure, -1))} ${tag(b.channel || 'Other')}</span><span class="sub">${b.lead} days ahead</span></li>`).join('')}</ul>`
      : '<div class="empty">Nothing unusual in the last 60 days.</div>'}</div>`;
}

async function pricingView() {
  const today = todayISO();
  pr.month ||= today.slice(0, 8) + '01';
  const live = stamp('pricing');
  const P = await api('/pricing?' + q({ start: pr.month, days: 62, ...(pr.room && { room: pr.room }) }));
  if (!live()) return;
  if (!P.room) { view.innerHTML = `<div class="card empty">${P.connected === false ? 'Connect Beds24 in Settings first.' : 'No rooms found in Beds24 yet.'}</div>`; return; }
  pr.room = P.room.id;
  const S = P.settings, byDate = Object.fromEntries(P.nights.map(n => [n.date, n]));
  const notice = !P.connected ? 'Connect Beds24 in Settings to apply prices.' : !P.canWrite ? 'Your Beds24 invite code can\'t change prices. Create one with write access to Inventory and paste it in Settings.' : '';

  const monthGrid = m => {
    const first = new Date(m + 'T00:00:00Z'), len = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    let cells = Array.from({ length: first.getUTCDay() }, () => '<div class="day pad"></div>').join('');
    for (let i = 1; i <= len; i++) {
      const date = m.slice(0, 8) + String(i).padStart(2, '0'), n = byDate[date];
      if (!n) { cells += `<div class="day past"><div class="n">${i}</div></div>`; continue; }
      const lv = n.demand ? `lv-${n.demand.level}` : '';
      if (n.booked || n.blocked) {
        cells += `<div class="day dday ${n.blocked ? 'blocked' : 'booked'}" data-tip="${date}" tabindex="0"><div class="n">${i}</div><div class="m">${n.blocked ? 'Blocked' : 'Booked'}</div></div>`;
        continue;
      }
      const up = n.current != null && n.price > n.current, down = n.current != null && n.price < n.current;
      cells += `<div class="day dday pday ${lv} ${pr.selected === date ? 'sel' : ''}" data-pdate="${date}" data-tip="${date}" tabindex="0">
        <div class="n">${i}${n.event ? ' <span class="evdot" aria-label="event">●</span>' : ''}${n.gap ? ' <span class="gapb">gap</span>' : ''}</div>
        <div class="p">${money(n.price)}</div>
        <div class="m">${n.current == null ? 'not set' : up || down ? `${up ? '▲' : '▼'} now ${money(n.current)}` : '✓ set'}</div></div>`;
    }
    return `<div class="month"><h4>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h4>
      <div class="mgrid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div></div>`;
  };
  const legend = `<div class="dlegend"><span class="sub">Demand</span>${P.levels.slice().reverse().map(l => `<span><span class="sw lv-${l.key}"></span>${l.label}</span>`).join('')}
    <span><span class="sw booked"></span>Booked</span><span><span class="evdot">●</span> Event</span></div>`;
  const sel = pr.selected && byDate[pr.selected];
  const pendRow = (label, p, days) => p ? `<tr><td>${label}</td><td>${p.nights ? `<b>${p.nights}</b> night${p.nights === 1 ? '' : 's'}` : '<span class="ok">Up to date</span>'}</td>
    <td class="sub">${p.nights ? `avg ${p.avgNow != null ? money(p.avgNow) : 'not set'} → ${money(p.avgNew)}` : ''}</td>
    <td>${p.nights ? `<button data-apply="${days}" ${P.canWrite ? '' : 'disabled'}>Apply</button>` : ''}</td></tr>` : '';
  const paceRows = Object.entries(P.pace).slice(0, 6).map(([m, v]) => `<tr><td>${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</td><td>${Math.round(v.now * 100)}%</td>
    <td>${v.lastYear == null ? '<span class="sub">no history</span>' : Math.round(v.lastYear * 100) + '%'}</td>
    <td>${v.lastYear == null || !S.pacing ? '–' : (() => { const a = Math.max(-S.pacingMax, Math.min(S.pacingMax, (v.now - v.lastYear) * 25)); return Math.abs(a) >= 1 ? pctStr(a) : '0%'; })()}</td></tr>`).join('');
  const tableRows = P.next90.map(n => `<tr><td>${dayLabel(n.date)}</td><td>${n.booked ? 'Booked' : n.blocked ? 'Blocked' : money(n.price)}</td>
    <td>${n.current != null ? money(n.current) : '—'}</td><td>${LEVEL_LABEL[n.level] || '—'}${n.score != null ? ` (${n.score})` : ''}</td><td>${esc(n.event || '')}</td></tr>`).join('');

  view.innerHTML = `${notice ? `<div class="notice">${notice}</div>` : ''}${P.error ? `<div class="notice">Auto-pricing problem: ${esc(P.error)}</div>` : ''}
  <div class="toolbar pfilters">${P.rooms.length > 1 ? `<select id="proom" aria-label="Room">${P.rooms.map(r => `<option value="${r.id}" ${r.id === P.room.id ? 'selected' : ''}>${esc(r.property_name)} · ${esc(r.name)}</option>`).join('')}</select>` : `<b>${esc(P.room.property_name)}</b>`}
    <div class="seg" role="group" aria-label="Window">${[30, 60, 90].map(d => `<button data-win="${d}" class="${pr.win === d ? 'on' : ''}" aria-pressed="${pr.win === d}">Next ${d} days</button>`).join('')}</div></div>
  ${P.needsBase ? `<div class="card stack" style="max-width:620px;margin-bottom:14px"><h3>Start here</h3>
    <div>Set a <b>base price</b>: your normal weeknight rate before any adjustments. Everything else builds on it.</div>
    <div class="sub">Not sure? <b>Suggest from my history</b> works it out from your past stays (including the Guesty import).</div></div>` : kpiTiles(P)}
  <div class="rates">
    <div class="stack" style="max-width:none">
    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Demand calendar</h3><span style="margin-left:auto"></span><button id="pprev" aria-label="Previous month">‹</button><button id="ptoday">Today</button><button id="pnext" aria-label="Next month">›</button></div>
      ${P.needsBase ? '<div class="empty">Recommendations appear once a base price is set.</div>' : `${legend}<div class="months">${[pr.month, addMonths(pr.month, 1)].map(monthGrid).join('')}</div>
      <div class="sub">Each night shows the recommended price; ▲▼ = Beds24 has a different price now. Click a night to see why.</div>`}
    </div>
    ${P.needsBase ? '' : `<div class="card"><div class="toolbar" style="margin:0 0 4px"><h3 style="margin:0">Next 90 nights: price and demand</h3>
      <div class="plegend"><span><span class="lk rec"></span>Recommended</span><span><span class="lk now"></span>In Beds24 now</span></div></div>
      <div id="pchart" class="pchart"></div>
      <div class="sub">Lines break on booked nights. The strip underneath is demand for each night (same colors as the calendar); dots above it mark events.</div>
      <details id="ptable" ${pr.open.table ? 'open' : ''}><summary class="sub">Show as a table</summary><div class="tscroll"><table class="pv"><tr><th>Night</th><th>Recommended</th><th>Beds24 now</th><th>Demand</th><th>Event</th></tr>${tableRows}</table></div></details></div>`}
    </div>
    <div class="stack" style="max-width:none">
      ${sel ? `<div class="card"><h3>${new Date(sel.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</h3>
        ${sel.demand ? `<div class="toolbar" style="margin:0 0 6px"><span class="sw lv-${sel.demand.level}"></span><b>${LEVEL_LABEL[sel.demand.level]} demand</b><span class="sub">${sel.demand.score}/100</span></div>
        <table class="pv">${sel.demand.parts.map(p => `<tr><td class="sub">${esc(p.label)}</td><td style="text-align:right" class="sub">${p.points > 0 && p !== sel.demand.parts[0] ? '+' : ''}${p.points}</td></tr>`).join('')}</table><hr>` : ''}
        <table class="pv">${sel.factors.map(f => `<tr><td>${esc(f.label)}</td><td style="text-align:right">${f.value != null ? money(f.value) : pctStr(f.pct)}</td></tr>`).join('')}
        ${sel.notes.map(n => `<tr><td colspan="2" class="sub">${esc(n)}</td></tr>`).join('')}
        <tr><td><b>Recommended</b></td><td style="text-align:right"><b>${money(sel.price)}</b></td></tr>
        <tr><td>In Beds24 now</td><td style="text-align:right">${sel.current != null ? money(sel.current) : '—'}</td></tr>
        <tr><td>Minimum stay</td><td style="text-align:right">${sel.minStay} night${sel.minStay === 1 ? '' : 's'}${sel.currentMinStay != null && sel.currentMinStay !== sel.minStay ? ` <span class="sub">(now ${sel.currentMinStay})</span>` : ''}</td></tr></table></div>` : ''}
      ${eventsPanel(P)}
    </div></div>

  <div class="cols" style="margin-top:14px">
    ${signalsPanel(P)}
    <div class="card"><h3>Booking pace</h3><table class="pv"><tr><th>Month</th><th>Now</th><th>Last year</th><th>Adjust</th></tr>${paceRows}</table>
      <div class="sub">Compares how full each month is today with how full it was a year ago today. Ahead of last year → prices up; behind → down.</div></div>
    ${P.pending ? `<div class="card"><h3>Apply to Beds24</h3><table class="pv">
      ${pendRow('Next 30 days', P.pending.d30, 30)}${pendRow('Next 90 days', P.pending.d90, 90)}${pendRow('Next 12 months', P.pending.d365, 365)}</table>
      <label class="sub"><input type="checkbox" id="pmin" checked> Also set minimum stays (events and gap nights)</label>
      <div class="sub">Only unbooked, unblocked nights change. Each save is checked against Beds24 afterwards and logged on the Rates page.</div>
      <hr><label><input type="checkbox" id="pauto" ${S.auto ? 'checked' : ''}> <b>Auto-pricing</b>: apply recommendations every day</label>
      <div class="sub">Next ${S.autoHorizon} days, only where the price differs by $${S.autoThreshold}+, never more than ${S.autoMaxChangePct}% in one day.${P.lastAuto ? ` Last run ${fmtDate(P.lastAuto)}.` : ''}</div></div>` : ''}
    ${P.needsBase ? '' : `<div class="card"><h3>✨ AI pricing review</h3>${status.ai ? `
      <div class="toolbar" style="margin:0 0 6px"><button id="paireview" ${pr.ai.busy ? 'disabled' : ''}>Review next 90 days</button>${sel ? `<button id="painight" ${pr.ai.busy ? 'disabled' : ''}>Explain ${fmtDate(sel.date)}</button>` : ''}</div>
      <form id="paiform" class="toolbar" style="margin:0"><input name="q" placeholder="Or ask, e.g. Is my weekend premium too low?" style="flex:1;min-width:0" maxlength="1000"><button ${pr.ai.busy ? 'disabled' : ''}>Ask</button></form>
      <div id="paiout" class="aianswer">${pr.ai.html}</div><div class="sub">Advice only: nothing changes in Beds24 unless you apply it.</div>`
      : aiSetup('Get a second opinion on these prices, or ask why a night is priced the way it is.')}</div>`}
  </div>

  <details class="card" id="psettings" style="margin-top:14px" ${pr.open.settings || P.needsBase ? 'open' : ''}><summary><b>Pricing rules</b></summary>
    <form id="psform" class="stack" style="max-width:none;margin-top:10px">
      <div class="toolbar" style="margin:0">
        <label class="sub">Base price ($)<br><input name="base" type="number" min="10" value="${S.base ?? ''}" required style="width:7em"></label>
        <label class="sub">Never below ($)<br><input name="min" type="number" min="10" value="${S.min ?? ''}" style="width:7em"></label>
        <label class="sub">Never above ($)<br><input name="max" type="number" min="10" value="${S.max ?? ''}" style="width:7em"></label>
        <label class="sub">Round to ($)<br><input name="rounding" type="number" min="1" max="50" value="${S.rounding}" style="width:5em"></label>
        <label class="sub">Usual minimum stay<br><input name="minStay" type="number" min="1" max="30" value="${S.minStay}" style="width:5em"></label></div>
      <div class="sub">Day of week</div><div class="pctgrid">${DOWS.map((d, i) => `<label>${d}<input name="dow${i}" type="number" step="1" value="${S.dow[i]}">%</label>`).join('')}</div>
      <div class="sub">Month (season)</div><div class="pctgrid">${MONTHS.map((m, i) => `<label>${m}<input name="season${i}" type="number" step="1" value="${S.season[i]}">%</label>`).join('')}</div>
      <div class="toolbar" style="margin:0">
        <label class="sub">Last-minute: up to <input name="lastMinutePct" type="number" max="0" value="${S.lastMinutePct}" style="width:5em">% off, starting <input name="lastMinuteDays" type="number" min="0" value="${S.lastMinuteDays}" style="width:4em"> days out</label>
        <label class="sub">Far ahead: <input name="farOutPct" type="number" min="0" value="${S.farOutPct}" style="width:4em">% more, beyond <input name="farOutDays" type="number" min="14" value="${S.farOutDays}" style="width:5em"> days</label></div>
      <div class="toolbar" style="margin:0">
        <label class="sub"><input name="pacing" type="checkbox" ${S.pacing ? 'checked' : ''}> Adjust for booking pace, up to ±<input name="pacingMax" type="number" min="0" max="30" value="${S.pacingMax}" style="width:4em">%</label>
        <label class="sub">Gap nights: <input name="gapPct" type="number" max="0" value="${S.gapPct}" style="width:5em">%</label></div>
      <div class="toolbar" style="margin:0">
        <label class="sub"><input name="demand" type="checkbox" ${S.demand !== false ? 'checked' : ''}> Demand signals: +<input name="demandStepPct" type="number" min="0" max="25" value="${S.demandStepPct}" style="width:4em">% per inquiry or early booking nearby, up to <input name="demandMax" type="number" min="0" max="50" value="${S.demandMax}" style="width:4em">%</label></div>
      <div class="toolbar" style="margin:0"><span class="sub">Auto-pricing:</span>
        <label class="sub">next <input name="autoHorizon" type="number" min="7" max="365" value="${S.autoHorizon}" style="width:5em"> days</label>
        <label class="sub">only if off by $<input name="autoThreshold" type="number" min="0" value="${S.autoThreshold}" style="width:4em">+</label>
        <label class="sub">max <input name="autoMaxChangePct" type="number" min="5" max="100" value="${S.autoMaxChangePct}" style="width:4em">% change per day</label></div>
      <div class="toolbar" style="margin:0"><button class="primary">Save rules</button><button type="button" id="psuggest">Suggest from my history</button><span class="sub" id="psuggestout"></span></div>
    </form></details>

  <details class="card" id="pevents" style="margin-top:14px" ${pr.open.events ? 'open' : ''}><summary><b>All events</b> <span class="sub">(${P.events.filter(e => e.end_date >= P.today).length}) · edit, add or delete</span></summary>
    <div style="overflow-x:auto;margin-top:10px"><table><tr><th>Event</th><th>Nights</th><th>Price</th><th>Min stay</th><th>Source</th><th></th></tr>
    ${P.events.filter(e => e.end_date >= P.today).map(e => `<tr><td>${esc(e.name)}</td><td>${nightsLabel(e.start_date, e.end_date)}</td>
      <td>${pctStr(e.pct)}</td><td>${e.min_stay || '–'}</td><td class="sub">${/estimated/.test(e.source || '') ? `<span class="warn">⚠ ${esc(e.source)}</span>` : esc(e.source || '')}</td>
      <td><a href="#" data-eedit="${e.id}">edit</a> · <a href="#" data-edel="${e.id}">delete</a></td></tr>`).join('')}</table></div>
    <form id="peform" class="toolbar" style="margin-top:10px"><input type="hidden" name="id">
      <input name="name" placeholder="Event name" size="22"><label class="sub">First night <input type="date" name="start_date"></label>
      <label class="sub">Last night <input type="date" name="end_date"></label><label class="sub"><input name="pct" type="number" style="width:5em" placeholder="+%"> %</label>
      <label class="sub">Min stay <input name="min_stay" type="number" min="1" max="30" style="width:4em"></label><button class="primary">Save event</button></form>
    <div class="sub">Game weekends are usually the Friday and Saturday nights. The event scout finds new schedules as they're published.</div></details>`;

  // The chart is drawn to the card's width (and again if the window is resized).
  const chartBox = $('#pchart');
  if (chartBox) {
    priceChart(chartBox, P.next90);
    let t; window.onresize = () => { clearTimeout(t); t = setTimeout(() => { if ($('#pchart') === chartBox) priceChart(chartBox, P.next90); }, 150); };
  }
  view.querySelectorAll('[data-tip]').forEach(el => {
    const n = byDate[el.dataset.tip];
    const show = () => { const r = el.getBoundingClientRect(); showTip(r.left + r.width / 2, r.top, [
      [dayLabel(n.date), ''], ...(n.booked ? [['Booked', '']] : n.blocked ? [['Blocked', '']] : [[money(n.price), 'recommended'], [n.current != null ? money(n.current) : '—', 'in Beds24 now']]),
      ...(n.demand ? [[`${LEVEL_LABEL[n.demand.level]} demand`, `(${n.demand.score}/100)`]] : []), ...(n.event ? [[n.event, '']] : [])]); };
    el.onpointerenter = show; el.onfocus = show; el.onpointerleave = hideTip; el.onblur = hideTip;
  });
  view.querySelectorAll('[data-win]').forEach(b => b.onclick = () => { pr.win = +b.dataset.win; pricingView(); });
  const go = m => { pr.month = m; pricingView(); };
  if ($('#pprev')) { $('#pprev').onclick = () => go(addMonths(pr.month, -1)); $('#pnext').onclick = () => go(addMonths(pr.month, 1)); $('#ptoday').onclick = () => go(today.slice(0, 8) + '01'); }
  if ($('#proom')) $('#proom').onchange = e => { pr.room = +e.target.value; pr.selected = null; pr.ai = { busy: false, html: '' }; pricingView(); };
  view.querySelectorAll('[data-pdate]').forEach(el => {
    // The page redraws around the chosen night; after Enter the keyboard user's place is put back on it.
    const pick = key => { hideTip(); const d = el.dataset.pdate; pr.selected = pr.selected === d ? null : d; pricingView().then(() => key && view.querySelector(`[data-pdate="${d}"]`)?.focus({ preventScroll: true })); };
    el.onclick = () => pick(false); el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(true); } };
  });
  $('#psettings').ontoggle = e => { pr.open.settings = e.target.open; };
  $('#pevents').ontoggle = e => { pr.open.events = e.target.open; };
  if ($('#ptable')) $('#ptable').ontoggle = e => { pr.open.table = e.target.open; };
  // Event scout: a scan takes a minute or two; the page stays usable meanwhile.
  if ($('#pscan')) $('#pscan').onclick = async () => {
    if (pr.scanning) return;
    pr.scanning = true; $('#pscan').disabled = true;   // before anything is awaited: a second tap must not start a second scan
    pricingView();
    try {
      const r = await api('/pricing/scout', { method: 'POST' });
      banner(r.added ? `Found ${r.added} new event${r.added === 1 ? '' : 's'} to review.` : `No new events found (${r.found} checked).`, 'ok');
    } catch (err) { if (err.message !== 'login') banner(err.message, true); }
    pr.scanning = false;
    if (location.hash === '#/pricing') pricingView();
  };
  view.querySelectorAll('[data-sadd]').forEach(b => b.onclick = () => {
    const box = b.closest('.sug');
    act(() => api('/pricing/suggestions/add', { method: 'POST', body: { id: +b.dataset.sadd, pct: box.querySelector('.spct').value, min_stay: box.querySelector('.smin').value } }));
  });
  view.querySelectorAll('[data-sdis]').forEach(b => b.onclick = () => act(() => api('/pricing/suggestions/dismiss', { method: 'POST', body: { id: +b.dataset.sdis } })));
  const sf = $('#pscoutform');
  if (sf) sf.onsubmit = e => { e.preventDefault(); act(() => api('/pricing/scout/settings', { method: 'POST', body: { area: sf.area.value, months: sf.months.value, auto: sf.auto.checked } })); };
  // AI review: the answer is kept in pr.ai so clicking around the calendar doesn't lose it.
  const aiAsk = async (body, label) => {
    if (pr.ai.busy) return;
    pr.ai = { busy: true, html: `<p class="sub">${esc(label)}: thinking…</p>` };
    view.querySelectorAll('#paireview, #painight, #paiform button').forEach(b => b.disabled = true);
    $('#paiout').innerHTML = pr.ai.html;
    const room = pr.room;
    let html;
    try {
      const r = await api('/ai/pricing', { method: 'POST', body: { roomId: room, ...body } });
      html = `<p class="sub"><b>${esc(label)}</b>${aiCost(r)}</p>${md(r.text)}`;
    } catch (err) { html = err.message === 'login' ? '' : `<span class="bad">${esc(err.message)}</span>`; }
    pr.ai = { busy: false, html: pr.room === room ? html : '' };
    if (location.hash === '#/pricing') pricingView();
  };
  if ($('#paireview')) $('#paireview').onclick = () => aiAsk({}, 'Review of the next 90 days');
  if ($('#painight')) $('#painight').onclick = () => aiAsk({ date: sel.date }, `About ${fmtDate(sel.date)}`);
  if ($('#paiform')) $('#paiform').onsubmit = e => { e.preventDefault(); const qn = e.target.q.value.trim(); if (qn) aiAsk({ question: qn, ...(sel && { date: sel.date }) }, qn); };
  view.querySelectorAll('[data-apply]').forEach(b => b.onclick = async () => {
    const days = +b.dataset.apply, p = P.pending[days === 30 ? 'd30' : days === 90 ? 'd90' : 'd365'];
    if (!confirm(`Send ${p.nights} night${p.nights === 1 ? '' : 's'} of recommended prices to Beds24?`)) return;
    b.disabled = true; b.textContent = 'Applying…';
    try {
      const r = await api('/pricing/apply', { method: 'POST', body: { roomId: pr.room, days, includeMinStay: $('#pmin').checked } });
      banner(`Applied ${r.applied} night${r.applied === 1 ? '' : 's'} to Beds24.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`, r.warnings.length ? '' : 'ok');
      await pricingView();
    } catch (err) { if (err.message !== 'login') banner(err.message, true); b.disabled = false; b.textContent = 'Apply'; }
  });
  if ($('#pauto')) $('#pauto').onchange = e => {
    if (e.target.checked && !confirm('Turn on auto-pricing? Every day, the app will send recommended prices for unbooked nights to Beds24, within the limits under Pricing rules.')) { e.target.checked = false; return; }
    act(() => api('/pricing/settings', { method: 'POST', body: { roomId: pr.room, auto: e.target.checked } }));
  };
  const f = $('#psform');
  f.onsubmit = e => {
    e.preventDefault();
    const v = n => f[n].value;
    act(() => api('/pricing/settings', { method: 'POST', body: {
      roomId: pr.room, base: v('base'), min: v('min'), max: v('max'), rounding: v('rounding'), minStay: v('minStay'),
      dow: DOWS.map((_, i) => +v('dow' + i)), season: MONTHS.map((_, i) => +v('season' + i)),
      lastMinutePct: v('lastMinutePct'), lastMinuteDays: v('lastMinuteDays'), farOutPct: v('farOutPct'), farOutDays: v('farOutDays'),
      pacing: f.pacing.checked, pacingMax: v('pacingMax'), gapPct: v('gapPct'),
      demand: f.demand.checked, demandStepPct: v('demandStepPct'), demandMax: v('demandMax'),
      autoHorizon: v('autoHorizon'), autoThreshold: v('autoThreshold'), autoMaxChangePct: v('autoMaxChangePct') } }));
  };
  $('#psuggest').onclick = async () => {
    let r;
    try { r = await api('/pricing/suggest', { method: 'POST', body: { roomId: pr.room } }); } catch (err) { return fail(err); }
    if (!r.enough) { $('#psuggestout').textContent = `Not enough history yet (${r.nights} nights; 20 needed).`; return; }
    f.base.value = r.base;
    r.season.forEach((v, i) => { f['season' + i].value = v; }); r.dow.forEach((v, i) => { f['dow' + i].value = v; });
    $('#psuggestout').textContent = `Filled in from ${r.nights} past nights (average ${money(r.adr)}/night). Review, then Save rules.`;
  };
  const ef = $('#peform');
  ef.onsubmit = e => {
    e.preventDefault();
    act(() => api('/pricing/events', { method: 'POST', body: { id: ef.id.value ? +ef.id.value : null, name: ef.name.value,
      start_date: ef.start_date.value, end_date: ef.end_date.value, pct: ef.pct.value, min_stay: ef.min_stay.value } }));
  };
  view.querySelectorAll('[data-eedit]').forEach(a => a.onclick = e => {
    e.preventDefault(); const ev = P.events.find(x => x.id === +a.dataset.eedit);
    ef.id.value = ev.id; ef.name.value = ev.name; ef.start_date.value = ev.start_date; ef.end_date.value = ev.end_date;
    ef.pct.value = ev.pct; ef.min_stay.value = ev.min_stay || ''; ef.name.focus();
  });
  view.querySelectorAll('[data-edel]').forEach(a => a.onclick = e => {
    e.preventDefault(); const ev = P.events.find(x => x.id === +a.dataset.edel);
    if (confirm(`Delete "${ev.name}"?`)) act(() => api('/pricing/events/delete', { method: 'POST', body: { id: ev.id } }));
  });
}

// ---------- Cleaning: turnovers and the Turno feed ----------
async function cleaningView() {
  const C = await api('/cleaning?' + q({ days: 45 }));
  const hrs = h => h == null ? '' : h >= 48 ? `${Math.floor(h / 24)} days` : `${Math.round(h * 10) / 10} hours`;
  const time = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  view.innerHTML = `<div class="card" style="overflow-x:auto"><h3>Upcoming turnovers (next 45 days)</h3>
    ${C.turnovers.length ? `<table><tr><th>Checkout</th><th>Leaving</th><th>Next guests</th><th>Time to clean</th>${C.feeds.length > 1 ? '<th>Room</th>' : ''}</tr>
    ${C.turnovers.map(t => `<tr class="${t.sameDay ? 'sameday' : ''}">
      <td><b>${new Date(t.checkout.departure + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}</b><div class="sub">by ${time(t.checkoutTime)}</div></td>
      <td>${esc(t.checkout.guest_name || 'Guest')} ${tag(t.checkout.channel)}</td>
      <td>${t.next ? `${esc(t.next.guest_name || 'Guest')} · ${(() => { const g = (t.next.adults || 0) + (t.next.children || 0); return g ? `${g} guest${g === 1 ? '' : 's'}` : 'guests ?'; })()}<div class="sub">arrive ${fmtDate(t.next.arrival)} from ${time(t.checkinTime)}</div>` : '<span class="sub">No booking yet</span>'}</td>
      <td>${t.sameDay ? `<span class="tag request">Same day</span> ${hrs(t.windowHours)}` : t.next ? hrs(t.windowHours) : '<span class="sub">open</span>'}</td>
      ${C.feeds.length > 1 ? `<td class="sub">${esc(t.room.name)}</td>` : ''}</tr>`).join('')}</table>` : '<div class="empty">No checkouts in the next 45 days.</div>'}</div>
  <div class="card stack" style="margin-top:14px;max-width:none"><h3>Turno</h3>
    <div>Turno creates a cleaning project at every checkout from a calendar link. Use this link instead of the Beds24 or Guesty one:
      it lists <b>real stays only</b> (blocked dates never create cleanings) and includes each stay's guest count. No guest names or contact details.</div>
    ${C.feeds.map(f => `<div class="toolbar" style="margin:0"><b>${esc(f.property_name)} · ${esc(f.name)}</b>
      <input readonly value="${esc(f.url)}" style="flex:1;min-width:220px" onclick="this.select()"><button data-copy="${esc(f.url)}">Copy</button></div>`).join('') || '<div class="empty">No rooms yet.</div>'}
    <ol class="sub" style="line-height:1.7;padding-left:18px;margin:0">
      <li>In Turno, open your property → <b>Calendar sync</b> (iCal) and remove the Guesty/Beds24 calendar link.</li>
      <li>Add the link above. Turno checks it regularly and creates a cleaning on each checkout day.</li>
      <li>Check Turno's schedule for the next few weeks matches the list above.</li></ol>
    <div class="sub">Keep the link private; anyone with it can see your booked dates. <a href="#" id="cregen">Make a new link</a> (the old one stops working; update Turno).</div>
    <div class="sub">Turno doesn't let other apps read cleaning status, so assignments and completion stay in the Turno app.</div></div>`;
  view.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.previousElementSibling.select(); }
  });
  $('#cregen').onclick = e => { e.preventDefault(); if (confirm('Make a new Turno link? The current link stops working until you update it in Turno.')) act(() => api('/cleaning/regenerate', { method: 'POST' })); };
}

// ---------- Automations: scheduled guest messages ----------
const am = { editing: null, previewBooking: null };
const ANCHOR_LABELS = { booked: 'After a booking is made', cancelled: 'After a booking is cancelled', dates_changed: 'After a booking\'s dates change',
  arrival: 'Before / on / after check-in day', departure: 'Before / on / after checkout day' };
const CHANNEL_LIST = ['Airbnb', 'Booking.com', 'VRBO', 'Direct', 'Other'];

async function automationsView() {
  const live = stamp('automations');
  const A = await api('/automations');
  if (!live()) return;
  const sendTag = st => ({ sent: '<span class="ok">✓ sent</span>', failed: '<span class="bad">✗ failed</span>', waiting: '<span class="warn">⏳ waiting</span>',
    pending: '<span class="sub">pending</span>', skipped: '<span class="sub">skipped</span>', scheduled: '<span class="sub">scheduled</span>' })[st] || esc(st);
  const vars = [...A.builtins, ...new Set(A.properties.flatMap(p => Object.keys(p.vars)))];
  const editor = a => {
    const timed = ['arrival', 'departure'].includes(a.anchor);
    return `<form class="stack amform" data-form="${a.id || 'new'}" style="max-width:none;margin-top:10px">
      <input name="name" value="${esc(a.name || '')}" placeholder="Name, e.g. Wi-Fi details" aria-label="Automation name">
      <div class="toolbar" style="margin:0"><select name="anchor" aria-label="When">${Object.entries(ANCHOR_LABELS).map(([k, l]) => `<option value="${k}" ${a.anchor === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="timed" ${timed ? '' : 'hidden'}><input type="number" name="days" min="0" max="30" value="${Math.abs(a.offset_days || 0)}" style="width:4em" aria-label="Days"> day(s)
          <select name="dir" aria-label="Before or after"><option value="-1" ${(a.offset_days || 0) < 0 ? 'selected' : ''}>before</option><option value="1" ${(a.offset_days || 0) > 0 ? 'selected' : ''}>after</option></select>
          at <input type="time" name="at_time" value="${a.at_time || '10:00'}" aria-label="Time of day"></span>
        <span class="event" ${timed ? 'hidden' : ''}>wait <input type="number" name="delay" min="0" max="1440" value="${a.delay_minutes ?? 5}" style="width:5em" aria-label="Minutes to wait"> minutes</span></div>
      <div class="toolbar" style="margin:0"><span class="sub">Channels:</span>${CHANNEL_LIST.map(c => `<label class="sub"><input type="checkbox" name="ch" value="${c}" ${!a.channels || a.channels.includes(c) ? 'checked' : ''}> ${c}</label>`).join('')}
        <label class="sub">Only stays of at least <input type="number" name="min_nights" min="1" max="60" value="${a.min_nights || ''}" style="width:4em"> nights</label></div>
      <textarea name="body" rows="6" maxlength="5000" aria-label="Message">${esc(a.body || '')}</textarea>
      <div class="chips">${vars.map(v => `<button type="button" class="chip" data-var="${v}">{${v}}</button>`).join('')}</div>
      <div class="toolbar" style="margin:0"><select name="pb" aria-label="Preview with a booking"><option value="">Preview with a booking…</option>${A.bookings.map(b => `<option value="${b.id}">${esc(b.guest_name || 'Guest')} · ${fmtDate(b.arrival)}</option>`).join('')}</select>
        <button class="primary">Save</button><button type="button" data-cancel>Cancel</button></div>
      <div class="pvbox" hidden></div></form>`;
  };
  view.innerHTML = `${!A.connected ? '<div class="notice">Connect Beds24 in Settings; messages are sent through it.</div>' : ''}
    ${A.error ? `<div class="notice">Automations problem: ${esc(A.error)}</div>` : ''}
    <div class="notice" style="background:var(--bg);color:var(--ink);border:1px solid var(--line)">Turn these on <b>on switch day</b>, after Beds24 is connected to your channels and has synced.
      Don't also set up the same messages as Beds24 Auto Actions (guests would get them twice). Switching an automation on never sends a backlog: only messages due from then on.</div>
    <div class="cols">
      <div class="card"><h3>Automations</h3>
        ${A.automations.map(a => `<div class="auto ${a.enabled ? 'on' : ''}">
          <label class="switch"><input type="checkbox" data-toggle="${a.id}" ${a.enabled ? 'checked' : ''}><span></span></label>
          <div style="flex:1;min-width:0"><b>${esc(a.name)}</b><div class="sub">${esc(a.when)}${a.channels ? ' · ' + a.channels.join(', ') : ''}${a.min_nights ? ` · ${a.min_nights}+ nights` : ''}</div>
            ${am.editing === a.id ? editor(a) : `<div class="sub snip2">${esc(a.body.slice(0, 120))}${a.body.length > 120 ? '…' : ''}</div>`}</div>
          ${am.editing === a.id ? '' : `<div><a href="#" data-edit="${a.id}">edit</a> · <a href="#" data-del="${a.id}">delete</a></div>`}</div>`).join('')}
        ${am.editing === 'new' ? `<div class="auto"><div style="flex:1">${editor({ anchor: 'arrival', offset_days: -1, at_time: '10:00' })}</div></div>` : '<button id="anew" style="margin-top:8px">+ New automation</button>'}
      </div>
      <div class="stack" style="max-width:none">
        <div class="card" style="overflow-x:auto"><h3>Coming up (14 days)</h3>${A.upcoming.length ? `<table class="pv"><tr><th>When</th><th>Message</th><th>Guest</th><th></th></tr>${A.upcoming.map(u => `<tr>
          <td>${new Date(u.when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: A.tz })}</td><td>${esc(u.automation)}${u.missing.length ? `<div class="warn sub">needs {${u.missing.join('}, {')}}</div>` : ''}</td>
          <td>${esc(u.guest || 'Guest')}</td><td><a href="#" data-pv="${encodeURIComponent(u.preview)}">preview</a> · <a href="#" data-skip="${u.automationId}:${u.bookingId}">skip</a></td></tr>`).join('')}</table>`
          : '<div class="empty">Nothing scheduled. Switch on an automation to see what it will send.</div>'}</div>
        <div class="card" style="overflow-x:auto"><h3>Recently</h3>${A.history.length ? `<table class="pv"><tr><th>Time</th><th>Message</th><th>Guest</th><th>Status</th></tr>${A.history.slice(0, 25).map(h => `<tr>
          <td>${h.updated_at ? new Date(h.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: A.tz }) : ''}</td><td>${esc(h.automation)}</td>
          <td>${esc(h.guest_name || '')}</td><td>${sendTag(h.status)}${h.error ? `<div class="sub">${esc(h.error)}</div>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No automated messages yet.</div>'}</div>
        <div class="card"><h3>Property details</h3><div class="sub">Your own fill-ins for messages, e.g. <code>{wifi_password}</code>. Built in: ${A.builtins.map(b => `<code>{${b}}</code>`).join(' ')}</div>
          ${A.properties.map(p => `<form class="stack pvars" data-prop="${p.id}" style="max-width:none;margin-top:8px"><b>${esc(p.name)}</b>
            ${[...Object.entries(p.vars), ['', ''], ['', '']].map(([k, v]) => `<div class="toolbar" style="margin:0"><input name="k" value="${esc(k)}" placeholder="name, e.g. wifi_name" aria-label="Fill-in name" style="width:12em"><input name="v" value="${esc(v)}" placeholder="value" aria-label="Fill-in value" style="flex:1;min-width:120px"></div>`).join('')}
            <button class="primary">Save details</button></form>`).join('')}</div>
      </div></div>`;

  view.querySelectorAll('[data-toggle]').forEach(t => t.onchange = () => {
    const a = A.automations.find(x => x.id === +t.dataset.toggle);
    if (t.checked && !confirm(`Turn on "${a.name}"? It will send ${a.when} to every matching guest from now on.`)) { t.checked = false; return; }
    act(() => api('/automations/enable', { method: 'POST', body: { id: a.id, enabled: t.checked } }));
  });
  view.querySelectorAll('[data-edit]').forEach(l => l.onclick = e => { e.preventDefault(); am.editing = +l.dataset.edit; automationsView(); });
  view.querySelectorAll('[data-del]').forEach(l => l.onclick = e => {
    e.preventDefault(); const a = A.automations.find(x => x.id === +l.dataset.del);
    if (confirm(`Delete "${a.name}"?`)) act(() => api('/automations/delete', { method: 'POST', body: { id: a.id } }));
  });
  if ($('#anew')) $('#anew').onclick = () => { am.editing = 'new'; automationsView(); };
  view.querySelectorAll('[data-skip]').forEach(l => l.onclick = e => {
    e.preventDefault(); const [automationId, bookingId] = l.dataset.skip.split(':').map(Number);
    if (confirm('Skip this message for this guest?')) act(() => api('/automations/skip', { method: 'POST', body: { automationId, bookingId } }));
  });
  view.querySelectorAll('[data-pv]').forEach(l => l.onclick = e => { e.preventDefault(); alert(decodeURIComponent(l.dataset.pv)); });
  view.querySelectorAll('form.amform').forEach(f => {
    const sync = () => { const timed = ['arrival', 'departure'].includes(f.anchor.value); f.querySelector('.timed').hidden = !timed; f.querySelector('.event').hidden = timed; };
    f.anchor.onchange = sync;
    // Insert fill-ins where the cursor last was (clicking a chip takes focus away from the message box).
    let pos = f.body.value.length;
    const remember = () => { pos = f.body.selectionStart; };
    f.body.onkeyup = remember; f.body.onclick = remember; f.body.onblur = remember;
    f.querySelectorAll('[data-var]').forEach(b => b.onclick = () => {
      const t = f.body, v = `{${b.dataset.var}}`;
      t.setRangeText(v, pos, pos, 'end'); pos += v.length; t.focus();
    });
    f.querySelector('[data-cancel]').onclick = () => { am.editing = null; automationsView(); };
    const preview = async () => {
      const box = f.querySelector('.pvbox');
      if (!f.pb.value) { box.hidden = true; return; }
      let r;
      try { r = await api('/automations/preview', { method: 'POST', body: { body: f.body.value, bookingId: +f.pb.value } }); } catch (err) { return fail(err); }
      box.hidden = false;
      box.innerHTML = `<div class="bubble" style="white-space:pre-wrap">${esc(r.text)}</div>${r.missing.length ? `<div class="warn sub">Not filled in yet: {${r.missing.join('}, {')}}. A message waits until these are available.</div>` : ''}`;
    };
    f.pb.onchange = preview;
    f.onsubmit = e => {
      e.preventDefault();
      const timed = ['arrival', 'departure'].includes(f.anchor.value);
      const id = f.dataset.form === 'new' ? null : +f.dataset.form;
      act(async () => {
        await api('/automations', { method: 'POST', body: { id, name: f.name.value, anchor: f.anchor.value, body: f.body.value,
          offset_days: timed ? Number(f.days.value) * Number(f.dir.value) : 0, at_time: timed ? f.at_time.value : null, delay_minutes: timed ? 0 : Number(f.delay.value),
          channels: [...f.querySelectorAll('[name=ch]:checked')].map(x => x.value), min_nights: f.min_nights.value } });
        am.editing = null;
      });
    };
  });
  view.querySelectorAll('form.pvars').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const ks = [...f.querySelectorAll('[name=k]')], vs = [...f.querySelectorAll('[name=v]')];
    const vars = Object.fromEntries(ks.map((k, i) => [k.value.trim(), vs[i].value]).filter(([k, v]) => k || v.trim()));
    act(() => api('/property-vars', { method: 'POST', body: { propertyId: +f.dataset.prop, vars } }));
  });
}

// ---------- Listing editor ----------
const ls = { property: null, edited: null };
const fieldInput = (f, val, name) => {
  const v = val ?? '';
  if (f.type === 'select') return `<select name="${name}"><option value=""></option>${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  if (f.type === 'textarea') return `<textarea name="${name}" rows="${f.max > 5000 ? 8 : 4}" maxlength="${f.max}" data-count="${f.max}" data-ai="${f.key}">${esc(v)}</textarea>`;
  if (f.type === 'int' || f.type === 'money') return `<input name="${name}" type="number" step="${f.type === 'money' ? '0.01' : '1'}" min="${f.min}" max="${f.max}" value="${esc(v)}" style="width:9em">`;
  return `<input name="${name}" value="${esc(v)}" maxlength="${f.max || 200}" data-count="${f.max || 200}" ${f.key === 'headline' || f.key === 'contentHeadline' ? `data-ai="${f.key}"` : ''}>`;
};
const fieldRow = (f, val, name) => `<label class="lfield"><span class="sub">${esc(f.label)}${f.hint ? ` <span class="hint">· ${esc(f.hint)}</span>` : ''}</span>${fieldInput(f, val, name)}<span class="sub count"></span></label>`;

async function listingView() {
  const live = stamp('listing');
  const L = await api('/listing?' + new URLSearchParams(ls.property ? { property: ls.property } : {}));
  if (!live()) return;
  if (!L.connected) { view.innerHTML = '<div class="card empty">Connect Beds24 in Settings to edit your listing.</div>'; return; }
  if (!L.listing) { view.innerHTML = '<div class="card empty">No properties found in Beds24 yet.</div>'; return; }
  ls.property = L.listing.id;
  const x = L.listing, F = L.fields;
  view.innerHTML = `${L.canWrite === false ? '<div class="notice">Your Beds24 invite code can read but not change listing content. Create one with write access to <b>Properties</b> and paste it in Settings.</div>' : ''}
    <div class="notice" style="background:var(--bg);color:var(--ink);border:1px solid var(--line)">This edits your listing content in Beds24. Whether a change reaches Airbnb, VRBO or Booking.com depends on each channel's content settings in Beds24 (Booking.com content is usually managed in its own extranet). Photos and amenities are managed in Beds24.</div>
    <form id="lform">
      <div class="card stack" style="max-width:none"><div class="toolbar" style="margin:0">
        ${L.properties.length > 1 ? `<select id="lprop" aria-label="Property">${L.properties.map(p => `<option value="${p.id}" ${p.id === x.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : `<h3 style="margin:0">${esc(x.property.name)}</h3>`}
        <span class="sub" style="margin-left:auto">Changes are previewed before anything is sent.</span></div>
        <h3>Listing text</h3>${F.propertyText.map(f => fieldRow(f, x.propertyText[f.key], `pt.${f.key}`)).join('')}
        <h3>Property details</h3><div class="lgrid">${F.property.map(f => fieldRow(f, x.property[f.key], `p.${f.key}`)).join('')}</div></div>
      ${x.rooms.map((r, i) => `<div class="card stack" style="max-width:none;margin-top:14px"><h3>Room: ${esc(r.name || r.id)}</h3>
        <div class="lgrid">${F.room.map(f => fieldRow(f, r[f.key], `r${i}.${f.key}`)).join('')}</div>
        ${F.roomText.map(f => fieldRow(f, r.text[f.key], `rt${i}.${f.key}`)).join('')}</div>`).join('')}
      <div class="card stack" style="max-width:none;margin-top:14px;position:sticky;bottom:0;z-index:3">
        <div class="toolbar" style="margin:0"><button type="button" id="lpreview" class="primary">Preview changes</button><span class="sub" id="lstatus"></span></div>
        <div id="ldiff"></div></div>
    </form>
    <div class="card" style="margin-top:14px"><h3>Recent listing changes</h3>${L.log.length ? `<ul class="list">${L.log.map(c => `<li><span>${c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(c.summary)}${c.error ? `<div class="sub">${esc(c.error)}</div>` : ''}</span><span class="sub">${new Date(c.at).toLocaleString()}</span></li>`).join('')}</ul>` : '<div class="empty">No listing changes from this app yet.</div>'}</div>`;

  const form = $('#lform');
  const counters = () => form.querySelectorAll('[data-count]').forEach(el => {
    const c = el.parentElement.querySelector('.count'), n = el.value.length, max = +el.dataset.count;
    c.textContent = n > max * 0.6 || el.dataset.ai === 'headline' ? `${n}/${max}` : '';
    c.classList.toggle('warn', el.dataset.ai === 'headline' && n > 50);
  });
  form.oninput = counters; counters();
  if ($('#lprop')) $('#lprop').onchange = e => { ls.property = +e.target.value; listingView(); };
  const collect = () => {
    const val = n => form.elements[n]?.value;
    return { lang: x.lang,
      property: Object.fromEntries(F.property.map(f => [f.key, val(`p.${f.key}`)])),
      propertyText: Object.fromEntries(F.propertyText.map(f => [f.key, val(`pt.${f.key}`)])),
      rooms: x.rooms.map((r, i) => ({ id: r.id, ...Object.fromEntries(F.room.map(f => [f.key, val(`r${i}.${f.key}`)])),
        text: Object.fromEntries(F.roomText.map(f => [f.key, val(`rt${i}.${f.key}`)])) })) };
  };
  ls.collect = collect;
  // AI writing help on each text field: suggest, then "Use this" puts it in the field (still previewed before saving).
  form.querySelectorAll('[data-ai]').forEach(el => {
    const wrap = document.createElement('div');
    wrap.className = 'aiw';
    wrap.innerHTML = L.ai ? `<button type="button" class="linkbtn">✨ ${el.value.trim() ? 'Improve' : 'Write'} with AI</button>
      <div class="aipanel" hidden><div class="toolbar" style="margin:4px 0"><input placeholder="Optional: what should it say or change? e.g. shorter, mention the fenced yard" style="flex:1;min-width:0" maxlength="1000">
        <button type="button" class="aigo">Suggest</button></div><div class="aiout"></div></div>` : '';
    if (!L.ai) return;
    el.closest('label').after(wrap);
    const panel = wrap.querySelector('.aipanel'), out = wrap.querySelector('.aiout'), go = wrap.querySelector('.aigo');
    wrap.querySelector('.linkbtn').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) wrap.querySelector('input').focus(); };
    wrap.querySelector('input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
    go.onclick = async () => {
      const [, kind, idx] = el.name.match(/^(pt|rt)(\d*)\./);
      go.disabled = true; go.textContent = 'Writing…'; out.innerHTML = '';
      try {
        const r = await api('/ai/listing', { method: 'POST', body: { propertyId: x.id, section: kind === 'pt' ? 'propertyText' : 'roomText', field: el.dataset.ai,
          roomId: kind === 'rt' ? x.rooms[+idx].id : null, listing: collect(), instruction: wrap.querySelector('input').value } });
        out.innerHTML = `<div class="aisugg">${esc(r.text)}</div><div class="toolbar" style="margin:6px 0 0"><button type="button" class="primary aiuse">Use this</button>
          <span class="sub ${r.length > r.limit ? 'warn' : ''}">${r.length}/${r.limit} characters${aiCost(r)}</span></div>`;
        out.querySelector('.aiuse').onclick = () => {
          el.value = r.text; el.dispatchEvent(new Event('input', { bubbles: true }));
          out.innerHTML = '<span class="sub ok">Added. Press Preview changes, then Save, to send it to Beds24.</span>';
        };
      } catch (err) { if (err.message !== 'login') out.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
      go.disabled = false; go.textContent = out.querySelector('.aisugg') ? 'Try again' : 'Suggest';
    };
  });
  if (!L.ai) form.querySelector('.lfield')?.insertAdjacentHTML('beforebegin', aiSetup('✨ The AI assistant can write and improve this text.'));
  const short = v => { const t = v == null || v === '' ? '(empty)' : String(v); return esc(t.length > 140 ? t.slice(0, 140) + '…' : t); };
  $('#lpreview').onclick = async () => {
    try {
      const edited = collect();
      const { changes } = await api('/listing/preview', { method: 'POST', body: { propertyId: x.id, edited } });
      $('#ldiff').innerHTML = changes.length ? `<table class="pv"><tr><th>Where</th><th>Field</th><th>Now</th><th>New</th></tr>${changes.map(c => `<tr><td>${esc(c.where)}</td><td>${esc(c.label)}</td><td class="sub">${short(c.before)}</td><td>${short(c.after)}</td></tr>`).join('')}</table>
        <button type="button" class="primary" id="lsave" ${L.canWrite === false ? 'disabled' : ''}>Save ${changes.length} change${changes.length === 1 ? '' : 's'} to Beds24</button>` : '<span class="sub">No changes yet.</span>';
      if ($('#lsave')) $('#lsave').onclick = async () => {
        $('#lsave').disabled = true; $('#lsave').textContent = 'Saving…';
        try {
          const r = await api('/listing/save', { method: 'POST', body: { propertyId: x.id, edited } });
          banner(`Saved ${r.applied} change${r.applied === 1 ? '' : 's'} to Beds24.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`, r.warnings.length ? '' : 'ok');
          await listingView();
        } catch (err) { if (err.message !== 'login') { $('#lstatus').innerHTML = `<span class="bad">${esc(err.message)}</span>`; $('#lsave').disabled = false; $('#lsave').textContent = 'Try again'; } }
      };
    } catch (err) { if (err.message !== 'login') $('#ldiff').innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
  };
}

// ---------- AI helpers ----------
// Minimal, safe markdown for AI answers: everything is escaped first, then **bold**, *italic*, `code`,
// headings, bullet/numbered lists and pipe tables are allowed.
function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const isRow = l => /^\s*\|.*\|\s*$/.test(l), isSep = l => /^\s*\|[\s:|-]+\|\s*$/.test(l), isItem = l => /^\s*([-*•]|\d+[.)])\s+/.test(l);
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (isRow(l)) {
      const rows = []; while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
      const head = rows.length > 1 && isSep(rows[1]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      out += `<div class="mdt"><table class="pv">${rows.filter(r => !isSep(r)).map((r, n) => `<tr>${cells(r).map(c => head && n === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
      continue;
    }
    if (isItem(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && isItem(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      out += `<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    const h = l.match(/^#{1,4}\s+(.*)/);
    if (h) { out += `<p><b>${inline(h[1])}</b></p>`; i++; continue; }
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !isRow(lines[i]) && !isItem(lines[i]) && !/^#{1,4}\s/.test(lines[i])) para.push(lines[i++]);
    out += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return out;
}
const aiCost = r => r.cost != null ? ` · about $${r.cost < 0.01 ? '0.01' : r.cost.toFixed(2)}` : '';
const aiSetup = what => `<div class="sub">${what} <a href="#/settings">Add an Anthropic API key in Settings</a> to turn it on.</div>`;

// ---------- Analytics ----------
const an = { range: '12m', metric: 'revenue', history: [], busy: false };
const delta = (cur, ly, points = false) => {
  if (ly == null) return '';
  if (points) { const d = Math.round((cur - ly) * 100); return d ? `<span class="${d > 0 ? 'ok' : 'bad'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)} pts</span>` : '<span class="sub">=</span>'; }
  if (!ly) return cur ? '<span class="ok">new</span>' : '';
  const d = Math.round((cur - ly) / ly * 100);
  return d ? `<span class="${d > 0 ? 'ok' : 'bad'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}%</span>` : '<span class="sub">=</span>';
};
const ASK_EXAMPLES = ['How did last month compare with the same month last year?', 'Which channel earns the most per night?', 'How far ahead do guests book in summer?', 'Am I ahead or behind last year for the next three months?'];

async function analyticsView() {
  const live = stamp('analytics');
  const A = await api('/analytics?' + q({ range: an.range }));
  if (!live()) return;
  const H = A.headline, M = A.monthly;
  const val = (m, k) => m ? (k === 'occupancy' ? m.occupancy : k === 'adr' ? m.adr : m.revenue) : 0;
  const fmt = (v, k) => k === 'occupancy' ? pct(v) : money(v);
  const max = Math.max(...M.flatMap(m => [val(m, an.metric), val(m.lastYear, an.metric)]), 1e-9);
  const head = (h, extra = '') => `<div class="card"><h3>${esc(h.label)}</h3><div class="big">${money(h.current.revenue)} ${delta(h.current.revenue, h.lastYear?.revenue)}</div>
    <div class="sub">${h.lastYear ? `Last year ${money(h.lastYear.revenue)}` : 'No bookings from last year to compare'}${extra}</div>
    <div class="kv"><span>Occupancy <b>${pct(h.current.occupancy)}</b> ${delta(h.current.occupancy, h.lastYear?.occupancy, true)}</span>
      <span>ADR <b>${money(h.current.adr)}</b> ${delta(h.current.adr, h.lastYear?.adr)}</span></div></div>`;
  const hbars = (rows, valueOf, label) => { const top = Math.max(...rows.map(valueOf), 1); return `<div class="hbars">${rows.map(r =>
    `<div class="hrow"><span>${esc(r.label)}</span><span class="track"><i style="width:${valueOf(r) / top * 100}%"></i></span><span class="sub">${label(r)}</span></div>`).join('')}</div>`; };
  const W = A.window, C = A.cancellations;
  const paceCell = p => p ? `${pct(p.occupancy)} <span class="sub">${money(p.revenue)}</span>` : '<span class="sub">no history</span>';
  const sources = A.sources.map(s => `${s.source === 'guesty' ? 'Guesty import' : s.source === 'beds24' ? 'Beds24' : esc(s.source)}: ${s.n} bookings since ${fmtDate(s.first)}`).join(' · ');

  view.innerHTML = `
    <div class="card ask" id="ask"><h3>✨ Ask about your numbers</h3>${status.ai ? `
      <div id="anlog">${an.history.length ? '' : `<div class="chips">${ASK_EXAMPLES.map(x => `<button type="button" class="chip-btn" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>`}</div>
      <form id="anform" class="toolbar" style="margin:8px 0 0"><input name="q" placeholder="Ask anything about your bookings, revenue or pace" style="flex:1;min-width:0" autocomplete="off" ${an.busy ? 'disabled' : ''}>
        <button class="primary" ${an.busy ? 'disabled' : ''}>Ask</button>${an.history.length ? '<button type="button" id="anclear">Clear</button>' : ''}</form>`
      : aiSetup('Ask questions in plain English (e.g. "How did October compare with last year?") and get answers from your own booking data.')}</div>
    <div class="grid">${head(H.ytd)}${head(H.trailing12)}${head(H.next90, ' (same dates)')}</div>
    <div class="card"><div class="toolbar"><h3 style="margin:0">By month</h3>
      <select id="anmetric" aria-label="Measure">${[['revenue', 'Revenue'], ['occupancy', 'Occupancy'], ['adr', 'ADR']].map(([v, l]) => `<option value="${v}" ${an.metric === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="legend" style="margin:0"><span><span class="sw cy"></span>This year</span><span><span class="sw ly"></span>Same month last year</span><span class="sub">faded = on the books so far</span></span></div>
      <div class="gbars">${M.map(m => `<div class="gbar ${m.future ? 'future' : ''} ${m.current ? 'cur' : ''}" title="${esc(`${MONTHS[+m.month.slice(5) - 1]} ${m.month.slice(0, 4)}: ${fmt(val(m, an.metric), an.metric)}${m.lastYear ? ` (last year ${fmt(val(m.lastYear, an.metric), an.metric)})` : ''}`)}">
        <div class="pair"><i class="ly" style="height:${val(m.lastYear, an.metric) / max * 100}%"></i><i class="cy" style="height:${val(m, an.metric) / max * 100}%"></i></div>
        <span>${MONTHS[+m.month.slice(5) - 1][0]}${m.month.endsWith('-01') ? `<br>’${m.month.slice(2, 4)}` : ''}</span></div>`).join('')}</div>
      <details style="margin-top:10px"><summary class="sub">Month-by-month table</summary><div class="tscroll"><table class="pv">
        <tr><th>Month</th><th>Nights</th><th>Occupancy</th><th>ADR</th><th>Revenue</th><th>Last year</th><th>Change</th></tr>
        ${[...M].reverse().map(m => `<tr><td>${MONTHS[+m.month.slice(5) - 1]} ${m.month.slice(0, 4)}${m.future ? ' <span class="sub">(so far)</span>' : ''}</td><td>${m.nights}</td><td>${pct(m.occupancy)}</td><td>${money(m.adr)}</td>
          <td>${money(m.revenue)}</td><td>${m.lastYear ? money(m.lastYear.revenue) : '<span class="sub">—</span>'}</td><td>${m.lastYear ? delta(m.revenue, m.lastYear.revenue) : ''}</td></tr>`).join('')}</table></div></details></div>
    <div class="cols" style="margin-top:14px">
      <div class="card"><h3>Pace: on the books vs last year</h3><div class="tscroll"><table class="pv"><tr><th>Month</th><th>Now</th><th>Last year, same day</th><th>Last year, final</th></tr>
        ${A.pace.map(p => `<tr><td>${MONTHS[+p.month.slice(5) - 1]}${p.fromToday ? ' <span class="sub">(rest)</span>' : ''}</td><td>${paceCell(p.now)}</td><td>${paceCell(p.lastYearAtThisPoint)}</td><td>${paceCell(p.lastYearFinal)}</td></tr>`).join('')}</table></div>
        <div class="sub">"Same day" counts what had been booked by this date last year, so it's a fair comparison for months still filling up.</div></div>
      <div class="card"><div class="toolbar" style="margin-bottom:6px"><h3 style="margin:0">Stays arriving</h3>
        <select id="anrange" aria-label="Date range">${Object.entries(A.ranges).map(([v, l]) => `<option value="${v}" ${A.range === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <span class="sub">${fmtDate(A.from)} – ${fmtDate(addDaysISO(A.to, -1))}</span></div>
        <div class="kv"><span>Stays <b>${W.bookings}</b></span><span>Avg stay <b>${W.stay.average ?? '—'}</b> nights</span><span>Booked <b>${W.lead.median ?? '—'}</b> days ahead (median)</span><span>Party <b>${W.guests.average ?? '—'}</b> guests</span></div>
        <div class="sub" style="margin-top:6px">The sections below use stays arriving in this range.</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Channels</h3><div class="tscroll"><table class="pv"><tr><th>Channel</th><th>Stays</th><th>Nights</th><th>Revenue</th><th>Share</th><th>ADR</th><th>Booked ahead</th><th>Avg stay</th></tr>
      ${A.channels.map(c => `<tr><td>${tag(c.channel)}</td><td>${c.bookings}</td><td>${c.nights} <span class="sub">${pct(c.nightShare)}</span></td><td>${money(c.revenue)}</td><td>${pct(c.revenueShare)}</td><td>${money(c.adr)}</td>
        <td>${c.avgLead != null ? c.avgLead + ' days' : '—'}</td><td>${c.avgStay ?? '—'} nights</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No stays in this range</td></tr>'}</table></div></div>
    <div class="cols" style="margin-top:14px">
      <div class="card"><h3>How far ahead guests book</h3>${W.withBookingDate ? hbars(W.lead.buckets, r => r.bookings, r => `${r.bookings}${r.nights ? ' · ' + money(r.adr) + '/night' : ''}`) : '<div class="empty">No booking dates in this range</div>'}
        ${W.withBookingDate < W.bookings ? `<div class="sub">${W.bookings - W.withBookingDate} stays have no booking date.</div>` : ''}</div>
      <div class="card"><h3>Length of stay</h3>${W.bookings ? hbars(W.stay.buckets, r => r.bookings, r => `${r.bookings}${r.bookings ? ' · ' + money(r.adr) + '/night' : ''}`) : '<div class="empty">No stays in this range</div>'}</div>
      <div class="card"><h3>Night of the week</h3><div class="bars wk">${A.weekdays.map(d => `<div class="bar" title="${d.day}: ${pct(d.occupancy)} booked, ADR ${money(d.adr)}"><i style="height:${d.occupancy * 100}%"></i>${d.day}<span class="sub">${pct(d.occupancy)}</span></div>`).join('')}</div>
        <div class="sub">Occupancy of each night of the week (Friday = Friday night). Hover for ADR.</div></div>
      <div class="card"><h3>Cancellations</h3><div class="big">${pct(C.rate)} <span class="sub">${C.cancelled} of ${C.bookings} bookings</span></div>
        <div class="sub">${money(C.lostRevenue)} in cancelled bookings${C.medianNoticeDays != null ? ` · typically ${C.medianNoticeDays} days before arrival` : ''}</div>
        ${C.byChannel.length ? `<ul class="list" style="margin-top:6px">${C.byChannel.map(c => `<li><span>${tag(c.channel)}</span><span>${pct(c.rate)} <span class="sub">${c.cancelled}/${c.bookings}</span></span></li>`).join('')}</ul>` : ''}</div>
    </div>
    <div class="sub" style="margin-top:10px">Revenue is each booking's total spread over its nights, as on the Dashboard. Data: ${sources || 'none yet'}.</div>`;

  $('#anmetric').onchange = e => { an.metric = e.target.value; analyticsView(); };
  $('#anrange').onchange = e => { an.range = e.target.value; analyticsView(); };
  if (!status.ai) return;
  const log = $('#anlog');
  const renderLog = (pending) => {
    if (!an.history.length && !pending) return;
    log.innerHTML = an.history.map(h => h.role === 'user' ? `<div class="q">${esc(h.content)}</div>` : `<div class="a">${md(h.content)}${h.meta ? `<div class="sub">${esc(h.meta)}</div>` : ''}</div>`).join('')
      + (pending ? `<div class="q">${esc(pending)}</div><div class="a sub">Looking at your data…</div>` : '');
  };
  renderLog();
  const ask = async question => {
    if (!question.trim() || an.busy) return;
    an.busy = true; renderLog(question);
    const form = $('#anform'); form.q.value = ''; form.q.disabled = true; form.querySelector('.primary').disabled = true;
    try {
      const r = await api('/ai/ask?' + q(), { method: 'POST', body: { question, history: an.history.map(({ role, content }) => ({ role, content })) } });
      an.history.push({ role: 'user', content: question }, { role: 'assistant', content: r.text, meta: aiCost(r).replace(/^ · /, '') });
    } catch (err) {
      if (err.message === 'login') return;
      an.history.push({ role: 'user', content: question }, { role: 'assistant', content: `**Couldn't answer:** ${err.message}` });
    } finally { an.busy = false; }
    if (location.hash === '#/analytics') { await analyticsView(); $('#anform')?.q.focus(); }
  };
  $('#anform').onsubmit = e => { e.preventDefault(); ask(e.target.q.value); };
  log.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => ask(b.dataset.ex));
  if ($('#anclear')) $('#anclear').onclick = () => { an.history = []; analyticsView(); };
}

// ---------- Smart home (Home Assistant) ----------
const hs = { devices: false, stay: null };
const BAD_STATES = ['unavailable', 'unknown'];
function sparkline(points, unit) {
  if (points.length < 2) return '<span class="sub">Not enough readings</span>';
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), h = y1 - y0 || 1;
  const pts = points.map(([x, y]) => `${((x - x0) / (x1 - x0 || 1) * 600).toFixed(1)},${(76 - (y - y0) / h * 70).toFixed(1)}`).join(' ');
  return `<div class="spark"><svg viewBox="0 0 600 80" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <span class="sub">low ${y0}${unit} · high ${y1}${unit}</span></div>`;
}

// One line about the private Tailscale route (only shown when TS_AUTHKEY is set on the server).
function tailscaleLine(T) {
  if (!T?.enabled) return '';
  if (T.state === 'Running') return `<span class="ok">●</span> Tailscale connected as <b>${esc(T.name || 'str-dashboard')}</b>${T.used ? ': Home Assistant is reached privately.' : '.'}`;
  return `<span class="bad">●</span> Tailscale not connected (${esc({ starting: 'starting', off: 'off', NoState: 'starting', Starting: 'starting', NeedsLogin: 'needs a new auth key', NeedsMachineAuth: 'approve it in the Tailscale admin console', Stopped: 'stopped' }[T.state] || T.state)})${T.error ? `: ${esc(T.error)}` : ''}.`;
}

async function homeView() {
  const live = stamp('home');
  const H = await api('/home?' + q());
  if (!live()) return;
  const T = H.tailscale || {};
  if (!H.configured) {
    view.innerHTML = `<div class="card stack"><h3>Connect Home Assistant</h3>
      <div class="sub">Shows your thermostats, locks, leak, air-quality and temperature sensors here, alerts your phones about problems, adjusts the thermostat around bookings, locks up after checkout, and keeps a record of conditions during each stay.</div>
      <ol class="sub steps"><li>In Home Assistant, open your profile (bottom left), then the <b>Security</b> tab, then <b>Long-lived access tokens → Create token</b>. Name it "STR Dashboard" and copy it.</li>
        <li>Paste Home Assistant's address (its Tailscale address, or one you use from outside the house) and the token.</li></ol>
      ${T.enabled ? `<div class="sub">${tailscaleLine(T)} Use Home Assistant's Tailscale address, like https://homeassistant.<i>your-tailnet</i>.ts.net.</div>`
        : '<div class="sub">Home Assistant only on your Tailscale network? Add a Tailscale auth key to the dashboard first (DEPLOY.md, section 9), so it can stay off the public internet.</div>'}
      <form id="haform" class="stack"><input name="url" placeholder="https://home.example.com" value="${esc(H.url || '')}" autocomplete="off">
        <input name="token" type="password" placeholder="Long-lived access token" autocomplete="off"><button class="primary">Connect</button></form>
      <div class="sub">The token stays on the server. Thermostat and lock automations stay off until you switch them on.</div></div>`;
    $('#haform').onsubmit = async e => {
      e.preventDefault();
      const b = e.target.querySelector('button'); b.disabled = true; b.textContent = 'Connecting…';
      try { const r = await api('/home/connect', { method: 'POST', body: { url: e.target.url.value, token: e.target.token.value } }); await boot(true); banner(`Connected. Following ${r.devices} devices.`, 'ok'); }
      catch (err) { if (err.message !== 'login') { banner(err.message, true); b.disabled = false; b.textContent = 'Connect'; } }
    };
    return;
  }
  const when = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: H.tz });
  const byRole = r => H.devices.filter(d => d.role === r);
  const A = H.alertSettings;
  const deg = v => v == null ? '—' : `${Math.round(v)}°F`;
  const stateTag = (d, good, label) => BAD_STATES.includes(d.state) ? '<span class="chip error">offline</span>' : `<span class="chip ${good ? 'set' : 'error'}">${esc(label)}</span>`;
  const rows = (list, fmt) => list.length ? `<ul class="list">${list.map(d => `<li><span>${esc(d.name)}</span><span>${fmt(d)}</span></li>`).join('')}</ul>` : '<div class="empty">None followed</div>';
  const airLimit = { pm25: A.pm25Above, co2: A.co2Above, aqi: A.aqiAbove, voc: A.vocAbove, co: A.coAbove };
  const air = H.devices.filter(d => ['pm25', 'pm10', 'co2', 'voc', 'aqi', 'co'].includes(d.role));
  const climateRows = byRole('humidity');
  const props = H.properties.filter(p => H.devices.some(d => d.propertyId === p.id) || H.properties.length === 1);
  const thermostats = byRole('thermostat'), locks = byRole('lock');
  const checks = (list, name, chosen) => list.length ? list.map(d => `<label class="sub"><input type="checkbox" name="${name}" value="${esc(d.id)}" ${chosen.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')
    : `<span class="sub">No ${name === 'thermostats' ? 'thermostats' : 'locks'} followed.</span>`;
  const num = (name, label, v, extra = '') => `<label class="sub">${label}<br><input name="${name}" type="number" value="${v ?? ''}" style="width:6em" ${extra}></label>`;

  view.innerHTML = `
    <div class="toolbar"><span class="sub">Home Assistant${H.name ? ` · ${esc(H.name)}` : ''}${T.used && T.state === 'Running' ? ' · via Tailscale' : ''} · updated ${H.lastPoll ? timeAgo(H.lastPoll) : 'never'}</span>
      ${T.used && T.state !== 'Running' ? `<span class="sub">${tailscaleLine(T)}</span>` : H.error ? `<span class="bad sub">${esc(H.error)}</span>` : ''}
      <span style="margin-left:auto"></span><button id="harefresh">↻ Refresh</button><button id="hadev">${hs.devices ? 'Hide devices' : 'Choose devices'}</button></div>
    ${H.alerts.length ? `<div class="notice bad-notice"><b>Needs attention</b><ul>${H.alerts.map(a => `<li>${esc(a.title)}${a.message ? ` · <span>${esc(a.message)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    <div id="hadevices"></div>
    ${props.map(p => `<div class="card" style="margin-bottom:14px"><h3>${H.properties.length > 1 ? esc(p.name) + ' · ' : ''}Right now</h3>
      <div>${p.occupancy.current ? `<b>Guest staying:</b> ${esc(p.occupancy.current.guest || 'guest')} until ${when(p.occupancy.current.checkOutAt)}` : '<b>No guests staying</b>'}
      ${p.occupancy.next ? `<div class="sub">Next check-in: ${esc(p.occupancy.next.guest || 'guest')}, ${when(p.occupancy.next.checkInAt)}${p.climate.enabled && p.preheatAt ? ` · thermostat warms up from ${when(p.preheatAt)}` : ''}</div>` : '<div class="sub">No upcoming check-ins in the next 60 days.</div>'}</div></div>`).join('')}
    <div class="cols">
      <div class="card"><h3>Thermostats</h3>${thermostats.length ? thermostats.map(d => `<div class="therm"><div><b>${esc(d.name)}</b><div class="sub">${BAD_STATES.includes(d.state) ? '<span class="bad">offline</span>'
        : `${esc(d.state)}${d.action ? ` · ${esc(d.action)}` : ''} · set to ${d.low != null && d.high != null && d.target == null ? `${deg(d.low)}–${deg(d.high)}` : deg(d.target)}`}</div></div><div class="big">${deg(d.current)}</div></div>`).join('') : '<div class="empty">None followed</div>'}</div>
      <div class="card"><h3>Temperature &amp; humidity</h3>${rows([...byRole('temperature'), ...byRole('outdoor'), ...climateRows], d => BAD_STATES.includes(d.state) ? '<span class="chip error">offline</span>'
        : d.role === 'humidity' ? `<span class="${A.humidityAbove != null && d.value > A.humidityAbove ? 'bad' : ''}">${d.value ?? '—'}%</span>`
        : `<span class="${d.role !== 'outdoor' && A.freezeBelow != null && d.value < A.freezeBelow ? 'bad' : ''}">${deg(d.value)}</span>${d.role === 'outdoor' ? ' <span class="sub">outside</span>' : ''}`)}</div>
      <div class="card"><h3>Air quality</h3>${rows(air, d => BAD_STATES.includes(d.state) ? '<span class="chip error">offline</span>'
        : `<span class="${airLimit[d.role] != null && d.value > airLimit[d.role] ? 'bad' : ''}">${d.value ?? '—'} <span class="sub">${esc(d.unit)}</span></span>`)}</div>
      <div class="card"><h3>Leaks &amp; alarms</h3>${rows([...byRole('leak'), ...byRole('safety')], d => d.role === 'leak' ? stateTag(d, d.state === 'off', d.state === 'on' ? 'WET' : 'Dry') : stateTag(d, d.state === 'off', d.state === 'on' ? 'ALARM' : 'Clear'))}</div>
      <div class="card"><h3>Locks</h3>${rows(locks, d => stateTag(d, d.state === 'locked', d.state || '—'))}</div>
      <div class="card"><h3>Batteries</h3>${rows(byRole('battery').sort((a, b) => (a.value ?? 999) - (b.value ?? 999)), d => BAD_STATES.includes(d.state) ? '<span class="chip error">offline</span>'
        : `<span class="${A.batteryBelow != null && d.value < A.batteryBelow ? 'bad' : ''}">${d.value ?? '—'}%</span>`)}</div>
    </div>
    ${props.map(p => `<div class="cols" style="margin-top:14px">
      <form class="card stack hclimate" data-pid="${p.id}" style="max-width:none"><h3>${H.properties.length > 1 ? esc(p.name) + ' · ' : ''}Thermostat around bookings</h3>
        <label><input type="checkbox" name="enabled" ${p.climate.enabled ? 'checked' : ''}> <b>Adjust the thermostat for bookings</b></label>
        <div class="sub">Set once at each change, so guests can still adjust it during their stay. Now: <b>${p.phase === 'occupied' ? 'guest temperatures' : 'eco (no guests)'}</b>.</div>
        <div class="chips">${checks(thermostats, 'thermostats', p.climate.thermostats)}</div>
        <div class="toolbar" style="margin:0">${num('occupiedHeat', 'Guests: heat to', p.climate.occupiedHeat)}${num('occupiedCool', 'Guests: cool to', p.climate.occupiedCool)}
          ${num('vacantHeat', 'Empty: heat to', p.climate.vacantHeat)}${num('vacantCool', 'Empty: cool to', p.climate.vacantCool)}</div>
        <div class="toolbar" style="margin:0">${num('preconditionHours', 'Hours before check-in', p.climate.preconditionHours, 'min="0" max="24" step="0.5"')}
          ${num('setbackMinutes', 'Minutes after checkout', p.climate.setbackMinutes, 'min="0" max="720"')}${num('freezeFloor', 'Never below (°F)', p.climate.freezeFloor, 'min="35" max="65"')}
          <label class="sub">If it's switched off<br><select name="offMode">${[['heat', 'Turn on heat'], ['cool', 'Turn on cooling'], ['heat_cool', 'Turn on heat/cool'], ['leave', 'Leave it off']].map(([v, l]) => `<option value="${v}" ${p.climate.offMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <div class="sub">Freeze protection: if the house gets within 2° of "never below" while the heat is off or set lower, the heat is turned on (and your phones are told).</div>
        <div class="toolbar" style="margin:0"><button class="primary">Save</button>${p.climate.enabled ? '<button type="button" class="happly">Apply now</button>' : ''}</div></form>
      <form class="card stack hlock" data-pid="${p.id}" style="max-width:none"><h3>${H.properties.length > 1 ? esc(p.name) + ' · ' : ''}Lock up after checkout</h3>
        <label><input type="checkbox" name="enabled" ${p.checkoutLock.enabled ? 'checked' : ''}> <b>Lock the doors after checkout if they're unlocked</b></label>
        <div class="chips">${checks(locks, 'locks', p.checkoutLock.locks)}</div>
        ${num('minutes', 'Minutes after checkout time', p.checkoutLock.minutes, 'min="0" max="240"')}
        <div class="sub">Once per stay. A door that won't lock (jammed or offline) is reported to your phones.</div>
        <div><button class="primary">Save</button></div></form></div>`).join('')}
    <form class="card stack" id="halerts" style="max-width:none;margin-top:14px"><h3>Alert thresholds</h3>
      <div class="toolbar" style="margin:0">${num('freezeBelow', 'Freeze risk below (°F)', A.freezeBelow)}${num('hotAbove', 'Too hot above (°F)', A.hotAbove)}${num('humidityAbove', 'Humidity above (%)', A.humidityAbove)}
        ${num('pm25Above', 'PM2.5 above', A.pm25Above)}${num('co2Above', 'CO₂ above (ppm)', A.co2Above)}${num('aqiAbove', 'AQI above', A.aqiAbove)}${num('vocAbove', 'VOC above', A.vocAbove, 'placeholder="off"')}
        ${num('coAbove', 'CO above (ppm)', A.coAbove)}${num('batteryBelow', 'Battery below (%)', A.batteryBelow)}${num('offlineMinutes', 'Offline after (min)', A.offlineMinutes)}${num('unlockedMinutes', 'Unlocked with no guest (min)', A.unlockedMinutes)}</div>
      <div class="sub">Leaks and smoke/CO alarms always alert straight away. Leave a box empty to turn that alert off. Alerts reach your phones if phone notifications are on (Settings).</div>
      <div><button class="primary">Save</button></div></form>
    <div class="card" style="margin-top:14px"><h3>Stay records</h3>${H.stays.length ? `<div class="tscroll"><table class="pv"><tr><th>Guest</th><th>Stay</th><th>Inside temp</th><th>Humidity</th><th>PM2.5 max</th><th>CO₂ max</th><th>Alerts</th><th></th></tr>
      ${H.stays.map(s => `<tr><td>${esc(s.guest_name || 'Guest')} ${tag(s.channel)}${s.current ? ' <span class="chip set">now</span>' : ''}</td><td>${fmtDate(s.arrival)} → ${fmtDate(s.departure)}</td>
        <td>${s.summary.temperature ? `${Math.round(s.summary.temperature.min)}–${Math.round(s.summary.temperature.max)}°F` : '—'}</td><td>${s.summary.humidity ? `${Math.round(s.summary.humidity.max)}%` : '—'}</td>
        <td class="${s.summary.pm25 && A.pm25Above != null && s.summary.pm25.max > A.pm25Above ? 'bad' : ''}">${s.summary.pm25 ? s.summary.pm25.max : '—'}</td><td>${s.summary.co2 ? Math.round(s.summary.co2.max) : '—'}</td>
        <td>${s.alerts ? `<span class="bad">${s.alerts}</span>` : '0'}</td><td><button type="button" data-stay="${s.id}">Details</button></td></tr>`).join('')}</table></div>`
      : '<div class="empty">Records start with the next stay: readings are saved every 10 minutes from now on.</div>'}<div id="hstay"></div></div>
    <div class="card" style="margin-top:14px"><h3>Recent automatic changes</h3>${H.actions.length ? `<ul class="list">${H.actions.map(a => `<li><span>${a.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(a.name)}: ${esc(a.detail)}</span><span class="sub">${new Date(a.at).toLocaleString()}</span></li>`).join('')}</ul>` : '<div class="empty">None yet</div>'}
      <hr><button id="hadisc">Disconnect Home Assistant</button></div>`;

  const save = async (body, msg) => {
    try { await api('/home/settings', { method: 'POST', body }); await homeView(); banner(msg, 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  const vals = (f, names) => Object.fromEntries(names.map(n => [n, f.elements[n].value]));
  view.querySelectorAll('.hclimate').forEach(f => {
    f.onsubmit = e => { e.preventDefault(); save({ climate: { propertyId: +f.dataset.pid, enabled: f.enabled.checked, thermostats: [...f.querySelectorAll('[name=thermostats]:checked')].map(x => x.value),
      ...vals(f, ['occupiedHeat', 'occupiedCool', 'vacantHeat', 'vacantCool', 'preconditionHours', 'setbackMinutes', 'freezeFloor', 'offMode']) } }, 'Thermostat schedule saved.'); };
    const ap = f.querySelector('.happly');
    if (ap) ap.onclick = async () => {
      ap.disabled = true;
      try { const r = await api('/home/climate/apply', { method: 'POST', body: { propertyId: +f.dataset.pid } }); await homeView(); banner(r.applied.length ? r.applied.map(x => x.detail).join('; ') : 'Nothing changed (see Recent automatic changes).', 'ok'); }
      catch (err) { if (err.message !== 'login') banner(err.message, true); ap.disabled = false; }
    };
  });
  view.querySelectorAll('.hlock').forEach(f => f.onsubmit = e => { e.preventDefault();
    save({ checkoutLock: { propertyId: +f.dataset.pid, enabled: f.enabled.checked, locks: [...f.querySelectorAll('[name=locks]:checked')].map(x => x.value), minutes: f.minutes.value } }, 'Checkout locking saved.'); });
  $('#halerts').onsubmit = e => { e.preventDefault();
    save({ alerts: vals(e.target, ['freezeBelow', 'hotAbove', 'humidityAbove', 'pm25Above', 'co2Above', 'aqiAbove', 'vocAbove', 'coAbove', 'batteryBelow', 'offlineMinutes', 'unlockedMinutes']) }, 'Alert thresholds saved.'); };
  $('#harefresh').onclick = async () => { try { await api('/home/refresh', { method: 'POST' }); await homeView(); } catch (err) { if (err.message !== 'login') banner(err.message, true); } };
  $('#hadisc').onclick = () => confirm('Disconnect Home Assistant? Thermostat and lock automations switch off; stay records are kept.') && act(() => api('/home/disconnect', { method: 'POST' }));
  $('#hadev').onclick = () => { hs.devices = !hs.devices; homeView(); };
  view.querySelectorAll('[data-stay]').forEach(b => b.onclick = async () => {
    hs.stay = +b.dataset.stay;
    let r;
    try { r = await api('/home/stay?booking=' + hs.stay); } catch (err) { return fail(err); }
    if (hs.stay !== r.booking?.id || !$('#hstay')) return;
    $('#hstay').innerHTML = `<div class="stay"><h3>${esc(r.booking.guest_name || 'Guest')} · ${fmtDate(r.booking.arrival)} → ${fmtDate(r.booking.departure)}</h3>
      ${r.series.map(x => `<div class="sub"><b>${esc(x.name)}</b> (${esc(x.unit)})</div>${sparkline(x.points, x.unit)}`).join('') || '<div class="empty">No readings for this stay.</div>'}
      ${r.alerts.length ? `<div class="sub" style="margin-top:8px"><b>Alerts</b></div><ul class="list">${r.alerts.map(a => `<li><span>${esc(a.name)}: ${esc(a.rule)}${a.peak != null ? ` (worst ${a.peak})` : ''}</span><span class="sub">${new Date(a.since).toLocaleString()}</span></li>`).join('')}</ul>` : ''}
      ${r.events.length ? `<div class="sub" style="margin-top:8px"><b>Lock and sensor events</b></div><ul class="list">${r.events.map(ev => `<li><span>${esc(ev.name)}: ${esc(ev.from_state)} → ${esc(ev.to_state)}</span><span class="sub">${new Date(ev.at).toLocaleString()}</span></li>`).join('')}</ul>` : ''}</div>`;
  });
  if (hs.devices) await renderDevices();
}

async function renderDevices() {
  const D = await api('/home/devices');
  const box = $('#hadevices');
  if (!box) return;
  box.innerHTML = `<form class="card stack" id="hdform" style="max-width:none;margin-bottom:14px"><h3>Devices to follow</h3>
    <div class="sub">Everything Home Assistant has that this app understands. Untick anything that isn't part of the rental (a phone's battery, for example).</div>
    <div class="tscroll"><table class="pv"><tr><th>Follow</th><th>Device</th><th>Type</th>${D.properties.length > 1 ? '<th>Property</th>' : ''}<th>Now</th></tr>
    ${D.devices.map(d => `<tr data-id="${esc(d.id)}"><td><input type="checkbox" name="follow" ${d.role ? 'checked' : ''}></td><td>${esc(d.name)}<div class="sub">${esc(d.id)}</div></td>
      <td><select name="role">${Object.entries(D.roles).map(([k, l]) => `<option value="${k}" ${(d.role || d.suggested) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
      ${D.properties.length > 1 ? `<td><select name="pid">${D.properties.map(p => `<option value="${p.id}" ${d.propertyId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>` : ''}
      <td class="sub">${esc(d.state)} ${esc(d.unit)}</td></tr>`).join('')}</table></div>
    <div><button class="primary">Save devices</button></div></form>`;
  $('#hdform').onsubmit = async e => {
    e.preventDefault();
    const entities = {};
    for (const tr of box.querySelectorAll('tr[data-id]')) {
      if (!tr.querySelector('[name=follow]').checked) continue;
      entities[tr.dataset.id] = { role: tr.querySelector('[name=role]').value, propertyId: tr.querySelector('[name=pid]')?.value ?? D.properties[0]?.id ?? null };
    }
    try { await api('/home/devices', { method: 'POST', body: { entities } }); hs.devices = false; await homeView(); banner(`Following ${Object.keys(entities).length} devices.`, 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
}

// ---------- Direct booking site ----------
const st = { property: null };
async function shrinkImage(file, max = 2000) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function siteView() {
  const live = stamp('site');
  const S = await api('/site?' + new URLSearchParams(st.property ? { property: st.property } : {}));
  if (!live()) return;
  if (!S.site) { view.innerHTML = '<div class="card empty">No properties yet. Connect Beds24 in Settings first.</div>'; return; }
  const s = S.site;
  st.property = s.propertyId;
  const base = `/stay/${s.slug}`;
  const field = (name, label, opts = {}) => opts.area
    ? `<label class="sub">${label}<textarea name="${name}" rows="${opts.rows || 5}" style="width:100%">${esc(s[name])}</textarea>${opts.hint ? `<span class="sub">${opts.hint}</span>` : ''}</label>`
    : `<label class="sub">${label}<input name="${name}" value="${esc(s[name])}" ${opts.type ? `type="${opts.type}"` : ''} style="width:${opts.w || '100%'}" ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''}>${opts.hint ? `<span class="sub">${opts.hint}</span>` : ''}</label>`;
  view.innerHTML = `
    <div class="card stack" style="max-width:none;margin-bottom:14px"><div class="toolbar" style="margin:0">
      ${S.properties.length > 1 ? `<select id="sprop" aria-label="Property">${S.properties.map(p => `<option value="${p.id}" ${p.id === s.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : `<h3 style="margin:0">Direct booking site</h3>`}
      <span style="margin-left:auto"></span><a href="${esc(S.url)}" target="_blank" rel="noopener"><button type="button">Open ${s.enabled ? 'site' : 'preview'} ↗</button></a></div>
      <div>${s.enabled ? `✅ Live at <a href="${esc(S.url)}" target="_blank" rel="noopener">${esc(S.url)}</a>${s.domain ? ` and <a href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a>` : ''}` : 'Off: only you can see the preview while signed in.'}</div>
      <div class="sub">${S.openNights} nights open for booking in the next 90 days. Availability and nightly prices come from Beds24 (set them on the Rates and Pricing pages). Guests pick dates here, then finish and pay on your Beds24 booking page.</div>
      ${!s.listingCached ? '<div class="sub warn">Open the Listing page once to fill this page from your Beds24 listing text.</div>' : ''}</div>
    <form id="sform">
      <div class="cols">
        <div class="card stack" style="max-width:none"><h3>Setup</h3>
          <label><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> <b>Site is live</b></label>
          ${field('slug', `Web address: ${esc(S.url.replace(/\/stay\/.*$/, ''))}/stay/…`, { w: '16em' })}
          ${field('bookingUrl', 'Beds24 booking page link', { hint: 'In Beds24: Settings → Booking Engine. Connect Stripe under Settings → Payments → Payment Gateways so guests pay when they book; a security deposit can be held on their card with a payment rule that doesn\'t capture.' })}
          ${field('domain', 'Your own domain (optional)', { ph: 'book.example.com', hint: 'Add it as a custom domain on the Railway service and point its CNAME record at Railway; the site then opens at that domain.' })}
          <div class="toolbar" style="margin:0">${field('maxGuests', 'Max guests', { type: 'number', w: '6em' })}${field('cleaningFee', 'Cleaning fee for estimates ($)', { type: 'number', w: '8em' })}</div>
          ${field('contactEmail', 'Contact email (optional)', { type: 'email' })}${field('contactPhone', 'Contact phone (optional)')}
        </div>
        <div class="card stack" style="max-width:none"><h3>Page text</h3>
          ${field('title', 'Title')}${field('perk', 'Why book direct', { ph: 'Book direct and save 10% compared with Airbnb.' })}
          ${field('intro', 'Description', { area: true, rows: 7 })}${field('highlights', 'Highlights (one per line)', { area: true, rows: 5 })}
          ${s.listingCached ? '<div><button type="button" id="sfill">Refill from Beds24 listing text</button></div>' : ''}
        </div>
      </div>
      <div class="cols" style="margin-top:14px">
        <div class="card stack" style="max-width:none"><h3>Rules and policies</h3>${field('houseRules', 'House rules', { area: true })}${field('neighbourhood', 'The neighbourhood', { area: true })}${field('cancellation', 'Cancellation policy', { area: true })}</div>
        <div class="card stack" style="max-width:none"><h3>Rental agreement</h3>${field('agreement', 'Agreement text', { area: true, rows: 14,
          hint: `Shown at <a href="${base}/terms" target="_blank" rel="noopener">${esc(S.url)}/terms</a>. Link it from your Beds24 booking page's terms so guests accept it when they book. Fill-ins: {check_in_time}, {check_out_time}, {property_name}. It's a starting template, not legal advice.` })}</div>
      </div>
      <div class="card" style="margin-top:14px;position:sticky;bottom:0;z-index:3"><button class="primary">Save</button> <span class="sub">Changes show on the site straight away.</span></div>
    </form>
    <div class="card stack" style="max-width:none;margin-top:14px"><h3>Photos</h3>
      <div class="toolbar" style="margin:0"><label class="sub">Add photos <input type="file" id="sfiles" accept="image/*" multiple></label>
        ${S.connected ? '<button type="button" id="simport">Import from Beds24</button>' : ''}<span class="sub" id="sup"></span></div>
      <div class="sub">The first photo is the big one. Photos are resized to 2000 px before upload.</div>
      <div class="photos">${S.photos.map((p, i) => `<div class="ph" data-id="${p.id}"><img src="${base}/photo/${p.id}" alt="" loading="lazy">
        <input value="${esc(p.caption || '')}" placeholder="Caption" data-cap="${p.id}"><div class="toolbar" style="margin:4px 0 0">
        <button type="button" data-mv="-1" ${i ? '' : 'disabled'}>←</button><button type="button" data-mv="1" ${i < S.photos.length - 1 ? '' : 'disabled'}>→</button><button type="button" data-del>Delete</button></div></div>`).join('') || '<div class="empty">No photos yet.</div>'}</div>
      ${S.photos.length ? '<div><button type="button" id="scaps">Save captions</button></div>' : ''}
    </div>`;

  if ($('#sprop')) $('#sprop').onchange = e => { st.property = +e.target.value; siteView(); };
  const form = $('#sform');
  form.onsubmit = async e => {
    e.preventDefault();
    const body = { propertyId: s.propertyId, enabled: form.enabled.checked };
    for (const k of ['slug', 'bookingUrl', 'domain', 'maxGuests', 'cleaningFee', 'contactEmail', 'contactPhone', 'title', 'perk', 'intro', 'highlights', 'houseRules', 'neighbourhood', 'cancellation', 'agreement']) body[k] = form.elements[k].value;
    try { await api('/site', { method: 'POST', body }); await siteView(); banner(body.enabled ? 'Saved. The site is live.' : 'Saved.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  if ($('#sfill')) $('#sfill').onclick = async () => {
    if (!confirm('Replace the title, description, house rules, neighbourhood and cancellation text with your Beds24 listing text?')) return;
    try { await api('/site', { method: 'POST', body: { propertyId: s.propertyId, title: '', intro: '', houseRules: '', neighbourhood: '', cancellation: '' } }); await siteView(); banner('Refilled from your listing.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  const photosNow = () => [...view.querySelectorAll('.ph')].map(el => +el.dataset.id);
  const update = async body => { try { await api('/site/photos/update', { method: 'POST', body: { propertyId: s.propertyId, ...body } }); await siteView(); } catch (err) { if (err.message !== 'login') banner(err.message, true); } };
  view.querySelectorAll('.ph').forEach(el => {
    const id = +el.dataset.id;
    el.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { const ids = photosNow(), i = ids.indexOf(id), j = i + +b.dataset.mv; [ids[i], ids[j]] = [ids[j], ids[i]]; update({ order: ids }); });
    el.querySelector('[data-del]').onclick = () => confirm('Delete this photo?') && update({ remove: [id] });
  });
  if ($('#scaps')) $('#scaps').onclick = () => update({ captions: Object.fromEntries([...view.querySelectorAll('[data-cap]')].map(i => [i.dataset.cap, i.value])) });
  $('#sfiles').onchange = async e => {
    const files = [...e.target.files];
    let done = 0;
    for (const f of files) {
      $('#sup').textContent = `Uploading ${done + 1} of ${files.length}…`;
      try { await api('/site/photos', { method: 'POST', body: { propertyId: s.propertyId, dataUrl: await shrinkImage(f) } }); done++; }
      catch (err) { if (err.message !== 'login') banner(`${f.name}: ${err.message}`, true); }
    }
    await siteView();
    if (done) banner(`Added ${done} photo${done === 1 ? '' : 's'}.`, 'ok');
  };
  if ($('#simport')) $('#simport').onclick = async () => {
    $('#simport').disabled = true;
    try { const r = await api('/site/photos/import', { method: 'POST', body: { propertyId: s.propertyId } }); await siteView(); banner(r.found ? `Found ${r.found} photos in Beds24, added ${r.added}.` : 'Beds24 didn\'t return any photos for this property. Upload them here instead.', r.found ? 'ok' : ''); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); $('#simport').disabled = false; }
  };
}

// ---------- Guest guidebook ----------
const gb = { property: null };
async function guideView() {
  const live = stamp('guide');
  const G = await api('/guide?' + new URLSearchParams(gb.property ? { property: gb.property } : {}));
  if (!live()) return;
  if (!G.guide) { view.innerHTML = '<div class="card empty">No properties yet. Connect Beds24 in Settings first.</div>'; return; }
  const g = G.guide;
  gb.property = g.propertyId;
  const area = (name, label, rows = 4, hint = '') => `<label class="sub">${label}<textarea name="${name}" rows="${rows}" style="width:100%">${esc(g[name])}</textarea>${hint ? `<span class="sub">${hint}</span>` : ''}</label>`;
  const input = (name, label, w = '100%', type = 'text') => `<label class="sub">${label}<input name="${name}" type="${type}" value="${esc(g[name])}" style="width:${w}"></label>`;
  const secRow = s => `<div class="rep sec"><input placeholder="Title, e.g. Heating" value="${esc(s.title)}" data-k="title"><textarea rows="3" placeholder="How it works" data-k="body">${esc(s.body)}</textarea><button type="button" class="rm">Remove</button></div>`;
  const placeRow = p => `<div class="rep place"><input placeholder="Name" value="${esc(p.name)}" data-k="name"><input placeholder="Category, e.g. Coffee" value="${esc(p.category)}" data-k="category">
    <input placeholder="Why you like it" value="${esc(p.note)}" data-k="note"><input placeholder="https://… (map or website)" value="${esc(p.url)}" data-k="url"><button type="button" class="rm">Remove</button></div>`;
  const first = G.stays.find(s => s.url);
  view.innerHTML = `
    <div class="card stack" style="max-width:none;margin-bottom:14px"><div class="toolbar" style="margin:0">
      ${G.properties.length > 1 ? `<select id="gprop" aria-label="Property">${G.properties.map(p => `<option value="${p.id}" ${p.id === g.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : '<h3 style="margin:0">Guest guidebook</h3>'}
      <span style="margin-left:auto"></span>${first ? `<a href="${esc(first.url)}" target="_blank" rel="noopener"><button type="button">Preview (${esc(first.guest_name || 'next guest')}) ↗</button></a>` : ''}</div>
      <div class="sub">Each booking gets its own private link. Send it with the <code>{guidebook_link}</code> fill-in in an automated message (e.g. check-in instructions) or a saved reply.
        The door code and address only appear from ${g.codeDaysBefore} day${g.codeDaysBefore === 1 ? '' : 's'} before check-in until checkout.</div></div>
    <form id="gform">
      <div class="cols">
        <div class="card stack" style="max-width:none"><h3>Arriving</h3>${area('welcome', 'Welcome message')}${area('arrival', 'Check-in steps', 5, 'Which door, where the keypad is, anything tricky. The door code and address are added automatically.')}
          ${area('parking', 'Parking', 2)}<div class="toolbar" style="margin:0">${input('wifiName', 'Wi-Fi network', '12em')}${input('wifiPassword', 'Wi-Fi password', '12em')}</div></div>
        <div class="card stack" style="max-width:none"><h3>Leaving and help</h3>${area('checkout', 'Checkout checklist (one step per line)', 5)}
          ${input('phone', 'Phone for guests (optional)', '14em')}${area('emergency', 'Emergency information', 3)}
          <div class="toolbar" style="margin:0">${input('codeDaysBefore', 'Show door code from (days before check-in)', '6em', 'number')}</div></div>
      </div>
      <div class="card stack" style="max-width:none;margin-top:14px"><h3>House guide</h3><div class="sub">How things work: heating, TV, kitchen, laundry, trash days, hot tub…</div>
        <div id="gsecs">${g.sections.map(secRow).join('')}</div><div><button type="button" id="gaddsec">Add section</button></div></div>
      <div class="card stack" style="max-width:none;margin-top:14px"><h3>Local tips</h3><div class="sub">Your favourite places in Laramie, grouped by category.</div>
        <div id="gplaces">${g.places.map(placeRow).join('')}</div><div><button type="button" id="gaddplace">Add place</button></div></div>
      <div class="card stack" style="max-width:none;margin-top:14px"><h3>Direct bookings</h3>
        <label><input type="checkbox" name="requireDirect" ${g.requireDirect ? 'checked' : ''}> <b>Direct guests check in online first</b>: they type their name to accept the rental agreement and upload a photo ID before the door code and address appear</label>
        <div class="toolbar" style="margin:0">${input('idRetentionDays', 'Delete ID photos this many days after checkout', '6em', 'number')}</div>
        <div class="sub">The agreement is the one on your Booking site page. Airbnb, VRBO and Booking.com guests are never asked.</div></div>
      <div class="card" style="margin-top:14px;position:sticky;bottom:0;z-index:3"><button class="primary">Save</button></div>
    </form>
    <div class="card" style="margin-top:14px"><h3>Upcoming stays</h3>${G.stays.length ? `<div class="tscroll"><table class="pv"><tr><th>Guest</th><th>Stay</th><th>Link</th><th>Online check-in</th></tr>
      ${G.stays.map(s => `<tr><td>${esc(s.guest_name || 'Guest')} ${tag(s.channel)}</td><td>${fmtDate(s.arrival)} → ${fmtDate(s.departure)}</td>
        <td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Open</a> · <a href="#" data-copy="${esc(s.url)}">Copy</a>` : '<span class="sub">—</span>'}</td>
        <td>${s.checkin?.signed_at ? `<span class="ok">✓</span> ${esc(s.checkin.name)}${s.checkin.has_id ? ` · <a href="/api/guide/id?booking=${s.id}" target="_blank" rel="noopener">View ID</a>` : s.checkin.id_deleted_at ? ' · ID deleted' : ''}` : s.channel === 'Direct' && g.requireDirect ? '<span class="warn">Not yet</span>' : '<span class="sub">Not needed</span>'}</td></tr>`).join('')}</table></div>`
      : '<div class="empty">No upcoming stays.</div>'}
      ${G.stays.length && !first ? '<div class="sub warn">Links appear once the app knows its own address: open the app once from its Railway address.</div>' : ''}
      <hr><button type="button" id="gregen">Make new links for everyone</button> <span class="sub">Old links stop working (use this if one was shared by mistake).</span></div>`;

  if ($('#gprop')) $('#gprop').onchange = e => { gb.property = +e.target.value; guideView(); };
  const wireRemove = () => view.querySelectorAll('.rep .rm').forEach(b => b.onclick = () => b.closest('.rep').remove());
  wireRemove();
  $('#gaddsec').onclick = () => { $('#gsecs').insertAdjacentHTML('beforeend', secRow({ title: '', body: '' })); wireRemove(); };
  $('#gaddplace').onclick = () => { $('#gplaces').insertAdjacentHTML('beforeend', placeRow({ name: '', category: '', note: '', url: '' })); wireRemove(); };
  const rows = sel => [...view.querySelectorAll(sel)].map(r => Object.fromEntries([...r.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value])));
  $('#gform').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, body = { propertyId: g.propertyId, requireDirect: f.requireDirect.checked, sections: rows('.rep.sec'), places: rows('.rep.place') };
    for (const k of ['welcome', 'arrival', 'parking', 'wifiName', 'wifiPassword', 'checkout', 'phone', 'emergency', 'codeDaysBefore', 'idRetentionDays']) body[k] = f.elements[k].value;
    try { await api('/guide', { method: 'POST', body }); await guideView(); banner('Guidebook saved.', 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); }
  };
  view.querySelectorAll('[data-copy]').forEach(a => a.onclick = async e => { e.preventDefault(); try { await navigator.clipboard.writeText(a.dataset.copy); a.textContent = 'Copied'; } catch { prompt('Copy this link', a.dataset.copy); } });
  $('#gregen').onclick = () => confirm('Make new guidebook links for every booking? Links already sent will stop working.') && act(() => api('/guide/regenerate', { method: 'POST' }));
}

// ---------- Money: profit and loss, expenses, payouts, lodging tax ----------
const mn = { tab: 'pnl', year: null, edit: null };
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const smoney = n => (n < 0 ? '−' : '') + money(Math.abs(n));
const moneyCell = n => Math.round(n) ? smoney(n) : '<span class="sub">–</span>';
function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function fileToDataUrl(file) {
  if (file.type.startsWith('image/')) return shrinkImage(file, 1800);
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
}

async function moneyView() {
  const live = stamp('money');
  const M = await api('/money?' + q(mn.year ? { year: mn.year } : {}));
  if (!live()) return;
  mn.year = M.year;
  const P = M.pnl, T = M.tax;
  const tabs = [['pnl', 'Profit & loss'], ['expenses', 'Expenses'], ['payouts', 'Payouts'], ['tax', 'Taxes']];
  const head = `<div class="toolbar"><div class="seg">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${mn.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${mn.tab !== 'payouts' ? `<select id="myear" aria-label="Year">${M.years.map(y => `<option ${y === M.year ? 'selected' : ''}>${y}</option>`).join('')}</select>` : ''}</div>`;
  const mlabel = m => MONTHS[+m.slice(5) - 1];
  let body = '';
  if (mn.tab === 'pnl') {
    const margin = P.total.net ? Math.round(P.total.profit / P.total.net * 100) : 0;
    const row = (label, vals, total, cls = '') => `<tr class="${cls}"><td>${label}</td>${vals.map((v, i) => `<td class="${P.months[i].future ? 'fut' : ''}">${moneyCell(v)}</td>`).join('')}<td><b>${moneyCell(total)}</b></td></tr>`;
    body = `<div class="grid">${kpi(`Income ${M.year}`, money(P.total.net), `${money(P.total.gross)} booked, ${money(P.total.fees)} channel fees`)}${kpi('Expenses', money(P.total.expenses), `${P.expenses.length} categories`)}
      ${kpi('Profit', `<span class="${P.total.profit < 0 ? 'bad' : ''}">${smoney(P.total.profit)}</span>`, `${margin}% of income`)}${kpi('Nights', P.total.nights, `${P.total.nights ? money(P.total.gross / P.total.nights) : '$0'} average per night`)}</div>
      <div class="card"><div class="toolbar"><h3 style="margin:0">By month</h3><span style="margin-left:auto"></span><button type="button" id="mcsv">Download CSV</button></div>
      <div class="tscroll"><table class="pv pnl"><tr><th></th>${P.months.map(m => `<th class="${m.future ? 'fut' : ''}">${mlabel(m.month)}</th>`).join('')}<th>Total</th></tr>
        ${row('<b>Booked</b>', P.months.map(m => m.gross), P.total.gross)}
        ${P.channels.map(c => row(`<span class="sub">${esc(c.channel)}</span>`, c.months, c.total, 'minor')).join('')}
        ${row('Channel fees', P.months.map(m => -m.fees), -P.total.fees)}
        ${row('<b>Income</b>', P.months.map(m => m.net), P.total.net, 'strong')}
        ${P.expenses.map(e => row(esc(e.category), e.months.map(v => -v), -e.total, 'minor')).join('')}
        ${row('<b>Expenses</b>', P.months.map(m => -m.expenses), -P.total.expenses, 'strong')}
        ${row('<b>Profit</b>', P.months.map(m => m.profit), P.total.profit, 'strong total')}</table></div>
      <div class="sub" style="margin-top:8px">Income is counted by night of stay (a stay crossing months counts partly in each), like the Dashboard. Channel fees are Beds24's commission where the channel reports it; for imported Guesty history, total minus payout. Faded months are still to come (bookings on the books and repeating expenses).</div></div>
      <form class="card stack" id="mset" style="max-width:none;margin-top:14px"><h3>Cleaning cost</h3>
        <label class="sub">Estimated cleaning cost per stay ($), counted at each checkout <input name="cleaningPerStay" type="number" min="0" step="1" value="${M.settings.cleaningPerStay ?? ''}" style="width:8em"></label>
        <div class="sub">Use this if you don't enter each Turno payment as an expense; leave empty if you do.</div><div><button class="primary">Save</button></div></form>`;
  } else if (mn.tab === 'expenses') {
    const e = mn.edit || { date: M.today, category: 'Supplies', amount: '', vendor: '', description: '', repeat: null, until: '', property_id: null };
    const total = M.expenses.reduce((a, x) => a + (x.repeat ? 0 : x.amount), 0);
    body = `<form class="card stack" id="mexp" style="max-width:none"><h3>${mn.edit ? 'Edit expense' : 'Add an expense'}</h3>
      <div class="toolbar" style="margin:0"><label class="sub">Date<br><input type="date" name="date" value="${esc(e.date)}" required></label>
        <label class="sub">Category<br><select name="category">${M.categories.map(c => `<option ${c === e.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="sub">Amount ($)<br><input type="number" name="amount" min="0.01" step="0.01" value="${e.amount}" required style="width:8em"></label>
        ${M.properties.length > 1 ? `<label class="sub">Property<br><select name="propertyId"><option value="">All properties</option>${M.properties.map(p => `<option value="${p.id}" ${p.id === e.property_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}</div>
      <div class="toolbar" style="margin:0"><label class="sub" style="flex:1">Vendor<br><input name="vendor" value="${esc(e.vendor)}" style="width:100%" placeholder="e.g. Turno, Rocky Mountain Power"></label>
        <label class="sub" style="flex:2">Note<br><input name="description" value="${esc(e.description)}" style="width:100%"></label></div>
      <div class="toolbar" style="margin:0"><label class="sub"><input type="checkbox" name="repeat" ${e.repeat ? 'checked' : ''}> Repeats monthly</label>
        <label class="sub">until (optional) <input type="date" name="until" value="${esc(e.until || '')}"></label>
        <label class="sub">Receipt (photo or PDF) <input type="file" name="receipt" accept="image/*,application/pdf"></label></div>
      <div class="toolbar" style="margin:0"><button class="primary">${mn.edit ? 'Save changes' : 'Add expense'}</button>${mn.edit ? '<button type="button" id="mcancel">Cancel</button>' : ''}</div></form>
      <div class="card" style="margin-top:14px"><div class="toolbar"><h3 style="margin:0">${M.year} expenses</h3><span class="sub">${money2(total)} one-off${M.expenses.some(x => x.repeat) ? ' plus monthly items' : ''}</span>
        <span style="margin-left:auto"></span><button type="button" id="mexpcsv">Download CSV</button></div>
      ${M.expenses.length ? `<div class="tscroll"><table class="pv"><tr><th>Date</th><th>Category</th><th>Vendor / note</th><th>Amount</th><th></th></tr>
        ${M.expenses.map(x => `<tr><td>${fmtDate(x.date)}${x.repeat ? ` <span class="chip">monthly${x.until ? ` to ${fmtDate(x.until)}` : ''}</span>` : ''}</td><td>${esc(x.category)}</td>
          <td>${esc(x.vendor)}${x.description ? `<div class="sub">${esc(x.description)}</div>` : ''}</td><td>${money2(x.amount)}</td>
          <td style="white-space:nowrap">${x.has_receipt ? `<a href="/api/money/receipt?id=${x.id}" target="_blank" rel="noopener">Receipt</a> · ` : ''}<a href="#" data-edit="${x.id}">Edit</a> · <a href="#" data-del="${x.id}">Delete</a></td></tr>`).join('')}</table></div>`
        : '<div class="empty">No expenses for this year yet.</div>'}</div>`;
  } else if (mn.tab === 'payouts') {
    const waiting = M.payouts.filter(p => p.status === 'waiting'), short = M.payouts.filter(p => p.status === 'short');
    body = `<div class="grid">${kpi('Not yet marked received', waiting.length, `${money(waiting.reduce((a, p) => a + p.expected, 0))} expected`)}${kpi('Paid short', short.length, short.length ? `${money2(short.reduce((a, p) => a + p.diff, 0))} in total` : 'None')}</div>
      <div class="card"><h3>Stays that checked out in the last 90 days</h3><div class="sub" style="margin-bottom:8px">Enter what actually reached your bank for each stay to catch missing or short payouts. Expected = booking total minus the channel's commission (where Beds24 reports it).</div>
      ${M.payouts.length ? `<div class="tscroll"><table class="pv"><tr><th>Guest</th><th>Checkout</th><th>Booked</th><th>Fees</th><th>Expected</th><th>Received</th><th></th></tr>
        ${M.payouts.map(p => `<tr data-id="${p.id}"><td>${esc(p.guest || 'Guest')} ${tag(p.channel)}</td><td>${fmtDate(p.departure)}</td><td>${money2(p.gross)}</td>
          <td>${p.feesKnown ? money2(p.fees) : '<span class="sub">not reported</span>'}</td><td><b>${money2(p.expected)}</b></td>
          <td><input type="number" step="0.01" min="0" value="${p.received ?? ''}" style="width:7.5em" placeholder="amount"> <input type="date" value="${esc(p.receivedOn || '')}"></td>
          <td>${{ ok: '<span class="chip set">matches</span>', short: `<span class="chip error">short ${money2(-p.diff)}</span>`, over: `<span class="chip set">+${money2(p.diff)}</span>`, waiting: '<span class="chip">waiting</span>' }[p.status]}
            <button type="button" class="msavep">Save</button></td></tr>`).join('')}</table></div>` : '<div class="empty">No checkouts in the last 90 days.</div>'}</div>`;
  } else {
    const S = T.settings;
    body = `<form class="card stack" id="mtax" style="max-width:none"><h3>Who collects lodging tax</h3>
      <div class="sub">Tick the channels that collect and pay the tax for you. Bookings on the others are yours to report. Check the current rules and rates for Wyoming and your city and county; this report is an estimate, not tax advice.</div>
      <div class="chips">${M.channels.map(c => `<label class="sub"><input type="checkbox" name="remit_${esc(c)}" ${S.remits[c] ? 'checked' : ''}> ${esc(c)} collects it</label>`).join('')}</div>
      <div class="sub">Tax rates you pay on the other bookings:</div>
      <div id="mrates">${(S.taxes.length ? S.taxes : [{ name: '', pct: '' }]).map(t => `<div class="toolbar rate" style="margin:0"><input placeholder="Name, e.g. State lodging tax" value="${esc(t.name)}" data-k="name" style="flex:1"><input type="number" step="0.01" min="0" max="30" placeholder="%" value="${t.pct}" data-k="pct" style="width:6em"> %<button type="button" class="rm">Remove</button></div>`).join('')}</div>
      <div class="toolbar" style="margin:0"><button type="button" id="maddrate">Add a rate</button><button class="primary">Save</button></div></form>
      <div class="card" style="margin-top:14px"><div class="toolbar"><h3 style="margin:0">${M.year}</h3><span class="sub">Revenue by night of stay</span><span style="margin-left:auto"></span><button type="button" id="mtaxcsv">Download CSV</button></div>
      <div class="grid">${T.quarters.map(qq => kpi(qq.quarter, money(qq.due), `on ${money(qq.owner)} you report`)).join('')}</div>
      <div class="tscroll"><table class="pv"><tr><th>Month</th><th>Collected by channels</th><th>You report</th>${S.taxes.map(t => `<th>${esc(t.name)} (${t.pct}%)</th>`).join('')}<th>Estimated due</th></tr>
        ${T.months.map(m => `<tr><td>${mlabel(m.month)}</td><td>${moneyCell(m.remitted)}</td><td>${moneyCell(m.owner)}</td>${m.byTax.map(x => `<td>${moneyCell(x.amount)}</td>`).join('')}<td><b>${moneyCell(m.due)}</b></td></tr>`).join('')}
        <tr class="total"><td><b>Total</b></td><td><b>${money(T.total.remitted)}</b></td><td><b>${money(T.total.owner)}</b></td>${S.taxes.map(() => '<td></td>').join('')}<td><b>${money(T.total.due)}</b></td></tr></table></div>
      ${!S.taxes.length ? '<div class="sub warn" style="margin-top:8px">Add your tax rates above to see what\'s due.</div>' : ''}</div>`;
  }
  view.innerHTML = head + body;

  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { mn.tab = b.dataset.tab; mn.edit = null; moneyView(); });
  if ($('#myear')) $('#myear').onchange = e => { mn.year = +e.target.value; moneyView(); };
  let busy = false;
  const done = async (fn, msg, after) => {
    if (busy) return;
    busy = true;
    const buttons = [...view.querySelectorAll('button:not(:disabled)')];
    buttons.forEach(b => { b.disabled = true; });
    try { await fn(); after?.(); await moneyView(); if (msg) banner(msg, 'ok'); }
    catch (err) { if (err.message !== 'login') banner(err.message, true); buttons.forEach(b => { b.disabled = false; }); }
    finally { busy = false; }
  };
  if (mn.tab === 'pnl') {
    $('#mcsv').onclick = () => downloadCsv(`profit-and-loss-${M.year}.csv`, [['', ...P.months.map(m => mlabel(m.month)), 'Total'],
      ['Booked', ...P.months.map(m => m.gross), P.total.gross], ['Channel fees', ...P.months.map(m => -m.fees), -P.total.fees], ['Income', ...P.months.map(m => m.net), P.total.net],
      ...P.expenses.map(x => [x.category, ...x.months.map(v => -v), -x.total]), ['Expenses', ...P.months.map(m => -m.expenses), -P.total.expenses], ['Profit', ...P.months.map(m => m.profit), P.total.profit]]);
    $('#mset').onsubmit = e => { e.preventDefault(); done(() => api('/money/settings', { method: 'POST', body: { cleaningPerStay: e.target.cleaningPerStay.value } }), 'Saved.'); };
  }
  if (mn.tab === 'expenses') {
    $('#mexp').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, file = f.receipt.files[0];
      const body = { id: mn.edit?.id, date: f.date.value, category: f.category.value, amount: f.amount.value, vendor: f.vendor.value, description: f.description.value,
        repeat: f.repeat.checked ? 'monthly' : null, until: f.until.value, propertyId: f.propertyId?.value ?? null };
      try { if (file) body.receipt = await fileToDataUrl(file); } catch { return banner('Couldn\'t read that receipt.', true); }
      // The edit is only cleared once it's saved: a failed save retried must update, not add a second expense.
      done(() => api('/money/expense', { method: 'POST', body }), mn.edit ? 'Expense updated.' : 'Expense added.', () => { mn.edit = null; });
    };
    if ($('#mcancel')) $('#mcancel').onclick = () => { mn.edit = null; moneyView(); };
    view.querySelectorAll('[data-edit]').forEach(a => a.onclick = ev => { ev.preventDefault(); mn.edit = M.expenses.find(x => x.id === +a.dataset.edit); moneyView(); });
    view.querySelectorAll('[data-del]').forEach(a => a.onclick = ev => { ev.preventDefault(); if (confirm('Delete this expense?')) done(() => api('/money/expense/delete', { method: 'POST', body: { id: +a.dataset.del } }), 'Deleted.'); });
    $('#mexpcsv').onclick = () => downloadCsv(`expenses-${M.year}.csv`, [['Date', 'Category', 'Vendor', 'Note', 'Amount', 'Repeats', 'Until'],
      ...M.expenses.map(x => [x.date, x.category, x.vendor, x.description, x.amount, x.repeat || '', x.until || ''])]);
  }
  if (mn.tab === 'payouts') view.querySelectorAll('.msavep').forEach(b => b.onclick = () => {
    const tr = b.closest('tr'), [amt, on] = tr.querySelectorAll('input');
    done(() => api('/money/payout', { method: 'POST', body: { bookingId: +tr.dataset.id, amount: amt.value, receivedOn: on.value } }), amt.value ? 'Payout saved.' : 'Cleared.');
  });
  if (mn.tab === 'tax') {
    const wire = () => view.querySelectorAll('.rate .rm').forEach(b => b.onclick = () => b.closest('.rate').remove());
    wire();
    $('#maddrate').onclick = () => { $('#mrates').insertAdjacentHTML('beforeend', '<div class="toolbar rate" style="margin:0"><input placeholder="Name" data-k="name" style="flex:1"><input type="number" step="0.01" min="0" max="30" placeholder="%" data-k="pct" style="width:6em"> %<button type="button" class="rm">Remove</button></div>'); wire(); };
    $('#mtax').onsubmit = e => {
      e.preventDefault();
      const remits = Object.fromEntries(M.channels.map(c => [c, e.target.elements[`remit_${c}`].checked]));
      const taxes = [...view.querySelectorAll('.rate')].map(r => ({ name: r.querySelector('[data-k=name]').value, pct: r.querySelector('[data-k=pct]').value })).filter(t => t.name || t.pct);
      done(() => api('/money/settings', { method: 'POST', body: { remits, taxes } }), 'Tax settings saved.');
    };
    $('#mtaxcsv').onclick = () => downloadCsv(`lodging-tax-${M.year}.csv`, [['Month', 'Collected by channels', 'You report', ...T.settings.taxes.map(t => `${t.name} (${t.pct}%)`), 'Estimated due'],
      ...T.months.map(m => [m.month, m.remitted, m.owner, ...m.byTax.map(x => x.amount), m.due])]);
  }
}

// Runs a change, then reloads. While it runs the page's buttons are disabled, so a double tap can't submit twice.
// Whatever happens, buttons still on the page come back: a reload that fails must not leave the page dead.
let acting = false;
async function act(fn) {
  if (acting) return;
  acting = true;
  takeDrafts(submitting);
  const btn = $('#sync'), buttons = [...view.querySelectorAll('button:not(:disabled)')];
  btn.disabled = true; buttons.forEach(b => { b.disabled = true; }); banner('Working…');
  try { await fn(); banner(''); await boot(true); }
  catch (e) { if (e.message !== 'login') banner(e.message, true); }
  finally { buttons.forEach(b => { if (b.isConnected) b.disabled = false; }); btn.disabled = false; acting = false; }
}

const routes = { '': dashboard, calendar: calendarView, inbox: inboxView, automations: automationsView, bookings: bookingsView, analytics: analyticsView, home: homeView, site: siteView, guide: guideView, money: moneyView, listing: listingView, rates: ratesView, pricing: pricingView, cleaning: cleaningView, locks: locksView, settings: settingsView };
async function render() {
  // #/inbox/123 (from a phone notification, or a thread opened from the list) is that conversation; #/inbox is the list.
  const [r, arg] = routeOf();
  if (r === 'inbox') inbox.booking = /^\d+$/.test(arg || '') ? +arg : null;
  clearInterval(pageTimer); pageTimer = null;
  renderSeq++;
  document.querySelectorAll('a[data-r]').forEach(a => a.classList.toggle('on', a.dataset.r === r));
  setMenu(false);
  try {
    // Nothing to show until Beds24 is connected or demo data is loaded; a connected account with no stays yet is fine.
    if (status.empty && !status.connected && !status.demo && r !== 'settings') return location.hash = '#/settings';
    await (routes[r] || dashboard)();
    restoreDrafts(r);
    banner(stickyBanner, true);   // the page is up: an earlier page's error has had its say
  } catch (e) { if (e.message !== 'login') banner(e.message, true); }
  finally { drafts = null; }
}

async function boot(keepProp) {
  try {
    status = await api('/status');
    document.body.classList.remove('signed-out');
    setUnread(status.unreadMessages || 0);
    const cur = prop();
    const props = await api('/properties');
    $('#prop').innerHTML = '<option value="">All properties</option>' + props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (keepProp) $('#prop').value = cur;
    $('#prop').hidden = props.length < 2;   // nothing to filter with a single property
    stickyBanner = status.lastSyncError ? 'Last sync failed: ' + status.lastSyncError : '';
    banner(stickyBanner, true);
    await render();
  } catch (e) { if (e.message !== 'login') banner(e.message, true); }
}

// A request that fails in a handler with no catch of its own (a ‹ › tap while offline) still gets the banner; being
// signed out or having moved on are not errors.
window.onunhandledrejection = e => { const m = e.reason?.message; if (!m) return; if (m === 'login' || m === 'stale') e.preventDefault(); else banner(m, true); };

// Phone menu: the sidebar slides in; it closes on navigation, the backdrop, or Escape.
function setMenu(open) {
  $('#side').classList.toggle('open', open);
  $('#scrim').hidden = !open;
  $('#menubtn').setAttribute('aria-expanded', String(open));
}
$('#menubtn').onclick = () => setMenu(!$('#side').classList.contains('open'));
$('#scrim').onclick = () => setMenu(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
$('#side').addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
$('#sync').onclick = () => status.connected ? act(() => api('/sync', { method: 'POST' })) : (location.hash = '#/settings');
$('#prop').onchange = render;
window.onhashchange = render;
boot();
