# Switching from Guesty Lite to Beds24

One listing, four booking sources (Airbnb, VRBO, Booking.com, direct). Everything moves on the same day.
Do phases 1 and 2 at your own pace, then pick a **quiet day with no check-ins or check-outs** for phase 3.

Menu names come from the Beds24 wiki and may differ slightly from what you see. Beds24's in-app **HELP**
links on each settings page are the source of truth.

## Phase 1 · Save what's in Guesty (15 min)

- [ ] **Export your reservation history.** Guesty Lite → side menu **Reservation report** → **Columns**
      (top right): turn on every column → export CSV. It arrives by email. Keep the file; the dashboard will
      import it so your revenue and occupancy history doesn't start at zero.
- [ ] **Copy your auto-message texts** (every template and when it's sent) into a document.
- [ ] **Write down your direct booking site's address** and whether it uses your own domain.
- [ ] **Screenshot your Airbnb, VRBO and Booking.com calendars** for the next 12 months, including blocked
      dates. Beds24 doesn't import blocked dates, so you'll re-enter them.

## Phase 2 · Set up Beds24 before connecting anything (1–2 hours)

Nothing here touches your live listings yet.

- [ ] **Property and room**: name, address, photos, description, amenities, house rules, check-in/out times.
      VRBO's connection checks this content and lists anything missing as "Fix Content Errors".
- [ ] **Prices and minimum stays for the next 12 months.** This is the most important step: if prices
      aren't set when you connect, Beds24 sends its base rate and **overwrites your current Airbnb/VRBO
      prices**. Match what's live on Airbnb today. Quickest: on the dashboard's **Pricing** page, click
      "Suggest from my history", review the rules, then **Apply → Next 12 months**. (Or set ranges by hand on
      the **Rates** page.) Then check a few nights in Beds24.
- [ ] **Blocked dates** from your screenshots (Rates page → select the nights → "block").
- [ ] **Automated messages (dashboard → Automations)**: edit the starter messages to match your Guesty ones
      (wording and timing), and add any others. Put your Wi-Fi, address, parking etc. under **Property
      details** so they can be used as `{wifi_password}`-style fill-ins. Write plain text: Airbnb and
      Booking.com don't show formatting, and Booking.com doesn't allow links. **Leave them all off** for now;
      Guesty is still messaging guests. Don't set the same messages up as Beds24 Auto Actions.
- [ ] **Booking confirmation template** (Beds24: Settings → Guest Management → Confirmation Messages). VRBO
      requires a confirmation from the channel manager, so keep Beds24's one even with the dashboard's
      "Booking confirmation" automation (or switch that automation to exclude VRBO).
- [ ] **Door codes (dashboard → Locks)**: add your Seam API key, click **Connect Yale account**, set both
      locks to open your property, and check the check-in/checkout times. Leave **automatic guest codes
      off** for now; Guesty is still making codes.
- [ ] **Door code in the check-in message**: the "Check-in instructions" automation already includes
      `{door_code}`, and waits rather than sends if a code isn't ready. Keep it within 14 days of arrival (the
      Locks page "create codes" setting). The code is also saved on the Beds24 booking (`[GUESTCUSTOMQ10]`)
      if you ever want it in a Beds24 message.
- [ ] **Booking page for direct bookings**: set up Beds24's booking page and connect a payment provider
      (e.g. Stripe) for deposits and payments. Make a test booking, then cancel it.

## Phase 3 · Switch-over day (2–3 hours)

Do one channel at a time, and check each before moving on.

**Airbnb**
- [ ] In Guesty, disconnect the Airbnb listing.
- [ ] In Beds24: Settings → Channel Manager → Airbnb → connect your account → map the room to your
      **existing** listing (don't create a new one; that would lose your reviews) → check prices →
      **import upcoming bookings**.
- [ ] When connecting, make sure the permission list includes **messaging**, so Auto Actions reach guests.
- [ ] Compare Beds24's calendar against Airbnb's **date by date** for the next 12 months. The wiki notes
      the import may miss some long or in-progress stays, so add anything missing by hand.
- [ ] Open your Airbnb listing as a guest and search a few dates (don't book) to confirm price and
      availability look right.

**Booking.com**
- [ ] Disconnect in Guesty (Booking.com may also need you to switch the connectivity provider in the
      Extranet).
- [ ] In Beds24: connect, map the room, **import upcoming bookings**, check the calendar, then turn on
      two-way sync.

**VRBO**
- [ ] Disconnect in Guesty.
- [ ] In Beds24: Settings → Channel Manager → VRBO → Mapping → enable the room → fix any content errors →
      Account → generate the VRBO Software ID (needs a credit card) → **Connect with Vrbo** and follow the
      steps.
- [ ] ⚠️ **VRBO only sends bookings made after you connect.** Add every existing upcoming VRBO booking to
      Beds24 by hand (or via iCal) **before** the calendar goes live, or those dates could be sold twice.

**Turno**
- [ ] In Turno, replace the property's Guesty calendar link with the dashboard's **Cleaning → Turno link**.
      Turno creates a cleaning at each checkout. Unlike Beds24's own calendar link, this one lists real stays
      only, so blocked dates don't create stray cleanings.
- [ ] Check Turno's schedule for the next month matches the dashboard's Cleaning page.

**Door codes**
- [ ] Turn off Guesty's lock automation / check-in message, so guests don't get two different codes.
- [ ] On the Locks page, turn on **automatic guest codes**. Every upcoming guest within 14 days gets a code
      on both locks (last 4 digits of their phone), saved to their Beds24 booking.
- [ ] ⚠️ **Guests who already received a Guesty code**: leave those Guesty codes on the locks (they show
      under "Other codes"), so those guests can still get in. Their new code may differ, because the app
      won't reuse a code that's already on a lock. Delete the Guesty codes after those guests check out.
- [ ] Check the Dashboard: every arrival in the next few days shows 🔑 with its code and no ⚠.
- [ ] On the Automations page, preview "Check-in instructions" with an upcoming booking and confirm the code
      appears.

**Direct bookings**
- [ ] Point your direct booking link (or domain) at the Beds24 booking page.
- [ ] Add any existing direct bookings to Beds24 by hand.

**Automated messages**
- [ ] Turn off Guesty's automated messages.
- [ ] After Beds24 has synced, switch on your automations (dashboard → Automations). Nothing already due is
      sent; check **Coming up** lists what you expect, and skip anything a guest already received from
      Guesty.

**Messages**
- [ ] Open the dashboard's **Inbox** and check a recent Airbnb conversation shows up. If Airbnb messages
      are missing, reconnect Airbnb in Beds24 and make sure the permission list includes messaging.
- [ ] Send yourself a test reply on a booking (or reply to a real guest question) and confirm it appears in
      the guest's Airbnb/VRBO/Booking.com thread.
- [ ] Edit the saved replies (Inbox → a conversation → "Edit saved replies") to match your voice.

**Wrap-up**
- [ ] In the dashboard, press **Sync** and check every upcoming booking appears with the right channel,
      guest and total.
- [ ] Watch the first few days closely: a new booking on each channel should appear in Beds24, the
      dashboard and Turno.
- [ ] Only then cancel Guesty. Keep the history export.

## Direct booking site (replaces Guesty's)

1. In Beds24: **Settings → Payments → Payment Gateways → Stripe**: connect Stripe and set capture so guests pay
   when they book. For a damage deposit, add a payment rule that authorises without capturing (a hold).
2. In Beds24: **Settings → Booking Engine**: check the booking page shows your room and prices, link the rental
   agreement (the app's **Booking site** page shows its address) in the terms, and make sure the booking
   confirmation email to guests is switched on (direct guests don't get Airbnb's emails).
3. In the app: **Booking site** → add photos, check the text, paste your Beds24 booking page link if it differs,
   preview, then tick **Site is live**.
4. Optional: add your own domain (e.g. book.yourdomain.com) as a custom domain on the Railway service, point its
   CNAME at Railway, and enter it on the Booking site page.
5. Make a test booking for a night far ahead, then cancel it in Beds24. Then point Guesty's direct booking links
   at the new site before cancelling Guesty.
