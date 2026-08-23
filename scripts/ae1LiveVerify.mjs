// AE1 + AE2 VERIFICATION — the real Ashby posting, in preview mode, nothing submitted.
//
// What this proves, on the exact URL the defect was reported against:
//   1. the run does NOT report a gate;
//   2. discovery reports a real field count;
//   3. the fill actually fills — and the answers carry the EMPLOYER'S control names, which is what
//      makes "Open & fill" able to do anything on the far side.
//
// PREVIEW, NOT FULL. `mode: "preview"` is full-auto minus the click: every gate and check runs, the
// form is filled, and the run stops at the PREVIEW STOP before any submit button is touched
// (applyAutomation.js). Nothing reaches OpenAI.
//
// FIXTURE IDENTITY ONLY. This types into a real employer's form. It refuses to run under a real
// candidate's details, for the same reason a5Rehearsal refuses a non-localhost target: the cost of
// being wrong is a stranger's name and address in a third party's system.
//
// Usage: node scripts/ae1LiveVerify.mjs [url]
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoApply, closeSemiBrowser } from "../services/applyAutomation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Flags are not the URL. `--semi` in argv[2] was navigated to as one, and the run then failed with
// "Cannot navigate to invalid URL" — which the AE6 check correctly read as "reported nothing".
const ARGS = process.argv.slice(2);
const URL_ = ARGS.find(a => !a.startsWith("--"))
  || "https://jobs.ashbyhq.com/openai/0432731c-f229-476e-92b6-d53491e79096/application";

const db = new Database(path.join(ROOT, "data", "resume_master.db"), { readonly: true });
// The FIXTURE candidate specifically, not "the most recent user" — this run types into a real
// employer's form, and the most recent user is a real person. `--user N` overrides.
const wanted = ARGS.indexOf("--user") >= 0 ? Number(ARGS[ARGS.indexOf("--user") + 1]) : null;
const user = wanted
  ? db.prepare("SELECT id FROM users WHERE id=?").get(wanted)
  : db.prepare(`SELECT u.id FROM users u JOIN user_profile p ON p.user_id=u.id
                WHERE p.first_name='John' AND p.last_name='Doe' ORDER BY u.id DESC LIMIT 1`).get();
if (!user) { console.error("No fixture candidate. Run scripts/a5SeedFixture.mjs first."); process.exit(1); }
const prof = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(user.id) || {};

const isFixture = /\b(test|smoke|fixture|sample|demo|john doe|jane doe)\b/i
  .test(`${prof.first_name} ${prof.last_name} ${prof.email || ""}`);
if (!isFixture) {
  console.error(`REFUSING: "${prof.first_name} ${prof.last_name} <${prof.email}>" does not look like a ` +
    `placeholder identity, and this script types into a real employer's form.`);
  process.exit(1);
}

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

// `--semi` runs the ATTENDED path instead of preview (AE6): a visible browser, no gates, and — since
// AE6 — a report of what the human still has to answer. Neither mode ever clicks submit.
const MODE = ARGS.includes("--semi") ? "semi" : "preview";

console.log("=".repeat(90));
console.log(`AE1/AE2/AE6 LIVE VERIFICATION — ${MODE} mode, nothing submitted`);
console.log("=".repeat(90));
console.log(`target    : ${URL_}`);
console.log(`candidate : ${prof.first_name} ${prof.last_name} <${prof.email}>  (fixture)`);
console.log("");

const res = await autoApply(URL_, payload, { mode: MODE, jobId: `ae1-live-verify-${MODE}` });
if (MODE === "semi") await closeSemiBrowser(`ae1-live-verify-semi`);

const filled = (res.answers || []).filter(a => !a.skipped && a.value !== null && a.value !== "");
console.log("\n" + "-".repeat(90));
console.log(`status            : ${res.status}`);
console.log(`reasonCode        : ${res.reasonCode ?? "(none)"}`);
console.log(`flowState         : ${res.flowState ?? "(none)"}`);
console.log(`fieldsFilled      : ${res.fieldsFilled}`);
console.log(`answers (filled)  : ${filled.length}`);
console.log(`screenshot        : ${res.screenshotPath ?? "(none)"}`);
console.log(`landedUrl         : ${res.landedUrl ?? "(none)"}`);
console.log(`missingRequired   : ${res.missingRequired === undefined ? "(ABSENT — the AE6 defect)" : JSON.stringify(res.missingRequired)}`);
console.log(`openQuestions     : ${(res.openQuestions || []).length}`);
console.log("-".repeat(90));
for (const a of filled) {
  console.log(`  ${String(a.name || a.field_id).padEnd(42)} ${String(a.provenance).padEnd(16)} ` +
              `${String(a.value).slice(0, 34)}`);
}

// ── the three assertions ─────────────────────────────────────────────────────
const GATES = new Set(["captcha_required", "login_required"]);
const problems = [];
if (GATES.has(res.status) || GATES.has(res.reasonCode) || GATES.has(res.flowState)) {
  problems.push(`the run reported a GATE (${res.reasonCode ?? res.status}) on a page that has none`);
}
if (res.status === "no_fields_discovered") problems.push("discovery found zero fields on a live Ashby page");
if (!(res.fieldsFilled > 0)) problems.push(`the fill filled nothing (fieldsFilled=${res.fieldsFilled})`);
// The point of AE2: the answers have to be keyed on the EMPLOYER'S control names. A canonical-profile
// packet is keyed on `email`/`first_name`, which match nothing on this form — that is exactly how
// "Open & fill" managed to fill an empty form.
if (!filled.some(a => /_systemfield_|^[0-9a-f]{8}-/.test(String(a.name || "")))) {
  problems.push("no answer is keyed on one of Ashby's own control names — the packet would not match");
}

// AE6: the attended path runs no gates by design, and used to say nothing at all about the form it
// had just filled. An empty array is a pass — "we checked, nothing is outstanding"; an ABSENT field
// is the defect.
if (MODE === "semi" && !Array.isArray(res.missingRequired)) {
  problems.push("a semi run reported NOTHING about its required fields — missingRequired is absent");
}

console.log("");
if (problems.length) {
  console.log("FAILED:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("PASSED: no gate reported, discovery found real fields, the fill filled, and the answers");
console.log("        are keyed on the employer's own control names.");
if (MODE === "semi") {
  console.log(`        And the attended run states its own gap: ${res.missingRequired.length} required ` +
              `field(s) are yours to answer${res.missingRequired.length ? ` — ${res.missingRequired.join(", ")}` : ""}.`);
}
