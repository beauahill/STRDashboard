// Import reservation history from a Guesty (Lite) "Reservation report" CSV export.
// Only the fields the dashboard needs are kept: guest addresses, IDs and door key codes are discarded.
import { createHash } from 'node:crypto';
import { diffDays } from './sync.js';

/** RFC 4180 CSV parser with delimiter detection (comma, semicolon or tab) and BOM stripping. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// Errors the person can fix (wrong file, missing choice) are reported as 400s, not crashes.
const userError = msg => Object.assign(new Error(msg), { status: 400 });

const normHeader = h => h.trim().toUpperCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y < 100 ? 2000 + y : y}-${pad(m)}-${pad(d)}` : null);

/** Parse the date part of many common formats, ignoring any time. `dayFirst` resolves 03/04/2025. */
export function parseDate(s, dayFirst = false) {
  s = (s || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return dayFirst ? ymd(+m[3], +m[2], +m[1]) : ymd(+m[3], +m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/))) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})/))) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** "$1,234.56", "1.234,56", "(12.00)" -> number. */
export function parseMoney(s) {
  s = (s || '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.includes('-');
  s = s.replace(/[^\d.,]/g, '');
  if (s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.') && s.length - s.lastIndexOf(',') <= 3) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Guesty status -> our status; null means "not a stay" (inquiries, declines, expired holds) and is skipped. */
export function mapStatus(s) {
  s = (s || '').toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (/confirm|checked|completed/.test(s)) return 'confirmed';
  if (s.includes('reserved')) return 'request';
  return null;
}

export function mapChannel(source, platform, website) {
  if ((website || '').trim()) return 'Direct';
  const t = `${source || ''} ${platform || ''}`.toLowerCase();
  if (t.includes('airbnb')) return 'Airbnb';
  if (/booking\.?com/.test(t)) return 'Booking.com';
  if (/vrbo|homeaway|expedia/.test(t)) return 'VRBO';
  if (/website|engine|direct|manual|owner|guesty|phone|email|walk/.test(t)) return 'Direct';
  if (t.includes('booking')) return 'Booking.com';
  return t.trim() ? 'Other' : 'Direct';
}

/** Stable negative id per Guesty confirmation code, so re-importing a file updates rather than duplicates. */
const guestyId = code => -parseInt(createHash('sha256').update('guesty:' + code).digest('hex').slice(0, 12), 16);

/** Parse a Guesty export into normalized bookings plus a summary of what was found and skipped. */
export function readGuestyExport(text) {
  const [header, ...data] = parseCsv(text);
  if (!header) throw userError('The file is empty.');
  const cols = header.map(normHeader);
  for (const need of ['CHECK-IN', 'CHECK-OUT', 'CONFIRMATION CODE', 'STATUS']) {
    if (!cols.includes(need)) throw userError(`This doesn't look like a Guesty reservations export (missing a "${need}" column).`);
  }
  const rows = data.map(r => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));

  // Slash dates are ambiguous (03/04/2025); if any day-part exceeds 12 the file is day-first.
  const dayFirst = rows.some(r => [r['CHECK-IN'], r['CHECK-OUT']].some(v => /^(\d{1,2})\//.test(v) && +v.split('/')[0] > 12));

  const summary = { total: rows.length, imported: 0, skipped: {}, statuses: {}, channels: {}, listings: {}, nightsMismatch: 0, first: null, last: null };
  const skip = why => { summary.skipped[why] = (summary.skipped[why] || 0) + 1; };
  const bookings = [];
  for (const r of rows) {
    const rawStatus = r['STATUS'] || '(blank)';
    summary.statuses[rawStatus] = (summary.statuses[rawStatus] || 0) + 1;
    const status = mapStatus(r['STATUS']);
    if (!status) { skip(`status "${rawStatus}"`); continue; }
    const code = r['CONFIRMATION CODE'] || r['CHANNEL RESERVATION ID'];
    if (!code) { skip('no confirmation code'); continue; }
    const arrival = parseDate(r['CHECK-IN'], dayFirst), departure = parseDate(r['CHECK-OUT'], dayFirst);
    if (!arrival || !departure || departure <= arrival) { skip('unreadable dates'); continue; }

    const nights = diffDays(arrival, departure);
    if (r['NUMBER OF NIGHTS'] && +r['NUMBER OF NIGHTS'] !== nights) summary.nightsMismatch++;
    const fare = parseMoney(r['ACCOMMODATION FARE']), cleaning = parseMoney(r['CLEANING FARE']);
    const payout = parseMoney(r['TOTAL PAYOUT']);
    const channel = mapChannel(r['SOURCE'], r['PLATFORM'], r['WEBSITE NAME']);
    const listing = r['LISTING'] || r["LISTING'S NICKNAME"] || '(no listing name)';
    const adults = parseInt(r['NUMBER OF ADULTS']) || parseInt(r['NUMBER OF GUESTS']) || 0;

    bookings.push({
      id: guestyId(code), listing, status, channel, arrival, departure, nights,
      guest_name: r['GUEST'] || null, email: r["GUEST'S EMAIL"] || null,
      adults, children: (parseInt(r['NUMBER OF CHILDREN']) || 0) + (parseInt(r['NUMBER OF INFANTS']) || 0),
      // Revenue = what the guest paid for the stay before taxes and channel fees, matching how
      // nightly rate + cleaning is usually reported. Payout (what reached you) is kept alongside.
      price: fare != null || cleaning != null ? (fare || 0) + (cleaning || 0) : (payout || 0),
      payout, currency: r['CURRENCY'] || null,
      channel_ref: r['CHANNEL RESERVATION ID'] || code,
      booked_at: parseDate(r['BOOKING DATE'] || r['CREATION DATE - CHANNEL'] || r['CREATION DATE'], dayFirst),
    });
    summary.imported++;
    summary.channels[channel] = (summary.channels[channel] || 0) + 1;
    summary.listings[listing] = (summary.listings[listing] || 0) + 1;
    if (!summary.first || arrival < summary.first) summary.first = arrival;
    if (!summary.last || departure > summary.last) summary.last = departure;
  }
  return { bookings, summary };
}

/**
 * Write parsed bookings. `mapping` maps each Guesty listing name to an existing room id, or to "new"
 * to create a local property for it (useful before the property exists in Beds24).
 */
export function importGuesty(db, bookings, mapping = {}) {
  const rooms = new Map(db.prepare('SELECT id, property_id FROM rooms').all().map(r => [r.id, r.property_id]));
  const target = {};
  const nextId = table => Math.min(0, db.prepare(`SELECT MIN(id) m FROM ${table}`).get().m ?? 0) - 1;
  const cols = ['id', 'property_id', 'room_id', 'status', 'channel', 'arrival', 'departure', 'nights', 'guest_name', 'email',
    'adults', 'children', 'price', 'payout', 'currency', 'channel_ref', 'booked_at', 'source'];
  const insert = db.prepare(`INSERT OR REPLACE INTO bookings(${cols}) VALUES(${cols.map(() => '?')})`);

  db.exec('BEGIN');
  try {
    for (const listing of new Set(bookings.map(b => b.listing))) {
      const choice = mapping[listing];
      if (choice != null && choice !== 'new' && rooms.has(Number(choice))) {
        target[listing] = { room: Number(choice), property: rooms.get(Number(choice)) };
      } else if (choice === 'new' || rooms.size === 0) {
        const pid = nextId('properties'), rid = nextId('rooms');
        db.prepare('INSERT INTO properties(id,name) VALUES(?,?)').run(pid, listing);
        db.prepare('INSERT INTO rooms(id,property_id,name,qty) VALUES(?,?,?,1)').run(rid, pid, listing);
        target[listing] = { room: rid, property: pid };
        rooms.set(rid, pid);
      } else if (rooms.size === 1) {
        const [[room, property]] = rooms;
        target[listing] = { room, property };
      } else throw userError(`Choose which property "${listing}" belongs to.`);
    }
    for (const b of bookings) {
      const t = target[b.listing];
      insert.run(...cols.map(c => c === 'property_id' ? t.property : c === 'room_id' ? t.room : c === 'source' ? 'guesty' : b[c] ?? null));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const duplicates = dedupeImported(db);
  removeEmptyLocalProperties(db);
  return { imported: bookings.length, duplicates };
}

/**
 * Once Beds24 is live it re-imports upcoming bookings that are also in the Guesty history.
 * Beds24 is the source of truth, so drop the Guesty copy of any stay Beds24 also has.
 */
export function dedupeImported(db) {
  return Number(db.prepare(`
    DELETE FROM bookings WHERE source = 'guesty' AND EXISTS (
      SELECT 1 FROM bookings b WHERE b.source = 'beds24' AND b.status != 'cancelled' AND (
        (b.channel_ref IS NOT NULL AND b.channel_ref = bookings.channel_ref) OR
        (b.room_id = bookings.room_id AND b.arrival = bookings.arrival AND b.departure = bookings.departure)))`).run().changes);
}

/** Local (negative id) properties exist only to hold imported history; drop them once nothing points at them. */
function removeEmptyLocalProperties(db) {
  db.exec(`DELETE FROM rooms WHERE id < 0 AND id NOT IN (SELECT room_id FROM bookings WHERE room_id IS NOT NULL);
           DELETE FROM properties WHERE id < 0 AND id NOT IN (SELECT property_id FROM rooms);`);
}

export function removeGuestyImport(db) {
  const n = Number(db.prepare("DELETE FROM bookings WHERE source = 'guesty'").run().changes);
  removeEmptyLocalProperties(db);
  return { removed: n };
}
