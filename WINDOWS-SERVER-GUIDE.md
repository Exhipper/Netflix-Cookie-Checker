# NFX Puke Kicker — Windows Server Self-Hosting Guide

This guide restores the original Render-style architecture (persistent Node.js server with real-time SSE) and walks you through hosting it on your own Windows Server with **Supabase PostgreSQL**.

> Why this change? Vercel serverless has strict 60-second function limits and connection pooling issues that cause large cookie checks to hang. A persistent Windows Server avoids those limits entirely.

---

## What changed in the code

- Removed Vercel serverless chunked processing (`/continue`, `run_tasks`, etc.).
- Restored the original **SSE live progress** stream (`/api/check/:runId/stream`).
- Restored the original **dashboard SSE** stream (`/api/events`).
- Removed `vercel.json` and `web/api/index.ts`.
- Added **Supabase SSL detection** to the database pool so it works with managed Postgres.

---

## Prerequisites

1. A Windows Server with internet access (Windows 10/11/Server 2019/2022 works).
2. **Node.js** installed (v20 LTS recommended). Download from https://nodejs.org/
3. **Bun** installed (the project uses bun as the package manager). Install:
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```
4. A **Supabase** project with a PostgreSQL database.

---

## Step 1: Clone the repo on your Windows Server

For a fresh install:

```powershell
cd C:\
git clone https://github.com/Exhipper/NFX-Puke-Kicker.git
cd NFX-Puke-Kicker\web
```

If you already have an older copy on the server and see a "refusing to merge unrelated histories" error, run this instead:

```powershell
cd C:\NFX-Puke-Kicker
git fetch origin
git reset --hard origin/main
cd web
```

---

## Step 2: Create the environment file

Copy the example file and fill in your real Supabase connection string:

```powershell
copy .env.example .env
notepad .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
NODE_ENV=production
PORT=8080
```

> Get the connection string from: Supabase Dashboard → Project Settings → Database → Connection String. Use the **session pooler** or **transaction pooler** URL for server use.

The server automatically loads `.env` when it starts, so you don't need to set Windows environment variables manually.

---

## Step 3: Install dependencies

```powershell
bun install
```

If you don't have bun, you can use npm instead:

```powershell
npm install
```

(Note: the project is configured for bun, but npm works for a local server build.)

---

## Step 4: Build the app

```powershell
bun run build
```

This creates:
- `web/dist/` — the front-end static files
- `web/dist/server/` — the compiled server code

---

## Step 5: Start the server

Use the included wrapper script. It builds the latest code and then starts the server, so `.env` changes and source edits are always picked up:

```powershell
node start-server.js
```

Or with Bun:

```powershell
bun start-server.js
```

The server will listen on the port defined in `.env` (default `8080`).

You should see:
```
Database initialized successfully
Server running on port 8080
```

> Note: free public proxy lists change frequently. If you see many proxy source failures, you can disable proxy auto-fetch entirely and run checks directly from your server IP by adding `DISABLE_PROXY_FETCH=true` to `.env`.

---

## Step 6: Open the app

On the same server or any machine on the network:

```
http://YOUR_SERVER_IP:8080
```

---

## Step 7: Keep the server running with PM2 (recommended)

Install PM2 globally:

```powershell
npm install -g pm2
```

Create a PM2 config file `ecosystem.config.cjs` in `web/`:

```js
module.exports = {
  apps: [
    {
      name: "nfx-puke-kicker",
      script: "start-server.js",
      cwd: "C:\\NFX-Puke-Kicker\\web",
      env: {
        NODE_ENV: "production",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },
  ],
};
```

Start with PM2:

```powershell
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## Step 8: Expose to the internet (optional)

If you want to access the app from outside your network:

1. Open the port in Windows Firewall:
   ```powershell
   New-NetFirewallRule -DisplayName "NFX Puke Kicker" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
   ```
2. Forward port `8080` on your router to your Windows Server's local IP.
3. Use a reverse proxy like **Nginx** or **Caddy** if you want HTTPS and a domain name.

---

## Supabase database notes

- The app auto-detects Supabase URLs and enables SSL with `rejectUnauthorized: false`.
- If your connection string does not contain `supabase.co` or `pooler`, set `DATABASE_SSL=true` in `.env`.
- The first time the server starts, it automatically creates all required tables and indexes.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `DATABASE_URL is not set` | Make sure `.env` exists and is in the `web/` folder, then start with `node start-server.js`. |
| `self-signed certificate` / SSL errors | Set `DATABASE_SSL=true` in `.env`. |
| Many proxy source 404s / failures | Add `DISABLE_PROXY_FETCH=true` to `.env` to run checks directly from your server IP, or set `PROXY_DEBUG_LOGS=true` to see full details. |
| `fatal: refusing to merge unrelated histories` | Run `git fetch origin` then `git reset --hard origin/main` inside `C:\NFX-Puke-Kicker`. |
| `MODULE_NOT_FOUND` for `start-server.js` | The file was not downloaded. Run the fetch/reset command above, then try again. |
| Port already in use | Change `PORT` in `.env` or kill the other process. |
| Server unreachable from outside | Check Windows Firewall and router port forwarding. |
| App shows no live progress | Make sure SSE is not blocked by Windows Firewall or a proxy. |

---

## Reverting to this version later

If you ever need to come back to this Windows-Server-ready version, make sure your repo is on the `main` branch that contains this commit. The Vercel-specific files (`vercel.json`, `web/api/index.ts`) are removed in this version.
