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

## 5. Check which branch it deploys

Service → **Settings → Source → Branch**. Railway redeploys automatically on every push to that branch.

## 6. Connect Beds24

1. Open your Railway address and sign in with `APP_PASSWORD`.
2. In Beds24: **Settings → Apps & Integrations → API → generate an invite code**. Give it read access to
   **properties, inventory and bookings, including guest personal details and financial details**
   (otherwise guest names and booking totals come back blank).
3. In the app: **Settings → paste the invite code → Connect & sync**.

The invite code is single-use: the app exchanges it for a long-lived key stored on the volume. If you
ever disconnect, generate a fresh code.

## Troubleshooting

- **Deploy failed**: open **Deploy Logs**; any `STARTUP ERROR:` line says exactly what's missing.
- **Forgot the password**: change `APP_PASSWORD` in Variables. Railway redeploys and everyone is signed out.
- **Backups**: check the volume's **Backups** tab. Bookings and properties can always be re-synced from
  Beds24, so the main thing to protect is anything you enter only in this app.
