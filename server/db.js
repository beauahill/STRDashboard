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
-- Local copy of the Beds24 calendar (per room, per night) so the Rates page loads instantly.
CREATE TABLE IF NOT EXISTS calendar_days (
  room_id INTEGER NOT NULL, date TEXT NOT NULL,
  price REAL, min_stay INTEGER, num_avail INTEGER, override TEXT,
  PRIMARY KEY (room_id, date)
);
-- Smart locks known to Seam, and which room each one opens.
CREATE TABLE IF NOT EXISTS locks (
  device_id TEXT PRIMARY KEY, name TEXT NOT NULL, room_id INTEGER,
  online INTEGER, battery REAL, can_program INTEGER, updated_at TEXT
);
-- One door code per booking (the same code on every lock of that room).
CREATE TABLE IF NOT EXISTS door_codes (
  booking_id INTEGER PRIMARY KEY, code TEXT NOT NULL, starts_at TEXT, ends_at TEXT,
  beds24_written TEXT, beds24_error TEXT, created_at TEXT, updated_at TEXT
);
-- The Seam access code for that booking on each lock, with its last known state.
CREATE TABLE IF NOT EXISTS door_code_devices (
  booking_id INTEGER NOT NULL, device_id TEXT NOT NULL, access_code_id TEXT,
  status TEXT, scheduled INTEGER, errors TEXT, warnings TEXT, error TEXT, updated_at TEXT,
  PRIMARY KEY (booking_id, device_id)
);
-- Guest messages (copy of Beds24's message log; attachments are fetched on demand).
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL,
  source TEXT NOT NULL,            -- guest | host | system | internalNote
  body TEXT, time TEXT NOT NULL, read INTEGER DEFAULT 0,
  attachment_name TEXT, attachment_mime TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id, time);
CREATE TABLE IF NOT EXISTS saved_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL);
-- Dates that move prices: football weekends, festivals, holidays (inclusive first and last night).
CREATE TABLE IF NOT EXISTS pricing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  pct REAL NOT NULL, min_stay INTEGER, source TEXT
);
-- Automated guest messages: when to send (anchor + offset), to whom (filters) and what (template).
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  anchor TEXT NOT NULL,            -- booked | cancelled | dates_changed | arrival | departure
  offset_days INTEGER DEFAULT 0, at_time TEXT, delay_minutes INTEGER DEFAULT 0,
  channels TEXT, min_nights INTEGER, body TEXT NOT NULL,
  enabled INTEGER DEFAULT 0, enabled_at TEXT, sort INTEGER DEFAULT 0
);
-- One row per automation per booking (per date change): what was sent, is waiting, failed or was skipped.
CREATE TABLE IF NOT EXISTS automation_sends (
  automation_id INTEGER NOT NULL, booking_id INTEGER NOT NULL, key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, scheduled_at TEXT, sent_at TEXT, error TEXT, body TEXT, updated_at TEXT,
  PRIMARY KEY (automation_id, booking_id, key)
);
-- Last known dates per booking, to notice date changes.
CREATE TABLE IF NOT EXISTS booking_snapshots (booking_id INTEGER PRIMARY KEY, arrival TEXT, departure TEXT);
-- Listing content saves (property and room texts/details) sent to Beds24.
CREATE TABLE IF NOT EXISTS listing_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, property_id INTEGER NOT NULL, summary TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
-- Each AI assistant request, with its token use and estimated cost (US$).
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task TEXT NOT NULL, calls INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER, cost REAL, error TEXT
);
-- Phone notifications sent (or tried) per event, so each goes out once.
CREATE TABLE IF NOT EXISTS notification_log (
  kind TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, title TEXT, ok INTEGER NOT NULL, error TEXT, attempts INTEGER DEFAULT 0,
  PRIMARY KEY (kind, ref)
);
-- Home Assistant: latest reading per followed device, 10-minute samples (for stay records), lock/leak events,
-- conditions currently breaking an alert rule, every alert episode, and automatic actions taken.
CREATE TABLE IF NOT EXISTS ha_states (entity_id TEXT PRIMARY KEY, state TEXT, attributes TEXT, last_changed TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS ha_samples (entity_id TEXT NOT NULL, at TEXT NOT NULL, value REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ha_samples ON ha_samples(at, entity_id);
CREATE TABLE IF NOT EXISTS ha_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, at TEXT NOT NULL, from_state TEXT, to_state TEXT);
CREATE INDEX IF NOT EXISTS idx_ha_events ON ha_events(at);
CREATE TABLE IF NOT EXISTS ha_alerts (entity_id TEXT NOT NULL, rule TEXT NOT NULL, since TEXT NOT NULL, value REAL, log_id INTEGER, PRIMARY KEY (entity_id, rule));
CREATE TABLE IF NOT EXISTS ha_alert_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, rule TEXT NOT NULL, since TEXT NOT NULL, until TEXT, peak REAL);
CREATE TABLE IF NOT EXISTS ha_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity_id TEXT, kind TEXT NOT NULL, detail TEXT, ok INTEGER NOT NULL, notify INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ha_done (key TEXT PRIMARY KEY, at TEXT NOT NULL);
-- Photos for the direct booking site (uploaded, or links to Beds24's copies).
CREATE TABLE IF NOT EXISTS site_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, sort INTEGER DEFAULT 0, caption TEXT,
  mime TEXT, data BLOB, url TEXT, created_at TEXT
);
-- Direct guests' online check-in from the guidebook: typed-name signature of the rental agreement and an ID photo
-- (the photo is deleted a set number of days after checkout).
CREATE TABLE IF NOT EXISTS guide_checkins (
  booking_id INTEGER PRIMARY KEY, name TEXT, signed_at TEXT, ip TEXT, user_agent TEXT, id_mime TEXT, id_data BLOB, id_deleted_at TEXT
);
-- Money: expenses (optionally repeating monthly, with a receipt) and payouts the owner has marked as received.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER, date TEXT NOT NULL, category TEXT NOT NULL, vendor TEXT,
  description TEXT, amount REAL NOT NULL, repeat TEXT, until TEXT, receipt_mime TEXT, receipt_data BLOB, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE TABLE IF NOT EXISTS payouts_received (booking_id INTEGER PRIMARY KEY, amount REAL, received_on TEXT, note TEXT, updated_at TEXT);
-- Every change sent to Beds24 from this app, successful or not.
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, room_id INTEGER NOT NULL,
  date_from TEXT NOT NULL, date_to TEXT NOT NULL, nights INTEGER NOT NULL,
  summary TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
`;

// Columns added after the first release; created on startup if an older database lacks them.
const ADDED_COLUMNS = [
  ['bookings', 'source', "TEXT NOT NULL DEFAULT 'beds24'"],  // beds24 | guesty
  ['bookings', 'payout', 'REAL'],                             // what reached the host, when known
  ['bookings', 'cancelled_at', 'TEXT'],                       // Beds24 cancelTime
  ['bookings', 'first_seen', 'TEXT'],                         // when this app first saw the booking
  ['bookings', 'commission', 'REAL'],                         // channel commission (Beds24), when known
  ['bookings', 'tax', 'REAL'],                                // tax on the booking (Beds24), when known
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
