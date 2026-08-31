#!/usr/bin/env node
// AK2 task 4 — draw the evaluation set the band thresholds must be judged against.
//
// WHY THIS SCRIPT EXISTS RATHER THAN A LIST IN A DOC.
// AK1 Phase 3 states its 30 postings were "pinned by title+company, not re-drawn per run", and
// gives the reason: an earlier version re-drew the stratified sample after each scorer change,
// silently re-selecting different postings and making two runs incomparable. That reasoning is
// right and the set was still never committed — the only fixtures in the repo are four synthetic
// jobs in test/atsRankingHonesty.test.js. So AK1's 30 are unrecoverable and its ρ cannot be
// reproduced or re-joined against a human pass. This time the set is written to disk, and the
// generator that drew it is here beside it.
//
// STRATIFIED, THEN SHUFFLED, AND THE SCORE IS WITHHELD FROM THE SHEET. The grader must not see the
// engine's answer before recording their own — that is the entire point of the exercise, and a
// sheet ordered by score would leak it even with the number removed. The scores go to the answer
// key, which is a separate file.
//
//   node scripts/ak2AtsGradingSet.mjs [--db data/resume_master.db] [--profile <id>] [--n 30]
//
// Excluded from verify:harness (it writes files and asserts nothing) — see verifyHarnesses.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { buildRuntimeAtsBasis, scoreAtsLocally, LOCAL_ATS_SOURCE } from '../services/localAtsScorer.js';
import { loadTermWeights } from '../services/atsTermWeights.js';
import { loadOrCreateSimpleApplyProfile } from '../services/simpleApplyProfile.js';
import { roleFamilyForTitle } from '../services/searchQueryBuilder.js';

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : process.argv[i + 1];
};
const DB_PATH = arg('--db', 'data/resume_master.db');
const WANT = Number(arg('--n', '30'));
const PROFILE_ARG = arg('--profile', null);

// WORKS ON A COPY, AND OPENS IT WRITABLE.
// loadOrCreateSimpleApplyProfile refreshes a derived cache row whenever the stored source_hash no
// longer matches the resume, so the real runtime path WRITES. Opening the live database readonly
// throws SQLITE_READONLY; opening it writable would mutate the developer's data just to draw a
// sample. Reimplementing the derivation to avoid the write would be a second copy of it — the
// thing this codebase keeps getting bitten by. A throwaway copy runs the real code path and
// touches nothing.
const snapshot = path.join(os.tmpdir(), `ak2-ats-${process.pid}.db`);
fs.copyFileSync(DB_PATH, snapshot);
process.on('exit', () => { try { fs.unlinkSync(snapshot); } catch {} });
const db = new Database(snapshot);

// Default to the profile with a REAL resume. Profile 5 on this board is the "John Doe
// fakeemail@gmail.com" placeholder AK1 called out as matching almost nothing; grading against it
// would measure the resume's emptiness, not the ranking.
const profiles = db.prepare('SELECT * FROM domain_profiles WHERE is_active=1 ORDER BY id').all();
const withResume = profiles
  .map(p => ({ p, base: db.prepare('SELECT * FROM profile_base_resumes WHERE profile_id=?').get(p.id) }))
  .filter(x => x.base?.content);
const chosen = PROFILE_ARG
  ? withResume.find(x => String(x.p.id) === String(PROFILE_ARG))
  : withResume.sort((a, b) => b.base.content.length - a.base.content.length)[0];
if (!chosen) throw new Error('no active profile with a base resume');

const { p: profile, base } = chosen;
const resumeText = base.content;
const signalProfile = loadOrCreateSimpleApplyProfile(db, { userId: profile.user_id, profileId: profile.id });
const runtimeBasis = buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile: profile });

const weightCache = new Map();
function weightsForJob(job) {
  let family = null;
  try { family = roleFamilyForTitle(job?.normalized_title || job?.title || ''); } catch { family = null; }
  const key = family || '__none__';
  if (!weightCache.has(key)) {
    let loaded = null;
    try { loaded = loadTermWeights(db, family); } catch { loaded = null; }
    weightCache.set(key, loaded && !loaded.stale && loaded.weights.size ? loaded.weights : null);
  }
  return weightCache.get(key);
}

const scored = [];
for (const job of db.prepare('SELECT * FROM scraped_jobs').all()) {
  let r;
  try { r = scoreAtsLocally({ job, runtimeBasis, termWeights: weightsForJob(job) }); } catch { continue; }
  if (r.score == null) continue;                       // declines are their own band, not graded here
  scored.push({ job, score: r.score });
}
scored.sort((a, b) => a.score - b.score);

// Even strata across the SCORE RANGE, so the set spans the engine's opinion rather than the board's
// mass — most of the board sits in a narrow middle and a uniform random draw would barely leave it.
const lo = scored[0].score, hi = scored[scored.length - 1].score;
const bands = WANT / 3;
const picks = [];
const seen = new Set();
for (let b = 0; b < bands; b++) {
  const from = lo + (hi - lo) * (b / bands);
  const to = lo + (hi - lo) * ((b + 1) / bands);
  const inBand = scored.filter(x => x.score >= from && (b === bands - 1 ? x.score <= to : x.score < to));
  for (let k = 0; k < 3 && inBand.length; k++) {
    const cand = inBand[Math.floor((k + 0.5) * inBand.length / 3)];
    if (cand && !seen.has(cand.job.job_id)) { seen.add(cand.job.job_id); picks.push(cand); }
  }
}

// TOP UP TO EXACTLY `WANT`. The high bands are sparse — the top decile of this board holds a
// handful of postings — so asking three from each can collide and come back short. Filling from
// the widest-spaced remainder keeps the set the promised size without re-drawing the strata.
if (picks.length < WANT) {
  const rest = scored.filter(x => !seen.has(x.job.job_id));
  const need = WANT - picks.length;
  for (let k = 0; k < need && rest.length; k++) {
    const cand = rest[Math.floor((k + 0.5) * rest.length / need)];
    if (cand && !seen.has(cand.job.job_id)) { seen.add(cand.job.job_id); picks.push(cand); }
  }
}
if (picks.length !== WANT) {
  console.warn(`WARNING: drew ${picks.length}, wanted ${WANT} — the board may be too small to stratify`);
}

// Deterministic shuffle — a fixed seed so re-running reproduces the same sheet.
let seed = 20260830;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = picks.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [picks[i], picks[j]] = [picks[j], picks[i]];
}

const clean = t => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

const sheet = [];
sheet.push('# AK2 — ATS grading sheet (task 4, requirement 5)');
sheet.push('');
sheet.push(`Drawn from **${scored.length} scored postings** on the live board under \`${LOCAL_ATS_SOURCE}\`,`);
sheet.push(`against profile ${profile.id} (${resumeText.length}-char real resume). Stratified evenly across the`);
sheet.push('engine\'s score range, then shuffled with a fixed seed.');
sheet.push('');
sheet.push('**The engine\'s score is deliberately not shown.** Record your own judgement first — that is the');
sheet.push('whole point. AK1\'s ρ = 0.504 came from a model grading the same text the engine reads, which');
sheet.push('shares a failure mode with the thing it grades. The answer key is in');
sheet.push('`docs/ak2-ats-grading-key.json` and joining before grading destroys the measurement.');
sheet.push('');
sheet.push('For each posting, rate how well it fits the resume, **1 (poor) to 5 (excellent)**, in the FIT');
sheet.push('column. Judge from the title and description only.');
sheet.push('');
sheet.push('| # | FIT (1-5) | Company | Title |');
sheet.push('|---|---|---|---|');
picks.forEach((x, i) => {
  sheet.push(`| ${i + 1} | | ${clean(x.job.company).slice(0, 40)} | ${clean(x.job.title).slice(0, 70)} |`);
});
sheet.push('');
sheet.push('---');
sheet.push('');
sheet.push('## The postings');
picks.forEach((x, i) => {
  sheet.push('');
  sheet.push(`### ${i + 1}. ${clean(x.job.title)} — ${clean(x.job.company)}`);
  sheet.push('');
  sheet.push(`\`${x.job.job_id}\``);
  sheet.push('');
  sheet.push(clean(x.job.description).slice(0, 1400) || '_(no description stored)_');
});

const key = {
  generated_at: new Date().toISOString(),
  scorer: LOCAL_ATS_SOURCE,
  profile_id: profile.id,
  resume_chars: resumeText.length,
  board_size: scored.length,
  note: 'Do not read before grading. Join on job_id after the FIT column is filled in.',
  postings: picks.map((x, i) => ({ n: i + 1, job_id: x.job.job_id, company: clean(x.job.company), title: clean(x.job.title), engine_score: x.score })),
};

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(path.join('docs', 'ak2-ats-grading-set.md'), sheet.join('\n') + '\n');
fs.writeFileSync(path.join('docs', 'ak2-ats-grading-key.json'), JSON.stringify(key, null, 2) + '\n');

console.log(`profile ${profile.id}, ${resumeText.length}-char resume, ${scored.length} scored postings`);
console.log(`drew ${picks.length} postings, scores ${Math.min(...picks.map(p => p.score))}..${Math.max(...picks.map(p => p.score))}`);
console.log('wrote docs/ak2-ats-grading-set.md and docs/ak2-ats-grading-key.json');
