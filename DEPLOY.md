# Deploying to Railway

About 10 minutes, all in the browser. Cost: Railway's Hobby plan (about $5/month); this app uses very little.

## 1. Create the project

1. Sign in at [railway.com](https://railway.com) with your GitHub account.
2. **New Project → Deploy from GitHub repo → `beauahill/STRDashboard`**.
   If the repo isn't listed, click **Configure GitHub App** and give Railway access to it.
3. Railway starts building right away. **The first deploy will fail** with
   `STARTUP ERROR: APP_PASSWORD is not set`. That's expected; the next two steps fix it.

## 2. Set a password

Click the service → **Variables → New Variable**:

| Name | Value |
| --- | --- |
| `APP_PASSWORD` | a long passphrase (this protects your guests' details; use a password manager) |

## 3. Attach a volume (where your data lives)

On the project canvas, right-click the service (or press `Ctrl/Cmd + K` and type "volume") →
**Attach volume** → mount path **`/data`**.

Without it the app refuses to start, because everything would be wiped on each redeploy.

## 4. Get your address

Service → **Settings → Networking → Generate Domain**. If it asks for a port, use the one shown in the
**Deploy Logs** line `STR Dashboard on http://localhost:XXXX`.

You'll get something like `https://strdashboard-production.up.railway.app`. That's the app's address.
(You can attach your own domain later on the same screen.)

## 5. Deploy from `main`

Service → **Settings → Source → Branch** → choose **`main`**. Railway redeploys automatically on every
change to `main`. New features are prepared on a separate branch and reach `main` (and your live app) only
when you merge their pull request on GitHub, so nothing goes live until you choose.

## 6. Connect Beds24

1. Open your Railway address and sign in with `APP_PASSWORD`.
2. In Beds24: **Settings → Apps & Integrations → API → generate an invite code**. Give it access to
   **properties**, **bookings with write access, including guest personal details and financial details**
   (otherwise guest names and totals come back blank, and door codes can't be saved on bookings), and
   **write access to inventory** (to change prices, minimum stays and blocked dates on the Rates page), and
   **write access to properties** (to edit listing content on the Listing page).
3. In the app: **Settings → paste the invite code → Connect & sync**.

The invite code is single-use: the app exchanges it for a long-lived key stored on the volume. To change
permissions later (e.g. add write access), generate a fresh code and paste it in Settings; it replaces
the old one. Settings shows the permissions currently granted.

## 7. Door locks (optional)

On the app's **Locks** page: paste a Seam API key (from your workspace at seam.co), click **Connect Yale
account** to sign in to Yale Access through Seam, then choose which property each lock opens. See the
"Door codes" items in `CUTOVER.md` for turning on automatic guest codes.

## 8. Phone notifications (optional)

1. Install the free **ntfy** app on each phone ([App Store and Google Play links](https://docs.ntfy.sh/subscribe/phone/)).
2. In the app: **Settings → Phone notifications**. Copy the topic name shown there.
3. In ntfy on each phone: tap **+**, paste the topic, leave the server as ntfy.sh, and allow notifications.
4. Press **Send test**. When it arrives, tick **Send notifications** and save.

Anyone who knows the topic name can read the alerts on ntfy.sh, so keep it private; **New topic name** (under
Advanced) replaces it if it leaks. Email alerts aren't built in: Railway blocks outgoing email (SMTP) below the
Pro plan, so they'd need an email service such as Resend.

## 9. Home Assistant (optional)

The app runs on Railway, not in the house, so it needs a way to reach Home Assistant. The recommended way keeps
Home Assistant off the public internet: Home Assistant and the dashboard both join your Tailscale network, and the
dashboard is only allowed to reach Home Assistant. (Any public address also works: Home Assistant Cloud,
Tailscale Funnel or a Cloudflare Tunnel. Then skip to step 5, and turn on multi-factor login in Home Assistant,
because its login page is then on the internet.)

1. **Put Home Assistant on Tailscale.** In Home Assistant: **Settings → Add-ons → Add-on Store → Tailscale →
   Install**, start it, open its Web UI and sign in to your Tailscale account. In the add-on's **Configuration**,
   set **Share Home Assistant** to **serve** (not funnel) on port 443, then restart the add-on. Then in
   **Settings → System → Network**, turn on **Trust X-Forwarded-For** and add `127.0.0.1` to **Trusted proxies**.
   On the Tailscale admin console's **Machines** page, note Home Assistant's name and IP (100.x.y.z), and in its
   ⋯ menu choose **Disable key expiry**. Its address is `https://<name>.<your-tailnet>.ts.net`, for example
   `https://homeassistant.tail1ebd8f.ts.net`.
2. **Let the dashboard reach only Home Assistant.** Admin console → **Access controls**. Merge this into the
   policy (keep your existing `ssh` and `nodeAttrs` sections; use Home Assistant's IP from step 1):

   ```json
   "tagOwners": { "tag:str-dashboard": ["autogroup:admin"] },
   "hosts": { "homeassistant": "100.x.y.z" },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
     { "src": ["tag:str-dashboard"], "dst": ["homeassistant"], "ip": ["tcp:443"] }
   ]
   ```

   If the policy has the default allow-everything rule (`"src": ["*"]`), replace it with the `autogroup:member`
   line above: left as it is, it would let the dashboard reach every device you own. (Older policies use `acls`
   instead of `grants`: change that rule's `"src": ["*"]` to `["autogroup:member"]` and add
   `{ "action": "accept", "src": ["tag:str-dashboard"], "dst": ["homeassistant:443"] }`.)
3. **Create a key for the dashboard.** Admin console → **Settings → Keys → Generate auth key**: turn on **Tags**
   and pick `tag:str-dashboard` (tagged machines never expire), and **Pre-approved** if device approval is on.
   Leave **Reusable** off. The key is only used the first time; after that the dashboard's Tailscale identity is
   kept on the volume, so redeploys stay the same machine.
4. **Add it to Railway.** Service → **Variables** → `TS_AUTHKEY` = the key. Railway redeploys, and the dashboard
   appears on the Machines page as `str-dashboard`. Leave the variable in place.
5. **Connect.** In Home Assistant: your profile (bottom left) → **Security** → **Long-lived access tokens → Create
   token**. In the app: **Smart home** → paste Home Assistant's address and the token → **Connect**. With
   Tailscale, the page says "Tailscale connected as str-dashboard… Home Assistant is reached privately."
   Everything relevant is followed; **Choose devices** lets you untick anything that isn't part of the rental and
   fix a device's type.
6. Review **Alert thresholds**, then switch on **Thermostat around bookings** and **Lock up after checkout** if
   you want them. Phone notifications include Home Assistant alerts (Settings → Phone notifications).

The token gives full control of Home Assistant, so it stays on the server; you can revoke it in Home Assistant at
any time. If you use Home Assistant's own automations for the same thermostat, switch one of them off.

If the Smart home page says Tailscale isn't connected: *needs a new auth key* means the key expired before its
first use or was already used (generate another and update `TS_AUTHKEY`); *approve it in the Tailscale admin
console* means device approval is on (approve `str-dashboard` on the Machines page). *Tailscale couldn't reach
…* means the dashboard is connected but can't get to Home Assistant: check the access rule from step 2 and that
the Tailscale add-on is running.

## 10. AI assistant (optional)

1. At [console.anthropic.com](https://console.anthropic.com): add a payment method or credits under
   **Billing**, then **API keys → Create key**. Copy it (it starts with `sk-ant-`).
2. In the app: **Settings → AI assistant → paste the key → Save key**. The app checks it with Anthropic
   before saving. (Alternatively, add it as an `ANTHROPIC_API_KEY` variable in Railway; a key pasted in
   Settings takes priority.)
3. Set a **monthly spending limit** (default $25) and fill in the **house notes** for each property:
   parking, pets, check-in policies, local tips, and the name to sign off with. Guest reply drafts use them.

Usage is billed to your Anthropic account, typically one to a few cents per request. Settings shows this
month's estimate. The key stays on the server; the browser only ever sees its last four characters.

## Troubleshooting

- **Deploy failed**: open **Deploy Logs**; any `STARTUP ERROR:` line says exactly what's missing.
- **Forgot the password**: change `APP_PASSWORD` in Variables. Railway redeploys and everyone is signed out.
- **Backups**: check the volume's **Backups** tab. Bookings and properties can always be re-synced from
  Beds24, so the main thing to protect is anything you enter only in this app.
