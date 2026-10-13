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
    ${status.auth ? '<hr><button id="lo">Sign out</button>' : ''}</div>
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
  if ($('#lo')) $('#lo').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };
  if ($('#dc')) $('#dc').onclick = () => act(() => api('/disconnect', { method: 'POST' }));
  $('#ncopy').onclick = async () => {
    try { await navigator.clipboard.writeText(NS.topic); $('#ncopy').textContent = 'Copied'; }
    catch { getSelection().selectAllChildren($('#ntopic')); }
  };
  $('#nform').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, body = Object.fromEntries(['enabled', 'messages', 'bookings', 'cancellations', 'problems', 'preview'].map(k => [k, f.elements[k].checked]));
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
      ${status.ai ? `<div class="toolbar" style="margin:0 0 6px"><input id="iaihint" placeholder="Anything the draft should say? (optional)" style="flex:1;min-width:0" maxlength="2000">
        <button type="button" id="iai">✨ Draft reply</button></div>` : ''}
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
  // AI draft: replaces the reply box (with undo); nothing is sent until Send is pressed.
  if ($('#iai')) $('#iai').onclick = async () => {
    const btn = $('#iai'), booking = inbox.booking, before = ta.value;
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

// ---------- Pricing tool ----------
const pr = { month: null, room: null, selected: null, open: { settings: false, events: false }, ai: { html: '', busy: false } };
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pctStr = v => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`;

async function pricingView() {
  const today = todayISO();
  pr.month ||= today.slice(0, 8) + '01';
  const P = await api('/pricing?' + q({ start: pr.month, days: 62, ...(pr.room && { room: pr.room }) }));
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
      if (n.booked || n.blocked) {
        cells += `<div class="day ${n.blocked ? 'blocked' : 'booked ' + (n.booking?.channel || '')}"><div class="n">${i}</div><div class="m">${n.blocked ? 'Blocked' : esc((n.booking?.guest || 'Booked').split(' ')[0])}</div></div>`;
        continue;
      }
      const up = n.current != null && n.price > n.current, down = n.current != null && n.price < n.current;
      cells += `<div class="day pday ${pr.selected === date ? 'sel' : ''} ${n.event ? 'event' : ''}" data-pdate="${date}" title="${esc(n.event || '')}">
        <div class="n">${i}${n.event ? ' <span class="evdot">●</span>' : ''}${n.gap ? ' <span class="gapb">gap</span>' : ''}</div>
        <div class="p">${money(n.price)}</div>
        <div class="m">${n.current == null ? 'not set' : up || down ? `<span class="${up ? 'ok' : 'bad'}">${up ? '▲' : '▼'}</span> now ${money(n.current)}` : '✓ set'}</div></div>`;
    }
    return `<div class="month"><h4>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h4>
      <div class="mgrid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div></div>`;
  };
  const sel = pr.selected && byDate[pr.selected];
  const pendRow = (label, p, days) => p ? `<tr><td>${label}</td><td>${p.nights ? `<b>${p.nights}</b> night${p.nights === 1 ? '' : 's'}` : '<span class="ok">Up to date</span>'}</td>
    <td class="sub">${p.nights ? `avg ${p.avgNow != null ? money(p.avgNow) : 'not set'} → ${money(p.avgNew)}` : ''}</td>
    <td>${p.nights ? `<button data-apply="${days}" ${P.canWrite ? '' : 'disabled'}>Apply</button>` : ''}</td></tr>` : '';
  const paceRows = Object.entries(P.pace).slice(0, 6).map(([m, v]) => `<tr><td>${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</td><td>${Math.round(v.now * 100)}%</td>
    <td>${v.lastYear == null ? '<span class="sub">no history</span>' : Math.round(v.lastYear * 100) + '%'}</td>
    <td>${v.lastYear == null || !S.pacing ? '–' : (() => { const a = Math.max(-S.pacingMax, Math.min(S.pacingMax, (v.now - v.lastYear) * 25)); return Math.abs(a) >= 1 ? pctStr(a) : '0%'; })()}</td></tr>`).join('');

  view.innerHTML = `${notice ? `<div class="notice">${notice}</div>` : ''}${P.error ? `<div class="notice">Auto-pricing problem: ${esc(P.error)}</div>` : ''}
  ${P.needsBase ? `<div class="card stack" style="max-width:620px;margin-bottom:14px"><h3>Start here</h3>
    <div>Set a <b>base price</b>: your normal weeknight rate before any adjustments. Everything else builds on it.</div>
    <div class="sub">Not sure? <b>Suggest from my history</b> works it out from your past stays (including the Guesty import).</div></div>` : ''}
  <div class="rates">
    <div class="card">
      <div class="toolbar">${P.rooms.length > 1 ? `<select id="proom">${P.rooms.map(r => `<option value="${r.id}" ${r.id === P.room.id ? 'selected' : ''}>${esc(r.property_name)} · ${esc(r.name)}</option>`).join('')}</select>` : `<b>${esc(P.room.property_name)}</b>`}
        <button id="pprev">‹</button><button id="ptoday">Today</button><button id="pnext">›</button>
        <span class="sub">Recommended price per night. ▲▼ = differs from Beds24 now. Click a night to see why.</span></div>
      ${P.needsBase ? '<div class="empty">Recommendations appear once a base price is set.</div>' : `<div class="months">${[pr.month, addMonths(pr.month, 1)].map(monthGrid).join('')}</div>`}
    </div>
    <div class="stack" style="max-width:none">
      ${sel ? `<div class="card"><h3>${new Date(sel.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</h3>
        <table class="pv">${sel.factors.map(f => `<tr><td>${esc(f.label)}</td><td style="text-align:right">${f.value != null ? money(f.value) : pctStr(f.pct)}</td></tr>`).join('')}
        ${sel.notes.map(n => `<tr><td colspan="2" class="sub">${esc(n)}</td></tr>`).join('')}
        <tr><td><b>Recommended</b></td><td style="text-align:right"><b>${money(sel.price)}</b></td></tr>
        <tr><td>In Beds24 now</td><td style="text-align:right">${sel.current != null ? money(sel.current) : '—'}</td></tr>
        <tr><td>Minimum stay</td><td style="text-align:right">${sel.minStay} night${sel.minStay === 1 ? '' : 's'}${sel.currentMinStay != null && sel.currentMinStay !== sel.minStay ? ` <span class="sub">(now ${sel.currentMinStay})</span>` : ''}</td></tr></table></div>` : ''}
      ${P.needsBase ? '' : `<div class="card"><h3>✨ AI pricing review</h3>${status.ai ? `
        <div class="toolbar" style="margin:0 0 6px"><button id="paireview" ${pr.ai.busy ? 'disabled' : ''}>Review next 90 days</button>${sel ? `<button id="painight" ${pr.ai.busy ? 'disabled' : ''}>Explain ${fmtDate(sel.date)}</button>` : ''}</div>
        <form id="paiform" class="toolbar" style="margin:0"><input name="q" placeholder="Or ask, e.g. Is my weekend premium too low?" style="flex:1;min-width:0" maxlength="1000"><button ${pr.ai.busy ? 'disabled' : ''}>Ask</button></form>
        <div id="paiout" class="aianswer">${pr.ai.html}</div><div class="sub">Advice only: nothing changes in Beds24 unless you apply it.</div>`
        : aiSetup('Get a second opinion on these prices, or ask why a night is priced the way it is.')}</div>`}
      ${P.pending ? `<div class="card"><h3>Apply to Beds24</h3><table class="pv">
        ${pendRow('Next 30 days', P.pending.d30, 30)}${pendRow('Next 90 days', P.pending.d90, 90)}${pendRow('Next 12 months', P.pending.d365, 365)}</table>
        <label class="sub"><input type="checkbox" id="pmin" checked> Also set minimum stays (events and gap nights)</label>
        <div class="sub">Only unbooked, unblocked nights change. Each save is checked against Beds24 afterwards and logged on the Rates page.</div>
        <hr><label><input type="checkbox" id="pauto" ${S.auto ? 'checked' : ''}> <b>Auto-pricing</b>: apply recommendations every day</label>
        <div class="sub">Next ${S.autoHorizon} days, only where the price differs by $${S.autoThreshold}+, never more than ${S.autoMaxChangePct}% in one day.${P.lastAuto ? ` Last run ${fmtDate(P.lastAuto)}.` : ''}</div></div>` : ''}
      <div class="card"><h3>Booking pace</h3><table class="pv"><tr><th>Month</th><th>Now</th><th>Last year</th><th>Adjust</th></tr>${paceRows}</table>
        <div class="sub">Compares how full each month is today with how full it was a year ago today. Ahead of last year → prices up; behind → down.</div></div>
    </div></div>

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
      <div class="toolbar" style="margin:0"><span class="sub">Auto-pricing:</span>
        <label class="sub">next <input name="autoHorizon" type="number" min="7" max="365" value="${S.autoHorizon}" style="width:5em"> days</label>
        <label class="sub">only if off by $<input name="autoThreshold" type="number" min="0" value="${S.autoThreshold}" style="width:4em">+</label>
        <label class="sub">max <input name="autoMaxChangePct" type="number" min="5" max="100" value="${S.autoMaxChangePct}" style="width:4em">% change per day</label></div>
      <div class="toolbar" style="margin:0"><button class="primary">Save rules</button><button type="button" id="psuggest">Suggest from my history</button><span class="sub" id="psuggestout"></span></div>
    </form></details>

  <details class="card" id="pevents" style="margin-top:14px" ${pr.open.events ? 'open' : ''}><summary><b>Events</b> <span class="sub">(${P.events.length}) · football weekends, festivals, holidays</span></summary>
    <div style="overflow-x:auto;margin-top:10px"><table><tr><th>Event</th><th>Nights</th><th>Price</th><th>Min stay</th><th>Source</th><th></th></tr>
    ${P.events.filter(e => e.end_date >= P.today).map(e => `<tr><td>${esc(e.name)}</td><td>${fmtDate(e.start_date)}${e.end_date !== e.start_date ? ' → ' + fmtDate(e.end_date) : ''}</td>
      <td>${pctStr(e.pct)}</td><td>${e.min_stay || '–'}</td><td class="sub">${/estimated/.test(e.source || '') ? '<span class="warn">⚠ estimated, check the date</span>' : esc(e.source || '')}</td>
      <td><a href="#" data-eedit="${e.id}">edit</a> · <a href="#" data-edel="${e.id}">delete</a></td></tr>`).join('')}</table></div>
    <form id="peform" class="toolbar" style="margin-top:10px"><input type="hidden" name="id">
      <input name="name" placeholder="Event name" size="22"><label class="sub">First night <input type="date" name="start_date"></label>
      <label class="sub">Last night <input type="date" name="end_date"></label><label class="sub"><input name="pct" type="number" style="width:5em" placeholder="+%"> %</label>
      <label class="sub">Min stay <input name="min_stay" type="number" min="1" max="30" style="width:4em"></label><button class="primary">Save event</button></form>
    <div class="sub">Tip: add next season's UW home games when the schedule comes out (usually in March). Game weekends are usually the Friday and Saturday nights.</div></details>`;

  const go = m => { pr.month = m; pricingView(); };
  $('#pprev').onclick = () => go(addMonths(pr.month, -1)); $('#pnext').onclick = () => go(addMonths(pr.month, 1));
  $('#ptoday').onclick = () => go(today.slice(0, 8) + '01');
  if ($('#proom')) $('#proom').onchange = e => { pr.room = +e.target.value; pr.selected = null; pr.ai = { busy: false, html: '' }; pricingView(); };
  view.querySelectorAll('[data-pdate]').forEach(el => el.onclick = () => { pr.selected = pr.selected === el.dataset.pdate ? null : el.dataset.pdate; pricingView(); });
  $('#psettings').ontoggle = e => { pr.open.settings = e.target.open; };
  $('#pevents').ontoggle = e => { pr.open.events = e.target.open; };
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
      autoHorizon: v('autoHorizon'), autoThreshold: v('autoThreshold'), autoMaxChangePct: v('autoMaxChangePct') } }));
  };
  $('#psuggest').onclick = async () => {
    const r = await api('/pricing/suggest', { method: 'POST', body: { roomId: pr.room } });
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
  const A = await api('/automations');
  const statusTag = st => ({ sent: '<span class="ok">✓ sent</span>', failed: '<span class="bad">✗ failed</span>', waiting: '<span class="warn">⏳ waiting</span>',
    pending: '<span class="sub">pending</span>', skipped: '<span class="sub">skipped</span>', scheduled: '<span class="sub">scheduled</span>' })[st] || esc(st);
  const vars = [...A.builtins, ...new Set(A.properties.flatMap(p => Object.keys(p.vars)))];
  const editor = a => {
    const timed = ['arrival', 'departure'].includes(a.anchor);
    return `<form class="stack amform" data-form="${a.id || 'new'}" style="max-width:none;margin-top:10px">
      <input name="name" value="${esc(a.name || '')}" placeholder="Name, e.g. Wi-Fi details">
      <div class="toolbar" style="margin:0"><select name="anchor">${Object.entries(ANCHOR_LABELS).map(([k, l]) => `<option value="${k}" ${a.anchor === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="timed" ${timed ? '' : 'hidden'}><input type="number" name="days" min="0" max="30" value="${Math.abs(a.offset_days || 0)}" style="width:4em"> day(s)
          <select name="dir"><option value="-1" ${(a.offset_days || 0) < 0 ? 'selected' : ''}>before</option><option value="1" ${(a.offset_days || 0) > 0 ? 'selected' : ''}>after</option></select>
          at <input type="time" name="at_time" value="${a.at_time || '10:00'}"></span>
        <span class="event" ${timed ? 'hidden' : ''}>wait <input type="number" name="delay" min="0" max="1440" value="${a.delay_minutes ?? 5}" style="width:5em"> minutes</span></div>
      <div class="toolbar" style="margin:0"><span class="sub">Channels:</span>${CHANNEL_LIST.map(c => `<label class="sub"><input type="checkbox" name="ch" value="${c}" ${!a.channels || a.channels.includes(c) ? 'checked' : ''}> ${c}</label>`).join('')}
        <label class="sub">Only stays of at least <input type="number" name="min_nights" min="1" max="60" value="${a.min_nights || ''}" style="width:4em"> nights</label></div>
      <textarea name="body" rows="6" maxlength="5000">${esc(a.body || '')}</textarea>
      <div class="chips">${vars.map(v => `<button type="button" class="chip" data-var="${v}">{${v}}</button>`).join('')}</div>
      <div class="toolbar" style="margin:0"><select name="pb"><option value="">Preview with a booking…</option>${A.bookings.map(b => `<option value="${b.id}">${esc(b.guest_name || 'Guest')} · ${fmtDate(b.arrival)}</option>`).join('')}</select>
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
          <td>${esc(h.guest_name || '')}</td><td>${statusTag(h.status)}${h.error ? `<div class="sub">${esc(h.error)}</div>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No automated messages yet.</div>'}</div>
        <div class="card"><h3>Property details</h3><div class="sub">Your own fill-ins for messages, e.g. <code>{wifi_password}</code>. Built in: ${A.builtins.map(b => `<code>{${b}}</code>`).join(' ')}</div>
          ${A.properties.map(p => `<form class="stack pvars" data-prop="${p.id}" style="max-width:none;margin-top:8px"><b>${esc(p.name)}</b>
            ${[...Object.entries(p.vars), ['', ''], ['', '']].map(([k, v]) => `<div class="toolbar" style="margin:0"><input name="k" value="${esc(k)}" placeholder="name, e.g. wifi_name" style="width:12em"><input name="v" value="${esc(v)}" placeholder="value" style="flex:1;min-width:120px"></div>`).join('')}
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
      const r = await api('/automations/preview', { method: 'POST', body: { body: f.body.value, bookingId: +f.pb.value } });
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
  if (f.type === 'int' || f.type === 'money') return `<input name="${name}" type="number" step="${f.type === 'money' ? '0.01' : '1'}" min="${f.min}" max="${f.max}" value="${v}" style="width:9em">`;
  return `<input name="${name}" value="${esc(v)}" maxlength="${f.max || 200}" data-count="${f.max || 200}" ${f.key === 'headline' || f.key === 'contentHeadline' ? `data-ai="${f.key}"` : ''}>`;
};
const fieldRow = (f, val, name) => `<label class="lfield"><span class="sub">${esc(f.label)}${f.hint ? ` <span class="hint">· ${esc(f.hint)}</span>` : ''}</span>${fieldInput(f, val, name)}<span class="sub count"></span></label>`;

async function listingView() {
  const L = await api('/listing?' + new URLSearchParams(ls.property ? { property: ls.property } : {}));
  if (!L.connected) { view.innerHTML = '<div class="card empty">Connect Beds24 in Settings to edit your listing.</div>'; return; }
  if (!L.listing) { view.innerHTML = '<div class="card empty">No properties found in Beds24 yet.</div>'; return; }
  ls.property = L.listing.id;
  const x = L.listing, F = L.fields;
  view.innerHTML = `${L.canWrite === false ? '<div class="notice">Your Beds24 invite code can read but not change listing content. Create one with write access to <b>Properties</b> and paste it in Settings.</div>' : ''}
    <div class="notice" style="background:var(--bg);color:var(--ink);border:1px solid var(--line)">This edits your listing content in Beds24. Whether a change reaches Airbnb, VRBO or Booking.com depends on each channel's content settings in Beds24 (Booking.com content is usually managed in its own extranet). Photos and amenities are managed in Beds24.</div>
    <form id="lform">
      <div class="card stack" style="max-width:none"><div class="toolbar" style="margin:0">
        ${L.properties.length > 1 ? `<select id="lprop">${L.properties.map(p => `<option value="${p.id}" ${p.id === x.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : `<h3 style="margin:0">${esc(x.property.name)}</h3>`}
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
  const A = await api('/analytics?' + q({ range: an.range }));
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
      <select id="anmetric">${[['revenue', 'Revenue'], ['occupancy', 'Occupancy'], ['adr', 'ADR']].map(([v, l]) => `<option value="${v}" ${an.metric === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
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
        <select id="anrange">${Object.entries(A.ranges).map(([v, l]) => `<option value="${v}" ${A.range === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
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

async function act(fn) {
  const btn = $('#sync'); btn.disabled = true; banner('Working…');
  try { await fn(); banner(''); await boot(true); } catch (e) { if (e.message !== 'login') banner(e.message, true); }
  btn.disabled = false;
}

const routes = { '': dashboard, calendar: calendarView, inbox: inboxView, automations: automationsView, bookings: bookingsView, analytics: analyticsView, listing: listingView, rates: ratesView, pricing: pricingView, cleaning: cleaningView, locks: locksView, settings: settingsView };
async function render() {
  // #/inbox/123 (from a phone notification) opens that conversation.
  const [r, arg] = location.hash.replace(/^#\/?/, '').split('/');
  if (r === 'inbox' && /^\d+$/.test(arg || '')) inbox.booking = +arg;
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
