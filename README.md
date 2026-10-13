# STR Dashboard

A small, self-hosted dashboard for short-term rentals, fed by the [Beds24 API v2](https://wiki.beds24.com/index.php/API_V2.0)
(which in turn syncs Airbnb, VRBO and Booking.com). Built to replace Guesty for day-to-day visibility.

No build step and one dependency (Anthropic's official SDK, for the optional AI assistant): Node 22.13+
(built-in SQLite) and a vanilla JS frontend. Run `npm install` once before starting it locally.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for Railway (recommended): one service, one volume, one `APP_PASSWORD` variable.

## Run locally

```sh
npm install
npm run demo                    # try it with sample data on http://localhost:3000
APP_PASSWORD=secret npm start   # password-protects the UI and API
```

Then open **Settings → Connect**. In Beds24 go to *Settings → Apps & Integrations → API → Invite codes*, create a
code with access to properties and bookings (including guest personal and financial details) and write access
to inventory (for the Rates page), and paste it in. Invite codes are single-use, so connect from the copy you'll actually keep using.
The app exchanges the code for a refresh token, does a full sync (1 year back), then syncs incrementally every
15 minutes (or press **Sync**).

Env vars: `PORT` (3000), `APP_PASSWORD` (if unset, binds to localhost only), `DB_PATH` (`data/str.db`, or
`$RAILWAY_VOLUME_MOUNT_PATH/str.db` on Railway), `ANTHROPIC_API_KEY` (optional; the key can also be pasted in
Settings). Failed logins are rate-limited (10 per IP per 15 minutes).

## What's in it

Pages are grouped in a sidebar (Today, Guests, Revenue, Property), which becomes a slide-in menu on phones;
Settings is the gear at the top right. On a phone, "Add to Home Screen" installs it as an app.

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
  `{check_in_time}`, `{guidebook_link}`, …). Unread count in the menu and on the Dashboard. Checks for new messages every
  minute while the inbox is open (at most twice a minute against Beds24), otherwise with each 15-minute sync.
- **Automations**: scheduled guest messages sent through Beds24: after a booking is made, cancelled or its
  dates change, or N days before/after check-in or checkout at a set time; filtered by channel and minimum
  nights. Eight editable starters (confirmation, check-in instructions with door code, check-in day,
  mid-stay, checkout reminder, review request, cancellation, dates changed), all off by default. Safety:
  switching one on never sends a backlog; last-minute bookings still get messages due before they existed;
  messages with an unfilled `{fill-in}` wait (and fail after a deadline) instead of sending; each message goes
  once per booking. Upcoming sends with preview and skip, history, and per-property custom fill-ins
  (Wi-Fi, address, ...). Runs every 5 minutes; problems show on the Dashboard.
- **Phone notifications** (free [ntfy](https://ntfy.sh) app): new guest messages and inquiries (checked every
  minute while on), new bookings and booking requests, cancellations, and problems (a failed automated message, a
  door code not working before arrival, Beds24 not syncing for an hour). Tap one to open that conversation. Each
  event is sent once, nothing from before notifications were switched on is sent, the message text can be left out,
  and the topic is long and random because on ntfy.sh it's what keeps the alerts private. Settings has a test
  button and the recent sends.
- **Smart home** (Home Assistant, through its API with a long-lived access token; checked every minute):
  - *Status*: thermostats (temperature, setpoint, mode), inside/outside temperatures, humidity, air quality, leak
    sensors and smoke/CO alarms, locks, batteries and offline devices, plus whether a guest is staying and when the
    next check-in is. A summary card on the Dashboard.
  - *Alerts* (to phones through notifications): leak and alarm at once; freeze risk, too hot, high humidity, poor air
    (PM2.5, CO₂, AQI, VOC, CO; "possible smoking or vaping" during a stay), a door left unlocked with no guest
    staying, jammed locks, low batteries, offline devices and Home Assistant unreachable. Thresholds are editable;
    a condition must clear (with a margin) before it can alert again.
  - *Thermostat around bookings* (off until switched on): guest temperatures from N hours before check-in, eco
    temperatures from N minutes after checkout, set once per change so guests can still adjust it; handles
    heat, cool and heat/cool modes and thermostats that are switched off; °C installs are converted. Freeze
    protection turns the heat on if the house nears a floor temperature while the heat is off.
  - *Lock up after checkout* (off until switched on): locks chosen doors N minutes after checkout if unlocked,
    once per stay; failures are reported.
  - *Stay records*: readings saved every 10 minutes (kept 400 days) give each stay's temperature range, humidity,
    worst PM2.5 / CO₂, alerts and lock/leak events, with charts, for smoking or damage claims.
  - Door codes stay with Seam (Home Assistant's Yale integration doesn't manage keypad codes).
- **Booking site** (direct bookings): a public page per property at `/stay/<name>` (or your own domain) with
  photos, description, highlights, house rules, neighbourhood, cancellation policy and check-in times; a two-month
  availability calendar with nightly prices from Beds24 (booked, blocked and unpriced nights closed, minimum stays
  respected); an estimate with the cleaning fee; and **Book now**, which opens your Beds24 booking page with the dates
  and guests filled in, where the guest pays (Stripe through Beds24) and gets Beds24's confirmation email. A rental
  agreement page to link from the booking page's terms. Only availability and prices are public. Off until switched
  on; while off, you see a preview when signed in. Photos are uploaded (resized in the browser) or imported from Beds24.
- **Guidebook**: a private page per booking (`/guide/<link>`, sent with the `{guidebook_link}` fill-in) with a welcome,
  check-in steps, the door code and address (only from N days before check-in until checkout), Wi-Fi with a copy
  button, house rules, a house guide (heating, TV, trash…), local tips by category, a tickable checkout checklist
  and help/emergency details. Optional for direct guests: online check-in (typed-name acceptance of the rental
  agreement and an ID photo) before the code and address appear; ID photos are deleted N days after checkout and
  only the signed-in owner can view them. Links are signed per booking and can all be revoked at once.
- **Bookings**: searchable/filterable list.
- **Analytics**: year to date, last 12 months and next 90 days against the same dates last year; revenue,
  occupancy or ADR by month next to the same month last year; pace (on the books now versus what was booked
  by this date last year, and how last year finished); channel mix with ADR, lead time and length of stay;
  how far ahead guests book; length of stay; occupancy by night of the week; cancellations. Includes the
  Guesty history import. Filter by property and by period (last 12 months, this year, last year, all time).
- **AI assistant** (optional, uses your own Anthropic API key; model `claude-opus-5-5`):
  - *Inbox*: **Draft reply** writes a reply in the guest's language from the conversation, stay details,
    your saved replies, the listing text and your house notes. Access details (door code, Wi-Fi, directions)
    are only given to it for confirmed stays. The draft goes in the reply box; you edit and send it, and
    Send asks first if a [bracketed] fill-in is left.
  - *Analytics*: **Ask about your numbers** in plain English ("How did October compare with last year?").
    Claude looks the figures up with read-only tools over the local database, never estimates them, and
    keeps the conversation for follow-ups.
  - *Listing*: **Improve / Write with AI** on every text field, with an optional instruction; keeps to the
    character limit (50 for the Airbnb headline). "Use this" puts it in the field, which is still previewed
    before saving.
  - *Pricing*: **Review next 90 days**, **Explain** a selected night, or ask a question. It sees your rules,
    events, pace and each night's factors. Advice only; nothing is applied.
  - Settings: key (checked before saving, never sent to the browser), monthly spending limit (default $25)
    with this month's estimated cost, and per-property house notes. Refusals and errors show as clear
    messages; requests use Anthropic's server-side fallback so a declined request is retried on another
    model.
- Per-property filter on every view.
- **Listing**: edit the property's listing text (headline, description, neighbourhood, directions, house rules,
  policies), details (name, type, address, check-in/out times, contact) and each room's capacity, size, fees
  and texts, then push to Beds24. Changes are previewed field by field, only changed fields are sent, the
  result is re-read from Beds24 to confirm, and saves are logged. Needs write access to Properties.
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
`server/messages.js` inbox and saved replies · `server/pricing.js` pricing tool · `server/cleaning.js` Turno feed and turnovers · `server/automations.js` automated messages · `server/listing.js` listing editor ·
`server/analytics.js` analytics · `server/ai.js` AI assistant · `server/notify.js` phone notifications · `server/ha.js` Home Assistant · `server/site.js` booking site · `server/guide.js` guidebook ·
`server/guesty.js` Guesty import ·
`server/stats.js` metrics · `server/demo.js` sample data · `public/` UI · `test/` (`npm test`).

## Known gaps / next steps

- No creating or editing bookings from the app yet (Beds24 `POST /bookings`).
- Owner statements / profit and loss (expenses aren't tracked yet).
- The AI assistant has only been run against a stand-in for Anthropic's API in tests; try it on a few real
  drafts before relying on it.
- Beds24 request/response fields are checked against Beds24's published OpenAPI spec, but the app hasn't yet run
  against a Beds24 account with live channel connections.
- Beds24 API credits are rate limited; the incremental sync keeps usage low.
