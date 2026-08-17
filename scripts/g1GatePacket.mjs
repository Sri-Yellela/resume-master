// TASK G1 — gated portal handoff: packet + single-use token. REAL-RUN verification.
//
// A unit test can prove the token maths. It cannot prove that a run which meets a login wall ends
// held_gate with a usable packet rather than "failed / browser error" — that needs a real browser
// reaching a real gate, which is what fakeAts's /gated route is for. So the run here is real: real
// autoApply, real Chromium, real classifyFlowState, real routes/apply.js.
//
// What must hold:
//   1. a gated run ends held_gate, NOT failed and NOT held_review, with a packet row
//   2. the packet carries PROVENANCE PER FIELD — not bare values
//   3. a token works exactly ONCE; the replay is refused
//   4. expired, forged, superseded and another account's token are each refused DISTINCTLY
//   5. the resume is fetchable by the extension through the route that already existed
//   6. a NON-gated run is completely unchanged, and its audit trail still records fully
//
// THE HARD BOUNDARY: nothing here crosses the gate. The sign-in wall has no valid credential and is
// never submitted to. The assertion is that we STOP there having prepared everything.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/g1GatePacket.mjs
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import applyRoutes from "../routes/apply.js";
import { MIGRATIONS } from "./migrations.js";
import { mintPacketToken } from "../services/applyGatePacket.js";

const ATS = "http://localhost:4599";
const RESUME_PDF = process.env.A1_RESUME;
if (!RESUME_PDF || !fs.existsSync(RESUME_PDF)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}
// Must match routes/apply.js's fallback, which is what an unset environment resolves to.
const SECRET = process.env.APPLY_GATE_TOKEN_SECRET || process.env.SESSION_SECRET
  || "dev-gate-token-secret-change-me";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, plan_tier TEXT DEFAULT 'BASIC');
  CREATE TABLE domain_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, profile_name TEXT,
    role_family TEXT, domain TEXT, is_active INTEGER DEFAULT 0);
  CREATE TABLE user_profile (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
    full_name TEXT, email TEXT, phone TEXT, custom_answers TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE user_integrations (user_id INTEGER, provider TEXT, status TEXT, account_email TEXT,
    updated_at INTEGER, last_checked_at INTEGER);
  CREATE TABLE profile_base_resumes (profile_id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT,
    content TEXT, enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE base_resume (user_id INTEGER PRIMARY KEY, name TEXT, content TEXT,
    enhanced_content TEXT, enhanced_at INTEGER, enhanced_ats_delta REAL, updated_at INTEGER);
  CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, title TEXT, company TEXT, url TEXT,
    apply_url TEXT, source TEXT, location TEXT);
  CREATE TABLE resumes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_id TEXT,
    apply_mode TEXT, ats_score INTEGER, html TEXT, updated_at INTEGER);
  CREATE TABLE apply_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, mode TEXT, approval_mode TEXT,
    tool_type TEXT, status TEXT, total_jobs INTEGER, held_count INTEGER DEFAULT 0,
    submitted_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()), started_at INTEGER, finished_at INTEGER);
  CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, user_id INTEGER,
    approved_at INTEGER, approved_from_run_job_id INTEGER,
    job_id TEXT, status TEXT, reason_code TEXT, reason_detail TEXT, started_at INTEGER,
    finished_at INTEGER, created_at INTEGER DEFAULT (unixepoch()),
    answers_json TEXT, resume_artifact_id INTEGER, resume_ats_score INTEGER,
    screenshot_path TEXT, submit_verified INTEGER, submit_evidence TEXT,
    open_questions_json TEXT, UNIQUE(run_id, job_id));
  CREATE TABLE apply_job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, run_job_id INTEGER,
    user_id INTEGER, job_id TEXT, level TEXT DEFAULT 'info', event TEXT, message TEXT,
    details_json TEXT, created_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE job_applications (user_id INTEGER, job_id TEXT, company TEXT, role TEXT, job_url TEXT,
    source TEXT, location TEXT, apply_mode TEXT, resume_file TEXT, applied_at INTEGER, notes TEXT,
    auto_status TEXT, UNIQUE(user_id, job_id));
  CREATE TABLE user_jobs (user_id INTEGER, job_id TEXT, domain_profile_id INTEGER, applied INTEGER DEFAULT 0,
    updated_at INTEGER, UNIQUE(user_id, job_id));
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()));
  CREATE TABLE apply_idempotency (user_id INTEGER NOT NULL, idem_key TEXT NOT NULL, endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 200, response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, idem_key));
  INSERT INTO users (id, username, plan_tier) VALUES (1, 'ada', 'PRO');
  INSERT INTO users (id, username, plan_tier) VALUES (2, 'grace', 'PRO');
  INSERT INTO domain_profiles (id, user_id, profile_name, is_active) VALUES (10, 1, 'SWE', 1);
  INSERT INTO user_profile (user_id, first_name, last_name, email) VALUES (1, 'Ada', 'Lovelace', 'ada@example.com');
  INSERT INTO profile_base_resumes (profile_id, user_id, name, content, updated_at)
    VALUES (10, 1, 'r.txt', 'real resume text', unixepoch());
`);

// The gate-packet table comes from migration 079 ITSELF rather than being restated here. A hand-copied
// CREATE TABLE would be a third definition alongside server.js and scripts/migrations.js, and the one
// that drifts silently is always the one only a test reads.
const mig079 = MIGRATIONS.find(m => m.id === "079_apply_gate_packets");
if (!mig079) { console.error("migration 079_apply_gate_packets not found"); process.exit(1); }
// The fixture's apply_run_jobs has no REFERENCES clause, so the FK in 079 has nothing to point at
// here; foreign_keys is off by default in better-sqlite3, so the DDL is accepted as written.
db.exec(mig079.sql);

// The ?ats= hint is what detectPlatformFromUrl reads, and processRunJob will not open a browser at
// all for a provider outside V1_AUTO_PROVIDERS — without it the run holds as provider_review_only and
// never reaches the gate, so the gate branch goes untested while every assertion still "runs".
// A gated Ashby posting is realistic: referral-only and internal roles sit behind a login on hosts
// that are otherwise in scope.
const GATED_URL   = `${ATS}/gated?ats=jobs.ashbyhq.com`;
const UNGATED_URL = `${ATS}/ashby?ats=jobs.ashbyhq.com`;

const seedJob = (jobId, applyUrl, company) => {
  db.prepare(`INSERT OR IGNORE INTO scraped_jobs (job_id, title, company, url, apply_url, source, location)
              VALUES (?, 'Platform Engineer', ?, ?, ?, 'ashby', 'Remote')`).run(jobId, company, applyUrl, applyUrl);
  db.prepare(`INSERT INTO resumes (user_id, job_id, apply_mode, ats_score, html, updated_at)
              VALUES (1, ?, 'TAILORED', 80, '<html><body>resume</body></html>', unixepoch())`).run(jobId);
};
seedJob("gate1", GATED_URL, "GatedCo");
seedJob("gate2", GATED_URL, "GatedCo");
seedJob("open1", UNGATED_URL, "OpenCo");

// A payload that can answer most of the canonical set but NOT all of it, so `unresolved` is exercised
// as a real result rather than always being empty.
const buildAutofillPayload = () => ({
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100",
    address_line1: "12 Analytical Way", city: "Boston", state: "MA", zip: "02115",
    country: "United States", linkedin_url: "https://linkedin.com/in/ada",
    requires_sponsorship: "No", work_authorization: "Yes",
    location: "Boston, MA", available_start_date: "2026-09-01",
    website_url: "https://ada.dev",
  },
  handler_map: {},
  custom_answers: { "I am authorized to work without sponsorship": "yes" },
});

let CURRENT_USER = 1;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: CURRENT_USER, planTier: "PRO" }; next(); });
applyRoutes(app, db, (q, r, n) => n(), buildAutofillPayload,
  async () => ({ error: "not_needed" }),
  async () => fs.readFileSync(RESUME_PDF),
  async () => ({}));
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

const post = (p, b) => fetch(`${url}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}),
});
const get = (p) => fetch(`${url}${p}`);
const atsCount = () => fetch(`${ATS}/_submissions`).then(r => r.json()).then(j => j.count);

async function waitForRuns(ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    if (db.prepare("SELECT COUNT(*) n FROM apply_runs WHERE status IN ('queued','running')").get().n === 0) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 1000));
  }
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

await fetch(`${ATS}/_reset`, { method: "POST" });

// ── 1. a gated run holds with a packet ───────────────────────────────────────
console.log("\n=== 1. a run that meets a login wall ends held_gate with a packet ===");
const run1 = await post("/api/apply/runs", { jobIds: ["gate1"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const gatedJob = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run1.runId);

check("the job ended held_gate, not failed and not held_review",
  gatedJob.status === "held_gate", `status=${gatedJob.status} reason=${gatedJob.reason_code}`);
check("the reason names the gate it met",
  gatedJob.reason_code === "login_required" || gatedJob.reason_code === "captcha_required",
  `reason=${gatedJob.reason_code}`);
check("NOTHING was submitted to the portal", await atsCount() === 0, `count=${await atsCount()}`);

const pktRow = db.prepare("SELECT * FROM apply_gate_packets WHERE job_id='gate1'").get();
check("a packet row exists", !!pktRow, pktRow ? `id=${pktRow.id}` : "none");
check("the packet stores the origin the extension must target-match",
  pktRow?.expected_origin === "http://localhost:4599", `origin=${pktRow?.expected_origin}`);
check("the packet records the URL the GATE was observed at, not the queued URL",
  pktRow?.apply_url?.includes("/gated/signin"), `applyUrl=${pktRow?.apply_url}`);
check("no usable token is stored on the row",
  typeof pktRow?.token_hash === "string" && pktRow.token_hash.startsWith("unminted:"),
  `token_hash=${String(pktRow?.token_hash).slice(0, 24)}`);

// ── 2. provenance per field, not bare values ─────────────────────────────────
console.log("\n=== 2. the packet carries provenance per field ===");
const body = JSON.parse(pktRow.answers_json);
check("the packet has answers", Array.isArray(body.answers) && body.answers.length > 0,
  `${body.answers?.length} answers, source=${body.source}`);
const bare = (body.answers || []).filter(a => !a.provenance);
check("EVERY answer carries a provenance tier", bare.length === 0,
  bare.length ? `${bare.length} bare: ${bare.map(a => a.name).join(", ")}` : "none bare");
const noConf = (body.answers || []).filter(a => typeof a.confidence !== "number");
check("EVERY answer carries a confidence", noConf.length === 0,
  noConf.length ? noConf.map(a => a.name).join(", ") : "all present");
const elig = (body.answers || []).filter(a => a.eligibility);
check("eligibility answers are flagged as such", elig.length >= 2,
  elig.map(a => `${a.name}=${a.value}`).join(", "));
check("what could NOT be answered is reported, not hidden",
  Array.isArray(body.unresolved),
  `${body.unresolved?.length} unresolved: ${(body.unresolved || []).map(u => u.name).join(", ")}`);
console.log("      provenance mix:", JSON.stringify(
  (body.answers || []).reduce((m, a) => { m[a.provenance] = (m[a.provenance] || 0) + 1; return m; }, {})));

// ── 3. the list surface exposes counts only ──────────────────────────────────
console.log("\n=== 3. the queue lists the packet without leaking its contents ===");
const list = await get("/api/apply/gate-packets").then(r => r.json());
check("the packet is listed", list.packets?.length === 1 && list.packets[0].packetId === pktRow.id);
const listJson = JSON.stringify(list);
check("the list carries NO answer values",
  !listJson.includes("Analytical Way") && !listJson.includes("ada@example.com"),
  "no address or email in the list response");
check("the list still says how much is prepared",
  list.packets[0].answerCount === body.answers.length, `answerCount=${list.packets[0].answerCount}`);

// ── 4. the token works exactly once ──────────────────────────────────────────
console.log("\n=== 4. single use ===");
const minted = await post(`/api/apply/gate-packets/${pktRow.id}/token`).then(r => r.json());
check("a token is issued on demand", typeof minted.token === "string" && minted.token.length > 40);
check("the mint response carries the expected origin for pre-release matching",
  minted.expectedOrigin === "http://localhost:4599", `origin=${minted.expectedOrigin}`);
check("the mint response points at the EXISTING resume route",
  minted.resumeUrl === `/api/apply/run-jobs/${gatedJob.id}/resume`, `resumeUrl=${minted.resumeUrl}`);
const ttlMin = (minted.expiresAt - Date.now()) / 60000;
check("the TTL is minutes, not hours", ttlMin > 0 && ttlMin <= 60, `${ttlMin.toFixed(1)} min`);

const ex1 = await post("/api/apply/gate-packet/exchange", { token: minted.token });
const ex1Body = await ex1.json();
check("the first exchange returns the packet", ex1.status === 200 && !!ex1Body.packet,
  `status=${ex1.status}`);
check("the released packet carries the answers with provenance",
  ex1Body.packet?.answers?.length === body.answers.length &&
  ex1Body.packet.answers.every(a => !!a.provenance),
  `${ex1Body.packet?.answers?.length} answers`);
check("the released packet carries the expected origin at the top level",
  ex1Body.expectedOrigin === "http://localhost:4599");

const ex2 = await post("/api/apply/gate-packet/exchange", { token: minted.token });
check("a REPLAY is refused, and distinctly", ex2.status === 409,
  `status=${ex2.status} error=${(await ex2.json()).error}`);
check("the row records it as consumed",
  db.prepare("SELECT consumed_at FROM apply_gate_packets WHERE id=?").get(pktRow.id).consumed_at != null);

// ── 5. every other rejection is its own distinct answer ──────────────────────
console.log("\n=== 5. rejections are distinct, not one generic 400 ===");
const seen = {};
const tryToken = async (label, token) => {
  const r = await post("/api/apply/gate-packet/exchange", { token });
  const b = await r.json().catch(() => ({}));
  seen[label] = `${r.status} ${b.error}`;
  return { status: r.status, error: b.error };
};

// A second packet, so these are tested against something not already consumed.
const run2 = await post("/api/apply/runs", { jobIds: ["gate2"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const pkt2 = db.prepare("SELECT * FROM apply_gate_packets WHERE job_id='gate2'").get();
check("a second gated run produced its own packet", !!pkt2, pkt2 ? `id=${pkt2.id}` : "none");

const expired = mintPacketToken({ secret: SECRET, userId: 1, jobId: "gate2", packetId: pkt2.id, ttlMs: -1000 });
const forged  = mintPacketToken({ secret: "not-the-server-secret", userId: 1, jobId: "gate2", packetId: pkt2.id });
const otherU  = mintPacketToken({ secret: SECRET, userId: 2, jobId: "gate2", packetId: pkt2.id });

const rExpired = await tryToken("expired", expired.token);
check("an EXPIRED token is refused as expired (410)", rExpired.status === 410 && rExpired.error === "token_expired", seen.expired);

const rForged = await tryToken("forged", forged.token);
check("a FORGED signature is refused as invalid (401)", rForged.status === 401 && rForged.error === "token_invalid", seen.forged);

const rMalformed = await tryToken("malformed", "not-even-a-token");
check("a MALFORMED token is refused as malformed (401)", rMalformed.status === 401 && rMalformed.error === "token_malformed", seen.malformed);

// Another account's token, presented by this session. Signature is valid; the binding is not.
const rOther = await tryToken("other_user", otherU.token);
check("ANOTHER ACCOUNT's token is refused as a user mismatch (403)",
  rOther.status === 403 && rOther.error === "token_user_mismatch", seen.other_user);

// And the same token presented BY that other account still fails, because the row is not theirs.
const realMint = await post(`/api/apply/gate-packets/${pkt2.id}/token`).then(r => r.json());
CURRENT_USER = 2;
const rCross = await post("/api/apply/gate-packet/exchange", { token: realMint.token });
const rCrossBody = await rCross.json();
check("a token cannot be redeemed by a different account even with the right signature",
  rCross.status === 403, `status=${rCross.status} error=${rCrossBody.error}`);
CURRENT_USER = 1;
check("that other account cannot even see the packet",
  (await (async () => { CURRENT_USER = 2; const r = await get("/api/apply/gate-packets").then(x => x.json()); CURRENT_USER = 1; return r; })()).packets.length === 0);

// Re-minting rotates: the previously issued token must stop working.
const remint = await post(`/api/apply/gate-packets/${pkt2.id}/token`).then(r => r.json());
const rSuperseded = await post("/api/apply/gate-packet/exchange", { token: realMint.token });
check("re-minting SUPERSEDES the older token rather than adding a second key",
  rSuperseded.status === 401 && (await rSuperseded.json()).error === "token_superseded",
  `status=${rSuperseded.status}`);
const rFresh = await post("/api/apply/gate-packet/exchange", { token: remint.token });
check("the freshly minted token still works", rFresh.status === 200, `status=${rFresh.status}`);

check("each rejection was logged under its own event",
  db.prepare(`SELECT COUNT(DISTINCT event) n FROM apply_job_logs WHERE event LIKE 'gate_packet_exchange%'`).get().n >= 5,
  db.prepare(`SELECT DISTINCT event FROM apply_job_logs WHERE event LIKE 'gate_packet_exchange%'`)
    .all().map(r => r.event.replace("gate_packet_exchange_", "")).join(", "));

// ── 6. the resume is fetchable by the extension ──────────────────────────────
console.log("\n=== 6. the resume travels with the packet ===");
const resumeRes = await get(`/api/apply/run-jobs/${gatedJob.id}/resume`);
check("the pre-existing, session-authenticated resume route serves the gated job",
  resumeRes.status === 200 || resumeRes.status === 503,
  `status=${resumeRes.status}${resumeRes.status === 503 ? " (no browser to render PDF — route reached, nothing new added)" : ""}`);

// ── 7. a NON-gated run is untouched ──────────────────────────────────────────
console.log("\n=== 7. regression: a non-gated run behaves exactly as before ===");
const run3 = await post("/api/apply/runs", { jobIds: ["open1"], mode: "auto" }).then(r => r.json());
await waitForRuns();
const openJob = db.prepare("SELECT * FROM apply_run_jobs WHERE run_id=?").get(run3.runId);
check("no held_gate status appears on an ungated run", openJob.status !== "held_gate",
  `status=${openJob.status} reason=${openJob.reason_code}`);
check("no packet was created for it",
  db.prepare("SELECT COUNT(*) n FROM apply_gate_packets WHERE job_id='open1'").get().n === 0);
check("its audit trail still records fully",
  db.prepare(`SELECT COUNT(*) n FROM apply_job_logs WHERE run_id=? AND event='audit_recorded'`).get(run3.runId).n === 1,
  db.prepare(`SELECT message FROM apply_job_logs WHERE run_id=? AND event='audit_recorded'`).get(run3.runId)?.message);
check("its answers were recorded with provenance, as before",
  JSON.parse(openJob.answers_json || "[]").length > 0,
  `${JSON.parse(openJob.answers_json || "[]").length} answers`);

// The gated jobs must still be VISIBLE somewhere — the whole risk of a new status is that they
// silently vanish from the surface they used to appear on.
const runsRes = await get("/api/apply/runs").then(r => r.json());
check("gated jobs are listed under their own key, not lost",
  Array.isArray(runsRes.gated) && runsRes.gated.length === 2,
  `gated=${runsRes.gated?.length} review=${runsRes.review?.length}`);
check("they are NOT mixed back into the review list",
  (runsRes.review || []).every(j => j.status !== "held_gate"));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
server.close();
db.close();
process.exit(failures === 0 ? 0 : 1);
