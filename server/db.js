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

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export const getSetting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value == null ? null : String(value));
