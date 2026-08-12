// TASK A5 fixture seeding — build a complete, apply-ready candidate from two files you drop in.
//
//   data/a5-fixture/profile.json          the candidate's details
//   data/a5-fixture/resume.(txt|md|html|pdf)   the resume itself
//
// Both live under data/, which is gitignored, so nothing here is committed.
//
// NO ANTHROPIC CREDITS ARE SPENT. With --job, this also writes a `resumes` row for that posting, and
// generateResumeForApply short-circuits on an existing artifact (server.js: "Existing artifact in DB
// — reuse immediately") before it ever reaches the model. processRunJob then takes CASE A, whose only
// remaining cost is htmlToPdf — local Chromium, free. That is a real production path, not a bypass:
// it is exactly what happens for a user who already generated a resume for that job.
//
// Usage:
//   node scripts/a5SeedFixture.mjs                          # seed profile + base resume
//   node scripts/a5SeedFixture.mjs --job greenhouse::6110219004   # …and pre-generate for that job
//   node scripts/a5SeedFixture.mjs --job <id> --ats 82 --password "hunter2"
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../services/authSecurity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "data", "a5-fixture");
const DB_PATH = path.join(ROOT, "data", "resume_master.db");

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const JOB_ID = arg("job");
const ATS = Number(arg("ats") || 78);
const PASSWORD = arg("password") || "A5-fixture-pass!";

if (!fs.existsSync(DIR)) {
  console.error(`Missing ${path.relative(ROOT, DIR)}/ — create it and add profile.json + resume.(txt|md|html|pdf)`);
  process.exit(1);
}
const profilePath = path.join(DIR, "profile.json");
if (!fs.existsSync(profilePath)) { console.error(`Missing ${profilePath}`); process.exit(1); }
const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

const resumeFile = ["resume.html", "resume.txt", "resume.md", "resume.pdf"]
  .map(f => path.join(DIR, f)).find(fs.existsSync);
if (!resumeFile) { console.error(`Missing a resume file in ${DIR} (.txt, .md, .html or .pdf)`); process.exit(1); }

// ── resume -> text + html ────────────────────────────────────────────────────
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** A plain resume rendered as clean, ATS-friendly HTML — headings, bullets, paragraphs. */
function textToHtml(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${esc(line.replace(/^[-*•]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (/^#{1,3}\s+/.test(line)) out.push(`<h2>${esc(line.replace(/^#{1,3}\s+/, ""))}</h2>`);
    else if (line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 60) out.push(`<h2>${esc(line)}</h2>`);
    else if (out.length === 0) out.push(`<h1>${esc(line)}</h1>`);
    else out.push(`<p>${esc(line)}</p>`);
  }
  closeList();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Georgia,'Times New Roman',serif;font-size:11pt;line-height:1.4;color:#111;margin:48px 56px}
    h1{font-size:20pt;margin:0 0 2px} h2{font-size:12pt;margin:16px 0 4px;text-transform:uppercase;
       letter-spacing:.05em;border-bottom:1px solid #999;padding-bottom:2px}
    p{margin:2px 0} ul{margin:4px 0 8px 18px;padding:0} li{margin:2px 0}
  </style></head><body>${out.join("\n")}</body></html>`;
}

let resumeText = "";
let resumeHtml = "";
if (resumeFile.endsWith(".pdf")) {
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  resumeText = (await pdfParse(fs.readFileSync(resumeFile))).text.trim();
  resumeHtml = textToHtml(resumeText);
} else if (resumeFile.endsWith(".html")) {
  resumeHtml = fs.readFileSync(resumeFile, "utf8");
  resumeText = resumeHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
} else {
  resumeText = fs.readFileSync(resumeFile, "utf8").trim();
  resumeHtml = textToHtml(resumeText);
}
if (resumeText.length < 1200) {
  console.error(`Resume is only ${resumeText.length} chars. The resume IS the payload — the preflight ` +
                `requires ~1200+. Add real content to ${path.basename(resumeFile)}.`);
  process.exit(1);
}

// ── seed ─────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
const username = profile.username || (profile.email || "a5.candidate").split("@")[0];

const existing = db.prepare("SELECT id FROM users WHERE username=?").get(username);
let userId;
if (existing) {
  userId = existing.id;
} else {
  userId = db.prepare(
    "INSERT INTO users (username, password_hash, is_admin, apply_mode, plan_tier) VALUES (?, ?, 0, 'TAILORED', 'PRO')"
  ).run(username, hashPassword(PASSWORD)).lastInsertRowid;
}

const cols = new Set(db.prepare("PRAGMA table_info(user_profile)").all().map(c => c.name));
db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(userId);
const fields = Object.entries(profile)
  .filter(([k]) => k !== "username" && cols.has(k))
  .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : v]);
if (fields.length) {
  db.prepare(`UPDATE user_profile SET ${fields.map(([k]) => `${k}=?`).join(", ")} WHERE user_id=?`)
    .run(...fields.map(([, v]) => v), userId);
}

// One active domain profile — the apply readiness gate requires it.
let dp = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? AND is_active=1").get(userId);
if (!dp) {
  const id = db.prepare(
    "INSERT INTO domain_profiles (user_id, profile_name, role_family, domain, is_active) VALUES (?, ?, ?, ?, 1)"
  ).run(userId, profile.profile_name || "A5 Candidate",
        profile.role_family || "engineering", profile.domain || "engineering").lastInsertRowid;
  dp = { id };
}

db.prepare(`
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(profile_id) DO UPDATE SET user_id=excluded.user_id, name=excluded.name,
    content=excluded.content, updated_at=excluded.updated_at
`).run(dp.id, userId, path.basename(resumeFile), resumeText);

console.log(`Seeded user ${userId} (${username})`);
console.log(`  profile fields written : ${fields.map(([k]) => k).join(", ") || "(none)"}`);
console.log(`  active domain profile  : ${dp.id}`);
console.log(`  base resume            : ${resumeText.length} chars from ${path.basename(resumeFile)}`);
if (!existing) console.log(`  login                  : ${username} / ${PASSWORD}`);

if (JOB_ID) {
  const job = db.prepare("SELECT job_id, title, company FROM scraped_jobs WHERE job_id=?").get(JOB_ID);
  if (!job) { console.error(`\nJob ${JOB_ID} not found — nothing pre-generated.`); process.exit(1); }
  db.prepare("DELETE FROM resumes WHERE user_id=? AND job_id=?").run(userId, JOB_ID);
  db.prepare(`
    INSERT INTO resumes (user_id, job_id, company, role, apply_mode, ats_score, html, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'TAILORED', ?, ?, unixepoch(), unixepoch())
  `).run(userId, JOB_ID, job.company, job.title, ATS, resumeHtml);
  console.log(`\nPre-generated artifact for ${job.company} — ${job.title}`);
  console.log(`  ats_score=${ATS} (threshold is 65), html=${resumeHtml.length} chars`);
  console.log(`  -> generateResumeForApply will REUSE this and never call Anthropic.`);
}

console.log(`\nNext:  node scripts/a5Preflight.mjs --user ${userId}${JOB_ID ? ` --job ${JOB_ID}` : " --job <job_id>"}`);
