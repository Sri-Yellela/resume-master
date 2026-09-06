#!/usr/bin/env node
/**
 * AM1 / task R1 requirement 3 — DOES rho = 0.746 STILL REPRODUCE?
 *
 * ⛔ THE POINT IS THE SOURCE IT READS. scripts/al3SynonymRhoEffect.mjs already measures rho, but it
 * opens `data/backups/resume_master_2026-08-31...db` — a 110 MB untracked file that survives
 * exactly one more auto-daily backup (measured by am1PreserveGradedCorpus.mjs, from the real
 * selectRetained policy). A measurement that depends on a file retention is free to delete is the
 * same defect as the guard R3 was about: correctness resting on mutable data.
 *
 * So this reads `docs/am1-ats-graded-corpus.json` — COMMITTED, 30 postings, full description text —
 * and re-scores from that. If it reproduces the published figure, the fixture has genuinely replaced
 * the backup for this purpose and the backup can be lost without losing the measurement.
 *
 * ── WHAT IT CANNOT PROVE ───────────────────────────────────────────────────────────────────────
 *
 * The fixture is not self-sufficient and does not claim to be. Scoring also needs profile 6, its
 * base résumé and ats_term_weights, all of which are read from the LIVE database. They survived
 * cleanup_log id 85 because they are not scraped_jobs rows — but ats_term_weights is DERIVED from
 * the board, so a re-derivation against the current 5 fixtures would destroy it and this
 * measurement with it. That is exactly what task R2 requirement 6 forbids, and this script reports
 * the term-weight count so the erosion would be visible here first.
 *
 * ── TWO SEPARATE CHECKS, and they can fail independently ───────────────────────────────────────
 *
 *   A. PER-POSTING. Does today's engine give each posting the same score the grading key recorded?
 *      A drift here means the ENGINE changed since 2026-08-31, not that the fixture is wrong.
 *   B. AGGREGATE. Does rho over (human FIT, freshly computed score) match the published 0.746?
 *
 * A can fail while B holds — the engine can move every score and preserve the ordering. Reporting
 * only B would hide that. Both are printed either way.
 *
 * Usage: node scripts/am1GradedCorpusVerify.mjs [--db <path>]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";
import { loadTermWeights } from "../services/atsTermWeights.js";
import { roleFamilyForTitle } from "../services/searchQueryBuilder.js";
// loadSimpleApplyProfile, NOT loadOrCreate — the "create" half writes a row when none exists, which
// turns a measurement into a mutation. Same reasoning as al3SynonymRhoEffect.mjs.
import { loadSimpleApplyProfile } from "../services/simpleApplyProfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

const FIXTURE = path.join(ROOT, "docs", "am1-ats-graded-corpus.json");
const TOLERANCE = 0.02;

/** Spearman rho over ranks, average ranks for ties. */
function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/** Kendall tau-b, and the share of comparable pairs the engine puts in the wrong order. */
function kendallAndMisordered(xs, ys) {
  let concordant = 0, discordant = 0, tiedX = 0, tiedY = 0, comparable = 0;
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const a = Math.sign(xs[i] - xs[j]);
      const b = Math.sign(ys[i] - ys[j]);
      if (a === 0 && b === 0) continue;
      if (a === 0) { tiedX++; continue; }
      if (b === 0) { tiedY++; continue; }
      comparable++;
      if (a === b) concordant++; else discordant++;
    }
  }
  const n0 = concordant + discordant + tiedX + tiedY;
  return {
    tau: (concordant - discordant) / Math.sqrt((n0 - tiedX) * (n0 - tiedY) || 1),
    misordered: comparable ? discordant / comparable : 0,
  };
}

// ── load ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(FIXTURE)) {
  console.error("⛔ " + path.relative(ROOT, FIXTURE) + " is missing.");
  console.error("   Run: node scripts/am1PreserveGradedCorpus.mjs");
  process.exit(2);
}
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const dbPath = val("--db") || path.join(ROOT, "data", "resume_master.db");
const db = new Database(dbPath, { readonly: true });

console.log("─".repeat(94));
console.log("R1.3 — re-score the graded 30 FROM THE COMMITTED FIXTURE");
console.log("─".repeat(94));
console.log("fixture         " + path.relative(ROOT, FIXTURE) + "  (" + fixture.postings.length + " postings, " + fixture.schema + ")");
console.log("scoring inputs  " + path.relative(ROOT, dbPath) + "  (read-only)");

const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(fixture.provenance.profile_id);
const resumeText = db.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=?")
  .get(fixture.provenance.profile_id)?.content;
const termWeightCount = db.prepare("SELECT COUNT(*) c FROM ats_term_weights").get().c;
const boardSize = db.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c;

// ⛔ FAIL LOUDLY RATHER THAN SCORING AGAINST NOTHING. An absent résumé or an empty weight table
// would still produce a number here — a wrong one — and a silently wrong rho is worse than no rho.
if (!profile) { console.error("⛔ domain_profiles id " + fixture.provenance.profile_id + " is not in this database. Cannot score."); process.exit(3); }
if (!resumeText) { console.error("⛔ profile " + fixture.provenance.profile_id + " has no base résumé in this database. Cannot score."); process.exit(3); }
console.log("profile         id " + profile.id + ", résumé " + resumeText.length + " chars " +
            "(key recorded " + fixture.provenance.resume_chars + ")");
console.log("term weights    " + termWeightCount + " rows" +
            (termWeightCount < 100 ? "   ⛔ THIN — the weights have been re-derived or purged; scores below are not comparable" : ""));
console.log("live board      " + boardSize + " postings" +
            (boardSize < 200 ? "   (purged — which is why this reads the fixture and not scraped_jobs)" : ""));

if (resumeText.length !== fixture.provenance.resume_chars) {
  console.log("⚠  THE RÉSUMÉ HAS CHANGED since grading (" + fixture.provenance.resume_chars + " -> " +
              resumeText.length + " chars). Scores are expected to move; the published figure was");
  console.log("   measured against the old text and any mismatch below may be this, not a defect.");
}

// ── score ───────────────────────────────────────────────────────────────────
const signalProfile = loadSimpleApplyProfile(db, { userId: profile.user_id, profileId: profile.id });
const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });

const rows = [];
for (const p of fixture.postings) {
  if (!Number.isFinite(p.human_fit)) continue;
  const weights = loadTermWeights(db, roleFamilyForTitle(p.title));
  // The fixture object IS the job row as far as the scorer is concerned — it carries every column
  // scoreAtsLocally reads. That equivalence is what makes the fixture a replacement for the table.
  const rep = scoreAtsLocally({ job: p, runtimeBasis, termWeights: weights, synonyms: null });
  rows.push({ ...p, fresh: rep.score });
}

// ── A. per-posting drift vs the recorded engine score ───────────────────────
const drifted = rows.filter(r => r.fresh !== r.engine_score);
console.log("─".repeat(94));
console.log("A. PER-POSTING — today's engine vs the score recorded in the grading key");
if (!drifted.length) {
  console.log("   ✓ all " + rows.length + " scores identical. The engine has not moved since 2026-08-31.");
} else {
  const maxDrift = Math.max(...drifted.map(r => Math.abs(r.fresh - r.engine_score)));
  console.log("   " + drifted.length + " of " + rows.length + " postings score differently (max |delta| " + maxDrift + "):");
  for (const r of drifted.slice(0, 12)) {
    console.log("     " + String(r.n).padStart(2) + "  human " + r.human_fit + "   " +
                String(r.engine_score).padStart(3) + " -> " + String(r.fresh).padStart(3) + "   " +
                r.company + " — " + String(r.title).slice(0, 46));
  }
  if (drifted.length > 12) console.log("     … " + (drifted.length - 12) + " more");
  console.log("   This is an ENGINE change, not a fixture problem — the fixture stores text, not scores.");
}

// ── B. aggregate vs the published figure ────────────────────────────────────
const human = rows.map(r => r.human_fit);
const engine = rows.map(r => r.fresh);
const rho = spearman(human, engine);
const { tau, misordered } = kendallAndMisordered(human, engine);
const pub = fixture.published;

console.log("─".repeat(94));
console.log("B. AGGREGATE — rank agreement between the human FIT and the engine");
console.log("   published   rho " + pub.rho.toFixed(3) + "   tau-b " + pub.tau.toFixed(3) +
            "   mis-ordered " + (pub.misordered * 100).toFixed(1) + "%");
console.log("   from fixture rho " + rho.toFixed(3) + "   tau-b " + tau.toFixed(3) +
            "   mis-ordered " + (misordered * 100).toFixed(1) + "%   n=" + rows.length);

const drift = Math.abs(rho - pub.rho);
console.log("─".repeat(94));
let exit = 0;
if (drift <= TOLERANCE) {
  console.log("✓ REPRODUCED — rho = " + rho.toFixed(3) + " against the published " + pub.rho +
              " (drift " + drift.toFixed(3) + ", tolerance " + TOLERANCE + ").");
  console.log("  docs/am1-ats-graded-corpus.json is now sufficient to reproduce the ATS engine's only");
  console.log("  human-graded validation. The 110 MB backup is no longer the sole copy of that evidence.");
} else {
  // ⛔ A FAILURE HERE IS A FINDING, NOT A BUG TO BE SMOOTHED (task R1, requirement 3).
  exit = 1;
  console.log("⛔ DID NOT REPRODUCE — rho = " + rho.toFixed(3) + ", published " + pub.rho +
              " (drift " + drift.toFixed(3) + " > " + TOLERANCE + ").");
  console.log("  Report this as measured. The published figure was taken against a board that no longer");
  console.log("  exists; if it cannot be reproduced from the preserved text, then every band cutpoint in");
  console.log("  shared/atsBands.js rests on a number nothing can now check.");
}
console.log("─".repeat(94));
process.exit(exit);
