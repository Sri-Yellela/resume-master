// G2 — human-reviewed identity resolutions for LCA company matching.
//
// ⛔ WHAT A WRONG ROW HERE DOES: it tells a job seeker that a company sponsors H-1B visas when the
// filings belong to a similarly-named company. That is a FALSE ATTESTATION ABOUT A THIRD PARTY —
// worse than a wrong score, because it is a factual claim about someone who is not the user, cannot
// see it, and cannot correct it.
//
// The corpus really does contain "Linear Labs LLC" (electric motors, 17 certified) sitting next to
// our Linear, and "Mercury Insurance Services, LLC" (89 certified) next to our Mercury. lcaMatch.js
// declines all of them on purpose. These tests exist so that the resolution path cannot quietly
// become the thing that undoes that.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  matchCompanyToEntities, buildEntityIndex, companyMatchKey, parseDbaNames,
  TIER_CONFIDENCE, PRESENTABLE_MIN_CONFIDENCE, HIGH_CONFIDENCE,
} from "../services/kb/lcaMatch.js";
import {
  recordResolutionProposal, loadConfirmedResolutions, confirmResolution, rejectResolution,
  resolutionStats, RESOLUTION_CONFIDENCE,
} from "../services/kb/lcaResolution.js";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lca_company_resolutions (
      company TEXT NOT NULL PRIMARY KEY, resolved_employer_name TEXT, resolved_match_key TEXT,
      candidates_json TEXT, model_confidence REAL, model_reason TEXT,
      status TEXT NOT NULL DEFAULT 'proposed', reviewed_at INTEGER, reviewed_by TEXT,
      proposed_at INTEGER, updated_at INTEGER
    );
  `);
  return db;
}

/**
 * Built through buildEntityIndex, not hand-shaped. The index is what the matcher actually consumes
 * (keys, dba keys, FEIN grouping), and a hand-written object silently misses all of that — the
 * first version of this file did exactly that and every matcher assertion failed for a reason that
 * had nothing to do with resolutions.
 *
 * Real names from the corpus: two Ramps that genuinely collide, plus Stripe for the override test.
 */
const index = (rows) => buildEntityIndex(rows.map(e => ({
  ...e,
  employer_key: companyMatchKey(e.employer_name),
  dba_keys_json: JSON.stringify(parseDbaNames(e.employer_name)),
})));

const RAMP_ENTITIES = index([
  { employer_name: "Ramp Business Corporation", fein: "83-2508297", state: "NY" },
  { employer_name: "Ramp Systems, Inc.",        fein: "11-1111111", state: "CA" },
]);

// ── TIER R SITS WHERE IT DOES FOR A REASON ──────────────────────────────────────────────────────

test("tier R is presentable but NOT high-confidence", () => {
  // Every other tier's confidence is the measured ambiguity of a rule applied to the filing data.
  // R is the only one whose evidence is NOT IN THE DATA — it rests on a person knowing that Ramp
  // the fintech is registered as "Ramp Business Corporation". So it must render with the entity
  // NAMED rather than as a bare count: above the presentable floor, below the high line.
  assert.equal(TIER_CONFIDENCE.R, RESOLUTION_CONFIDENCE);
  assert.ok(TIER_CONFIDENCE.R > PRESENTABLE_MIN_CONFIDENCE,
    "a confirmed resolution the owner vouched for must be showable at all");
  assert.ok(TIER_CONFIDENCE.R < HIGH_CONFIDENCE,
    "a claim resting on outside knowledge must show its working — never bare prose with a count");
  assert.ok(TIER_CONFIDENCE.R < TIER_CONFIDENCE.A,
    "and it must never outrank an exact legal-name match found IN the data");
});

// ── THE MATCHER ─────────────────────────────────────────────────────────────────────────────────

test("without a resolution, an ambiguous company stays ambiguous", () => {
  const m = matchCompanyToEntities("Ramp", RAMP_ENTITIES);
  assert.equal(m.status, "ambiguous");
});

test("a confirmed resolution upgrades it to tier R, naming the entity", () => {
  const m = matchCompanyToEntities("Ramp", RAMP_ENTITIES, {
    employerName: "Ramp Business Corporation", matchKey: "ramp business corporation", reviewedBy: "owner",
  });
  assert.equal(m.status, "matched");
  assert.equal(m.tier, "R");
  assert.equal(m.confidence, TIER_CONFIDENCE.R);
  assert.deepEqual(m.entities.map(e => e.employerName), ["Ramp Business Corporation"],
    "ONLY the resolved entity — the other Ramp must not be summed into the total");
  assert.match(m.reason, /reviewed identity resolution by owner/);
});

test("⛔ a resolution NEVER overrides a match found in the data", () => {
  // Tiers A/B/C are evidence in the source; R is outside knowledge. Where the data already answers,
  // the data wins — otherwise one review mistake silently replaces the strongest evidence there is.
  const exact = index([{ employer_name: "Stripe, Inc.", fein: "47-1849232", state: "CA" }]);
  const m = matchCompanyToEntities("Stripe", exact, {
    employerName: "Stripe, Inc.", matchKey: "stripe inc", reviewedBy: "owner",
  });
  assert.equal(m.tier, "A", "an exact legal-name match must not be downgraded to a reviewed one");
  assert.equal(m.confidence, TIER_CONFIDENCE.A);
});

test("⛔ a resolution naming an entity that is not in the corpus is NOT applied", () => {
  // A name typed by a reviewer that matches no employer would otherwise become a sponsorship claim
  // backed by zero filings — the exact failure the whole module exists to prevent, arriving through
  // the review step instead of the matcher.
  const m = matchCompanyToEntities("Ramp", RAMP_ENTITIES, {
    employerName: "Ramp Holdings International LLC", matchKey: "ramp holdings international", reviewedBy: "owner",
  });
  assert.equal(m.status, "ambiguous", "it must stay declined");
  assert.match(m.reason, /not in the LCA corpus — not applied/);
});

test("a confirmed NULL resolution records the DECISION and keeps the company declined", () => {
  // Linear. The corpus holds "Linear Labs LLC", an electric-motor company; Linear.app has never
  // filed. "None of these" is the correct answer, and recording it is what stops a later pass
  // re-proposing the wrong entity. The status must NOT change — but the reason must show a human
  // looked, because "declined because nobody checked" and "declined because someone checked" are
  // different facts.
  const m = matchCompanyToEntities("Linear", RAMP_ENTITIES, {
    employerName: null, matchKey: null, reviewedBy: "owner",
  });
  assert.notEqual(m.status, "matched");
  assert.match(m.reason, /reviewed by owner: none of the candidates is this company/);
});

// ── PROPOSALS NEVER REACH THE MATCHER ───────────────────────────────────────────────────────────

test("a proposal is invisible until confirmed", () => {
  const db = makeDb();
  recordResolutionProposal(db, { company: "Ramp", resolvedEmployerName: "Ramp Business Corporation" });
  assert.equal(loadConfirmedResolutions(db).size, 0, "proposed is not confirmed");
  confirmResolution(db, "Ramp", "owner");
  assert.equal(loadConfirmedResolutions(db).get("Ramp").employerName, "Ramp Business Corporation");
  db.close();
});

test("a reviewed decision outranks every later proposal, including a rejection", () => {
  const db = makeDb();
  recordResolutionProposal(db, { company: "Linear", resolvedEmployerName: null });
  rejectResolution(db, "Linear", "owner");
  // A later pass proposes the electric-motor company. It must not reopen the question.
  const accepted = recordResolutionProposal(db, { company: "Linear", resolvedEmployerName: "Linear Labs LLC" });
  assert.equal(accepted, false);
  const row = db.prepare("SELECT * FROM lca_company_resolutions WHERE company='Linear'").get();
  assert.equal(row.status, "rejected");
  assert.equal(row.resolved_employer_name, null, "and the rejected proposal's content is untouched");
  db.close();
});

test("a confirmed NULL is loadable — a decided negative is not the same as no decision", () => {
  const db = makeDb();
  recordResolutionProposal(db, { company: "Linear", resolvedEmployerName: null });
  confirmResolution(db, "Linear", "owner");
  const r = loadConfirmedResolutions(db).get("Linear");
  assert.ok(r, "the row must be present…");
  assert.equal(r.employerName, null, "…with a null employer, which the matcher reads as a decision");
  assert.deepEqual(resolutionStats(db), { proposed: 0, confirmed: 1, rejected: 0 });
  db.close();
});

test("an absent table degrades to 'no resolutions' rather than throwing", () => {
  const db = new Database(":memory:");
  assert.equal(loadConfirmedResolutions(db).size, 0);
  db.close();
});

// ── THE INTEGRITY LINE IS UNTOUCHED (requirement 3) ─────────────────────────────────────────────

test("the posting-level sponsorship signal is a DIFFERENT column and was not touched", () => {
  // "This company filed 47 H-1B petitions" is evidence about the EMPLOYER. is_h1b_sponsor is a
  // claim about THIS ROLE. Two facts, two columns, and G2 must not have blurred them — the
  // company-level resolution has no business changing what a posting says about itself.
  const layer = fs.readFileSync("services/kb/lcaLayer.js", "utf8");
  const resolution = fs.readFileSync("services/kb/lcaResolution.js", "utf8");
  assert.ok(!/is_h1b_sponsor/.test(resolution),
    "the resolution module must not reference the posting-level column at all");
  assert.ok(!/UPDATE\s+scraped_jobs/i.test(layer + resolution),
    "nothing in the company-level path may write a posting's own visa signal");
});

test("the resolution module makes no model call", () => {
  // The model proposes in scripts/al4LcaResolution.mjs, offline and by hand. A call inside the KB
  // layer would put a model on the read path for a sponsorship claim.
  const src = fs.readFileSync("services/kb/lcaResolution.js", "utf8");
  assert.ok(!/callModel|messages\.create|fetch\s*\(/.test(src));
});

test("the proposal script never asks about a company with no candidates", () => {
  // An unmatched company has ZERO candidate employers out of 144,584. There is nothing to resolve
  // to, so the only answer a model could give is an invented one — and an invented match here is a
  // sponsorship claim about a company that has never filed.
  const src = fs.readFileSync("scripts/al4LcaResolution.mjs", "utf8");
  assert.match(src, /rows\.filter\(r => r\.match_status === "ambiguous"\)/);
  assert.match(src, /no candidate entities exist, so there is nothing to resolve/);
});

test("the prompt offers 'none' and names the two real traps", () => {
  const src = fs.readFileSync("scripts/al4LcaResolution.mjs", "utf8");
  assert.match(src, /"none" is a REAL and often CORRECT answer/);
  assert.match(src, /Linear Labs LLC" makes electric\s*\n?\s*motors/,
    "the prompt must name the actual trap, not describe it abstractly");
  assert.match(src, /Mercury Insurance Services" is not the fintech/);
});
