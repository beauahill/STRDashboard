import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { upsertProperties, upsertBookings } from '../server/sync.js';
import { periodStats } from '../server/stats.js';
import {
  parseCsv, parseDate, parseMoney, mapStatus, mapChannel, readGuestyExport, importGuesty, dedupeImported, removeGuestyImport,
} from '../server/guesty.js';

// The exact header row from a real Guesty Lite export (all columns selected).
const HEADER = ['CHECK-IN', 'CHECK-OUT', 'CONFIRMATION CODE', 'LISTING', 'GUEST', 'STATUS', 'CHANNEL RESERVATION ID',
  'CHECK-IN FORM SUBMISSION STATUS', "GUEST'S ID", "GUEST'S EMAIL", "GUEST'S HOMETOWN", "GUEST'S ADDRESS", "GUEST'S COUNTRY",
  "GUEST'S STATE", "GUEST'S CITY", "GUEST'S STREET", "GUEST'S POSTAL CODE", 'NUMBER OF GUESTS', 'NUMBER OF NIGHTS',
  'TOTAL PAYOUT', 'SOURCE', 'WEBSITE NAME', 'CREATION DATE', 'BOOKING DATE', 'CREATION DATE - CHANNEL', 'CANCELLATION DATE',
  'ALTERATION DATE', "LISTING'S NICKNAME", 'PROPERTY ZIPCODE', 'TOTAL PAID', 'BALANCE DUE', 'PROCESSING FEES',
  'CHANNEL COMMISSION', 'ACCOMMODATION FARE', 'TOTAL FEES', 'CURRENCY', 'CREATED BY', 'KEY CODE', 'POINT OF SALE',
  'NUMBER OF ADULTS', 'NUMBER OF CHILDREN', 'NUMBER OF INFANTS', 'NUMBER OF PETS', 'PLATFORM', 'NET ACCOMMODATION FARE',
  'CLEANING FARE', 'TOTAL TAXES', 'CITY TAX', 'STATE TAX', 'VAT', 'GOODS AND SERVICES TAX', 'LOCAL TAX', 'TOURISM TAX', 'TAX'];

const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
function csv(rows, delim = ',') {
  return [HEADER, ...rows.map(r => HEADER.map(h => r[h] ?? ''))].map(r => r.map(q).join(delim)).join('\r\n');
}
const base = { LISTING: 'Laramie House', CURRENCY: 'USD', 'NUMBER OF GUESTS': '4', 'NUMBER OF ADULTS': '3', 'NUMBER OF CHILDREN': '1' };
const ROWS = [
  { ...base, 'CHECK-IN': '2025-06-01 03:00 PM', 'CHECK-OUT': '2025-06-04 11:00 AM', 'CONFIRMATION CODE': 'GY-1', 'CHANNEL RESERVATION ID': 'HMAAAA1',
    GUEST: 'Pat Doe', STATUS: 'Confirmed', SOURCE: 'Airbnb', 'NUMBER OF NIGHTS': '3', 'ACCOMMODATION FARE': '$450.00', 'CLEANING FARE': '$100.00',
    'TOTAL PAYOUT': '$520.00', "GUEST'S ADDRESS": '1 Main St, Apt 2\nLaramie', 'KEY CODE': '4321', "GUEST'S EMAIL": 'pat@example.com' },
  { ...base, 'CHECK-IN': '2025-07-10', 'CHECK-OUT': '2025-07-12', 'CONFIRMATION CODE': 'GY-2', GUEST: 'Sam "Sammy" Lee', STATUS: 'Canceled',
    SOURCE: 'Booking.com', 'ACCOMMODATION FARE': '1,000.00', 'TOTAL PAYOUT': '0' },
  { ...base, 'CHECK-IN': '2025-08-01', 'CHECK-OUT': '2025-08-05', 'CONFIRMATION CODE': 'GY-3', GUEST: 'Vic', STATUS: 'Confirmed',
    SOURCE: 'HomeAway', PLATFORM: 'Vrbo', 'ACCOMMODATION FARE': '800', 'CLEANING FARE': '120', 'TOTAL PAYOUT': '850' },
  { ...base, 'CHECK-IN': '2025-09-01', 'CHECK-OUT': '2025-09-03', 'CONFIRMATION CODE': 'GY-4', GUEST: 'Dee', STATUS: 'Confirmed',
    SOURCE: 'Website', 'WEBSITE NAME': 'My direct site', 'ACCOMMODATION FARE': '300', 'TOTAL PAYOUT': '300' },
  { ...base, 'CHECK-IN': '2025-09-10', 'CHECK-OUT': '2025-09-12', 'CONFIRMATION CODE': 'GY-5', GUEST: 'Ina', STATUS: 'Inquiry', SOURCE: 'Airbnb' },
  { ...base, 'CHECK-IN': '2025-09-20', 'CHECK-OUT': '2025-09-22', 'CONFIRMATION CODE': 'GY-6', GUEST: 'Ray', STATUS: 'Reserved', SOURCE: 'Manual',
    'ACCOMMODATION FARE': '200' },
  { ...base, 'CHECK-IN': '2025-10-01', 'CHECK-OUT': '2025-10-01', 'CONFIRMATION CODE': 'GY-7', GUEST: 'Bad', STATUS: 'Confirmed' },
];

test('CSV parsing handles quotes, embedded commas/newlines, BOM, CRLF and other delimiters', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2\n\n'), [['a', 'b'], ['1', '2']]);
});

test('dates, money, status and channel mapping', () => {
  assert.equal(parseDate('2025-06-01 03:00 PM'), '2025-06-01');
  assert.equal(parseDate('2025-06-01T15:00:00.000Z'), '2025-06-01');
  assert.equal(parseDate('06/01/2025 3:00 PM'), '2025-06-01');
  assert.equal(parseDate('01/06/2025', true), '2025-06-01');
  assert.equal(parseDate('Jun 1, 2025'), '2025-06-01');
  assert.equal(parseDate('1 June 2025'), '2025-06-01');
  assert.equal(parseDate('garbage'), null);
  assert.equal(parseMoney('$1,234.50'), 1234.5);
  assert.equal(parseMoney('1.234,50 €'), 1234.5);
  assert.equal(parseMoney('(12.00)'), -12);
  assert.equal(parseMoney(''), null);
  assert.equal(mapStatus('Confirmed'), 'confirmed');
  assert.equal(mapStatus('canceled'), 'cancelled');
  assert.equal(mapStatus('Reserved'), 'request');
  assert.equal(mapStatus('Inquiry'), null);
  assert.equal(mapChannel('Airbnb'), 'Airbnb');
  assert.equal(mapChannel('airbnb2'), 'Airbnb');
  assert.equal(mapChannel('Booking.com'), 'Booking.com');
  assert.equal(mapChannel('HomeAway', 'Vrbo'), 'VRBO');
  assert.equal(mapChannel('Booking Engine'), 'Direct', '"booking engine" is a direct site, not Booking.com');
  assert.equal(mapChannel('Website', '', 'My site'), 'Direct');
  assert.equal(mapChannel('Manual'), 'Direct');
});

test('reads a Guesty export and summarizes it', () => {
  const { bookings, summary } = readGuestyExport(csv(ROWS));
  assert.equal(summary.total, 7);
  assert.equal(summary.imported, 5);
  assert.deepEqual(summary.skipped, { 'status "Inquiry"': 1, 'unreadable dates': 1 });
  assert.deepEqual(summary.channels, { Airbnb: 1, 'Booking.com': 1, VRBO: 1, Direct: 2 });
  assert.equal(summary.first, '2025-06-01');
  assert.equal(summary.last, '2025-09-22');
  const pat = bookings.find(b => b.guest_name === 'Pat Doe');
  assert.equal(pat.price, 550, 'accommodation + cleaning');
  assert.equal(pat.payout, 520);
  assert.equal(pat.nights, 3);
  assert.equal(pat.channel_ref, 'HMAAAA1');
  assert.equal(pat.adults, 3); assert.equal(pat.children, 1);
  assert.ok(pat.id < 0);
  assert.ok(!JSON.stringify(bookings).includes('4321'), 'door key code is not kept');
  assert.ok(!JSON.stringify(bookings).includes('Main St'), 'guest address is not kept');
  assert.equal(bookings.find(b => b.guest_name === 'Sam "Sammy" Lee').status, 'cancelled');
});

test('semicolon-separated exports and day-first dates are detected', () => {
  const rows = [{ ...ROWS[0], 'CHECK-IN': '25/06/2025', 'CHECK-OUT': '28/06/2025' }, { ...ROWS[2], 'CHECK-IN': '01/08/2025', 'CHECK-OUT': '05/08/2025' }];
  const { bookings } = readGuestyExport(csv(rows, ';'));
  assert.deepEqual(bookings.map(b => [b.arrival, b.departure]), [['2025-06-25', '2025-06-28'], ['2025-08-01', '2025-08-05']]);
});

test('rejects files that are not Guesty exports', () => {
  assert.throws(() => readGuestyExport('name,email\nx,y'), e => e.status === 400 && /CHECK-IN/.test(e.message));
  assert.throws(() => readGuestyExport(''), e => e.status === 400);
});

const beds24Property = db => upsertProperties(db, [{ id: 500, name: 'Laramie House', roomTypes: [{ id: 600, name: 'Whole house', qty: 1 }] }]);

test('imports onto the only Beds24 room, idempotently, and counts in stats', () => {
  const db = openDb(':memory:');
  beds24Property(db);
  const { bookings } = readGuestyExport(csv(ROWS));
  importGuesty(db, bookings);
  importGuesty(db, bookings); // re-importing the same file must not duplicate
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookings WHERE source='guesty'").get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings WHERE room_id = 600').get().n, 5);
  const june = periodStats(db, '2025-06-01', '2025-07-01');
  assert.equal(june.revenue, 550);
  assert.equal(june.nights, 3);
  assert.equal(periodStats(db, '2025-07-01', '2025-08-01').revenue, 0, 'cancelled stays are excluded');
});

test('before Beds24 is set up, history gets its own property; re-mapping later removes it', () => {
  const db = openDb(':memory:');
  const { bookings } = readGuestyExport(csv(ROWS));
  importGuesty(db, bookings);
  const local = db.prepare('SELECT * FROM properties').all();
  assert.equal(local.length, 1); assert.ok(local[0].id < 0); assert.equal(local[0].name, 'Laramie House');

  beds24Property(db);
  assert.throws(() => importGuesty(db, bookings), /Choose which property/, 'two rooms now exist, so a choice is required');
  importGuesty(db, bookings, { 'Laramie House': 600 });
  assert.deepEqual(db.prepare('SELECT id FROM properties').all().map(p => p.id), [500], 'empty local property removed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings WHERE room_id = 600').get().n, 5);
});

test('Beds24 copies of the same stay replace the Guesty ones', () => {
  const db = openDb(':memory:');
  beds24Property(db);
  importGuesty(db, readGuestyExport(csv(ROWS)).bookings);
  upsertBookings(db, [
    { id: 1, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2025-06-01', departure: '2025-06-04', apiReference: 'HMAAAA1', price: 550 },
    { id: 2, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2025-08-01', departure: '2025-08-05', price: 920 },  // same dates, no ref
    { id: 3, propertyId: 500, roomId: 600, status: 'cancelled', arrival: '2025-09-01', departure: '2025-09-03', price: 300 }, // cancelled: keep Guesty
  ]);
  assert.equal(dedupeImported(db), 2);
  const left = db.prepare("SELECT guest_name FROM bookings WHERE source='guesty' ORDER BY arrival").all().map(r => r.guest_name);
  assert.deepEqual(left, ['Sam "Sammy" Lee', 'Dee', 'Ray']);
  assert.equal(periodStats(db, '2025-06-01', '2025-07-01').revenue, 550, 'not double counted');
});

test('removing the Guesty import leaves Beds24 data alone', () => {
  const db = openDb(':memory:');
  beds24Property(db);
  upsertBookings(db, [{ id: 9, propertyId: 500, roomId: 600, status: 'confirmed', arrival: '2026-01-01', departure: '2026-01-03', price: 1 }]);
  importGuesty(db, readGuestyExport(csv(ROWS)).bookings);
  assert.deepEqual(removeGuestyImport(db), { removed: 5 });
  assert.deepEqual(db.prepare('SELECT id FROM bookings').all().map(b => b.id), [9]);
});

test('databases from before this release gain the new columns', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'str-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE bookings (id INTEGER PRIMARY KEY, property_id INTEGER, room_id INTEGER, status TEXT NOT NULL, channel TEXT NOT NULL,
    arrival TEXT NOT NULL, departure TEXT NOT NULL, nights INTEGER NOT NULL, guest_name TEXT, email TEXT, phone TEXT, adults INTEGER DEFAULT 0,
    children INTEGER DEFAULT 0, price REAL DEFAULT 0, currency TEXT, notes TEXT, channel_ref TEXT, booked_at TEXT, modified_at TEXT);
    INSERT INTO bookings(id,status,channel,arrival,departure,nights) VALUES(1,'confirmed','Airbnb','2026-01-01','2026-01-02',1);`);
  old.close();
  const db = openDb(path);
  assert.deepEqual({ ...db.prepare('SELECT source, payout FROM bookings').get() }, { source: 'beds24', payout: null });
});
