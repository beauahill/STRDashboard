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

async function calendarView() {
  const days = 30;
  const start = new Date().toISOString().slice(0, 10);
  const c = await api('/calendar?' + q({ start, days }));
  const col = d => Math.round((Date.parse(d) - Date.parse(c.start)) / 86400000);
  const dayCells = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(c.start) + i * 86400000);
    return `<div class="cal-day ${i === 0 ? 'today' : ''}">${d.getUTCDate()}</div>`;
  }).join('');
  const track = `grid-template-columns:repeat(${days},minmax(34px,1fr))`;
  const rows = c.rooms.map(r => {
    const bars = c.bookings.filter(b => b.room_id === r.id).map(b => {
      const from = Math.max(col(b.arrival), 0), to = Math.min(col(b.departure), days);
      // Bars start/end at mid-day so same-day turnovers don't overlap.
      const left = ((from + (col(b.arrival) >= 0 ? 0.5 : 0)) / days) * 100, right = ((to - (col(b.departure) <= days ? 0.5 : 0)) / days) * 100;
      const cls = b.status === 'block' ? 'block' : b.status === 'request' ? `request ${b.channel}` : b.channel;
      return `<div class="cal-bar ${cls}" style="left:${left}%;width:${right - left}%" title="${esc(b.guest_name)} · ${b.arrival} → ${b.departure} · ${money(b.price)}">${esc(b.status === 'block' ? 'Blocked' : b.guest_name)}</div>`;
    }).join('');
    return `<div class="cal-row"><div class="cal-name">${esc(r.name)}<small>${esc(r.property_name)}</small></div><div class="cal-track" style="${track}">${bars}</div></div>`;
  }).join('');
  view.innerHTML = `<div class="cal"><div class="cal-row"><div class="cal-name">Next ${days} days</div><div class="cal-track" style="${track}">${dayCells}</div></div>${rows || '<div class="card empty">No rooms yet</div>'}</div>`;
}

async function bookingsView() {
  view.innerHTML = `<div class="toolbar"><input id="bq" placeholder="Search guest, email, ref…" size="28">
    <select id="bs"><option value="">Any status</option><option>confirmed</option><option>new</option><option>request</option><option>cancelled</option><option>block</option></select>
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

async function act(fn) {
  const btn = $('#sync'); btn.disabled = true; banner('Working…');
  try { await fn(); banner(''); await boot(true); } catch (e) { if (e.message !== 'login') banner(e.message, true); }
  btn.disabled = false;
}

const routes = { '': dashboard, calendar: calendarView, bookings: bookingsView, rates: ratesView, locks: locksView, settings: settingsView };
async function render() {
  const r = location.hash.replace(/^#\/?/, '');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r));
  try {
    if (status.empty && r !== 'settings') return location.hash = '#/settings';
    await (routes[r] || dashboard)();
  } catch (e) { if (e.message !== 'login') banner(e.message, true); }
}

async function boot(keepProp) {
  try {
    status = await api('/status');
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
