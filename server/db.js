import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, currency TEXT DEFAULT 'USD'
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, name TEXT NOT NULL, qty INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  property_id INTEGER, room_id INTEGER,
  status TEXT NOT NULL,            -- confirmed | new | request | cancelled | inquiry | block
  channel TEXT NOT NULL,           -- Airbnb | Booking.com | VRBO | Direct | Other
  arrival TEXT NOT NULL, departure TEXT NOT NULL, nights INTEGER NOT NULL,
  guest_name TEXT, email TEXT, phone TEXT,
  adults INTEGER DEFAULT 0, children INTEGER DEFAULT 0,
  price REAL DEFAULT 0, currency TEXT,
  notes TEXT, channel_ref TEXT,
  booked_at TEXT, modified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(arrival, departure);
CREATE INDEX IF NOT EXISTS idx_bookings_room ON bookings(room_id);
`;

// Columns added after the first release; created on startup if an older database lacks them.
const ADDED_COLUMNS = [
  ['bookings', 'source', "TEXT NOT NULL DEFAULT 'beds24'"],  // beds24 | guesty
  ['bookings', 'payout', 'REAL'],                             // what reached the host, when known
];

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, col, def] of ADDED_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
  return db;
}

export const getSetting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value == null ? null : String(value));
