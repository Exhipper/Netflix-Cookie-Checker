# Netflix Cookie Checker — Web App

A full-stack web app ported from the original Python Netflix cookie checker.

## What's Included

- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express.js API server (TypeScript)
- **Database**: PostgreSQL (stores run history & results)
- **Deploy**: Render.com config (`render.yaml`)

## Features

- Paste Netflix cookies and check them in bulk
- Proxy support (HTTP/SOCKS)
- nfToken generation
- Account info extraction (name, email, plan, country, billing, etc.)
- Notifications via Webhook and Telegram
- Dashboard with stats
- Run history with detailed results
- Configurable settings panel

## Quick Start (Local)

```bash
cd web
bun install
bun run build       # builds frontend + compiles server
node dist/server/index.js
```

App runs on http://localhost:8080

## Deploy on Render.com

1. Push this code to your GitHub repo
2. Create a new Web Service on Render, select your repo
3. Render will auto-detect `render.yaml` — or manually set:
   - **Build Command**: `cd web && bun install && bun run build`
   - **Start Command**: `node web/dist/server/index.js`
4. Add environment variable `DATABASE_URL` with your Render PostgreSQL internal URL
5. Deploy!

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 8080) |
| `NODE_ENV` | No | Set to `production` |

## Tech Stack

- Node.js + Express (API server)
- React 18 + Vite (frontend)
- TypeScript (full type safety)
- Tailwind CSS + shadcn/ui (UI)
- pg (PostgreSQL client)
- Server-Sent Events (real-time progress)
