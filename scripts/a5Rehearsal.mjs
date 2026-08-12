// A5 REHEARSAL — the semi-mode review, against the local fixture instead of an employer.
//
// Same mechanics as TASK A5 step 2-3: a visible browser, the form pre-filled by the real resolver,
// every answer dumped with its provenance and confidence, and NOTHING submitted until a human clicks
// submit. The only difference is the target — scripts/fakeAts.js on localhost, so a mistake costs
// nothing. Do the rehearsal before the run that counts.
//
// READ THIS BEFORE REVIEWING: semi mode approves EVERY answer, including low-confidence guesses
// (applyAutomation.js:862). Full-auto holds those back for review; semi deliberately pre-fills them
// so you can correct them. Your read of the form is therefore the only check that runs. The table
// below flags anything that is not an exact mapping.
//
// Requires: node scripts/fakeAts.js
// Usage:
//   node scripts/a5Rehearsal.mjs                       # greenhouse fixture, resume from the A5 seed
//   node scripts/a5Rehearsal.mjs --form lever
//   node scripts/a5Rehearsal.mjs --resume /path/to.pdf
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoApply } from "../services/applyAutomation.js";
import { launchBrowser } from "../services/browserLauncher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ATS = process.env.ATS_URL || "http://localhost:4599";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const FORM = arg("form") || "greenhouse";
const USER_ID = Number(arg("user") || 0) || null;

// Refuse anything that is not local. This script opens a browser and fills a form; pointed at a real
// posting it becomes an unreviewed application under whatever identity the DB happens to hold.
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(ATS)) {
  console.error(`REFUSING: ATS_URL must be localhost. Got ${ATS}\n` +
                `A5 against a real employer runs through scripts/a5Preflight.mjs, not this script.`);
  process.exit(1);
}

// ── the candidate, read from the same tables the real run reads ──────────────
const db = new Database(path.join(ROOT, "data", "resume_master.db"), { readonly: true });
const user = USER_ID
  ? db.prepare("SELECT id FROM users WHERE id=?").get(USER_ID)
  : db.prepare(`SELECT u.id FROM users u JOIN profile_base_resumes b ON b.user_id=u.id
                WHERE LENGTH(b.content) > 1200 ORDER BY u.id DESC LIMIT 1`).get();
if (!user) { console.error("No seeded candidate. Run scripts/a5SeedFixture.mjs first."); process.exit(1); }

const prof = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(user.id) || {};
const base = db.prepare("SELECT name, content FROM profile_base_resumes WHERE user_id=?").get(user.id);

const isFixture = /\b(test|smoke|fixture|sample|demo|john doe|jane doe)\b/i
  .test(`${prof.first_name} ${prof.last_name} ${prof.email || ""}`);

// ── the resume artifact you will review ──────────────────────────────────────
// Mirrors server.js htmlToPdf (same launchBrowser, same page.pdf settings) rather than importing it,
// because importing server.js would boot the whole server.
async function renderPdf(html, outPath) {
  const browser = await launchBrowser({ headless: true, viewport: { width: 1240, height: 1754 } });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });
    await page.setContent(html.trimStart().toLowerCase().startsWith("<!doctype") ? html : "<!DOCTYPE html>" + html,
      { waitUntil: "networkidle0", timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    const pdf = await page.pdf({
      format: "Letter", printBackground: true, preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    if (!pdf || pdf.length === 0) throw new Error("PDF generation produced empty output");
    fs.writeFileSync(outPath, Buffer.from(pdf));
  } finally { await browser.close(); }
}

let RESUME = arg("resume");
if (!RESUME) {
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:Georgia,serif;font-size:11pt;line-height:1.4;margin:48px 56px}</style></head>
    <body>${base.content.split("\n").map(l => `<p>${esc(l)}</p>`).join("")}</body></html>`;
  RESUME = path.join(os.tmpdir(), `a5-rehearsal-${Date.now()}.pdf`);
  console.log("Rendering the resume PDF you will review...");
  await renderPdf(html, RESUME);
}
if (!fs.existsSync(RESUME)) { console.error(`No resume at ${RESUME}`); process.exit(1); }

// ── the profile the resolver will use ────────────────────────────────────────
const payload = {
  field_map: Object.fromEntries(Object.entries({
    first_name: prof.first_name, last_name: prof.last_name, full_name: prof.full_name,
    email: prof.email, phone: prof.phone, location: prof.location,
    linkedin_url: prof.linkedin_url, github_url: prof.github_url, website_url: prof.website_url,
    years_of_experience: prof.years_of_experience, available_start_date: prof.available_start_date,
    current_company: prof.current_company, current_job_title: prof.current_job_title,
  }).filter(([, v]) => v != null && v !== "")),
  handler_map: {},
  custom_answers: (() => { try { return JSON.parse(prof.custom_answers || "{}"); } catch { return {}; } })(),
};

console.log("=".repeat(78));
console.log("A5 REHEARSAL — semi mode, local fixture, nothing reaches an employer");
console.log("=".repeat(78));
console.log(`candidate : ${prof.first_name} ${prof.last_name} <${prof.email}>  (user ${user.id})`);
if (isFixture) console.log(`            ^ PLACEHOLDER identity — fine here, blocked by the preflight for real A5`);
console.log(`resume    : ${RESUME}`);
console.log(`            ${(fs.statSync(RESUME).size / 1024).toFixed(1)} KB, from base resume "${base.name}" (${base.content.length} chars)`);
console.log(`target    : ${ATS}/${FORM}`);
console.log(`\n>>> OPEN THE RESUME NOW AND READ IT: ${RESUME}\n`);

// ── the run ──────────────────────────────────────────────────────────────────
// Clear the recorder first, so the wait below detects YOUR submission and not a stale one.
await fetch(`${ATS}/_reset`, { method: "POST" }).catch(() => {
  console.error(`Cannot reach ${ATS} — is scripts/fakeAts.js running?`); process.exit(1);
});

const res = await autoApply(`${ATS}/${FORM}`, payload,
  { mode: "semi", jobId: `a5-rehearsal-${FORM}`, resumePath: RESUME });

// ── the field-by-field review (A5 step 3) ────────────────────────────────────
// Exact mappings are trustworthy; anything fuzzy is a guess semi mode typed on your behalf.
const EXACT = new Set(["handler_exact", "field_map_exact", "label_exact", "custom_answer"]);
const answers = (res.answers || []).filter(a => !a.skipped);

console.log("\n" + "=".repeat(78));
console.log("REVIEW EVERY ROW AGAINST THE FORM ON SCREEN");
console.log("=".repeat(78));
console.log("  ! marks an answer that is NOT an exact mapping — read those first.\n");
const w = Math.min(46, Math.max(20, ...answers.map(a => (a.label || a.name || "").length)));
for (const a of answers) {
  const flag = EXACT.has(a.provenance) ? " " : "!";
  console.log(` ${flag} ${String(a.label || a.name).slice(0, w).padEnd(w)} | ` +
    `${JSON.stringify(a.value).slice(0, 30).padEnd(32)} | ${a.provenance} ${a.confidence ?? "-"}`);
}
const fuzzy = answers.filter(a => !EXACT.has(a.provenance));
console.log(`\n  ${answers.length} answers filled — ${fuzzy.length} not an exact mapping.`);
if (res.rejectedAnswers?.length)
  console.log(`  ${res.rejectedAnswers.length} guess(es) the policy declined to type:`,
    JSON.stringify(res.rejectedAnswers));

console.log(`\nstatus=${res.status} (semi never submits — "awaiting_user" is correct)`);
console.log(`fieldsFilled=${res.fieldsFilled}  screenshot=${res.screenshotPath || "-"}`);
console.log(`
NEXT — the browser is open:
  1. Read the resume PDF above.
  2. Check every row against the rendered form, the ! rows first.
  3. Correct anything wrong IN THE BROWSER.
  4. Click submit yourself.

This process must stay running to hold the browser open — puppeteer kills it on exit. Waiting
for you to submit; Ctrl-C to abandon the run without submitting.
`);

// Poll rather than prompt: the decision happens in the browser, not at this terminal.
const DEADLINE = Date.now() + 20 * 60_000;
let recorded = null;
while (Date.now() < DEADLINE) {
  await new Promise(r => setTimeout(r, 2000));
  const j = await fetch(`${ATS}/_submissions`).then(r => r.json()).catch(() => null);
  if (j?.count > 0) { recorded = j.submissions.at(-1); break; }
}

if (!recorded) {
  console.log("No submission after 20 minutes — nothing was sent. Closing.");
  process.exit(0);
}

console.log("\n" + "=".repeat(78));
console.log(`SUBMITTED — this is exactly what the form received (provider: ${recorded.provider})`);
console.log("=".repeat(78));
for (const [k, v] of Object.entries(recorded.fields)) console.log(`  ${k} = ${JSON.stringify(v)}`);
console.log("\n  files:");
for (const [k, v] of Object.entries(recorded.files || {})) {
  console.log(`    ${k} = ${v ? `${v.filename} (${v.size} bytes, ${v.contentType})` : "EMPTY — no file was attached"}`);
}
console.log(`\nOn a real application this would now be unrecallable. It was localhost.`);
process.exit(0);
