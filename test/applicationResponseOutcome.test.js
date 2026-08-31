import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import express from "express";
import {
  RESPONSE_OUTCOME, RESPONSE_OUTCOMES, RESPONDED, STAGE_RANK, RESPONSE_LABELS,
  MATURITY_DAYS, isResponse, responseBucket, mergeResponse,
} from "../shared/applicationResponse.js";
import { MIGRATIONS } from "../scripts/migrations.js";
import applyRoutes from "../routes/apply.js";
import { at, lastAt } from "../test-support/sourceAnchors.js";

const DAY = 86400;
const NOW = 1_800_000_000;

// ── The vocabulary, and the two calls in it that are easy to get wrong ───────────────────────────

test("a REJECTION counts as a response — the resume got read", () => {
  // The load-bearing judgement in this module. An ATS score is a resume-SCREENING score; the only
  // thing it could plausibly predict is "did something read this and reply". A rejection is a reply.
  // Filing rejections with silence would measure hiring outcomes instead, which the score has no
  // business predicting, and would make a resume that reliably gets rejections look identical to
  // one that vanishes into a void.
  assert.ok(isResponse(RESPONSE_OUTCOME.REJECTED));
  assert.ok(isResponse(RESPONSE_OUTCOME.SCREEN));
  assert.ok(isResponse(RESPONSE_OUTCOME.INTERVIEW));
  assert.ok(isResponse(RESPONSE_OUTCOME.OFFER));
  assert.ok(!isResponse(RESPONSE_OUTCOME.NO_RESPONSE));
});

test("WITHDRAWN is not a response and not a silence — it says nothing about the employer", () => {
  assert.ok(!RESPONDED.includes(RESPONSE_OUTCOME.WITHDRAWN));
  // With nothing else known, a withdrawal must land in no denominator at all.
  assert.equal(
    responseBucket({ response_outcome: RESPONSE_OUTCOME.WITHDRAWN, applied_at: NOW - 200 * DAY }, { now: NOW }),
    "unresolved",
    "the candidate ending it tells us nothing about whether the employer replied");
  // But if they HAD replied before the candidate withdrew, that is still a response.
  assert.equal(
    responseBucket({ response_outcome: RESPONSE_OUTCOME.WITHDRAWN, first_response_at: NOW - 190 * DAY, applied_at: NOW - 200 * DAY }, { now: NOW }),
    "responded");
});

test("every outcome has a label, and the vocabulary is closed", () => {
  for (const o of RESPONSE_OUTCOMES) {
    assert.ok(RESPONSE_LABELS[o]?.label, `${o} has no label — a UI would invent its own wording`);
  }
  assert.equal(Object.keys(RESPONSE_LABELS).length, RESPONSE_OUTCOMES.length);
});

// ── The maturity window: the number that keeps an early response rate honest ─────────────────────

test("a recent application with nothing recorded is UNRESOLVED, not a negative", () => {
  // Without this, an application sent yesterday and one sent six months ago both read "no
  // response", and any rate computed over them is biased toward zero by however much recent
  // activity there is — which is worst exactly when someone first looks at the number.
  const recent = { applied_at: NOW - 3 * DAY };
  const mature = { applied_at: NOW - (MATURITY_DAYS + 1) * DAY };
  assert.equal(responseBucket(recent, { now: NOW }), "unresolved");
  assert.equal(responseBucket(mature, { now: NOW }), "silent");

  // Exactly at the boundary counts as mature — the window is inclusive, and a test pins which.
  assert.equal(responseBucket({ applied_at: NOW - MATURITY_DAYS * DAY }, { now: NOW }), "silent");
  assert.equal(responseBucket({ applied_at: NOW - (MATURITY_DAYS * DAY - 1) }, { now: NOW }), "unresolved");
});

test("an EXPLICIT no-response is a negative immediately — the candidate knows", () => {
  assert.equal(
    responseBucket({ response_outcome: RESPONSE_OUTCOME.NO_RESPONSE, applied_at: NOW - DAY }, { now: NOW }),
    "silent",
    "someone saying they were ghosted does not have to wait out the window");
});

test("an application with no applied_at cannot be aged, so it is unresolved", () => {
  assert.equal(responseBucket({}, { now: NOW }), "unresolved");
  assert.equal(responseBucket({ applied_at: null }, { now: NOW }), "unresolved");
});

// ── Merge semantics: both monotonic properties ───────────────────────────────────────────────────

test("first_response_at is set once and never moved", () => {
  const first = mergeResponse({}, { outcome: RESPONSE_OUTCOME.SCREEN }, { now: NOW });
  assert.equal(first.first_response_at, NOW);

  // A later stage must not restamp it — otherwise "how fast did they reply" silently becomes
  // "when did this row last change".
  const later = mergeResponse(
    { first_response_at: NOW, furthest_stage: RESPONSE_OUTCOME.SCREEN },
    { outcome: RESPONSE_OUTCOME.INTERVIEW },
    { now: NOW + 30 * DAY });
  assert.equal(later.first_response_at, NOW, "the FIRST engagement timestamp is the metric");
});

test("furthest_stage only advances — a later rejection must not erase an interview", () => {
  // The reason furthest_stage exists at all. screen -> interview -> rejected is a common shape, and
  // a single current-state column would leave that row reading `rejected`, indistinguishable from
  // one rejected off the resume alone. The interview is the most informative fact on the row.
  let state = mergeResponse({}, { outcome: RESPONSE_OUTCOME.SCREEN }, { now: NOW });
  assert.equal(state.furthest_stage, RESPONSE_OUTCOME.SCREEN);

  state = mergeResponse(state, { outcome: RESPONSE_OUTCOME.INTERVIEW }, { now: NOW + DAY });
  assert.equal(state.furthest_stage, RESPONSE_OUTCOME.INTERVIEW);

  state = mergeResponse(state, { outcome: RESPONSE_OUTCOME.REJECTED }, { now: NOW + 2 * DAY });
  assert.equal(state.response_outcome, RESPONSE_OUTCOME.REJECTED, "how it ended");
  assert.equal(state.furthest_stage, RESPONSE_OUTCOME.INTERVIEW, "how far it got — must survive");
  assert.equal(state.first_response_at, NOW, "and when they first replied");

  // Going backwards is also refused.
  const back = mergeResponse(
    { furthest_stage: RESPONSE_OUTCOME.OFFER, first_response_at: NOW },
    { outcome: RESPONSE_OUTCOME.SCREEN }, { now: NOW + 5 * DAY });
  assert.equal(back.furthest_stage, RESPONSE_OUTCOME.OFFER);
  assert.ok(STAGE_RANK[RESPONSE_OUTCOME.OFFER] > STAGE_RANK[RESPONSE_OUTCOME.SCREEN]);
});

test("an explicit no-response RETRACTS an earlier recorded response", () => {
  // The one case that must go backwards: the candidate is correcting the record.
  const state = mergeResponse(
    { furthest_stage: RESPONSE_OUTCOME.SCREEN, first_response_at: NOW },
    { outcome: RESPONSE_OUTCOME.NO_RESPONSE }, { now: NOW + DAY });
  assert.equal(state.first_response_at, null);
  assert.equal(state.furthest_stage, null);
  assert.equal(state.response_outcome, RESPONSE_OUTCOME.NO_RESPONSE);
});

test("an unknown outcome is refused rather than stored", () => {
  assert.throws(() => mergeResponse({}, { outcome: "ghosted_maybe" }), /unknown response outcome/);
  // A caller-supplied response time is honoured — outcomes are often recorded days after the email.
  const back = mergeResponse({}, { outcome: RESPONSE_OUTCOME.REJECTED, respondedAt: NOW - 5 * DAY }, { now: NOW });
  assert.equal(back.first_response_at, NOW - 5 * DAY);
});

// ── It is a SEPARATE axis from the run-status vocabulary ─────────────────────────────────────────

test("the employer-response vocabulary does not collide with the run-status one", () => {
  const runStatuses = fs.readFileSync("shared/applyOutcomeGroups.js", "utf8");
  // Submitting and being replied to are different facts; a shared value would let one be read as
  // the other. `submitted` is a run status and must never appear as a response outcome.
  assert.ok(!RESPONSE_OUTCOMES.includes("submitted"));
  assert.ok(!RESPONSE_OUTCOMES.includes("held_review"));
  assert.match(runStatuses, /OUTCOME_STATUSES/, "the run-status partition still stands on its own");
  const src = fs.readFileSync("shared/applicationResponse.js", "utf8");
  assert.match(src, /applyOutcomeGroups\.js/,
    "the distinction between the two axes must be recorded where someone will read it");
});

// ── Migration 095 ────────────────────────────────────────────────────────────────────────────────

test("migration 095 is byte-identical in both runners and only ADDS", () => {
  const grab = (file) => {
    const s = fs.readFileSync(file, "utf8");
    const i = s.indexOf(`id: "095_application_response_outcome"`);
    assert.ok(i > 0, `095 missing from ${file}`);
    return s.slice(lastAt(s, "{", i), at(s, "\n    },", i))
      .replace(/\r\n/g, "\n").replace(/^\s+/gm, "");
  };
  const sql = grab("scripts/migrations.js");
  assert.equal(sql, grab("server.js"));
  assert.doesNotMatch(sql, /\bDROP\b|\bUPDATE\b|\bDELETE\b/i);
  for (const col of ["response_outcome", "furthest_stage", "first_response_at", "outcome_at", "outcome_source"]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${col}`), `095 must add ${col}`);
  }
});

test("the columns exist and default to null on an existing row", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.prepare("INSERT INTO users (id,username,password_hash) VALUES (1,'ada','x')").run();
  // company and role are NOT NULL without a default on this table.
  db.prepare(`INSERT INTO job_applications (user_id, job_id, company, role, applied_at) VALUES (1,'j1','Acme','Engineer',?)`)
    .run(NOW - 100 * DAY);
  const row = db.prepare("SELECT * FROM job_applications WHERE job_id='j1'").get();
  assert.equal(row.response_outcome, null);
  assert.equal(row.first_response_at, null);
  // An old application with nothing recorded is a genuine silence — that is the point of the window.
  assert.equal(responseBucket(row, { now: NOW }), "silent");
  db.close();
});

// ── The correlation endpoint's contract ──────────────────────────────────────────────────────────

test("the correlation query splits by scorer version and never pools across one", () => {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(src, /response-correlation/);
  assert.match(src, /ats_scorer_version/,
    "pooling v3 and v4 scores would produce a confident, meaningless correlation");
  assert.match(src, /sufficient:/, "it must say when there is too little data to conclude anything");
  assert.match(src, /caveats/, "and ship the caveats with the numbers, not in a doc nobody opens");
  assert.match(src, /unresolved/, "unresolved rows must be excluded, not counted as silence");
});

test("the response endpoint is scoped to the caller and rejects an unknown outcome", () => {
  const src = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(src, /app\.patch\("\/api\/apply\/applications\/:jobId\/response", requireAuth/);
  assert.match(src, /!RESPONSE_OUTCOMES\.includes\(outcome\)[\s\S]{0,200}?status\(400\)/,
    "an outcome outside the vocabulary must be refused, not stored");
  assert.match(src, /SELECT \* FROM job_applications WHERE user_id=\? AND job_id=\?[\s\S]{0,400}?status\(404\)/,
    "a job the caller has not applied to must 404 rather than reveal anything");
});

// ── The panel ────────────────────────────────────────────────────────────────────────────────────
//
// These are CONTRACT checks, not rendering checks. What the column actually looks like is verified
// by scripts/ak2ApplicationsOutcomeUi.mjs, which drives the real panel in a real Chrome and clicks
// the picker — and which caught a truncated cell that every string assertion here would have passed
// straight over. What is worth pinning in the node suite is the wiring these tests can actually
// see: that the panel uses the shared vocabulary and the merge endpoint rather than reinventing
// either.

test("the panel records outcomes through the MERGE endpoint, not the generic field PATCH", () => {
  const src = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  assert.match(src, /\/api\/apply\/applications\/\$\{encodeURIComponent\(rowId\)\}\/response/,
    "the merge rules — set-once first_response_at, monotonic furthest_stage — live behind that endpoint");
  // PATCH /api/applications writes whatever field it is handed. Sending a response column through
  // it would bypass every one of those rules.
  assert.doesNotMatch(src, /\/api\/applications\/[^\n]*response_outcome/,
    "response columns must never go through the generic field PATCH");
});

test("the panel reuses the shared response vocabulary rather than hardcoding labels", () => {
  const src = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  assert.match(src, /from "\.\.\/\.\.\/\.\.\/shared\/applicationResponse\.js"/);
  assert.match(src, /RESPONSE_LABELS/, "a cell must not invent its own wording for a stored value");
  assert.match(src, /RESPONSE_OUTCOMES\.map/, "the picker must offer exactly the values the API accepts");
  assert.match(src, /responseBucket\(/,
    "the maturity rule must be imported, not re-derived — a UI copy would get it wrong the same way a naive query does");
});

test("the panel shows the score and the outcome as adjacent columns", () => {
  const src = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  const cols = src.slice(at(src, "const APP_COLS"), at(src, "const RES_COLS"));
  const score = cols.indexOf("ats_score_at_apply");
  const outcome = cols.indexOf("response_outcome");
  assert.ok(score > 0 && outcome > 0, "both columns must exist");
  assert.ok(outcome > score, "the pair reads score-then-outcome");
  // The pair being visible in one row is the entire point; a column that is defined but never
  // rendered would satisfy the two assertions above.
  assert.match(src, /c\.isAtsAtApply/);
  assert.match(src, /c\.isOutcome/);
});

test("the ATS-at-apply cell is NOT colour-banded on the old thresholds", () => {
  // The existing ats_score column paints >=80 green / >=60 amber / else red. Under local_ats_v4 the
  // board runs median 28, max 63, so those bands would render every single row red and read as
  // "every application was bad" when it is only a different scale.
  const src = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  const cell = src.slice(at(src, "if (c.isAtsAtApply)"), at(src, "if (c.isOutcome)"));
  assert.ok(cell.length > 100, "the ats-at-apply renderer must exist");
  // Comments stripped first: the renderer EXPLAINS the old bands in prose, and an assertion that
  // reads prose as code fails on a file that is doing exactly the right thing. What must be absent
  // is a threshold comparison against the value, not a sentence about one.
  const code = cell.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(code, /raw\s*>=\s*\d+/,
    "v3-era colour bands must not be applied to a v4-era score");
  assert.match(cell, /ats_scorer_version/,
    "a score is only comparable to another from the same scorer, so the version must be reachable");
});

test("the summary strip counts unresolved applications separately", () => {
  const src = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  const fn = src.slice(at(src, "function ResponseSummary"), at(src, "function EmptyState"));
  assert.ok(fn.length > 200, "the summary component must exist");
  assert.match(fn, /unresolved/, "too-recent applications must be counted");
  assert.match(fn, /decided = responded \+ silent/,
    "and excluded from the denominator — including them is what makes an early rate read near zero");
  assert.match(fn, /enough/, "the score comparison must be withheld until there is enough data");
});

// ── The routes, actually mounted and driven ──────────────────────────────────────────────────────
//
// Built on the REAL migrations rather than a hand-rolled schema. Eleven fixtures in this suite
// hand-roll job_applications and every one of them had drifted from the real table by the time
// migration 094 landed; a new test has no reason to add a twelfth.

function mount() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.prepare("INSERT INTO users (id,username,password_hash,plan_tier) VALUES (1,'ada','x','PRO')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,plan_tier) VALUES (2,'bob','x','PRO')").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  const noop = async () => ({});
  applyRoutes(app, db, (req, _res, next) => next(), noop, noop, noop, noop);
  const server = app.listen(0);
  return { db, base: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

const seed = (db, { userId = 1, jobId = "j1", score = null, version = null, appliedAt = NOW - 60 * DAY } = {}) =>
  db.prepare(`INSERT INTO job_applications
      (user_id, job_id, company, role, applied_at, ats_score_at_apply, ats_scorer_version)
      VALUES (?,?,?,?,?,?,?)`)
    .run(userId, jobId, "Acme", "Engineer", appliedAt, score, version);

const patch = (base, jobId, body) => fetch(`${base}/api/apply/applications/${jobId}/response`, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("recording an outcome persists it and returns the updated application", async () => {
  const { db, base, stop } = mount();
  try {
    seed(db);
    const res = await patch(base, "j1", { outcome: RESPONSE_OUTCOME.SCREEN });
    assert.equal(res.status, 200);
    const { application } = await res.json();
    assert.equal(application.responseOutcome, RESPONSE_OUTCOME.SCREEN);
    assert.equal(application.furthestStage, RESPONSE_OUTCOME.SCREEN);
    assert.ok(application.firstResponseAt > 0);
    assert.equal(application.responseBucket, "responded");

    // Advance, then reject: the stage survives and the first-response time does not move.
    await patch(base, "j1", { outcome: RESPONSE_OUTCOME.INTERVIEW });
    const after = await (await patch(base, "j1", { outcome: RESPONSE_OUTCOME.REJECTED })).json();
    assert.equal(after.application.responseOutcome, RESPONSE_OUTCOME.REJECTED);
    assert.equal(after.application.furthestStage, RESPONSE_OUTCOME.INTERVIEW);
    assert.equal(after.application.firstResponseAt, application.firstResponseAt);
    assert.equal(after.application.responseBucket, "responded", "a rejection is still a response");
  } finally { stop(); }
});

test("an unknown outcome is 400 and another user's application is 404", async () => {
  const { db, base, stop } = mount();
  try {
    seed(db);
    seed(db, { userId: 2, jobId: "other" });
    const bad = await patch(base, "j1", { outcome: "definitely_maybe" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /unknown outcome/);

    const foreign = await patch(base, "other", { outcome: RESPONSE_OUTCOME.SCREEN });
    assert.equal(foreign.status, 404, "must not be usable to probe another user's history");
    assert.equal(db.prepare("SELECT response_outcome r FROM job_applications WHERE job_id='other'").get().r, null);

    const missing = await patch(base, "never-applied", { outcome: RESPONSE_OUTCOME.SCREEN });
    assert.equal(missing.status, 404, "and an unknown job is indistinguishable from a foreign one");
  } finally { stop(); }
});

test("the correlation endpoint excludes unresolved rows and never pools across scorer versions", async () => {
  const { db, base, stop } = mount();
  try {
    // Two mature responded, two mature silent, all v4.
    seed(db, { jobId: "a", score: 55, version: "local_ats_v4" });
    seed(db, { jobId: "b", score: 48, version: "local_ats_v4" });
    seed(db, { jobId: "c", score: 21, version: "local_ats_v4" });
    seed(db, { jobId: "d", score: 24, version: "local_ats_v4" });
    await patch(base, "a", { outcome: RESPONSE_OUTCOME.SCREEN });
    await patch(base, "b", { outcome: RESPONSE_OUTCOME.REJECTED });
    await patch(base, "c", { outcome: RESPONSE_OUTCOME.NO_RESPONSE });
    await patch(base, "d", { outcome: RESPONSE_OUTCOME.NO_RESPONSE });
    // One v3 row, which must not be pooled with them.
    seed(db, { jobId: "old", score: 62, version: "local_ats_v3" });
    await patch(base, "old", { outcome: RESPONSE_OUTCOME.SCREEN });
    // One recent row with nothing recorded — must be excluded, not counted as silence.
    seed(db, { jobId: "fresh", score: 30, version: "local_ats_v4", appliedAt: Math.floor(Date.now() / 1000) - DAY });

    const body = await (await fetch(`${base}/api/apply/response-correlation`)).json();
    assert.equal(body.totalWithScore, 6);
    assert.equal(body.unresolved, 1, "the day-old application is in no denominator");

    const v4 = body.versions.find(v => v.scorerVersion === "local_ats_v4");
    assert.equal(v4.n, 4);
    assert.equal(v4.responded, 2);
    assert.equal(v4.silent, 2);
    assert.equal(v4.responseRate, 0.5);
    assert.equal(v4.meanScoreResponded, 51.5);
    assert.equal(v4.meanScoreSilent, 22.5);
    assert.equal(v4.scoreDelta, 29, "higher-scoring applications got the replies, in this fixture");
    assert.equal(v4.sufficient, false, "four rows can support no conclusion, and it must say so");

    const v3 = body.versions.find(v => v.scorerVersion === "local_ats_v3");
    assert.equal(v3.n, 1, "v3 is reported separately — the scales are not comparable");
    assert.ok(body.caveats.some(c => /unresolved/.test(c)));
    assert.ok(body.caveats.some(c => /never pooled/.test(c)));
  } finally { stop(); }
});

test("the pair is complete: score in, outcome out, joined on one row", async () => {
  // The whole point of AK1's ground-truth work, asserted end to end.
  const { db, base, stop } = mount();
  try {
    db.prepare("INSERT INTO scraped_jobs (job_id,title,company,search_query,_hash,ats_report) VALUES (?,?,?,?,?,?)")
      .run("j1", "Backend Engineer", "Acme", "t", "h",
        JSON.stringify({ source: "local_ats_v4", score: 57 }));
    await fetch(`${base}/api/apply`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "j1", jobUrl: "https://x.test/j1" }),
    });
    await patch(base, "j1", { outcome: RESPONSE_OUTCOME.INTERVIEW });

    const row = db.prepare("SELECT * FROM job_applications WHERE job_id='j1'").get();
    assert.equal(row.ats_score_at_apply, 57, "the score at the moment of applying");
    assert.equal(row.ats_scorer_version, "local_ats_v4", "and the scorer that produced it");
    assert.equal(row.furthest_stage, RESPONSE_OUTCOME.INTERVIEW, "and what the employer did");
    assert.ok(row.first_response_at > 0);
  } finally { stop(); }
});
