# Resume Master v4 — Deploy Guide

## File Structure

```
resume-master/
├── server.js               # Express API + all backend logic
├── package.json            # Server dependencies
├── .env                    # Secrets (never commit)
├── .env.example            # Template
├── data/                   # SQLite DB auto-created here
└── client/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx
        └── App.jsx
```

---

## Local Development

### 1. Prerequisites

- Node.js 20+ — https://nodejs.org
- An Anthropic API key — https://console.anthropic.com
- An Apify account + API token — https://console.apify.com
  - Subscribe to **curious_coder/linkedin-jobs-scraper** (pay-per-result or monthly)
  - Subscribe to **curious_coder/indeed-scraper** (monthly rental)

### 2. Clone and install

```bash
git clone <your-repo> resume-master
cd resume-master

# Install server deps
npm install

# Install client deps + build
cd client && npm install && npm run build && cd ..
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in ANTHROPIC_KEY, APIFY_TOKEN, ADMIN_PASSWORD, SESSION_SECRET
```

### 4. Start the server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Open http://localhost:3001 — sign in with the credentials in your `.env`.

### 5. Client hot-reload during development

In a second terminal:

```bash
cd client
npm run dev
# Opens http://localhost:5173 — proxies /api to :3001
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | `{ username, password }` → session cookie |
| POST | `/api/auth/logout` | Clear session |
| GET  | `/api/auth/me` | Check auth status |
| GET  | `/api/profile` | Get user profile |
| POST | `/api/profile` | Save user profile |
| GET  | `/api/autofill` | Structured field map for form autofill |
| GET  | `/api/jobs?query=` | Get cached jobs (optional query filter) |
| POST | `/api/scrape` | `{ query }` — trigger fresh LinkedIn+Indeed scrape |
| GET  | `/api/categories` | List industry categories |
| GET  | `/api/base-resume` | Get saved base resume text |
| POST | `/api/base-resume` | `{ content, name }` — save base resume text |
| POST | `/api/parse-pdf` | `multipart file` → `{ text, chars }` |
| POST | `/api/generate` | `{ jobId, job, resumeText, forceRegen }` → `{ html, atsScore, atsReport }` |
| POST | `/api/resumes/:jobId/html` | `{ html }` — save edited sandbox HTML |
| POST | `/api/export-pdf` | `{ html, filename }` → PDF binary (Puppeteer) |
| GET  | `/api/resumes/:jobId/pdf` | Download PDF from saved HTML |
| GET  | `/api/resumes` | All generated resumes |
| GET  | `/api/resumes/:jobId` | Single resume |
| GET  | `/api/resumes/:jobId/versions` | All versions |
| DELETE | `/api/resumes/:jobId` | Delete resume + versions |
| GET  | `/api/history` | Summary list for history panel |
| GET  | `/api/health` | Server health check |

---

## Deployment — Railway (recommended, simplest)

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "init"
gh repo create resume-master --private && git push -u origin main
```

### 2. Create Railway project

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your repo
3. Railway auto-detects Node.js

### 3. Set environment variables

In Railway dashboard → your service → Variables:

```
ANTHROPIC_KEY      = sk-ant-...
APIFY_TOKEN        = apify_api_...
ADMIN_USER         = admin
ADMIN_PASSWORD     = <strong password>
SESSION_SECRET     = <random 64-char string>
NODE_ENV           = production
PORT               = 3001
```

### 4. Configure start command

In Railway → Settings → Deploy:
- Build command: `npm install && cd client && npm install && npm run build && cd ..`
- Start command: `node server.js`

### 5. Persistent volume for SQLite

In Railway → your service → Volumes:
- Mount path: `/app/data`
- This persists the SQLite DB across deploys

### 6. Deploy

Railway auto-deploys on every push to `main`. Your app will be live at the Railway-provided `.up.railway.app` URL.

---

## Deployment — Render

1. New Web Service → connect GitHub repo
2. Build command: `npm install && cd client && npm install && npm run build && cd ..`
3. Start command: `node server.js`
4. Add environment variables (same as Railway)
5. Add a Disk: mount path `/opt/render/project/src/data`, size 1GB
6. Deploy

---

## Deployment — VPS (Ubuntu 22.04+)

```bash
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Chromium for Puppeteer PDF export
sudo apt install -y chromium-browser

# Clone and setup
git clone <your-repo> /opt/resume-master
cd /opt/resume-master
npm install
cd client && npm install && npm run build && cd ..

# Copy and configure .env
cp .env.example .env && nano .env

# Run with PM2
npm install -g pm2
pm2 start server.js --name resume-master
pm2 save && pm2 startup

# Nginx reverse proxy (optional, recommended for HTTPS)
sudo apt install -y nginx certbot python3-certbot-nginx
# Configure /etc/nginx/sites-available/resume-master:
#   server {
#     listen 80;
#     server_name yourdomain.com;
#     location / { proxy_pass http://localhost:3001; proxy_set_header Host $host; }
#   }
sudo certbot --nginx -d yourdomain.com
```

---

## Puppeteer on Linux servers

If PDF export fails, install Chromium dependencies:

```bash
sudo apt install -y \
  libgbm-dev libxkbcommon-dev libgtk-3-0 libnss3 \
  libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 \
  libxrandr2 libgbm1 libxss1 libxtst6 libasound2
```

Then add to `.env`:
```
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

And update `htmlToPdf()` in `server.js`:
```js
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu"],
});
```

---

## Notes

- **Autofill in-app browser**: works for same-origin iframes. Cross-origin pages (LinkedIn, Greenhouse, Workday) block iframe script injection by browser security policy. Use the **bookmarklet** drag target shown in the browser toolbar — drag it to your browser bookmarks bar and click it on any job application page.
- **Session security**: set `NODE_ENV=production` in production so cookies are `Secure`.
- **Apify costs**: LinkedIn scraper charges per result; Indeed scraper is a flat monthly fee. The 12-hour cache and full-time filter keep Apify calls minimal.
- **SQLite concurrency**: fine for single-user. If you add multi-user support later, migrate to PostgreSQL with `pg` and update the Drizzle/Knex schema.
