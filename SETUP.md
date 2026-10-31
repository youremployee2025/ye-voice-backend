# YE Voice AI — Setup Guide

This guide walks you through setting up the full YE Voice AI platform on a new machine.
Use Claude Code to follow these steps — it can handle most of the work.

## Architecture Overview

```
ye-voice-dashboard  (Customer-facing app)  — Next.js 15, port 3002
ye-voice-backend    (API + Workers)        — Express + Prisma + BullMQ, port 3001
ye-voice-admin      (Staff console)        — Next.js 15, port 3020
```

All three talk to **Vocobase** for voice AI capabilities. The dashboard and admin
never call Vocobase directly — everything goes through the backend.

---

## Prerequisites

Install these on the new machine:

- **Node.js 22+** (LTS) — https://nodejs.org
- **PostgreSQL 15+** — https://www.postgresql.org/download/
- **Redis 7+** — https://redis.io/download (or `brew install redis` on Mac)
- **Git** — https://git-scm.com
- **GitHub CLI** — https://cli.github.com (`brew install gh` on Mac)

---

## Step 1: Clone the Repos

```bash
mkdir -p ~/dev/YE-Voice-AI
cd ~/dev/YE-Voice-AI

git clone https://github.com/Arvind9599/ye-voice-dashboard.git
git clone https://github.com/Arvind9599/ye-voice-backend.git
git clone https://github.com/Arvind9599/ye-voice-admin.git
```

---

## Step 2: Set Up External Services

### 2a. Clerk (Authentication)
1. Go to https://clerk.com and create a new application
2. Name it "YE Voice AI"
3. Enable Email + Password sign-in (and Google/GitHub SSO if desired)
4. From the Clerk dashboard, copy:
   - `CLERK_PUBLISHABLE_KEY` (starts with `pk_`)
   - `CLERK_SECRET_KEY` (starts with `sk_`)

### 2b. Vocobase (Voice AI Platform)
1. Get your new Vocobase partner account credentials from Vocobase
2. You need:
   - `VOCOBASE_API_KEY` — your partner API key
   - `VOCOBASE_WEBHOOK_SECRET` — set up later after deploying the backend

### 2c. PostgreSQL Database
```bash
# Create the databases
createdb ye_voice
createdb ye_voice_test
```

### 2d. Redis
```bash
# Start Redis (if not already running)
redis-server --daemonize yes
```

---

## Step 3: Configure the Backend

```bash
cd ~/dev/YE-Voice-AI/ye-voice-backend
npm ci
cp .env.example .env
```

Edit `.env` with these values:

```env
# Database
DATABASE_URL="postgresql://localhost:5432/ye_voice"
TEST_DATABASE_URL="postgresql://localhost:5432/ye_voice_test"

# Redis
REDIS_URL="redis://localhost:6379"
TEST_REDIS_URL="redis://localhost:6379/1"

# Server
PORT=3001
CORS_ORIGIN="http://localhost:3002"
PUBLIC_API_URL="http://localhost:3001"

# Auth
CLERK_SECRET_KEY="sk_test_..."
CLERK_PUBLISHABLE_KEY="pk_test_..."

# Vocobase
VOCOBASE_API_KEY="your-vocobase-partner-key"

# Admin
ADMIN_STAFF_TOKEN="generate-a-strong-random-string-here"

# Dialer (keep FALSE until ready to go live)
DIALER_ENABLED=FALSE
```

Run the database migrations:

```bash
npx prisma migrate deploy
```

Start the backend:

```bash
npm run dev
```

---

## Step 4: Configure the Dashboard

```bash
cd ~/dev/YE-Voice-AI/ye-voice-dashboard
npm ci
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_API_URL="http://localhost:3001"
```

Start the dashboard:

```bash
npm run dev
```

Open http://localhost:3002 — you should see the YE Voice AI sign-in page.

---

## Step 5: Configure the Admin Console

```bash
cd ~/dev/YE-Voice-AI/ye-voice-admin
npm ci
cp .env.example .env.local
```

Edit `.env.local`:

```env
API_URL=http://localhost:3001
```

Start the admin:

```bash
npm run dev
```

Open http://localhost:3020 — enter the `ADMIN_STAFF_TOKEN` you set in the backend.

---

## Step 6: Deploy to Production

### Backend → Render
1. Go to https://render.com
2. Create a new Web Service from the `ye-voice-backend` repo
3. Set environment variables (same as .env but with production values)
4. Use `render.yaml` for configuration
5. Database: Create a PostgreSQL instance on Render
6. Redis: Create a Redis instance on Render

### Dashboard → Vercel
1. Go to https://vercel.com
2. Import the `ye-voice-dashboard` repo
3. Set environment variables:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - `NEXT_PUBLIC_API_URL` (your Render backend URL)

### Admin → Vercel
1. Import the `ye-voice-admin` repo on Vercel
2. Set environment variable:
   - `API_URL` (your Render backend URL)

### Vocobase Webhook
After the backend is deployed:
1. Note your backend's public URL (e.g., `https://ye-voice-backend.onrender.com`)
2. Configure the webhook URL in Vocobase: `https://your-backend/webhooks/vocobase`
3. Set `VOCOBASE_WEBHOOK_SECRET` in your backend env vars

---

## Step 7: Initial Platform Setup

Once everything is running:

1. **Sign up** on the dashboard to create your first account
2. **Open admin console** with the staff token
3. In admin, use **Sync** buttons to pull agents, phone numbers, and tiers from Vocobase
4. **Grant credits** to your account via the admin
5. **Assign agents** to your workspace
6. You're ready to create campaigns!

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Cannot connect to database" | Check PostgreSQL is running and DATABASE_URL is correct |
| "Redis connection refused" | Start Redis: `redis-server --daemonize yes` |
| Clerk auth errors | Verify both CLERK keys match your Clerk app |
| Admin login fails | Check ADMIN_STAFF_TOKEN matches between backend .env and what you type |
| "Vocobase error" | Verify VOCOBASE_API_KEY is correct |
| Dashboard shows blank | Check NEXT_PUBLIC_API_URL points to running backend |

---

## Project Structure

```
YE-Voice-AI/
  ye-voice-dashboard/   → Customer app (agents, campaigns, calls, analytics)
  ye-voice-backend/     → API server + background workers
  ye-voice-admin/       → Internal staff console (accounts, billing, DIDs)
```

Each project has its own `CLAUDE.md` with detailed architecture documentation.
Claude Code can read those to understand the codebase.
