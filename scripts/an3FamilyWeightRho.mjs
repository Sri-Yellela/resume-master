#!/usr/bin/env node
/**
 * AN3 — DOES BUCKETING TERM WEIGHTS BY THE BOARD'S OWN TAXONOMY MOVE RHO?
 * ================================================================================================
 *
 * docs/ATS_TERM_WEIGHTS_SCHEDULE.md §6b found two classifiers answering one question:
 *
 *   roleFamilyForTitle  (services/searchQueryBuilder.js)  bucketed ats_term_weights
 *   classifyJob         (services/jobs/classifyJob.js)    fills job_role_map, and IS the board
 *
 * The narrow one left 44.2% of the enriched corpus with no family, so fewer than
 * MIN_FAMILY_POSTINGS rows landed in most buckets and production wrote only `__global__`. Scoring
 * still worked — loadTermWeights falls back to global by design — but a sales posting was weighted
 * with the whole board's document frequencies rather than sales'.
 *
 * §6b also said the fix "is a measurement task of its own — the weights change, so rho has to be
 * re-measured against the graded corpus before and after". This is that measurement.
 *
 * ⛔ IT DRIVES THE REAL computeTermWeights, NOT A COPY. Both arms call the production function with
 * a different `familyFor`, so the term extraction, the DF floor, the thin-board guard and the
 * weight formula are identical between them and identical to what ships. A harness that
 * reimplements the thing it measures is measuring the reimplementation — this repository has paid
 * for that twice, in the test copy of the extension reachability rules and in the second copy of
 * the board's role taxonomy that this very change exists to remove.
 *
 * ⛔ IT WRITES, SO IT WRITES TO A COPY. The pinned corpus at data/evidence/ is the only surviving
 * record of the 30 graded postings — cleanup_log id 85 destroyed the originals — and rebuilding a
 * weight table is a DELETE plus an INSERT. Every run VACUUMs the corpus into a scratch file and
 * mutates only that. The evidence database is opened read-only and never written.
 *
 * ⛔ THE CONTROL IS THE POINT, same as AL3. Before measuring any change, the CURRENT bucketing is
 * re-scored and checked against the published rho 0.746. A harness whose "before" does not
 * reproduce is measuring something other than the engine, and its "after" means nothing.
 *
 * Usage:
 *   node scripts/an3FamilyWeightRho.mjs
 *   node scripts/an3FamilyWeightRho.mjs --corpus <path>
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";
import {
  loadTermWeights, computeTermWeights, weightFamilyForJob,
  MIN_FAMILY_POSTINGS,
} from "../services/atsTermWeights.js";
import { roleFamilyForTitle } from "../services/searchQueryBuilder.js";
import { loadSimpleApplyProfile } from "../services/simpleApplyProfile.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = { rho: 0.746 };
const CONTROL_TOLERANCE = 0.02;

const val = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};

/**
 * ⚠ data/evidence/ FIRST, and that is not a preference. The 2026-08-31 snapshot was deliberately
 * PINNED there when the graded corpus was exported (docs/am1-ats-graded-corpus.json
 * `provenance.pinned_copy`), and the daily backup it came from has since rotated out of
 * data/backups/ entirely. scripts/al3SynonymRhoEffect.mjs looks only in backups/ and therefore
 * throws "no 2026-08-31 backup found" on a clean checkout today — a live defect, not a
 * hypothetical, and the reason this one checks both.
 */
function defaultCorpus() {
  for (const dir of ["evidence", "backups"]) {
    const d = path.join(ROOT, "data", dir);
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).filter(x => x.includes("2026-08-31") && x.endsWith(".db"))[0];
    if (f) return path.join(d, f);
  }
  throw new Error("the 2026-08-31 graded corpus is in neither data/evidence/ nor data/backups/");
}

/** Spearman rho over ranks, average ranks for ties. Same implementation as AL3's, deliberately. */
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
  const a = rank(xs), b = rank(ys), n = xs.length;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * dbb);
}

function kendallAndMisordered(h, e) {
  let conc = 0, disc = 0, pairs = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = i + 1; j < h.length; j++) {
      const dh = Math.sign(h[i] - h[j]), de = Math.sign(e[i] - e[j]);
      if (dh === 0 || de === 0) continue;
      pairs++;
      if (dh === de) conc++; else disc++;
    }
  }
  return { tau: pairs ? (conc - disc) / pairs : 0, misordered: pairs ? disc / pairs : 0 };
}

// ── THE TWO BUCKETINGS ──────────────────────────────────────────────────────────────────────────
const BUCKETINGS = {
  narrow: {
    label: "roleFamilyForTitle — what shipped before this change",
    familyFor: (_db, job) => roleFamilyForTitle(job.normalized_title || job.title || "") || null,
  },
  board: {
    label: "weightFamilyForJob — job_role_map, the board's own verdict",
    familyFor: weightFamilyForJob,
  },
  union: {
    label: "narrow first, board only where narrow has no answer",
    familyFor: (db, job) => roleFamilyForTitle(job.normalized_title || job.title || "") || weightFamilyForJob(db, job),
  },
  boardWithGeneral: {
    label: "job_role_map including the general bucket",
    familyFor: (db, job) => {
      const r = db.prepare("SELECT role_family, role_key FROM job_role_map WHERE job_id=? LIMIT 1").get(job.job_id);
      return r?.role_family || r?.role_key || null;
    },
  },
};

function scoreAll(db, graded, familyFor) {
  const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=6").get();
  const resumeText = db.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=6").get()?.content;
  if (!resumeText) throw new Error("profile 6's base resume is not in this corpus");
  const signalProfile = loadSimpleApplyProfile(db, { userId: profile.user_id, profileId: profile.id });
  const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });

  const out = [];
  for (const g of graded) {
    const job = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(g.job_id);
    if (!job) { out.push({ ...g, score: null, family: null }); continue; }
    // ⛔ THE SAME FUNCTION THAT BUCKETED, used to look up. Writing weights under one taxonomy and
    // reading them under another is a silent no-op: every lookup misses and falls back to global,
    // which is the state being fixed, wearing the costume of a fix.
    const family = familyFor(db, job);
    const rep = scoreAtsLocally({ job, runtimeBasis, termWeights: loadTermWeights(db, family) });
    out.push({ ...g, score: rep.score, family: family || "(global)" });
  }
  return out;
}

const stats = (rows) => {
  const u = rows.filter(r => Number.isFinite(r.score));
  const h = u.map(r => r.human), e = u.map(r => r.score);
  const { tau, misordered } = kendallAndMisordered(h, e);
  return { n: u.length, rho: spearman(h, e), tau, misordered, rows: u };
};

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const bar = (c = "─") => c.repeat(92);
const srcPath = val("--corpus") || defaultCorpus();
console.log(bar("═"));
console.log("AN3 — per-family term weights: does the board's own taxonomy move rho?");
console.log(bar("═"));
console.log(`corpus: ${path.relative(ROOT, srcPath)}  (read-only; every write goes to a scratch copy)`);

// VACUUM INTO rather than copyFile: the source may have a -wal alongside it, and a byte copy of
// the .db alone silently loses whatever is still in the write-ahead log.
const scratch = path.join(os.tmpdir(), `an3-corpus-${process.pid}.db`);
fs.rmSync(scratch, { force: true });
{
  const ro = new Database(srcPath, { readonly: true });
  ro.prepare("VACUUM INTO ?").run(scratch);
  ro.close();
}

const db = new Database(scratch);
const graded = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "am1-ats-graded-corpus.json"), "utf8"))
  .postings.filter(p => p.human_fit != null)
  .map(p => ({ job_id: p.job_id, human: p.human_fit }));
console.log(`graded set: ${graded.length} postings with a human FIT`);

const results = {};
for (const [key, b] of Object.entries(BUCKETINGS)) {
  const built = computeTermWeights(db, { familyFor: b.familyFor });
  const scored = scoreAll(db, graded, b.familyFor);
  const s = stats(scored);
  results[key] = { ...s, built, label: b.label };

  console.log(`\n${bar()}`);
  console.log(`${key.toUpperCase()} — ${b.label}`);
  console.log(bar());
  const fams = built?.families || [];
  console.log(`  families written (floor ${MIN_FAMILY_POSTINGS}):`);
  for (const f of fams) {
    console.log(`     ${String(f.family).padEnd(18)} ${String(f.weighted).padStart(4)} terms`
      + (f.postings != null ? ` over ${String(f.postings).padStart(4)} postings` : ""));
  }
  const perFamily = scored.reduce((m, r) => (m[r.family] = (m[r.family] || 0) + 1, m), {});
  console.log(`  the graded 30 resolve to: ${Object.entries(perFamily).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  console.log(`  rho ${s.rho.toFixed(4)}   tau-b ${s.tau.toFixed(4)}   mis-ordered ${(s.misordered * 100).toFixed(1)}%   n=${s.n}`);
}

console.log(`\n${bar("═")}`);
const drift = Math.abs(results.narrow.rho - PUBLISHED.rho);
if (drift <= CONTROL_TOLERANCE) {
  console.log(`CONTROL OK — the previous bucketing reproduces the published rho ${PUBLISHED.rho} (drift ${drift.toFixed(3)}).`);
} else {
  console.log(`⛔ CONTROL FAILED — previous bucketing gives ${results.narrow.rho.toFixed(4)} against a published `
    + `${PUBLISHED.rho} (drift ${drift.toFixed(3)} > ${CONTROL_TOLERANCE}). The "after" below means nothing.`);
}
const d = results.board.rho - results.narrow.rho;
console.log(bar("═"));
console.log(`rho ${d >= 0 ? "+" : ""}${d.toFixed(4)}   (${results.narrow.rho.toFixed(4)} -> ${results.board.rho.toFixed(4)})`);

// Per-posting movement, so a flat rho is not read as "nothing happened".
const byId = new Map(results.narrow.rows.map(r => [r.job_id, r]));
const moved = results.board.rows.filter(r => byId.get(r.job_id)?.score !== r.score);
console.log(`scores that moved: ${moved.length} of ${results.board.rows.length}`);
for (const r of moved) {
  const before = byId.get(r.job_id);
  console.log(`   ${String(before.score).padStart(3)} -> ${String(r.score).padStart(3)}  (human ${r.human})`
    + `  family ${before.family} -> ${r.family}`);
}

db.close();
fs.rmSync(scratch, { force: true });
console.log(`\n${bar("═")}`);
console.log("scratch copy removed; the pinned corpus was never written to.");
