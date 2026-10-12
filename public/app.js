const $ = s => document.querySelector(s);
const view = $('#view');
const money = n => '$' + Math.round(n).toLocaleString();
const pct = n => (n * 100).toFixed(0) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString(undefined, {
  month: 'short', day: 'numeric', timeZone: 'UTC', ...(s.slice(0, 4) !== String(new Date().getFullYear()) && { year: 'numeric' }) });
const tag = t => `<span class="tag ${esc(t)}">${esc(t)}</span>`;
let status = {};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { ...opts, body: opts.body && JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'Login required') { showLogin(); throw new Error('login'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const prop = () => $('#prop').value;
const q = (extra = {}) => new URLSearchParams({ ...(prop() && { property: prop() }), ...extra }).toString();

// kind: true/'err' = problem, 'ok' = success, otherwise a neutral notice.
function banner(msg, kind) { const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; b.className = kind === true || kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''; }

function showLogin() {
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
  const c = await api('/calendar?' + q({ start: gridStart, days: weeks * 7 }));
  const rooms = c.rooms;
  if (calState.room && !rooms.some(r => String(r.id) === calState.room)) calState.room = '';
  const inView = calState.room ? rooms.filter(r => String(r.id) === calState.room) : rooms;
  const roomIds = new Set(inView.map(r => r.id));
  const bookings = c.bookings.filter(b => roomIds.has(b.room_id));
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
      return `<div class="${cls}" data-bid="${b.id}" style="left:${s0 / 14 * 100}%;width:${(e0 - s0) / 14 * 100}%;top:${26 + lane * 24}px"
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
      ${rooms.length > 1 ? `<select id="croom"><option value="">All rooms</option>${rooms.map(r => `<option value="${r.id}" ${String(r.id) === calState.room ? 'selected' : ''}>${esc(r.property_name)} · ${esc(r.name)}</option>`).join('')}</select>` : ''}
      <span class="sub" style="margin-left:auto">${booked} of ${available} nights booked (${available ? Math.round(booked / available * 100) : 0}%) · ${money(revenue)}</span>
    </div>
    <div class="mcal"><div class="mhead">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>${html}</div>
    <div class="legend sub">${['Airbnb', 'Booking.com', 'VRBO', 'Direct', 'Other'].map(ch => `<span><i class="sw ${ch}"></i>${ch}</span>`).join('')}
      <span><i class="sw block"></i>Blocked</span><span><i class="sw request"></i>Request</span>${Object.keys(night).length ? '<span>Nightly prices from the Rates page</span>' : ''}</div>
  </div>
  ${sel ? `<div class="card" style="margin-top:14px" id="cdetail">
    <div class="toolbar" style="margin:0"><h3 style="margin:0">${sel.status === 'block' ? 'Blocked dates' : esc(sel.guest_name || 'Guest')}</h3>${sel.status === 'block' ? '' : tag(sel.channel) + ' ' + tag(sel.status)}<button id="cclose" style="margin-left:auto">Close</button></div>
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
  view.querySelectorAll('.mbar[data-bid]').forEach(el => el.onclick = () => {
    calState.selected = calState.selected === +el.dataset.bid ? null : +el.dataset.bid;
    calendarView().then(() => $('#cdetail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
  if ($('#cclose')) $('#cclose').onclick = () => { calState.selected = null; calendarView(); };
}

async function bookingsView() {
  view.innerHTML = `<div class="toolbar"><input id="bq" placeholder="Search guest, email, ref…" size="28">
    <select id="bs"><option value="">Any status</option><option>confirmed</option><option>new</option><option>request</option><option>inquiry</option><option>cancelled</option><option>block</option></select>
    <select id="bc"><option value="">Any channel</option><option>Airbnb</option><option>Booking.com</option><option>VRBO</option><option>Direct</option></select></div>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>Guest</th><th>Property / room</th><th>Dates</th><th>Nights</th><th>Guests</th><th>Channel</th><th>Status</th><th>Total</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  const load = async () => {
    const rows = await api('/bookings?' + q({ q: $('#bq').value, status: $('#bs').value, channel: $('#bc').value }));
    $('#rows').innerHTML = rows.map(b => `<tr title="${esc(b.notes || '')}"><td>${esc(b.guest_name || '—')}<div class="sub">${esc(b.email || '')}</div></td>
      <td>${esc(b.property_name)}<div class="sub">${esc(b.room_name)}</div></td><td>${fmtDate(b.arrival)} → ${fmtDate(b.departure)}</td><td>${b.nights}</td>
      <td>${b.adults + b.children}</td><td>${tag(b.channel)}${b.source === 'guesty' ? ' <span class="sub" title="Imported from Guesty history">Guesty</span>' : ''}</td><td>${tag(b.status)}</td><td>${money(b.price)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No bookings</td></tr>';
  };
  let t; $('#bq').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $('#bs').onchange = $('#bc').onchange = load;
  await load();
}

async function settingsView() {
  status = await api('/status');
  view.innerHTML = `<div class="card stack"><h3>Beds24 connection</h3>
    <div>${status.connected ? '✅ Connected' : 'Not connected'}${status.demo ? ' · <b>demo data loaded</b>' : ''}</div>
    <div class="sub">Last sync: ${status.lastSync ? new Date(status.lastSync).toLocaleString() : 'never'}${status.lastSyncError ? ' · error: ' + esc(status.lastSyncError) : ''}</div>
    <form class="stack" id="cf"><div class="sub">In Beds24: Settings → Apps &amp; Integrations → API → Invite codes. Create a code with access to properties, bookings (including guest personal and financial details, or names and totals come back blank) and inventory, then paste it here. Give <b>write</b> access to inventory (to change prices on the Rates page) and to bookings (to save door codes on bookings). Pasting a new code replaces the old one.</div>
      ${status.scopes ? `<div class="sub">Current permissions: ${esc(status.scopes.join(', ') || 'none reported')}</div>` : ''}
      <input name="code" placeholder="Invite code" autocomplete="off"><button class="primary">Connect &amp; sync</button></form>
    ${status.connected ? '<button id="dc">Disconnect</button>' : ''}
    ${status.demo ? '<hr><button id="cleardemo">Clear demo data</button>'
      : status.connected ? '' : '<hr><button id="demo">Load demo data</button><div class="sub">Fills the app with sample properties and bookings so you can try it before connecting. Connecting to Beds24 removes it automatically.</div>'}
    ${status.auth ? '<hr><button id="lo">Sign out</button>' : ''}</div>
    <div class="card stack" style="margin-top:14px"><h3>Import history from Guesty</h3>
      <div class="sub">In Guesty: Reservation report → Columns (turn everything on) → download CSV (it arrives by email). Choose that file here; you'll see a preview before anything is saved.
        Guest addresses, IDs and door key codes in the file are ignored.</div>
      ${status.guestyImported ? `<div>${status.guestyImported} bookings imported from Guesty. <button id="rmg">Remove Guesty import</button></div>` : ''}
      <input type="file" id="gfile" accept=".csv,text/csv"><div id="gprev"></div></div>`;
  $('#cf').onsubmit = async e => { e.preventDefault(); await act(() => api('/connect', { method: 'POST', body: { inviteCode: e.target.code.value } })); };
  if ($('#demo')) $('#demo').onclick = () => act(() => api('/demo', { method: 'POST' }));
  if ($('#cleardemo')) $('#cleardemo').onclick = () => act(() => api('/demo/clear', { method: 'POST' }));
  if ($('#lo')) $('#lo').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };
  if ($('#dc')) $('#dc').onclick = () => act(() => api('/disconnect', { method: 'POST' }));
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
const todayISO = () => new Date().toISOString().slice(0, 10);
const addMonths = (m, n) => { const d = new Date(m + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

async function ratesView() {
  const today = todayISO();
  ratesState.start ||= today.slice(0, 8) + '01';
  const r = await api('/rates?' + q({ start: ratesState.start, days: 62, ...(ratesState.room && { room: ratesState.room }) }));
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
      cells += `<div class="${cls}" data-date="${date}" title="${esc(d.booking ? `${d.booking.guest || 'Booking'} (${d.booking.channel})` : '')}">
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
        ${r.rooms.length > 1 ? `<select id="rroom">${r.rooms.map(x => `<option value="${x.id}" ${x.id === r.room.id ? 'selected' : ''}>${esc(x.property_name)} · ${esc(x.name)}</option>`).join('')}</select>` : `<b>${esc(r.room.property_name)}</b>`}
        <button id="rprev">‹</button><button id="rtoday">Today</button><button id="rnext">›</button>
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
  view.querySelectorAll('.day[data-date]').forEach(el => el.onclick = () => {
    const d = el.dataset.date;
    if (d < today) return;
    ratesState.form = readForm();
    if (!ratesState.from || ratesState.to) { ratesState.from = d; ratesState.to = null; }
    else if (d < ratesState.from) { ratesState.to = ratesState.from; ratesState.from = d; }
    else ratesState.to = d;
    ratesView();
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
        <td>${esc(l.name)}</td><td>${l.online ? '<span class="ok">● Online</span>' : '<span class="bad">● Offline</span>'}</td>
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
        ${L.locks.map(l => `<label class="sub"><input type="checkbox" name="dev" value="${esc(l.device_id)}" checked> ${esc(l.name)}</label>`).join('')}
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
  view.innerHTML = `<div class="inbox ${inbox.booking ? 'has-thread' : ''}">
    <div class="card convs"><div class="toolbar" style="margin-bottom:6px">
      <select id="ifilter">${[['all', 'All'], ['unread', 'Unread'], ['upcoming', 'Current & upcoming'], ['inquiries', 'Inquiries']].map(([v, l]) => `<option value="${v}" ${inbox.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="iq" placeholder="Search" value="${esc(inbox.q)}" style="flex:1;min-width:0"></div>
      <div id="ilist"></div></div>
    <div class="card tpane" id="ithread">${inbox.booking ? '' : '<div class="empty" style="padding:40px;text-align:center">Choose a conversation</div>'}</div></div>`;
  $('#ifilter').onchange = e => { inbox.filter = e.target.value; loadList(); };
  let t; $('#iq').oninput = e => { clearTimeout(t); t = setTimeout(() => { inbox.q = e.target.value; loadList(); }, 250); };
  await loadList();
  if (inbox.booking) await openThread(inbox.booking);
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
      <span class="top"><b>${esc(c.guest_name || `Booking ${c.booking_id}`)}</b> ${c.channel ? tag(c.channel) : ''}${c.status === 'inquiry' ? ' <span class="tag request">inquiry</span>' : ''}<span class="sub when">${timeAgo(c.last_time)}</span></span>
      <span class="sub">${c.arrival ? `${fmtDate(c.arrival)} → ${fmtDate(c.departure)}` : ''}${c.unread ? ` · <b class="ucount">${c.unread} new</b>` : ''}</span>
      <span class="snip">${c.last_source === 'host' ? 'You: ' : ''}${esc((c.last_body || '').slice(0, 90))}</span></button>`).join('')
    : `<div class="empty" style="padding:20px">${r.connected ? 'No messages yet. New guest messages from Airbnb, Booking.com and VRBO appear here.' : 'Connect Beds24 in Settings to see guest messages.'}</div>`);
  list.querySelectorAll('[data-conv]').forEach(el => el.onclick = () => openThread(+el.dataset.conv));
}

async function openThread(id) {
  inbox.booking = id;
  document.querySelector('.inbox')?.classList.add('has-thread');
  document.querySelectorAll('.conv').forEach(el => el.classList.toggle('on', +el.dataset.conv === id));
  const th = await api('/inbox/thread?booking=' + id);
  inbox.replies ||= await api('/replies');
  renderThread(th);
  if (th.messages.some(m => m.source === 'guest' && !m.read)) {
    api('/inbox/read', { method: 'POST', body: { bookingId: id } }).then(loadList).catch(() => {});
  }
}

async function loadThreadMessages(id) {
  const th = await api('/inbox/thread?booking=' + id);
  if (inbox.booking === id && $('#imsgs')) { $('#imsgs').innerHTML = messagesHtml(th); scrollThread(); }
}

const scrollThread = () => { const m = $('#imsgs'); if (m) m.scrollTop = m.scrollHeight; };
const messagesHtml = th => th.messages.map(m => {
  const who = { guest: th.booking?.guest_name?.split(' ')[0] || 'Guest', host: 'You', system: 'Channel notice', internalNote: 'Internal note' }[m.source] || m.source;
  const att = m.attachment_name ? `<a class="att" href="/api/inbox/attachment?id=${m.id}" target="_blank" rel="noopener">📎 ${esc(m.attachment_name)}</a>` : '';
  return `<div class="msg ${m.source}"><div class="bubble">${esc(m.body).replace(/\n/g, '<br>')}${att}</div>
    <div class="meta">${esc(who)} · ${new Date(m.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>`;
}).join('') || '<div class="empty" style="text-align:center;padding:20px">No messages in this conversation yet.</div>';

function renderThread(th) {
  const b = th.booking, pane = $('#ithread');
  if (!pane) return;
  const channelNote = !b ? '' : b.channel === 'Booking.com' ? 'Booking.com doesn\'t allow links in messages.'
    : b.channel === 'Direct' ? 'Direct bookings: Beds24 may not notify the guest of this message. Email or text them if it\'s urgent.'
    : `Sent to the guest's ${esc(b.channel)} message thread.`;
  pane.innerHTML = `
    <div class="thead"><button class="back" id="iback">‹</button>
      <div><b>${esc(b?.guest_name || `Booking ${inbox.booking}`)}</b> ${b ? tag(b.channel) + ' ' + tag(b.status) : ''}
      <div class="sub">${b ? `${fmtDate(b.arrival)} → ${fmtDate(b.departure)} · ${b.nights} night${b.nights === 1 ? '' : 's'}${(b.adults || 0) + (b.children || 0) ? ` · ${(b.adults || 0) + (b.children || 0)} guests` : ''}${b.property_name ? ' · ' + esc(b.property_name) : ''}` : ''}
        ${th.door ? ` · 🔑 <b class="code">${esc(th.door.code)}</b>` : ''}</div></div>
      <button id="ireload" title="Check for new messages" style="margin-left:auto">↻</button></div>
    <div class="msgs" id="imsgs">${messagesHtml(th)}</div>
    ${th.canReply ? `<div class="composer">
      <div class="toolbar" style="margin:0 0 6px"><select id="ireply"><option value="">Insert saved reply…</option>${inbox.replies.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select>
        <a href="#" id="imanage" class="sub">${inbox.manage ? 'Hide saved replies' : 'Edit saved replies'}</a></div>
      <textarea id="itext" rows="4" maxlength="5000" placeholder="Write a reply…">${esc(inbox.drafts[inbox.booking] || '')}</textarea>
      <div class="toolbar" style="margin:6px 0 0"><span class="sub" id="inote">${channelNote}</span>
        <span class="sub" id="icount" style="margin-left:auto"></span><button class="primary" id="isend">Send</button></div>
      <div id="imgr"></div></div>`
    : `<div class="sub" style="padding:10px">${b ? 'Replies can only be sent on Beds24 bookings (this one was imported from Guesty).' : 'This booking isn\'t in the app yet; press Sync.'}</div>`}`;
  scrollThread();
  $('#iback').onclick = () => { inbox.booking = null; document.querySelector('.inbox')?.classList.remove('has-thread'); };
  $('#ireload').onclick = async () => { const t2 = await api('/inbox/reload', { method: 'POST', body: { bookingId: inbox.booking } }); $('#imsgs').innerHTML = messagesHtml(t2); scrollThread(); };
  if (!th.canReply) return;
  const ta = $('#itext');
  const count = () => { $('#icount').textContent = ta.value.length > 4000 ? `${ta.value.length}/5000` : ''; inbox.drafts[inbox.booking] = ta.value; };
  ta.oninput = count; count();
  // Unfilled {placeholders} are left visible so they get noticed before sending.
  $('#ireply').onchange = e => {
    const r = inbox.replies.find(x => x.id === +e.target.value);
    if (r) { ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n\n' : '') + fill(r.body, th.vars); count(); ta.focus(); }
    e.target.value = '';
  };
  ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#isend').click(); };
  $('#isend').onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (/\{\w+\}/.test(text) && !confirm('The message still has a {placeholder} in it. Send anyway?')) return;
    $('#isend').disabled = true; $('#isend').textContent = 'Sending…';
    try {
      const t2 = await api('/inbox/send', { method: 'POST', body: { bookingId: inbox.booking, message: text } });
      inbox.drafts[inbox.booking] = '';
      renderThread(t2); loadList();
    } catch (err) {
      if (err.message === 'login') return;
      $('#inote').innerHTML = `<span class="bad">${esc(err.message)}</span>`;
      $('#isend').disabled = false; $('#isend').textContent = 'Try again';
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
    if (confirm(`Delete the saved reply "${r.title}"?`)) { await api('/replies/delete', { method: 'POST', body: { id: r.id } }); await reload(); }
  });
}

async function act(fn) {
  const btn = $('#sync'); btn.disabled = true; banner('Working…');
  try { await fn(); banner(''); await boot(true); } catch (e) { if (e.message !== 'login') banner(e.message, true); }
  btn.disabled = false;
}

const routes = { '': dashboard, calendar: calendarView, inbox: inboxView, bookings: bookingsView, rates: ratesView, locks: locksView, settings: settingsView };
async function render() {
  const r = location.hash.replace(/^#\/?/, '');
  clearInterval(pageTimer); pageTimer = null;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r));
  try {
    if (status.empty && r !== 'settings') return location.hash = '#/settings';
    await (routes[r] || dashboard)();
  } catch (e) { if (e.message !== 'login') banner(e.message, true); }
}

async function boot(keepProp) {
  try {
    status = await api('/status');
    setUnread(status.unreadMessages || 0);
    const cur = prop();
    const props = await api('/properties');
    $('#prop').innerHTML = '<option value="">All properties</option>' + props.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (keepProp) $('#prop').value = cur;
    banner(status.lastSyncError ? 'Last sync failed: ' + status.lastSyncError : '', true);
    render();
  } catch (e) { if (e.message !== 'login') banner(e.message, true); }
}

$('#sync').onclick = () => status.connected ? act(() => api('/sync', { method: 'POST' })) : (location.hash = '#/settings');
$('#prop').onchange = render;
window.onhashchange = render;
boot();
