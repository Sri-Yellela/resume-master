#!/usr/bin/env node
/**
 * TASK AH3 — ATS term quality, part two: category and judgement.
 * ============================================================================================
 * WHAT WAS OBSERVED, on Notion — Software Engineer, New Grad (ATS 81)
 *
 *   SKILLS MISSING: "thoughtful problem-solving", "intellectual curiosity", "problem decomposition"
 *   VERBS MISSING:  "Deliver", "Manage"
 *   SKILLS MATCHED: "systems", "time"
 *
 * AG1 fixed the FRAGMENT problem — the terms are well-formed now. What remained was category and
 * judgement: competencies filed as skills, generic language reported as gaps, and a matched list
 * padded with words that mean nothing.
 *
 * WHAT THE DIAGNOSIS FOUND
 *  1  MISCATEGORISATION was one dropped field. scraped_jobs.skills_json already carries
 *     {skill, type} with type "hard" or "soft" — 10,389 hard and 7,377 soft across the 1,291
 *     enriched postings in this corpus, with ZERO untyped. jobSkillTerms() read entry.skill and
 *     threw entry.type away, so the Notion posting's four soft terms landed beside typescript.
 *  2  NOISE IN MATCHED was worse than reported. The candidate's profile skills were pushed into
 *     the term list unconditionally, and those are resume-EXTRACTED tokens. On the real fixture
 *     profile this posting's SKILLS MATCHED read: engineering | provided | science | bachelor |
 *     current | environment | skills | specific. Eight of nine were ordinary English words that
 *     happened to appear in both documents — and each one counted as a match, so they inflated
 *     the score as well as the report.
 *  3  GENERIC VERBS could not be found by frequency. Managed appears in 44% of postings and
 *     Delivered in 42%, BELOW Built (93%), Designed (72%) and Developed (58%) — verbs whose
 *     absence is worth reporting. A frequency threshold would have kept the wrong ones. The
 *     criterion is semantic and stated in the source.
 *
 * WHAT IS ASSERTED HERE
 *   1  the reported posting, before and after, with counts per bucket
 *   2  every term in every bucket is defensible IN ITS CATEGORY, checked against the data that
 *      decides the category rather than against a transcription of the expected output
 *   3  corpus-wide: no soft-typed term reaches skills, no generic verb reaches the gap list, and
 *      no resume-extracted word reaches skills, across all 1,291 enriched postings
 *
 * NO BROWSER HERE, deliberately. The panel half of this verification lives in
 * scripts/ah3TermPanelShots.mjs. They were one script, and adding a 28th Chrome-launching harness
 * to the auto-discovered suite pushed this Windows box past its desktop-heap limit: every harness
 * after it died with exit 3221225794 (STATUS_DLL_INIT_FAILED) having run ZERO assertions, which
 * verifyHarnesses correctly reported as eleven truncated runs. Isolated, ah3 followed by e3
 * PASSES — the exhaustion is cumulative across the whole run, so this was the straw and not the
 * leak. Splitting keeps the corpus assertions in the suite where they belong and moves the
 * screenshots to a hand-run script, which is the same division ah1IdentityShots and ah2MultiTab
 * already sit on.
 *
 * Usage:  node scripts/ah3TermQuality.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { companyStackTerms, skillVocabularyTerms } from '../services/skillVocabulary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB_KEY = 'ashby::e32799d2-8ef8-4803-8189-c72514afa816';  // Notion, Software Engineer, New Grad
const PROFILE_ID = 6;

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── the pre-AH3 scorer, for a before/after that is COMPUTED, never transcribed ────────────────
function loadPreFixScorer() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  // Named by the change itself: the parent of the commit that introduced the competencies bucket.
  // While AH3 is uncommitted that commit does not exist and HEAD is still the BEFORE, which is
  // exactly what "the revision before this change" means in both states.
  let rev = 'HEAD';
  try {
    const introduced = git('log', '-S', 'competencies_matched', '--format=%H', '--',
      'services/localAtsScorer.js').toString().trim().split('\n').filter(Boolean).pop();
    if (introduced) rev = `${introduced}^`;
  } catch { /* no history yet — HEAD is the pre-fix revision */ }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ah3-prefix-${process.pid}-`));
  const written = new Set();
  const materialise = (name) => {
    if (written.has(name)) return;
    written.add(name);
    const src = git('show', `${rev}:services/${name}`).toString();
    fs.writeFileSync(path.join(dir, name.replace(/\.js$/, '.mjs')),
      src.replace(/(from\s+["']\.\/[^"']+)\.js(["'])/g, '$1.mjs$2'));
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)) materialise(m[1]);
  };
  materialise('localAtsScorer.js');
  return { url: pathToFileURL(path.join(dir, 'localAtsScorer.mjs')).href, tmp: dir, rev };
}

function openDb() {
  const dbPath = path.join(ROOT, 'data', 'resume_master.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  return new Database(dbPath, { readonly: true });
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
const softOf = (job) => {
  let list = []; try { list = JSON.parse(job.skills_json || '[]'); } catch {}
  return new Set(list.filter(e => e?.type === 'soft').map(e => norm(e.skill)).filter(Boolean));
};
const hardOf = (job) => {
  let list = []; try { list = JSON.parse(job.skills_json || '[]'); } catch {}
  return new Set(list.filter(e => e?.type !== 'soft').map(e => norm(e.skill)).filter(Boolean));
};

const db = openDb();
const job = db.prepare('SELECT * FROM scraped_jobs WHERE job_id=?').get(JOB_KEY);
if (!job) {
  console.log(`FAIL  the reported posting ${JOB_KEY} is not in scraped_jobs — nothing to verify`);
  process.exit(1);
}
const domainProfile = db.prepare('SELECT * FROM domain_profiles WHERE id=?').get(PROFILE_ID);
const base = db.prepare('SELECT content FROM profile_base_resumes WHERE profile_id=?').get(PROFILE_ID);
if (!domainProfile || !base?.content) {
  console.log(`FAIL  profile ${PROFILE_ID} or its base resume is missing`);
  process.exit(1);
}
// The REAL extracted signals for this profile. This is the half that produced "provided" and
// "science", so scoring against an empty signal set would verify the fix on inputs that never
// showed the defect.
const sig = db.prepare('SELECT * FROM profile_simple_apply_profiles WHERE profile_id=?').get(PROFILE_ID);
const signalProfile = sig ? {
  skills: JSON.parse(sig.skills_json || '[]'),
  keywords: JSON.parse(sig.keywords_json || '[]'),
  titles: JSON.parse(sig.titles_json || '[]'),
  yearsExperience: sig.years_experience,
} : { skills: [], keywords: [], yearsExperience: 4, structuredFacts: {} };

const preFix = loadPreFixScorer();
const AFTER = await import(pathToFileURL(path.join(ROOT, 'services', 'localAtsScorer.js')).href);
const BEFORE = await import(preFix.url);
try { fs.rmSync(preFix.tmp, { recursive: true, force: true }); } catch {}

const scoreWith = (M, j) => M.scoreAtsLocally({
  job: j,
  runtimeBasis: M.buildRuntimeAtsBasis({ resumeText: base.content, signalProfile, domainProfile }),
});
const before = scoreWith(BEFORE, job);
const after = scoreWith(AFTER, job);

console.log(`=== AH3 — ${job.company}, ${job.title}`);
console.log(`before scorer from ${preFix.rev}  (${BEFORE.LOCAL_ATS_SOURCE} -> ${AFTER.LOCAL_ATS_SOURCE})`);
console.log(`skills_json: ${job.skills_json}\n`);

// ── 1. counts, before and after, per bucket ───────────────────────────────────────────────────
console.log('── 1. COUNTS PER BUCKET ────────────────────────────────────────────────────────');
const n = (r, k) => (r[k] || []).length;
const row = (label, b, a) => console.log(`  ${label.padEnd(22)} before ${String(b).padStart(3)}   after ${String(a).padStart(3)}`);
row('score', before.score, after.score);
row('skills matched', n(before, 'tier1_matched'), n(after, 'tier1_matched'));
row('skills missing', n(before, 'tier1_missing'), n(after, 'tier1_missing'));
row('competencies matched', 0, n(after, 'competencies_matched'));
row('competencies missing', 0, n(after, 'competencies_missing'));
row('verbs matched', n(before, 'action_verbs_matched'), n(after, 'action_verbs_matched'));
row('verbs missing', n(before, 'action_verbs_missing'), n(after, 'action_verbs_missing'));
row('generic language', 0, n(after, 'action_verbs_generic'));
console.log('\n  BEFORE skills matched : ' + (before.tier1_matched || []).join(' | '));
console.log('  BEFORE skills missing : ' + (before.tier1_missing || []).join(' | '));
console.log('  BEFORE verbs missing  : ' + (before.action_verbs_missing || []).join(' | '));
console.log('\n  AFTER  skills matched : ' + (after.tier1_matched || []).join(' | '));
console.log('  AFTER  skills missing : ' + (after.tier1_missing || []).join(' | '));
console.log('  AFTER  competencies   : ' + [...(after.competencies_matched || []), ...(after.competencies_missing || [])].join(' | '));
console.log('  AFTER  verbs missing  : ' + (after.action_verbs_missing || []).join(' | '));
console.log('  AFTER  generic        : ' + (after.action_verbs_generic || []).join(' | '));

console.log('\n── 2. THE REPORTED TERMS, EACH IN ITS PLACE ────────────────────────────────────');
const allSkills = [...(after.tier1_matched || []), ...(after.tier1_missing || [])].map(norm);
const allComps = [...(after.competencies_matched || []), ...(after.competencies_missing || [])].map(norm);
const allVerbGaps = [...(after.action_verbs_missing || [])].map(norm);
const generic = (after.action_verbs_generic || []).map(norm);

for (const term of ['thoughtful problem solving', 'problem decomposition', 'collaboration']) {
  check(`"${term}" is a COMPETENCY, not a skill`,
    allComps.includes(term) && !allSkills.includes(term));
}
for (const term of ['typescript', 'node js', 'python']) {
  check(`"${term}" is still a SKILL`, allSkills.includes(term));
}
check('no verb gap is a generic stewardship verb',
  !allVerbGaps.some(v => /^(manage|deliver|own|drive|partner|report|grow|coordinate|execute|oversee|track|secure)/.test(v)),
  allVerbGaps.join(' | '));
check('"Delivered" is reported as generic LANGUAGE, not as a gap',
  generic.some(v => v.startsWith('deliver')), generic.join(' | '));
// The reported noise, by name.
for (const junk of ['provided', 'science', 'bachelor', 'current', 'environment', 'specific', 'skill', 'systems', 'time']) {
  check(`"${junk}" is gone from the skills buckets`, !allSkills.includes(norm(junk)));
}
check('the matched list is no longer padded: every matched skill is a real term',
  (after.tier1_matched || []).every(t => {
    const k = norm(t);
    return hardOf(job).has(k) || companyStackTerms(job.company).some(s => norm(s) === k)
      || skillVocabularyTerms().some(s => norm(s) === k);
  }),
  (after.tier1_matched || []).join(' | '));

// ── 3. the whole corpus, not one posting ──────────────────────────────────────────────────────
console.log('\n── 3. EVERY ENRICHED POSTING IN THE CORPUS ─────────────────────────────────────');
const corpus = db.prepare(
  'SELECT * FROM scraped_jobs WHERE description IS NOT NULL AND LENGTH(description) > 400').all();
const closedSet = new Set(skillVocabularyTerms().map(norm));
let softLeaks = 0, junkLeaks = 0, genericGaps = 0, emptyReports = 0;
let bSkills = 0, aSkills = 0, aComps = 0, bVerbs = 0, aVerbs = 0, aGeneric = 0, drops = 0, gateDown = 0;
const basisAfter = AFTER.buildRuntimeAtsBasis({ resumeText: base.content, signalProfile, domainProfile });
const basisBefore = BEFORE.buildRuntimeAtsBasis({ resumeText: base.content, signalProfile, domainProfile });
for (const j of corpus) {
  const b = BEFORE.scoreAtsLocally({ job: j, runtimeBasis: basisBefore });
  const a = AFTER.scoreAtsLocally({ job: j, runtimeBasis: basisAfter });
  const soft = softOf(j), hard = hardOf(j);
  const skills = [...(a.tier1_matched || []), ...(a.tier1_missing || [])].map(norm);
  for (const t of skills) {
    if (soft.has(t)) softLeaks++;
    // The closed set is the registry, the enrichment's HARD terms, and this employer's stack.
    if (!hard.has(t) && !closedSet.has(t) && !companyStackTerms(j.company).some(s => norm(s) === t)) junkLeaks++;
  }
  for (const v of (a.action_verbs_missing || []).map(norm)) {
    if (/^(manage|deliver|own|drive|partner|report|grew|grow|coordinat|execut|overse|track|secur)/.test(v)) genericGaps++;
  }
  if (!skills.length && !(a.competencies_missing || []).length) emptyReports++;
  bSkills += b.tier1_matched.length + b.tier1_missing.length;
  aSkills += a.tier1_matched.length + a.tier1_missing.length;
  aComps += (a.competencies_matched || []).length + (a.competencies_missing || []).length;
  bVerbs += b.action_verbs_matched.length + b.action_verbs_missing.length;
  aVerbs += a.action_verbs_matched.length + a.action_verbs_missing.length;
  aGeneric += (a.action_verbs_generic || []).length;
  drops += (a.score - b.score);
  if (b.score >= 65 && a.score < 65) gateDown++;
}
const per = (x) => (x / corpus.length).toFixed(1);
console.log(`  ${corpus.length} postings scored against the real fixture profile`);
console.log(`  skill terms per report  before ${per(bSkills)}  after ${per(aSkills)}  (+ ${per(aComps)} competencies)`);
console.log(`  verb  terms per report  before ${per(bVerbs)}  after ${per(aVerbs)}  (+ ${per(aGeneric)} generic)`);
console.log(`  mean score change ${(drops / corpus.length).toFixed(1)};  crossed the 65 auto-apply gate downward: ${gateDown}`);
check('NO soft-typed enrichment term reaches the skills buckets, in any posting', softLeaks === 0, `${softLeaks} leaks`);
check('NO term outside the closed set reaches the skills buckets, in any posting', junkLeaks === 0, `${junkLeaks} leaks`);
check('NO generic stewardship verb is reported as a gap, in any posting', genericGaps === 0, `${genericGaps} gaps`);
check('PRECISION OVER RECALL: the skills bucket shrank', aSkills < bSkills,
  `${per(bSkills)} -> ${per(aSkills)} per report`);
check('and it did not shrink to nothing — most postings still say something',
  emptyReports < corpus.length * 0.1, `${emptyReports} empty of ${corpus.length}`);
db.close();

console.log('');
console.log('='.repeat(96));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
console.log('='.repeat(96));
process.exit(failures ? 1 : 0);
