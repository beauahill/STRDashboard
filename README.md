# STR Dashboard

A small, self-hosted dashboard for short-term rentals, fed by the [Beds24 API v2](https://wiki.beds24.com/index.php/API_V2.0)
(which in turn syncs Airbnb, VRBO and Booking.com). Built to replace Guesty for day-to-day visibility.

No dependencies and no build step: Node 22.13+ (built-in SQLite) and a vanilla JS frontend.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for Railway (recommended): one service, one volume, one `APP_PASSWORD` variable.

## Run locally

```sh
npm run demo                    # try it with sample data on http://localhost:3000
APP_PASSWORD=secret npm start   # password-protects the UI and API
```

Then open **Settings → Connect**. In Beds24 go to *Settings → Apps & Integrations → API → Invite codes*, create a
code with access to properties and bookings (including guest personal and financial details) and write access
to inventory (for the Rates page), and paste it in. Invite codes are single-use, so connect from the copy you'll actually keep using.
The app exchanges the code for a refresh token, does a full sync (1 year back), then syncs incrementally every
15 minutes (or press **Sync**).

Env vars: `PORT` (3000), `APP_PASSWORD` (if unset, binds to localhost only), `DB_PATH` (`data/str.db`, or
`$RAILWAY_VOLUME_MOUNT_PATH/str.db` on Railway). Failed logins are rate-limited (10 per IP per 15 minutes).

## What's in it

- **Dashboard**: arrivals / departures / in-house / same-day turnovers, occupancy, revenue, ADR, RevPAR,
  12-month revenue chart (with forecast), revenue by channel, pending requests.
- **Calendar**: month grid with previous/next and jump-to-month (back through imported history, forward as far
  as bookings go). Stays are bars from check-in to checkout, coloured by channel; click one for guest count,
  total, nightly rate and door code. Shows nightly prices and blocked nights for a single room, and the
  month's booked nights, occupancy and revenue.
- **Inbox**: guest messages from Airbnb, Booking.com and VRBO through Beds24, including pre-booking
  inquiries. One conversation per booking (unread first; filters for unread, current/upcoming stays and
  inquiries), chat-style thread with the stay details and door code, replies sent to the guest's channel
  thread, attachments, and saved replies with fill-ins (`{guest_first_name}`, `{door_code}`,
  `{check_in_time}`, …). Unread count in the menu and on the Dashboard. Checks for new messages every
  minute while the inbox is open (at most twice a minute against Beds24), otherwise with each 15-minute sync.
- **Automations**: scheduled guest messages sent through Beds24: after a booking is made, cancelled or its
  dates change, or N days before/after check-in or checkout at a set time; filtered by channel and minimum
  nights. Eight editable starters (confirmation, check-in instructions with door code, check-in day,
  mid-stay, checkout reminder, review request, cancellation, dates changed), all off by default. Safety:
  switching one on never sends a backlog; last-minute bookings still get messages due before they existed;
  messages with an unfilled `{fill-in}` wait (and fail after a deadline) instead of sending; each message goes
  once per booking. Upcoming sends with preview and skip, history, and per-property custom fill-ins
  (Wi-Fi, address, ...). Runs every 5 minutes; problems show on the Dashboard.
- **Bookings**: searchable/filterable list.
- Per-property filter on every view.
- **Rates**: two-month calendar of nightly price, minimum stay, blocked and booked nights. Select a range
  (optionally only some weekdays), set a price / minimum stay / block or open, preview exactly which nights
  change, then save to Beds24. Every save is re-read from Beds24 to confirm it stuck, and logged under
  "Recent changes". Edits Beds24's **Price 1** daily rate. Needs an invite code with **write** access to
  Inventory; with a read-only code the page shows prices but can't save.
- **Pricing** (Laramie pricing tool): a recommended price and minimum stay for every unbooked night, from a
  base price × day-of-week × month × local events (UW football weekends, Jubilee Days, Frontier Days overflow,
  commencement, move-in, holidays; editable, with sources and "estimated" flags) × booking pace versus the
  same point last year × last-minute discount / far-ahead premium × gap-night discount, kept within a floor
  and ceiling. Click any night for the breakdown. "Suggest from my history" derives the base and seasonal
  adjustments from past stays. Apply 30/90/365 days to Beds24 (unbooked nights only, verified and logged),
  or switch on daily auto-pricing (capped change per day, off by default).
- **Cleaning**: upcoming turnovers with the time available to clean (same-day turnovers highlighted) and next
  guests' head count, plus a private per-room calendar link for **Turno** (Turno has no public API; it
  subscribes to iCal). The feed contains real stays only, so blocks never create cleanings, and no guest
  names or contact details. The link can be regenerated.
- **Locks** (Yale via [Seam](https://www.seam.co)): every confirmed Beds24 stay gets a door code on each lock
  of its property (last 4 digits of the guest's phone; last 5/6 if that clashes, random if no phone), active
  from check-in to checkout time in the property's time zone. Codes follow date changes and cancellations,
  are saved to a Beds24 booking custom field (`[GUESTCUSTOMQ10]` in Auto Action messages), and show on the
  Dashboard with a warning for any arrival without a working code. The page also lists, changes, deletes
  and adds cleaner/owner codes on all locks at once, including codes set in the Yale Access app. Automatic
  guest codes are off until switched on.
- **Guesty history import** (Settings): upload a Guesty Lite reservations CSV, preview it, then import.
  Re-importing updates rather than duplicates, and once Beds24 has a stay, its copy replaces the Guesty one.
  Guest addresses, IDs and door key codes in the file are never stored.

## Layout

`server/beds24.js` API client + token handling · `server/sync.js` mapping and sync ·
`server/rates.js` prices, minimum stays and blocks · `server/doors.js` + `server/seam.js` door codes ·
`server/messages.js` inbox and saved replies · `server/pricing.js` pricing tool · `server/cleaning.js` Turno feed and turnovers · `server/automations.js` automated messages ·
`server/guesty.js` Guesty import ·
`server/stats.js` metrics · `server/demo.js` sample data · `public/` UI · `test/` (`npm test`).

## Known gaps / next steps

- No creating or editing bookings from the app yet (Beds24 `POST /bookings`).
- Listing editor, AI assistant and analytics, owner statements.
- Beds24 request/response fields are checked against Beds24's published OpenAPI spec, but the app hasn't yet run
  against a Beds24 account with live channel connections.
- Beds24 API credits are rate limited; the incremental sync keeps usage low.
