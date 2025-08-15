# Lifestyle Design Backend (Clean Refresh)

Express + Mongoose backend implementing last-N recent posts dedupe (visual hash + caption similarity + duration delta), robust scheduler with Burst Mode, and the exact endpoints consumed by the Lifestyle Design frontend.

## Features
- Last-N recent posts window (default 30) for repost protection (no day windows)
- Visual hash (aHash/pHash-style) + caption similarity + duration delta
- Autopilot queue, scheduling, posting with locks
- Burst Mode window overrides (posts-per-hour, maxTotal)
- Health/diagnostics endpoints
- Minimal CORS for Vercel frontends

## Endpoints (contract)
See `src/routes` for:
- Settings: GET/POST /api/settings
- Autopilot: GET /api/autopilot/status, GET /api/autopilot/queue, POST /api/autopilot/run, POST /api/autopilot/refill
- Burst: GET/POST /api/burst, POST /api/burst/config
- Scheduler: GET /api/scheduler/health, GET /api/scheduler/status
- Diagnostics: GET /api/diag/autopilot-report, POST /api/diag/reset-counters
- Activity & analytics: GET /api/activity/feed, GET /api/heatmap/weekly, GET /api/heatmap/optimal-times, GET /api/analytics
- Manual: POST /api/post-now
- Debug: POST /api/debug/similarity-check
- Uploads: POST /api/upload/dragdrop, /api/upload/dropbox, /api/upload/google-drive, /api/test/*

## Getting started
```bash
npm i
cp .env.example .env
npm run dev
```

Provide a MongoDB connection string in `.env`:
```
MONGO_URI=mongodb+srv://...
PORT=3001
CORS_ORIGINS=https://lifestyle-design-frontend-refresh-hjxiagh1g.vercel.app,http://localhost:3000
TIMEZONE=America/Chicago
```

## Deploying to Render
- Create a new Web Service from the GitHub repo
- Build Command: `npm i`
- Start Command: `npm start`
- Add env vars (`MONGO_URI`, `TIMEZONE`, etc.)
