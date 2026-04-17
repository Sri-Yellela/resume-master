# Resume Master v5 — Complete Project Documentation

**Last updated:** April 2026  
**Status:** Local development complete, pre-deployment  
**Owner:** Sri Balaji (Software Engineer, Boston MA)

---

## 1. What This Project Is

Resume Master is a web application for managing a technical job search end-to-end. It is currently architected as a self-hosted single-server app with SQLite persistence, designed to support a small number of users with full data segregation per account. The architecture is intentionally simple for the current phase but is structured to migrate to a multi-tenant SaaS model — swapping SQLite for PostgreSQL, adding subscription/billing, and moving to a horizontally scalable deployment — without requiring a rewrite of application logic.

The current deployment target is Railway (single Node.js instance + persistent volume). When the SaaS migration happens, the primary changes will be: database driver (better-sqlite3 → pg), session store (connect-sqlite3 → connect-pg-simple), and infrastructure (single instance → managed Postgres + multiple dynos/containers). All API routes, business logic, and frontend code are designed to be database-agnostic at the query level.

### Core capabilities

| Capability | How it works |
|---|---|
| Job scraping | Apify actors scrape LinkedIn + Indeed on demand. Full-time only, deduped, ghost-filtered, categorised by Claude Haiku. |
| Resume generation | Claude Sonnet rewrites the user's base resume against a JD following a 6-section master prompt rulebook. |
| ATS scoring | Claude Haiku scores the generated resume against the JD, returns tier-matched keywords, strengths, improvements. |
| Resume sandbox | Live HTML editor + iframe preview + Puppeteer PDF export. |
| Autofill | Chrome extension fills job application forms (Greenhouse, Lever, Workday, iCIMS, LinkedIn, Taleo) using the user's profile. |
| Application tracking | Every PDF export is logged to a database table with company, role, date, resume file path. |
| Database panel | Live editable tables (Job Applications + Resume History) with calendar date picker, search, sort, Excel export. |
| Multi-user | Each user has segregated data. Admin has full access. |
| Backup/restore | Daily auto-backup, manual backup via admin panel, safe restore with pre-restore safety backup. |

---

## 2. Tech Stack

### Backend
| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | v20 LTS (required — v24 breaks better-sqlite3) |
| Framework | Express | ^4.21 |
| Database | SQLite via better-sqlite3 | ^11.5 |
| Session store | connect-sqlite3 | ^0.9.13 |
| Auth | Passport.js + passport-local | ^0.7 |
| Password hashing | bcryptjs | ^2.4 |
| AI | Anthropic SDK (@anthropic-ai/sdk) | ^0.39 |
| PDF export | Puppeteer | ^24 |
| Job scraping | Apify REST API (via fetch) | — |
| Excel export | ExcelJS | ^4.4 |
| Scheduling | node-cron | ^3.0 |
| File uploads | multer | ^2.0 |
| Environment | dotenv | ^16.4 |

### Frontend
| Component | Technology |
|---|---|
| Framework | React 18 |
| Build tool | Vite 5 |
| Styling | Inline styles (plain JS objects) — no Tailwind, no CSS modules |
| HTTP | Native fetch via centralised `lib/api.js` |
| DOCX parsing | mammoth |
| Animations | CSS keyframes (framer-motion planned post-Lovable revamp) |

### Infrastructure
| Component | Platform | SaaS migration path |
|---|---|---|
| Hosting | Railway | → managed containers (Railway/Render/Fly.io) |
| Database | SQLite (better-sqlite3) | → PostgreSQL (pg + connect-pg-simple) |
| Database persistence | Railway Volume at `/app/data` | → managed Postgres service |
| Source control | GitHub (private repo) | unchanged |
| Extension | Chrome Manifest V3, unpacked | → Chrome Web Store listing |

---

## 3. File Structure

```
resume-master/
├── server.js                        # All backend logic — single file
├── resume_masterprompt.md           # Static master prompt loaded at startup
├── package.json                     # Server dependencies + npm scripts
├── .env                             # Secrets — never commit
├── .env.example                     # Template for .env
│
├── scripts/
│   ├── backup.js                    # Backup + restore logic (imported by server.js)
│   └── migrate.js                   # Additive schema migration runner
│
├── data/
│   ├── resume_master.db             # SQLite database — all user data lives here
│   ├── sessions.db                  # Session storage (connect-sqlite3)
│   └── backups/
│       ├── manifest.json            # Index of all backup files
│       └── resume_master_*.db       # Timestamped backup files
│
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js                # Service worker — fetches autofill data, relays to tabs
│   ├── content.js                   # Injected on all pages — ATS detection, field filling
│   ├── popup.html                   # Extension popup UI
│   ├── popup.js                     # Popup logic
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
└── client/                          # React frontend (Vite)
    ├── index.html                   # HTML entry point
    ├── package.json                 # Client dependencies
    ├── vite.config.js               # Vite config — proxy /api to :3001, jsxRuntime automatic
    └── src/
        ├── main.jsx                 # React root — createRoot
        ├── App.jsx                  # Auth gate + tab routing
        ├── lib/
        │   └── api.js               # Fetch wrapper + saveWithPicker (File System Access API)
        ├── styles/
        │   └── theme.js             # Design tokens (planned — post-Lovable revamp)
        ├── components/
        │   ├── AuthScreen.jsx       # Landing page + auth modal (login + 2-step register)
        │   ├── LoginScreen.jsx      # Legacy — kept but not used
        │   └── TopBar.jsx           # Top navigation bar
        └── panels/
            ├── JobsPanel.jsx        # Job table, sandbox, ATS panel
            ├── SandboxPanel.jsx     # HTML editor + live preview + PDF export
            ├── ATSPanel.jsx         # ATS score display
            ├── ProfilePanel.jsx     # User profile form (accessed via avatar dropdown)
            ├── DatabasePanel.jsx    # Live DB tables with calendar, search, sort
            └── AdminPanel.jsx       # User management + backup/restore UI
```

---

## 4. Database Schema

All tables live in `data/resume_master.db`. Schema is managed by `scripts/migrate.js` — migrations are additive only, never destructive.

### `users`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto |
| username | TEXT UNIQUE | Login identifier |
| password_hash | TEXT | bcrypt hash |
| is_admin | INTEGER | 0=user, 1=admin |
| apply_mode | TEXT | SIMPLE \| TAILORED \| CUSTOM_SAMPLER |
| apify_token | TEXT | Optional personal Apify token |
| created_at | INTEGER | Unix timestamp |

### `user_profile`
One row per user. Used for resume header injection and autofill.

| Column | Type | Notes |
|---|---|---|
| user_id | INTEGER FK | References users(id) CASCADE |
| full_name, email, phone | TEXT | Personal info |
| linkedin_url, github_url | TEXT | URLs |
| location | TEXT | "City, State" — used in TAILORED mode |
| address_line1/2, city, state, zip, country | TEXT | Full address for autofill |
| gender, ethnicity, veteran_status, disability_status | TEXT | EEO fields |
| requires_sponsorship, has_clearance | INTEGER | Boolean flags |
| clearance_level, visa_type, work_auth | TEXT | Work auth fields |

### `job_cache`
Shared across users. Stores raw scraped job arrays as JSON.

| Column | Notes |
|---|---|
| search_query | The search term that produced this batch |
| source | Always "combined" (LinkedIn + Indeed merged) |
| scraped_at | Unix ms timestamp |
| jobs_json | Full array of job objects as JSON string |

### `resumes`
One row per user per job. Stores the latest generated HTML.

| Column | Notes |
|---|---|
| user_id, job_id | Composite unique key |
| company, role, category | Job metadata |
| apply_mode | Which mode was active when generated |
| html | Full resume HTML |
| ats_score | 0–100 |
| ats_report | JSON string — tier1_matched, tier1_missing, strengths, improvements, verdict |

### `resume_versions`
Every generation creates a new version row. Versions are never deleted unless the parent resume is deleted.

### `base_resume`
One row per user. Stores the raw text of their uploaded base resume.

### `job_applications`
Populated automatically when a user exports a PDF. Also editable inline in the Database panel.

| Column | Notes |
|---|---|
| user_id, job_id | Composite unique key |
| company, role | Job info |
| job_url, source, location | Job metadata |
| apply_mode | Mode used when applying |
| resume_file | Local file path saved by the user via Save-As dialog |
| applied_at | Unix timestamp — editable via calendar in DB panel |
| notes | Free text — editable inline |

### `refresh_log`
Tracks job scrape refreshes per user for rate limiting (4/day rolling window).

### `schema_migrations`
Tracks which migrations have been applied. Never edit manually.

---

## 5. API Routes

All routes are prefixed `/api/`. All except auth routes require a valid session cookie (`requireAuth`). Admin routes additionally require `is_admin=1` (`requireAdmin`).

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | None | `{username, password}` → session |
| POST | `/api/auth/register` | None | `{username, password, profile}` → creates user + profile |
| POST | `/api/auth/logout` | User | Destroys session |
| GET | `/api/auth/me` | None | Returns `{authenticated, user}` |

### User settings
| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get apply_mode, hasCustomToken |
| PATCH | `/api/settings/apply-mode` | `{mode}` — SIMPLE/TAILORED/CUSTOM_SAMPLER |
| PATCH | `/api/settings/apify-token` | `{token}` — save personal Apify token |

### Profile
| Method | Path | Description |
|---|---|---|
| GET | `/api/profile` | Get user profile |
| POST | `/api/profile` | Save user profile |
| GET | `/api/autofill` | Structured field map for autofill (mode-aware) |
| GET | `/api/extension/autofill` | Same as autofill, used by Chrome extension |

### Jobs
| Method | Path | Description |
|---|---|---|
| GET | `/api/jobs` | Get cached jobs. Query params: `query`, `ageFilter`, `hideGhost`, `hideFlag` |
| POST | `/api/scrape` | `{query}` — trigger fresh scrape (rate limited 4/day) |
| GET | `/api/scrape/quota` | Returns `{used, remaining, allowed, windowEnds}` |
| GET | `/api/categories` | List of industry categories |

### Resume generation
| Method | Path | Description |
|---|---|---|
| GET | `/api/base-resume` | Get saved base resume text |
| POST | `/api/base-resume` | `{content, name}` — save base resume |
| POST | `/api/parse-pdf` | Multipart PDF → extracted text via Anthropic document API |
| POST | `/api/generate` | `{jobId, job, resumeText, forceRegen, employers}` → `{html, atsScore, atsReport}` |
| POST | `/api/resumes/:jobId/html` | Save edited sandbox HTML |
| POST | `/api/export-pdf` | `{html, filename}` → PDF binary via Puppeteer |
| GET | `/api/resumes/:jobId/pdf` | Download PDF from saved HTML |
| GET | `/api/resumes` | All generated resumes for this user |
| GET | `/api/resumes/:jobId` | Single resume |
| GET | `/api/resumes/:jobId/versions` | All versions |
| DELETE | `/api/resumes/:jobId` | Delete resume + versions |
| GET | `/api/history` | Summary list |

### Applications
| Method | Path | Description |
|---|---|---|
| POST | `/api/applications` | Log a job application |
| GET | `/api/applications` | All applications for this user |
| PATCH | `/api/applications/:jobId` | Edit fields: company, role, location, notes, applied_at |
| DELETE | `/api/applications/:jobId` | Remove application |

### Export
| Method | Path | Description |
|---|---|---|
| GET | `/api/export/excel` | Download `.xlsx` with Job Applications + Resume History sheets |

### Admin
| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create user `{username, password, isAdmin}` |
| DELETE | `/api/admin/users/:id` | Delete user + all data |
| PATCH | `/api/admin/users/:id/password` | Reset password |
| GET | `/api/admin/users/:id/profile` | View any user's profile |
| GET | `/api/admin/users/:id/applications` | View any user's applications |
| DELETE | `/api/admin/users/:id/refresh-quota` | Reset scrape quota |
| GET | `/api/admin/backups` | List all backup files |
| POST | `/api/admin/backups` | `{label}` — trigger manual backup |
| POST | `/api/admin/backups/restore` | `{filename}` — restore from backup |

---

## 6. Resume Generation System

### How it works

1. User uploads a base resume (PDF/DOCX/TXT) — stored as plain text in `base_resume`
2. User selects a job from the board and clicks ✦ Generate
3. Server calls `buildFullPrompt()` which injects runtime inputs into the static master prompt
4. Claude Sonnet receives the full prompt and returns a complete HTML resume
5. Claude Haiku scores the resume and returns JSON with ATS analysis
6. HTML + score stored in `resumes` table, version logged in `resume_versions`

### Apply modes

| Mode | Employers | What changes |
|---|---|---|
| SIMPLE | N/A | No generation. Job board only. Generate button hidden. |
| TAILORED | Fixed — from base resume | Bullets rewritten to match JD. Employer names, locations rigid. User real location in header. |
| CUSTOM_SAMPLER | JD-driven — selected from Company Registry | Full company + bullet customisation. Max 1 FAANG. User location blank in header. Employer locations omitted. |

### Master prompt structure (resume_masterprompt.md)

The master prompt is a static markdown file loaded once at server startup. It is never regenerated — only runtime inputs are injected at generation time. This enables Anthropic's static prompt caching discount.

Sections:
- **RUNTIME INPUTS** — injected dynamically: mode, candidate info, JD, base resume
- **Section 0** — JD analysis: tier 1/2/3 keyword extraction, skill distribution plan
- **Section 0B** — Company selection rules (TAILORED vs CUSTOM_SAMPLER)
- **Section 0C** — Tech stack and narrative rules: company-authentic placement, bullet archetype diversity, AI placement rule, dynamic bullet count (16–22 total)
- **Section 1** — Factual integrity: no fabricated metrics, no inflated ownership
- **Section 1A** — Company Scope Registry: 35+ companies with authentic tech scope descriptions
- **Section 2** — ATS parsing rules: location by mode, no columns, no graphics, date formats
- **Section 2B** — Academic project gap compensation
- **Section 2C** — Technical skills section rules: two-way coverage check
- **Section 3** — AI screener compliance: no filler adjectives, coherence scoring, stack transformation
- **Section 4** — Language and articulation: action verbs, result-first structure
- **Section 5** — Structure and format: page fit rules, HTML output
- **Section 6** — Final quality checklist (30+ items)

---

## 7. Job Scraping Pipeline

1. User enters a search query and clicks Search
2. Rate limit checked: 4 refreshes per user per rolling 24-hour window from first refresh
3. If cache is valid (< 12 hours old), cached jobs are returned immediately
4. Otherwise: Apify LinkedIn scraper + Apify Indeed scraper run in parallel
5. Results are merged, then filtered:
   - Must have title + company
   - Must be full-time (NON_FULLTIME_TERMS blacklist)
   - Not reposted (keyword check)
   - Ghost job score < 4 (URL validity, description length, company name quality)
   - Not a known duplicate (MD5 hash of company+title checked against last 5 cache entries)
6. Remaining jobs classified by Claude Haiku into industry categories
7. Frequent repost flag set if same hash appeared in 2+ previous cache entries
8. Jobs stored in `job_cache`, returned to frontend
9. Frontend always passes `hideGhost=true&hideFlag=true` — ghost and repost filtering is always on, not user-configurable

### Ghost job scoring
A job scores points for: no apply URL (+3), very short description (+2), unknown company (+2), title contains "multiple/various" (+2), LinkedIn view-only URL (+1). Score ≥ 4 = filtered.

### Apify actors required
- `curious_coder/linkedin-jobs-scraper` — pay-per-result or monthly
- `curious_coder/indeed-scraper` — flat monthly rental

Users can supply their own Apify token in Settings → it overrides the server's token for their scrapes.

---

## 8. Autofill System

### Architecture
```
Resume Master web app
        ↓  (session cookie)
GET /api/extension/autofill
        ↓  (field_map + dropdown_map JSON)
Chrome Extension background.js  ←→  popup.js
        ↓  (chrome.scripting.executeScript)
content.js injected into job application page
        ↓  (fills inputs, selects, radios)
Application form on any ATS platform
```

### Location rules by mode
- **TAILORED**: user's real `location` field from profile included in field_map
- **CUSTOM_SAMPLER**: location field is blank — user fills address manually (resume location also blank)

### ATS platform support
content.js detects the ATS from `window.location.hostname` and applies a label-based field mapper:

| ATS | Detection |
|---|---|
| Greenhouse | greenhouse.io, boards.greenhouse |
| Lever | lever.co, jobs.lever.co |
| Workday | myworkdayjobs.com, workday.com |
| iCIMS | icims.com |
| LinkedIn Easy Apply | linkedin.com |
| Taleo | taleo.net |

### Multi-page form handling
content.js watches for next/continue/proceed buttons via MutationObserver. When clicked, it sends a `TRIGGER_FILL` message to background.js after a 1500ms delay (wait for new page section to render), which re-runs the fill.

### Extension install (local)
1. `chrome://extensions` → Developer mode ON
2. Load unpacked → select `extension/` folder
3. Click popup → set Resume Master URL (`http://localhost:3001` local, Railway URL in production)
4. Must be logged into Resume Master in the same Chrome profile

---

## 9. Backup and Recovery System

### Automatic backups
- Daily at 2:00 AM via node-cron
- Stored in `data/backups/` as timestamped `.db` files
- Maximum 30 backups kept (oldest pruned automatically)
- Manifest stored in `data/backups/manifest.json`

### Manual backup
```bash
npm run backup
# or from admin panel: Admin → Backups → Backup Now
```

### Restore
```bash
npm run restore <filename>
# or from admin panel: Admin → Backups → Restore button on any row
```

**Always backs up current DB before restoring.** After restoring, the server must be restarted to apply the restored database.

### Migration system
```bash
npm run migrate
```
Runs `scripts/migrate.js`. Each migration has a unique ID and is recorded in `schema_migrations`. Migrations only add — they never drop tables, columns, or data. Safe to run on a live database. Server runs migrations automatically on startup.

### Golden rule
**Never delete `data/resume_master.db` manually.** If you need to reset, use the admin restore panel or back up first with `npm run backup`.

---

## 10. Frontend Architecture

### Component hierarchy
```
App.jsx
├── AuthScreen.jsx          (shown when not logged in)
│   ├── CompanyTicker       (inline — scrolling company logos)
│   ├── RotatingEmblem      (inline — spinning APPLY•TRACK•LAND badge)
│   └── AuthModal           (inline — login + 2-step register)
└── TopBar.jsx              (shown when logged in)
    └── [active tab panel]
        ├── JobsPanel.jsx
        │   ├── SandboxPanel.jsx
        │   └── ATSPanel.jsx
        ├── DatabasePanel.jsx
        │   └── Calendar    (inline — date picker)
        ├── ProfilePanel.jsx (via avatar dropdown only — not a tab)
        └── AdminPanel.jsx  (admin users only)
```

### Key design constraints
- **No React Router** — tab state is a single `useState` in `App.jsx`
- **No external state management** — all state is local to each panel
- **Named exports** on all panels except `App`, `TopBar`, `AuthScreen` — these are default exports
- **No Tailwind** — all styling is plain JS inline style objects
- **`api()` wrapper** in `lib/api.js` — all fetch calls go through this, never raw `fetch()` outside of PDF export

### Module boundaries (safe to restyle without breaking backend)
Any file in `client/src/` can have its JSX structure and style objects changed freely. The only things that must not change:
1. Exported function names
2. Strings inside `api("...")` calls
3. Prop names on component calls in `App.jsx`
4. `useState`/`useEffect`/`useCallback`/`useRef` hook logic

---

## 11. Environment Variables

File location: `C:\Users\sriye\resume-master\.env` (local) or Railway Variables (production).

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_KEY` | Yes | Anthropic API key — `sk-ant-api03-...` |
| `APIFY_TOKEN` | Yes | Apify API token — `apify_api_...` |
| `ADMIN_USER` | Yes | Admin username |
| `ADMIN_PASSWORD` | Yes | Admin password (min 8 chars) |
| `SESSION_SECRET` | Yes | 64-char random string for session signing |
| `PASSWORD_RESET_SECRET` | Recommended | Separate HMAC secret for password reset token and OTP hashes; falls back to `SESSION_SECRET` |
| `APP_BASE_URL` | Recommended | Public app origin used in password reset links, for example `https://your-app.example` |
| `RESEND_API_KEY` | For email | Sends password reset email through Resend; without it, reset email contents are logged in dev |
| `PASSWORD_RESET_FROM` | No | From address for reset emails when `RESEND_API_KEY` is configured |
| `PORT` | No | Default 3001 |
| `NODE_ENV` | No | Set to `production` on Railway — enables secure cookies |

**No quotes around values.** `ADMIN_USER=admin` not `ADMIN_USER="admin"`.

---

## 12. npm Scripts

Run from `C:\Users\sriye\resume-master\`:

| Script | Command | What it does |
|---|---|---|
| Start server | `npm start` | `node server.js` |
| Dev (auto-restart) | `npm run dev` | `node --watch server.js` |
| Build frontend | `npm run build` | Runs `cd client && npm install && npm run build` |
| Run migrations | `npm run migrate` | `node scripts/migrate.js` — safe schema update |
| Create backup | `npm run backup` | `node scripts/backup.js` — saves timestamped backup |
| Restore backup | `npm run restore <file>` | `node scripts/backup.js restore <filename>` |

---

## 13. Known Issues and Fixes

| Issue | Cause | Fix |
|---|---|---|
| `Error: User not found` on refresh | Browser has stale session cookie after DB wipe | Clear `connect.sid` cookie in Chrome DevTools → Application → Cookies |
| `Cannot find package 'connect-sqlite3'` | Package removed by conflicting `npm install` | `npm install connect-sqlite3` |
| `React is not defined` | Old build cached in `client/dist` | Delete `client/dist`, confirm `vite.config.js` has `jsxRuntime: "automatic"`, rebuild |
| 401 on admin login | `.env` not loaded, hash computed from fallback `"changeme"` | Add `import "dotenv/config"` as first line of `server.js`, wipe DB, restart |
| `ERR_MODULE_NOT_FOUND` for any package | Package missing from `node_modules` | `npm install <package-name>` |
| `gyp` compilation error on `npm install` | Node.js v24 — no prebuilt binaries for better-sqlite3 | Use Node v20 LTS via nvm-windows |
| PDF export fails | Puppeteer Chromium not installed | `npx puppeteer browsers install chrome` |
| Blank white screen after login | Named export used as default import | Check `App.jsx` — `ProfilePanel`, `DatabasePanel`, `ATSPanel`, `AdminPanel` need `{ }` in import |
| Build hash unchanged after edit | `client/dist` not cleared | `rmdir /s /q client\dist` then rebuild |
| Session not persisting on Railway | `NODE_ENV` not set to `production` | Add `NODE_ENV=production` to Railway variables |

---

## 14. Planned / In Progress

| Item | Status |
|---|---|
| Lovable visual revamp (G-W Studio Event Platform template) | Ready to execute — prompt prepared, screenshots needed |
| framer-motion animations | Post-Lovable |
| `client/src/styles/theme.js` design tokens | Post-Lovable |
| Railway deployment | Pending — local dev complete |
| Chrome extension production URL update | Pending deployment |
| Extension icon PNGs (real design) | Using 1x1 placeholder currently |

---

## 15. Deployment Checklist (Railway)

When ready to deploy:

1. `npm run backup` — snapshot current local DB
2. `git add . && git commit -m "ready for deploy"`
3. `git push origin main`
4. Railway → New Project → Deploy from GitHub → select `resume-master`
5. Set all environment variables (see Section 11) — add `NODE_ENV=production`
6. Build command: `npm install && cd client && npm install && npm run build && cd ..`
7. Start command: `node server.js`
8. Volumes → Add Volume → Mount path: `/app/data`
9. Deploy → wait for Active status
10. Get Railway URL (e.g. `https://resume-master-production.up.railway.app`)
11. Update Chrome extension popup → change URL to Railway URL
12. Register accounts, verify all features on live URL
13. `npm run backup` again post-deploy

---

## 19. Quick Reference — Starting From Scratch in a New Chat

If you open a new chat to troubleshoot or extend this project, share this document and say:

> "I have a Node.js/React job application tool called Resume Master v5. The documentation is attached. [describe the specific issue or feature request]."

The LLM will have full context on: the stack, file structure, DB schema, API routes, apply modes, the master prompt system, autofill architecture, and all known issues. No additional briefing needed.

**Critical facts to know immediately:**
- Node must be v20 LTS — v24 breaks better-sqlite3
- `import "dotenv/config"` must be the first line of `server.js`
- All panel exports except App/TopBar/AuthScreen are named exports `{ }` not defaults
- Never delete `data/resume_master.db` — use `npm run backup` and the admin restore panel
- The master prompt (`resume_masterprompt.md`) is static — only runtime inputs are injected per generation
- Ghost job filtering is always on — `hideGhost=true&hideFlag=true` hardcoded in frontend requests
- `connect-sqlite3` replaced `better-sqlite3-session-store` (unpublished package)
- `multer` is v2 (v1 had security vulnerabilities)
