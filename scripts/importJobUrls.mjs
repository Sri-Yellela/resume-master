// Bring-your-own-job import, in bulk — repopulate the board from real posting URLs.
//
// The board empties because runExpiredJobsCleanup deletes anything whose scraped_at is older than
// 7 days (server.js), and the only crawl path (POST /api/admin/db/force-scrape) needs an
// apify_token no account has. This is the honest refill: each URL goes through the SAME
// services/jobs/importJob.js the app's own import uses, so rows land with a fresh scraped_at, the
// same dedup, the same enrichment, and — for a known ATS — the real structured data rather than an
// LLM's reading of rendered HTML.
//
// A greenhouse/lever/ashby URL costs NO model credits: importJob's path 1 refetches that company's
// board through the source's own fetchCompanyJobs and matches the posting. Only the generic
// text/HTML fallback calls a model.
//
// Usage:
//   node scripts/importJobUrls.mjs <url> [<url> ...]
//   node scripts/importJobUrls.mjs --file urls.txt          # one URL per line, # comments ok
//   node scripts/importJobUrls.mjs --greenhouse figma --match engineer   # a company's open board
//   node scripts/importJobUrls.mjs --greenhouse figma --list             # show, import nothing
//
// --user <id> stars the imports for that account (default: the single apply-ready one).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importJob } from "../services/jobs/importJob.js";
import { fetchCompanyJobs as fetchGreenhouse } from "../services/jobs/sources/greenhouse.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(`--${n}`);

const LIST = has("list");
const MATCH = arg("match");
const GREENHOUSE = arg("greenhouse");
const FILE = arg("file");
const USER_ID = Number(arg("user") || 0) || null;

// The preflight's own rule (scripts/a5Preflight.mjs). Reported per row so a URL that can never
// clear A5 is visible here rather than three steps later.
const isGreenhouseApplyUrl = (u) =>
  /(^|\/\/)(boards|job-boards)\.greenhouse\.io\//i.test(u || "") ||
  /greenhouse\.io\/[^/]+\/jobs\/\d+/i.test(u || "");

// ── gather the URLs ──────────────────────────────────────────────────────────
let urls = argv.filter(a => /^https?:\/\//i.test(a));

if (FILE) {
  urls = urls.concat(
    fs.readFileSync(FILE, "utf8").split(/\r?\n/)
      .map(l => l.replace(/#.*$/, "").trim())
      .filter(l => /^https?:\/\//i.test(l))
  );
}

if (GREENHOUSE) {
  const jobs = await fetchGreenhouse(GREENHOUSE, GREENHOUSE, []);
  const rx = MATCH ? new RegExp(MATCH, "i") : null;
  const picked = jobs.filter(j => !rx || rx.test(j.title || ""));
  console.log(`${GREENHOUSE}: ${jobs.length} open postings, ${picked.length} matching${MATCH ? ` /${MATCH}/i` : ""}`);
  for (const j of picked) console.log(`   ${isGreenhouseApplyUrl(j.url) ? " " : "!"} ${j.title}\n     ${j.url}`);
  if (LIST) {
    console.log("\n--list: nothing imported. Re-run without --list to import these.");
    process.exit(0);
  }
  urls = urls.concat(picked.map(j => j.url).filter(Boolean));
}

urls = [...new Set(urls)];
if (urls.length === 0) {
  console.error("No URLs. Pass them as arguments, --file <path>, or --greenhouse <slug>.");
  process.exit(1);
}

// ── who owns the imports ─────────────────────────────────────────────────────
const db = new Database(path.join(ROOT, "data", "resume_master.db"));
const userId = USER_ID ?? db.prepare(`
  SELECT u.id FROM users u JOIN profile_base_resumes b ON b.user_id = u.id
  WHERE LENGTH(b.content) > 1200 ORDER BY u.id DESC LIMIT 1
`).get()?.id ?? null;
console.log(`\nImporting ${urls.length} URL(s) as user ${userId ?? "(unowned)"}\n`);

// anthropic stays null: a known-ATS URL never needs it, and if a URL DOES fall through to the
// model path it should fail loudly here rather than quietly spend credits during a bulk refill.
const anthropic = null;

let ok = 0, failed = 0;
const landed = [];
for (const [i, url] of urls.entries()) {
  process.stdout.write(`[${i + 1}/${urls.length}] ${url.slice(0, 78)} … `);
  try {
    const { job } = await importJob({ url }, { db, anthropic, userId });
    const applyUrl = job.applyUrl || job.url || "";
    landed.push({ jobId: job.jobId || job.id, title: job.title, company: job.company, applyUrl });
    console.log(`ok — ${job.company} / ${job.title}${isGreenhouseApplyUrl(applyUrl) ? "" : "  [not a greenhouse apply page]"}`);
    ok++;
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    failed++;
  }
}

// ── what the board looks like now ────────────────────────────────────────────
const total = db.prepare("SELECT COUNT(*) n FROM scraped_jobs").get().n;
const fresh = db.prepare("SELECT COUNT(*) n FROM scraped_jobs WHERE scraped_at >= unixepoch() - 7*86400").get().n;
const gh = db.prepare(`
  SELECT COUNT(*) n FROM scraped_jobs
  WHERE COALESCE(apply_url, url) LIKE '%boards.greenhouse.io%'
     OR COALESCE(apply_url, url) LIKE '%job-boards.greenhouse.io%'
`).get().n;

console.log(`\nimported ${ok}, failed ${failed}`);
console.log(`board now: ${total} rows, ${fresh} inside the 7-day expiry window, ${gh} on a greenhouse apply page`);
console.log(`\nA5 candidates (greenhouse apply pages, survive cleanup):`);
for (const r of db.prepare(`
  SELECT job_id, company, title FROM scraped_jobs
  WHERE (COALESCE(apply_url, url) LIKE '%boards.greenhouse.io%'
      OR COALESCE(apply_url, url) LIKE '%job-boards.greenhouse.io%')
    AND scraped_at >= unixepoch() - 7*86400
  ORDER BY company, title LIMIT 40
`).all()) console.log(`   ${r.job_id}  ${r.company} — ${r.title}`);

console.log(`\nNext: node scripts/a5Preflight.mjs --user ${userId ?? "<id>"} --job <job_id>`);
process.exit(failed && !ok ? 1 : 0);
