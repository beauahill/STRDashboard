# STR Dashboard

A small, self-hosted dashboard for short-term rentals, fed by the [Beds24 API v2](https://wiki.beds24.com/index.php/API_V2.0)
(which in turn syncs Airbnb, VRBO and Booking.com). Built to replace Guesty for day-to-day visibility.

No dependencies and no build step: Node 22.13+ (built-in SQLite) and a vanilla JS frontend.

## Run it

```sh
npm run demo                    # try it with sample data on http://localhost:3000
APP_PASSWORD=secret npm start   # real use; password-protects the UI and API
```

Then open **Settings → Connect**. In Beds24 go to *Settings → Apps & Integrations → API → Invite codes*, create a
code with read access to properties and bookings, and paste it in. The app exchanges it for a refresh token,
does a full sync (1 year back), then syncs incrementally every 15 minutes (or press **Sync**).

Env vars: `PORT` (3000), `APP_PASSWORD` (if unset, binds to localhost only), `DB_PATH` (`data/str.db`).

## What's in v0.1 (read-only)

- **Dashboard**: arrivals / departures / in-house / same-day turnovers, occupancy, revenue, ADR, RevPAR,
  12-month revenue chart (with forecast), revenue by channel, pending requests.
- **Calendar**: 30-day multi-property timeline, colored by channel, blocks and requests marked.
- **Bookings**: searchable/filterable list.
- Per-property filter on every view.

## Layout

`server/beds24.js` API client + token handling · `server/sync.js` mapping and sync ·
`server/stats.js` metrics · `server/demo.js` sample data · `public/` UI · `test/` (`npm test`).

## Known gaps / next steps

- Read-only: no creating/editing bookings, rates or availability (Beds24 `POST /bookings`, `/inventory/rooms/calendar`).
- Guest messaging, cleaning/turnover task assignment, owner statements, expenses/P&L.
- Channel mapping in `normalizeChannel` is based on Beds24's `channel`/`referer` fields; check against your real
  data (VRBO often arrives as `expedia`/`homeaway`).
- Not yet tested against a live Beds24 account (only a mocked API); expect small field-name fixes on first real sync.
- Beds24 API credits are rate limited; the incremental sync keeps usage low.
