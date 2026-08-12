// TASK A5 preflight — GO / NO-GO for the first live application.
//
// READ-ONLY. Opens no browser, sends nothing, changes nothing. It exists because A5's own
// preconditions are checkable, and checking them by eye is how a junk application reaches a real
// employer: a submission cannot be recalled.
//
// Usage:  node scripts/a5Preflight.mjs [--user 10] [--job greenhouse::6110219004]
//         node scripts/a5Preflight.mjs --list          # apply-ready accounts + greenhouse pool
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getAutomationReadiness, getMissingApplyPrerequisites } from "../services/integrationReadiness.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "resume_master.db");

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const LIST = argv.includes("--list");
const USER_ID = Number(arg("user") || 0) || null;
const JOB_ID = arg("job");
const ALLOW_FIXTURE = argv.includes("--allow-fixture");

if (!fs.existsSync(DB_PATH)) { console.error(`No database at ${DB_PATH}`); process.exit(1); }
// Read-only: a preflight must not be able to change the thing it is inspecting.
const db = new Database(DB_PATH, { readonly: true });

const checks = [];
const ok   = (label, detail = "") => checks.push({ level: "GO",   label, detail });
const warn = (label, detail = "") => checks.push({ level: "WARN", label, detail });
const stop = (label, detail = "") => checks.push({ level: "STOP", label, detail });

// A greenhouse APPLICATION url, not an aggregator redirect. A5 notes that aggregator links
// frequently resolve to redirects rather than fillable ATS forms.
const isGreenhouseApplyUrl = (u) =>
  /(^|\/\/)(boards|job-boards)\.greenhouse\.io\//i.test(u || "") ||
  /greenhouse\.io\/[^/]+\/jobs\/\d+/i.test(u || "");

function applyReadyUsers() {
  return db.prepare("SELECT id FROM users").all()
    .map(({ id }) => {
      const readiness = getAutomationReadiness(db, id);
      return { id, missing: getMissingApplyPrerequisites(readiness), readiness };
    });
}

function greenhouseRows() {
  return db.prepare("SELECT job_id, title, company, url, apply_url FROM scraped_jobs").all()
    .filter(r => detectPlatformFromUrl(r.apply_url || r.url || "") === "greenhouse");
}

// ── --list ───────────────────────────────────────────────────────────────────
if (LIST) {
  console.log("=== apply-ready accounts ===");
  for (const u of applyReadyUsers()) {
    const p = db.prepare("SELECT first_name, last_name, email FROM user_profile WHERE user_id=?").get(u.id) || {};
    const br = db.prepare("SELECT LENGTH(content) AS len FROM profile_base_resumes WHERE user_id=?").get(u.id);
    console.log(`  user ${String(u.id).padStart(2)}  ${u.missing.length ? "BLOCKED" : "READY  "}  ` +
      `${(p.first_name || "?") + " " + (p.last_name || "")}`.padEnd(22) +
      `${p.email || "-"}`.padEnd(34) + `resume=${br?.len ?? 0} chars` +
      (u.missing.length ? `  missing=[${u.missing}]` : ""));
  }
  const gh = greenhouseRows();
  const companies = [...new Set(gh.map(r => r.company))];
  console.log(`\n=== greenhouse pool: ${gh.length} rows across ${companies.length} company/ies ===`);
  console.log(`  ${companies.join(", ")}`);
  console.log("\n  (pass --job <job_id> to preflight one of them)");
  for (const r of gh.slice(0, 15)) console.log(`   ${r.job_id}  ${r.title}`);
  if (gh.length > 15) console.log(`   … ${gh.length - 15} more`);
  process.exit(0);
}

// ── 1. the candidate ─────────────────────────────────────────────────────────
const ready = applyReadyUsers();
const candidates = ready.filter(u => u.missing.length === 0);
let user = USER_ID ? ready.find(u => u.id === USER_ID) : (candidates.length === 1 ? candidates[0] : null);

if (!user) {
  stop(USER_ID ? `user ${USER_ID} not found` : `cannot infer the candidate account`,
    `apply-ready: ${candidates.map(c => c.id).join(", ") || "none"} — pass --user`);
} else if (user.missing.length) {
  stop(`user ${user.id} is not apply-ready`, `missing: ${user.missing.join(", ")}`);
} else {
  ok(`user ${user.id} is apply-ready`);

  const p = db.prepare("SELECT first_name, last_name, email FROM user_profile WHERE user_id=?").get(user.id) || {};
  const name = `${p.first_name || ""} ${p.last_name || ""}`.trim();

  // A5 submits under a REAL candidate's name. A fixture identity reaching a real employer is a junk
  // application against that company, and it is not a test of anything either.
  const FIXTURE = /\b(test|smoke|fixture|sample|demo|foo|bar|qa|john doe|jane doe)\b/i;
  const FIXTURE_EMAIL = /@(example|test|invalid|localhost)\.|^$/i;
  if (FIXTURE.test(name) || FIXTURE.test(p.email || "") || FIXTURE_EMAIL.test(p.email || "")) {
    // --allow-fixture is a CONSCIOUS override, not a bypass: the check still fires and still prints.
    // What it protects against is an ACCIDENTAL fixture submission, and an explicit flag is not that.
    (ALLOW_FIXTURE ? warn : stop)(
      "the account is a FABRICATED identity, not a real candidate",
      `name="${name}" email="${p.email || ""}"` +
      (ALLOW_FIXTURE
        ? " — overridden with --allow-fixture. Anything submitted lands in a real employer's pipeline under this name."
        : " — A5 submits under a real name to a real employer. Pass --allow-fixture to proceed deliberately."));
  } else {
    ok(`candidate identity looks real`, `${name} <${p.email}>`);
  }

  // "The resume is the payload." A stub resume produces a stub application.
  const br = db.prepare("SELECT name, LENGTH(content) AS len FROM profile_base_resumes WHERE user_id=?").get(user.id);
  const MIN_RESUME_CHARS = 1200;
  if (!br || !br.len) stop("no base resume content");
  else if (br.len < MIN_RESUME_CHARS) {
    stop(`base resume is only ${br.len} chars`,
      `a real resume is >~${MIN_RESUME_CHARS}; the resume IS the payload, so this would submit a stub`);
  } else ok(`base resume is substantive`, `${br.len} chars ("${br.name}")`);
}

// ── 2. the target posting ────────────────────────────────────────────────────
const gh = greenhouseRows();
if (!JOB_ID) {
  stop("no target posting given", `pass --job <job_id>; ${gh.length} greenhouse rows available (--list)`);
} else {
  const job = db.prepare("SELECT job_id, title, company, url, apply_url FROM scraped_jobs WHERE job_id=?").get(JOB_ID);
  if (!job) stop(`job ${JOB_ID} not in scraped_jobs`);
  else {
    const applyUrl = job.apply_url || job.url || "";
    ok(`target: ${job.company} — ${job.title}`);
    const platform = detectPlatformFromUrl(applyUrl);
    if (platform !== "greenhouse") stop(`target detects as "${platform}", not greenhouse`, applyUrl);
    else ok("target detects as greenhouse");
    if (!isGreenhouseApplyUrl(applyUrl)) {
      stop("apply_url does not look like a greenhouse application page", applyUrl);
    } else ok("apply_url is a greenhouse application page", applyUrl);

    if (user) {
      const prior = db.prepare(`
        SELECT status FROM apply_run_jobs WHERE user_id=? AND job_id=?
      `).all(user.id, JOB_ID).map(r => r.status);
      if (prior.some(s => ["submitted", "running", "queued"].includes(s))) {
        stop("this job already has an application in flight or submitted", prior.join(", "));
      } else if (prior.length) warn("this job was attempted before", prior.join(", "));
      else ok("no prior attempt on this job");
    }
  }
}

// ── 3. run-time gates that would refuse the run anyway ───────────────────────
try {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='apply_full_auto_disabled'").get()?.value;
  // Only full-auto is blocked by the switch; A5 is semi, so this is informational.
  if (["1", "true", "yes", "on"].includes(String(flag ?? "").toLowerCase())) {
    ok("full-auto kill switch is ON", "semi mode is unaffected — A5 is semi by design");
  } else ok("full-auto kill switch is off", "A5 still runs in semi mode regardless");
} catch { warn("app_settings not present", "run migrations"); }

if (user) {
  const active = db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE user_id=? AND status IN ('queued','running')").get(user.id).n;
  if (active > 0) stop(`user ${user.id} already has ${active} run in flight`, "the concurrency guard will refuse a new run");
  else ok("no run in flight");
}

// ── 4. things this script cannot check ───────────────────────────────────────
const MANUAL = [
  "A human is physically present at this machine and will read every field before clicking submit",
  "The candidate actually WANTS this role — a bad first application costs a real opportunity",
  "The browser can open a visible window here (semi mode is not headless)",
  "`node --test` is green and the trap matrix passes (scripts/a1TrapMatrix.mjs)",
];

// ── verdict ──────────────────────────────────────────────────────────────────
const pad = { GO: "GO  ", WARN: "WARN", STOP: "STOP" };
console.log("=== A5 PREFLIGHT ===\n");
for (const c of checks) console.log(`  ${pad[c.level]}  ${c.label}${c.detail ? `\n          ${c.detail}` : ""}`);
const stops = checks.filter(c => c.level === "STOP");
console.log("\n=== CANNOT BE CHECKED FROM HERE — confirm by hand ===");
for (const m of MANUAL) console.log(`  [ ] ${m}`);
console.log(`\n${stops.length === 0
  ? "PREFLIGHT CLEAR — every automated check passes. The manual list above is still yours to confirm."
  : `NO-GO — ${stops.length} blocking condition(s). A5 must not start.`}`);
process.exitCode = stops.length === 0 ? 0 : 1;
