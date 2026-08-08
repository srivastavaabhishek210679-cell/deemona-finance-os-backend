# Deemona AI Finance OS — Complete Setup Guide

## Step 1 — Create Neon database

1. Go to https://console.neon.tech
2. Click **New Project**
3. Name it: `deemona-finance-os`
4. Region: **Singapore** (AP Southeast)
5. Click **Create Project**
6. Copy the **Connection string** — it looks like:
   `postgresql://neondb_owner:AbCdEf@ep-xyz-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`

---

## Step 2 — Run the database migration on Neon

1. In the Neon Console, click **SQL Editor** in the left sidebar
2. Open the file: `backend/src/db/migrations/001_finance_memory.sql`
3. Paste the entire contents into the SQL Editor
4. Click **Run**
5. Verify with this query:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_name LIKE 'finance_memory%';
   ```
   You should see 4 tables.

---

## Step 3 — Copy project to your machine

Open PowerShell and run:

```powershell
# Create the project folder
New-Item -ItemType Directory -Force -Path "C:\deemona-finance-os"

# Copy the downloaded project into it
# (after downloading and extracting the zip from Claude)
Copy-Item -Recurse -Force "PATH_TO_EXTRACTED_FOLDER\*" "C:\deemona-finance-os\"
```

---

## Step 4 — Set up the backend

```powershell
cd C:\deemona-finance-os\backend

# Create your .env file
Copy-Item .env.example .env
```

Now open `.env` in any text editor and fill in:

```env
DATABASE_URL=postgresql://neondb_owner:YOUR_PASS@YOUR_HOST.neon.tech/neondb?sslmode=require
JWT_SECRET=pick-any-long-random-string-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
INTERNAL_CRON_SECRET=another-random-string
```

Then install and start:

```powershell
npm install
npm run dev
```

You should see:
```
[DB] Connected to Neon PostgreSQL
[Cron] 3 Finance Memory jobs registered
[Server] Deemona AI Finance OS running on port 4000
```

Test it:
```powershell
curl http://localhost:4000/health
```

---

## Step 5 — Set up the frontend

Open a second PowerShell window:

```powershell
cd C:\deemona-finance-os\frontend
npm install
npm run dev
```

Open browser: http://localhost:5173

---

## Step 6 — Create GitHub repos

```powershell
# Backend repo
cd C:\deemona-finance-os\backend
git init
git add .
git commit -m "Initial commit — Deemona AI Finance OS backend"
git remote add origin https://github.com/srivastava.abhishek210679/deemona-finance-os-api.git
git push -u origin main

# Frontend repo
cd C:\deemona-finance-os\frontend
git init
git add .
git commit -m "Initial commit — Deemona AI Finance OS frontend"
git remote add origin https://github.com/srivastava.abhishek210679/deemona-finance-os-frontend.git
git push -u origin main
```

> Note: Create both repos on GitHub first (as empty repos), then push.

---

## Project structure (final)

```
C:\deemona-finance-os\
├── backend\
│   ├── src\
│   │   ├── index.ts                 ← main Express app (routes + crons wired here)
│   │   ├── db\
│   │   │   ├── pool.ts              ← Neon connection pool
│   │   │   ├── migrate.ts           ← migration runner
│   │   │   └── migrations\
│   │   │       └── 001_finance_memory.sql
│   │   ├── services\
│   │   │   └── memoryService.ts     ← write / search / ask / entity profiles
│   │   ├── routes\
│   │   │   └── memoryRoutes.ts      ← /api/memory/* endpoints + MemoryWriter
│   │   ├── jobs\
│   │   │   └── memoryCron.ts        ← 3 cron jobs
│   │   └── middleware\
│   │       └── auth.ts              ← JWT auth middleware
│   ├── package.json
│   ├── tsconfig.json
│   └── .env                         ← YOU CREATE THIS from .env.example
│
└── frontend\
    ├── src\
    │   ├── main.jsx
    │   ├── App.jsx                  ← sidebar + routing
    │   ├── pages\
    │   │   └── MemoryPage.jsx
    │   ├── components\
    │   │   └── memory\
    │   │       └── FinanceMemoryPanel.jsx
    │   └── styles\
    │       └── global.css
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## What's working after setup

- Backend API running on port 4000
- `/health` endpoint confirms server + DB are connected
- `/api/memory/*` — all 7 memory endpoints live
- 3 cron jobs running in background
- Frontend on port 5173 with sidebar nav
- Finance Memory Panel: feed, search, AI Ask tab

## What's next

Next module to build: **AI Decision Center** (executive home screen with AI-generated daily brief)
