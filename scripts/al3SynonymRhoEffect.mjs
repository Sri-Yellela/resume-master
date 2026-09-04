#!/usr/bin/env node
/**
 * AL3 (G1 requirement 5) — DOES THE SYNONYM TABLE MOVE RHO?
 *
 * "If rho does not move, the table is not earning its keep — say so." So this measures it, on the
 * owner's human-graded 30, and prints the answer whichever way it falls.
 *
 * ── THE CONTROL IS THE POINT ───────────────────────────────────────────────────────────────────
 *
 * It re-scores the graded set with NO synonyms first and checks that against the PUBLISHED figure
 * (ρ = 0.746, τ-b = 0.594, 12.2% mis-ordered — shared/atsBands.js). If the control does not
 * reproduce, the harness is measuring something other than the engine and its "after" number means
 * nothing. A before/after where only the "after" is trusted is not a measurement.
 *
 * ── IT READS A BACKUP, AND IT HAS TO ───────────────────────────────────────────────────────────
 *
 * ⛔ THE GRADED POSTINGS ARE NOT ON THE LIVE BOARD ANY MORE. `cleanup_log` id 85 deleted 1288 rows
 * from scraped_jobs on 2026-09-02; 0 of the 30 survive, and the live table holds 5 fixtures. The
 * JD text is what the scorer reads, so without it the graded set cannot be re-scored at all and
 * this measurement is simply impossible against the live database.
 *
 * data/backups/resume_master_2026-08-31...db is the snapshot the grading was actually done against
 * (1261 active, 1259 with skills_json, all 30 graded postings, profile 6 with its 4912-char
 * résumé). It is opened READ-ONLY. Nothing here writes anything.
 *
 * Usage:
 *   node scripts/al3SynonymRhoEffect.mjs [--corpus <path>] [--all-proposed]
 *
 *   --all-proposed   also score with EVERY proposed pair active, confirmed or not. This is the
 *                    ceiling-and-risk view, not a recommendation: the proposals demonstrably
 *                    include false pairs (mysql ~ postgresql), which is why review is mandatory.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAtsLocally, buildRuntimeAtsBasis } from "../services/localAtsScorer.js";
import { loadTermWeights } from "../services/atsTermWeights.js";
import { roleFamilyForTitle } from "../services/searchQueryBuilder.js";
// loadSimpleApplyProfile, NOT loadOrCreate — the corpus is opened read-only and the
// "create" half writes a row when none exists, which turns a measurement into an attempted
// mutation of the evidence.
import { loadSimpleApplyProfile } from "../services/simpleApplyProfile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

// ── The published control. From shared/atsBands.js; if these move, that file moved with them. ──
const PUBLISHED = { rho: 0.746, tau: 0.594, misordered: 0.122 };
const CONTROL_TOLERANCE = 0.02;

function defaultCorpus() {
  const dir = path.join(ROOT, "data", "backups");
  const f = fs.readdirSync(dir).filter(x => x.includes("2026-08-31") && x.endsWith(".db"))[0];
  if (!f) throw new Error("no 2026-08-31 backup found — the graded corpus is unavailable");
  return path.join(dir, f);
}

/** Spearman ρ over ranks, average ranks for ties. */
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

/** Kendall τ-b, and the share of comparable pairs the engine puts in the wrong order. */
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
  const tau = (concordant - discordant) /
              Math.sqrt((n0 - tiedX) * (n0 - tiedY) || 1);
  return { tau, misordered: comparable ? discordant / comparable : 0 };
}

/** The human grades live in the markdown sheet; the job_ids in the JSON key. Joined on `n`. */
function gradedSet() {
  const key = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "ak2-ats-grading-key.json"), "utf8"));
  const md = fs.readFileSync(path.join(ROOT, "docs", "ak2-ats-grading-set.md"), "utf8");
  const fits = new Map();
  for (const m of md.matchAll(/^\|\s*(\d+)\s*\|\s*([1-5])\s*\|/gm)) fits.set(Number(m[1]), Number(m[2]));
  return key.postings
    .map(p => ({ ...p, human: fits.get(p.n) }))
    .filter(p => Number.isFinite(p.human));
}

function loadSynonyms(db, { includeProposed = false } = {}) {
  const where = includeProposed ? "status IN ('confirmed','proposed')" : "status='confirmed'";
  const map = new Map();
  let rows = [];
  try { rows = db.prepare(`SELECT term, equivalent FROM skill_synonyms WHERE ${where}`).all(); } catch { return map; }
  const add = (a, b) => { let l = map.get(a); if (!l) { l = []; map.set(a, l); } if (!l.includes(b)) l.push(b); };
  for (const r of rows) { add(r.term, r.equivalent); add(r.equivalent, r.term); }
  return map;
}

function scoreAll(corpus, graded, synonyms) {
  const profile = corpus.prepare("SELECT * FROM domain_profiles WHERE id=6").get();
  const resumeText = corpus.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=6").get()?.content;
  if (!resumeText) throw new Error("profile 6's base resume is not in this corpus");
  const signalProfile = loadSimpleApplyProfile(corpus, { userId: profile.user_id, profileId: profile.id });
  const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });

  const out = [];
  for (const g of graded) {
    const job = corpus.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(g.job_id);
    if (!job) { out.push({ ...g, score: null }); continue; }
    const weights = loadTermWeights(corpus, roleFamilyForTitle(job.title));
    const rep = scoreAtsLocally({ job, runtimeBasis, termWeights: weights, synonyms });
    out.push({ ...g, score: rep.score });
  }
  return out;
}

function stats(rows) {
  const usable = rows.filter(r => Number.isFinite(r.score));
  const human = usable.map(r => r.human);
  const engine = usable.map(r => r.score);
  const { tau, misordered } = kendallAndMisordered(human, engine);
  return { n: usable.length, rho: spearman(human, engine), tau, misordered, rows: usable };
}

// ── run ─────────────────────────────────────────────────────────────────────
const corpusPath = val("--corpus") || defaultCorpus();
console.log(`corpus: ${path.relative(ROOT, corpusPath)} (read-only)`);
const corpus = new Database(corpusPath, { readonly: true });
const live = new Database(path.join(ROOT, "data", "resume_master.db"), { readonly: true });

const graded = gradedSet();
console.log(`graded set: ${graded.length} postings with a human FIT\n`);

const confirmed = loadSynonyms(live);
console.log(`synonym table: ${confirmed.size} terms with confirmed equivalents\n`);

const before = stats(scoreAll(corpus, graded, null));
const after = stats(scoreAll(corpus, graded, confirmed));

const line = (label, s) =>
  `  ${label.padEnd(22)} rho ${s.rho.toFixed(3)}   tau-b ${s.tau.toFixed(3)}   mis-ordered ${(s.misordered * 100).toFixed(1)}%   n=${s.n}`;

console.log("─".repeat(84));
console.log(line("BEFORE (no synonyms)", before));
console.log(line("AFTER  (confirmed)", after));

// ⛔ THE CONTROL. If the no-synonym run does not reproduce the published number, this harness is
// measuring something other than the shipped engine and the "after" figure is worthless.
const drift = Math.abs(before.rho - PUBLISHED.rho);
console.log("─".repeat(84));
if (drift <= CONTROL_TOLERANCE) {
  console.log(`CONTROL OK — the no-synonym run reproduces the published rho ${PUBLISHED.rho} (drift ${drift.toFixed(3)}).`);
} else {
  console.log(
    `⛔ CONTROL FAILED — no-synonym rho is ${before.rho.toFixed(3)}, published is ${PUBLISHED.rho} ` +
    `(drift ${drift.toFixed(3)}).\n` +
    `   This harness is not reproducing the shipped engine, so the AFTER number below means nothing.\n` +
    `   Do not report a delta from this run.`
  );
}

const delta = after.rho - before.rho;
console.log("─".repeat(84));
if (confirmed.size === 0) {
  console.log("NO CONFIRMED SYNONYMS — nothing was applied, so BEFORE and AFTER are the same run.");
  console.log("That is the correct state until a human has reviewed the proposals:");
  console.log("  node scripts/al3SkillSynonyms.mjs --review");
} else if (Math.abs(delta) < 0.001) {
  console.log(`rho did not move (${delta >= 0 ? "+" : ""}${delta.toFixed(3)}). THE TABLE IS NOT EARNING ITS KEEP —`);
  console.log("report that rather than keeping it because it was built.");
} else {
  console.log(`rho ${before.rho.toFixed(3)} -> ${after.rho.toFixed(3)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`);
  const changed = after.rows.filter((r, i) => r.score !== before.rows[i]?.score);
  console.log(`${changed.length} of ${after.n} postings changed score:`);
  for (const r of changed) {
    const b = before.rows.find(x => x.job_id === r.job_id);
    console.log(`  ${String(r.n).padStart(2)}  human ${r.human}  ${b.score} -> ${r.score}   ${r.company} — ${r.title.slice(0, 52)}`);
  }
}

// ── WHY IT DID OR DID NOT MOVE ──────────────────────────────────────────────
//
// A null result with no explanation is a dead end: the next session re-runs the extraction and
// gets the same nothing. This asks the direct question — of the terms the graded postings ask for
// and the résumé does NOT contain, how many does the proposed table have ANY equivalent for? If
// that number is near zero, the table cannot move rho no matter how good its pairs are, and the
// problem is the VOCABULARY it was mined from, not the review threshold.
{
  const all = loadSynonyms(live, { includeProposed: true });
  const profile = corpus.prepare("SELECT * FROM domain_profiles WHERE id=6").get();
  const resumeText = corpus.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=6").get()?.content || "";
  const resumeLower = resumeText.toLowerCase();
  let missingTotal = 0, covered = 0;
  const examples = [];
  for (const g of graded) {
    const job = corpus.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(g.job_id);
    if (!job) continue;
    const signalProfile = loadSimpleApplyProfile(corpus, { userId: profile.user_id, profileId: profile.id });
    const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });
    const rep = scoreAtsLocally({ job, runtimeBasis, termWeights: loadTermWeights(corpus, roleFamilyForTitle(job.title)) });
    for (const t of rep.tier1_missing || []) {
      missingTotal++;
      const eqs = all.get(String(t).toLowerCase()) || [];
      const hit = eqs.find(e => resumeLower.includes(e));
      if (hit) { covered++; if (examples.length < 12) examples.push(`${t} -> ${hit}`); }
    }
  }
  console.log("─".repeat(84));
  console.log(`COVERAGE: of ${missingTotal} missing terms across the graded 30, the proposed table`);
  console.log(`has an equivalent PRESENT IN THE RESUME for ${covered} (${((covered / (missingTotal || 1)) * 100).toFixed(1)}%).`);
  if (examples.length) examples.forEach(e => console.log(`   ${e}`));
  else console.log("   (none — the table cannot move this measurement whatever its quality)");
}

if (args.includes("--all-proposed")) {
  const all = loadSynonyms(live, { includeProposed: true });
  const hypothetical = stats(scoreAll(corpus, graded, all));
  console.log("─".repeat(84));
  console.log(line("ALL PROPOSED (unsafe)", hypothetical));
  console.log(
    `\n⚠ NOT A RECOMMENDATION. This includes every unreviewed pair, and the proposals demonstrably\n` +
    `  contain false equivalences — mysql ~ postgresql (competing databases, which the prompt\n` +
    `  explicitly forbade), ci cd ~ production debugging, data engineering ~ data visualization.\n` +
    `  It is shown to size the ceiling AND the risk, not to be adopted.`
  );
}

corpus.close();
live.close();
