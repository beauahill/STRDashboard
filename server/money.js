// Money: expenses, profit and loss by month, a payout check against what each stay should pay out, and a lodging-
// tax report for bookings on channels that don't collect and remit the tax themselves.
// Income is counted by night of stay (a stay crossing months counts partly in each), like the Dashboard.
import { getSetting, setSetting } from './db.js';
import { addDays, diffDays } from './sync.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = v => Math.round(v * 100) / 100;
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

export const CATEGORIES = ['Cleaning', 'Supplies', 'Repairs & maintenance', 'Utilities', 'Internet & TV', 'Insurance', 'Property tax',
  'Mortgage interest', 'HOA', 'Software & subscriptions', 'Platform fees', 'Advertising', 'Furnishings & equipment', 'Professional fees', 'Travel', 'Other'];
export const CHANNELS = ['Airbnb', 'VRBO', 'Booking.com', 'Direct', 'Other'];
export const MONEY_DEFAULTS = {
  cleaningPerStay: null,                       // estimated cleaning cost per checkout, if cleanings aren't entered as expenses
  remits: { Airbnb: true, VRBO: true, 'Booking.com': false, Direct: false, Other: false },   // channel collects and pays the tax
  taxes: [],                                   // [{ name, pct }], e.g. sales tax and lodging tax
};

export function moneySettings(db) {
  let s = {};
  try { s = JSON.parse(getSetting(db, 'money') || '{}'); } catch { /* defaults */ }
  return { ...MONEY_DEFAULTS, ...s, remits: { ...MONEY_DEFAULTS.remits, ...(s.remits || {}) } };
}

export function saveMoneySettings(db, input = {}) {
  const s = moneySettings(db);
  if ('cleaningPerStay' in input) {
    const v = input.cleaningPerStay === '' || input.cleaningPerStay == null ? null : Number(input.cleaningPerStay);
    if (v != null && !(Number.isFinite(v) && v >= 0 && v <= 5000)) throw err('Cleaning cost per stay must be between $0 and $5,000.');
    s.cleaningPerStay = v;
  }
  if (input.remits) for (const c of CHANNELS) if (c in input.remits) s.remits[c] = !!input.remits[c];
  if ('taxes' in input) {
    if (!Array.isArray(input.taxes) || input.taxes.length > 6) throw err('Up to 6 tax rates.');
    s.taxes = input.taxes.map(t => ({ name: String(t?.name || '').trim().slice(0, 60), pct: Number(t?.pct) })).filter(t => t.name || t.pct);
    for (const t of s.taxes) if (!t.name || !(Number.isFinite(t.pct) && t.pct > 0 && t.pct <= 30)) throw err('Each tax needs a name and a rate between 0 and 30%.');
  }
  setSetting(db, 'money', JSON.stringify(s));
  return s;
}

// ---------- Expenses ----------
function cleanExpense(db, x) {
  const date = String(x.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw err('Choose the expense date.');
  if (!CATEGORIES.includes(x.category)) throw err('Choose a category.');
  const amount = Number(x.amount);
  if (!(Number.isFinite(amount) && amount > 0 && amount <= 1e7)) throw err('Enter the amount.');
  const pid = x.propertyId == null || x.propertyId === '' ? null : Number(x.propertyId);
  if (pid != null && !db.prepare('SELECT 1 FROM properties WHERE id = ?').get(pid)) throw err('Unknown property.');
  const repeat = x.repeat === 'monthly' ? 'monthly' : null;
  const until = repeat && x.until ? String(x.until) : null;
  if (until && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < date)) throw err('"Until" must be a date after the first one.');
  return { date, category: x.category, vendor: String(x.vendor || '').trim().slice(0, 100), description: String(x.description || '').trim().slice(0, 500), amount: r2(amount), pid, repeat, until };
}

export function saveExpense(db, x = {}) {
  const e = cleanExpense(db, x);
  let receipt = null;
  if (x.receipt) {
    const m = String(x.receipt).match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw err('Receipts can be a photo or a PDF.');
    const data = Buffer.from(m[2], 'base64');
    if (data.length > 5e6) throw err('That receipt is too large (5 MB at most).');
    receipt = { mime: m[1], data };
  }
  if (x.id) {
    const id = Number(x.id);
    if (!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(id)) throw err('That expense no longer exists.', 404);
    db.prepare('UPDATE expenses SET property_id=?, date=?, category=?, vendor=?, description=?, amount=?, repeat=?, until=? WHERE id=?')
      .run(e.pid, e.date, e.category, e.vendor, e.description, e.amount, e.repeat, e.until, id);
    if (receipt) db.prepare('UPDATE expenses SET receipt_mime = ?, receipt_data = ? WHERE id = ?').run(receipt.mime, receipt.data, id);
    if (x.removeReceipt) db.prepare('UPDATE expenses SET receipt_mime = NULL, receipt_data = NULL WHERE id = ?').run(id);
    return id;
  }
  return Number(db.prepare(`INSERT INTO expenses(property_id, date, category, vendor, description, amount, repeat, until, receipt_mime, receipt_data, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.pid, e.date, e.category, e.vendor, e.description, e.amount, e.repeat, e.until, receipt?.mime || null, receipt?.data || null, new Date().toISOString()).lastInsertRowid);
}

export const deleteExpense = (db, id) => db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
export const receiptOf = (db, id) => db.prepare('SELECT receipt_mime, receipt_data FROM expenses WHERE id = ? AND receipt_data IS NOT NULL').get(id) || null;

const propFilter = pid => (pid ? 'AND (property_id = ? OR property_id IS NULL)' : '');
export function listExpenses(db, { year, propertyId = null } = {}) {
  return db.prepare(`SELECT id, property_id, date, category, vendor, description, amount, repeat, until, receipt_mime IS NOT NULL AS has_receipt FROM expenses
      WHERE (date LIKE ? OR (repeat = 'monthly' AND date <= ? AND (until IS NULL OR until >= ?))) ${propFilter(propertyId)} ORDER BY date DESC, id DESC`)
    .all(`${year}-%`, `${year}-12-31`, `${year}-01-01`, ...(propertyId ? [propertyId] : []));
}

/** Expense amounts per category per month of a year (monthly repeats counted in each month they cover). */
function expensesByMonth(db, year, propertyId) {
  const out = {};
  const add = (cat, m, v) => { (out[cat] ||= Object.fromEntries(MONTHS.map(k => [k, 0])))[m] += v; };
  for (const e of listExpenses(db, { year, propertyId })) {
    if (e.repeat === 'monthly') {
      for (const m of MONTHS) {
        const first = `${year}-${m}-01`, last = addDays(m === '12' ? `${year + 1}-01-01` : `${year}-${MONTHS[+m]}-01`, -1);
        // Same day of the month as the first payment (or the month's last day).
        const day = `${year}-${m}-${String(Math.min(+e.date.slice(8), +last.slice(8))).padStart(2, '0')}`;
        if (day >= e.date && (!e.until || day <= e.until) && day >= first) add(e.category, m, e.amount);
      }
    } else add(e.category, e.date.slice(5, 7), e.amount);
  }
  return out;
}

// ---------- Income ----------
/** Commission for a booking: Beds24's figure, or (for imported history) total minus payout. */
const commissionOf = b => b.commission != null ? b.commission : b.payout != null ? Math.max(0, b.price - b.payout) : 0;

function stays(db, from, to, propertyId) {
  return db.prepare(`SELECT id, channel, arrival, departure, nights, price, commission, tax, payout, source FROM bookings
      WHERE status IN ('confirmed','new') AND arrival < ? AND departure > ? ${propertyId ? 'AND property_id = ?' : ''}`).all(to, from, ...(propertyId ? [propertyId] : []));
}

/** Income, channel fees and taxes per month of a year, spread over the nights of each stay. */
function incomeByMonth(db, year, propertyId) {
  const from = `${year}-01-01`, to = `${year + 1}-01-01`;
  const rows = Object.fromEntries(['gross', 'fees', 'tax', 'nights', 'checkouts'].map(k => [k, Object.fromEntries(MONTHS.map(m => [m, 0]))]));
  const byChannel = {};
  for (const b of stays(db, from, to, propertyId)) {
    const n = b.nights || diffDays(b.arrival, b.departure) || 1;
    const per = { gross: b.price / n, fees: commissionOf(b) / n, tax: (b.tax || 0) / n };
    for (let d = b.arrival > from ? b.arrival : from; d < b.departure && d < to; d = addDays(d, 1)) {
      const m = d.slice(5, 7);
      rows.gross[m] += per.gross; rows.fees[m] += per.fees; rows.tax[m] += per.tax; rows.nights[m]++;
      const c = (byChannel[b.channel] ||= Object.fromEntries(MONTHS.map(k => [k, 0])));
      c[m] += per.gross;
    }
    if (b.departure >= from && b.departure < to) rows.checkouts[b.departure.slice(5, 7)]++;
  }
  return { ...rows, byChannel };
}

/** Profit and loss for a year, month by month. */
export function pnl(db, year, { propertyId = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  year = Number(year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw err('Choose a year.');
  const s = moneySettings(db);
  const inc = incomeByMonth(db, year, propertyId);
  const exp = expensesByMonth(db, year, propertyId);
  if (s.cleaningPerStay) {
    const cat = 'Cleaning (estimated per stay)';
    exp[cat] = Object.fromEntries(MONTHS.map(m => [m, inc.checkouts[m] * s.cleaningPerStay]));
  }
  const sum = o => Object.values(o).reduce((a, v) => a + v, 0);
  const month = m => {
    const expenses = Object.values(exp).reduce((a, c) => a + c[m], 0);
    const net = inc.gross[m] - inc.fees[m];
    return { month: `${year}-${m}`, future: `${year}-${m}` > today.slice(0, 7), nights: inc.nights[m], gross: r2(inc.gross[m]), fees: r2(inc.fees[m]), net: r2(net),
      tax: r2(inc.tax[m]), expenses: r2(expenses), profit: r2(net - expenses) };
  };
  const months = MONTHS.map(month);
  const total = k => r2(months.reduce((a, m) => a + m[k], 0));
  return {
    year, months,
    total: { nights: months.reduce((a, m) => a + m.nights, 0), gross: total('gross'), fees: total('fees'), net: total('net'), tax: total('tax'), expenses: total('expenses'), profit: total('profit') },
    expenses: Object.entries(exp).map(([category, byMonth]) => ({ category, months: MONTHS.map(m => r2(byMonth[m])), total: r2(sum(byMonth)) })).sort((a, b) => b.total - a.total),
    channels: Object.entries(inc.byChannel).map(([channel, byMonth]) => ({ channel, months: MONTHS.map(m => r2(byMonth[m])), total: r2(sum(byMonth)) })).sort((a, b) => b.total - a.total),
    estimatedCleaning: !!s.cleaningPerStay,
  };
}

// ---------- Payouts ----------
/** Stays that checked out in the last `days` days: what should have been paid out, and what the owner marked as received. */
export function payouts(db, today, { propertyId = null, days = 90 } = {}) {
  return db.prepare(`SELECT b.id, b.guest_name, b.channel, b.arrival, b.departure, b.price, b.commission, b.payout, b.source, r.amount received, r.received_on, r.note
      FROM bookings b LEFT JOIN payouts_received r ON r.booking_id = b.id
      WHERE b.status IN ('confirmed','new') AND b.departure <= ? AND b.departure >= ? ${propertyId ? 'AND b.property_id = ?' : ''} ORDER BY b.departure DESC`)
    .all(today, addDays(today, -days), ...(propertyId ? [propertyId] : []))
    .map(b => {
      const expected = r2(b.payout != null ? b.payout : b.price - commissionOf(b));
      const diff = b.received != null ? r2(b.received - expected) : null;
      return { id: b.id, guest: b.guest_name, channel: b.channel, arrival: b.arrival, departure: b.departure, gross: r2(b.price), fees: r2(commissionOf(b)),
        expected, feesKnown: b.commission != null || b.payout != null, received: b.received, receivedOn: b.received_on, note: b.note || '',
        status: b.received == null ? 'waiting' : Math.abs(diff) < 1 ? 'ok' : diff < 0 ? 'short' : 'over', diff };
    });
}

export function markPayout(db, bookingId, { amount, receivedOn, note } = {}) {
  if (!db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(bookingId)) throw err('Unknown booking.', 404);
  if (amount === '' || amount == null) { db.prepare('DELETE FROM payouts_received WHERE booking_id = ?').run(bookingId); return null; }
  const v = Number(amount);
  if (!(Number.isFinite(v) && v >= 0 && v <= 1e7)) throw err('Enter the amount received.');
  const on = receivedOn && /^\d{4}-\d{2}-\d{2}$/.test(receivedOn) ? receivedOn : new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO payouts_received(booking_id, amount, received_on, note, updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(booking_id) DO UPDATE SET amount = excluded.amount, received_on = excluded.received_on, note = excluded.note, updated_at = excluded.updated_at`)
    .run(bookingId, r2(v), on, String(note || '').slice(0, 300), new Date().toISOString());
  return { amount: r2(v), receivedOn: on };
}

// ---------- Lodging tax ----------
/**
 * Per month: revenue on channels that collect and remit the tax themselves, and on channels where the owner
 * must, with the tax due on the latter at the configured rates. Revenue is counted by night of stay.
 */
export function taxReport(db, year, { propertyId = null } = {}) {
  year = Number(year);
  const s = moneySettings(db);
  const inc = incomeByMonth(db, year, propertyId);
  const rate = s.taxes.reduce((a, t) => a + t.pct, 0) / 100;
  const months = MONTHS.map(m => {
    let remitted = 0, owner = 0;
    const byChannel = {};
    for (const [ch, byMonth] of Object.entries(inc.byChannel)) {
      const v = byMonth[m];
      if (!v) continue;
      byChannel[ch] = r2(v);
      if (s.remits[ch] ?? s.remits.Other) remitted += v; else owner += v;
    }
    return { month: `${year}-${m}`, remitted: r2(remitted), owner: r2(owner), due: r2(owner * rate), byTax: s.taxes.map(t => ({ name: t.name, amount: r2(owner * t.pct / 100) })), byChannel };
  });
  const quarters = [0, 1, 2, 3].map(q => {
    const ms = months.slice(q * 3, q * 3 + 3);
    return { quarter: `Q${q + 1} ${year}`, owner: r2(ms.reduce((a, m) => a + m.owner, 0)), due: r2(ms.reduce((a, m) => a + m.due, 0)) };
  });
  return { year, settings: s, months, quarters, total: { remitted: r2(months.reduce((a, m) => a + m.remitted, 0)), owner: r2(months.reduce((a, m) => a + m.owner, 0)), due: r2(months.reduce((a, m) => a + m.due, 0)) } };
}
