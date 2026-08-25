#!/usr/bin/env node
/**
 * TASK AH4 — KB failsafe: a city is not a team. Real-run verification + screenshots.
 * ============================================================================================
 * OBSERVED
 *   FLAG: 'Bangalore' doesn't match any team we've seen in Stripe's job postings
 *         (closest: 'Solutions Architecture')
 *
 * on "Stripe | Payments Infrastructure, Bangalore". Bangalore is the LOCATION, the candidate did
 * work there, and this is the costly error the KB rules name explicitly: a false "this doesn't
 * match" against a claim that is TRUE.
 *
 * WHAT THE DIAGNOSIS FOUND — two defects, and the second is worse than reported
 *  1  extractTeamClaim took the LAST comma-separated segment. In "Title, Team, Location" and
 *     "Title, Location" that is always the place, so the check was systematically aimed at the one
 *     part of the line that cannot be a team — and in the three-part shape the REAL team was never
 *     examined at all, because the location shadowed it.
 *  2  the flag named `best.org_unit` at ANY score, and best is chosen by `score > bestScore`
 *     starting at -1, so a field of zeroes elects whichever unit is iterated first. Measured
 *     against Stripe's real KB: "Bangalore", "San Francisco", "Remote" and "Quantum Basket
 *     Weaving" ALL scored exactly 0.000 and ALL named the same unit. The similarity threshold was
 *     not too low — there was no similarity at all.
 *
 * WHAT IS ASSERTED HERE, against the REAL KB (697 org units, 275 of them Stripe's)
 *   1  the reported claim, before and after, computed from both revisions — never transcribed
 *   2  no location or workplace type is taken as a team, and the real team is checked instead
 *   3  a genuinely wrong team name still flags, and a genuinely close one is still named
 *   4  the AUDIT AH4 asks for: no other field is matched against the wrong KB dimension
 *
 * NO BROWSER HERE. The finding strip is photographed by scripts/ah4FindingShots.mjs, which is
 * excluded from the auto-discovered suite for the reason recorded in ah3TermQuality: a Windows
 * desktop-heap limit that a 28th Chrome-launching harness trips, killing every harness after it
 * with STATUS_DLL_INIT_FAILED and zero assertions run.
 *
 * Usage:  node scripts/ah4LocationClaims.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { normalizeOrgUnitKey } from '../services/kb/orgLayer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPANY = 'Stripe';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── the pre-AH4 failsafe, so before/after is COMPUTED ─────────────────────────────────────────
function loadPreFix() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  let rev = 'HEAD';
  try {
    const introduced = git('log', '-S', 'looksLikeLocation', '--format=%H', '--',
      'services/kb/failsafe.js').toString().trim().split('\n').filter(Boolean).pop();
    if (introduced) rev = `${introduced}^`;
  } catch { /* uncommitted — HEAD is the BEFORE */ }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ah4-prefix-${process.pid}-`));
  // ONE file is materialised, and its imports are POINTED AT THE CURRENT TREE rather than followed.
  //
  // Walking the graph the way ag1AtsPanelUi does works there because that scorer only imports
  // siblings inside services/. failsafe.js reaches ../resumeFormatter.js, which reaches
  // ./usageTracker.js, which reaches ../shared/anthropicModels.js — outside services/ entirely.
  // Materialising that whole tree by hand got a path wrong and the harness died on
  // "does not provide an export named 'ANTHROPIC_PRICING'", having run zero assertions.
  //
  // Pointing the imports at the real files is also the more correct comparison: AH4 changed
  // failsafe.js and nothing else, so holding the formatter and the org layer FIXED across both
  // sides isolates the change under test instead of comparing two whole trees.
  const src = git('show', `${rev}:services/kb/failsafe.js`).toString();
  const resolved = src.replace(/from\s+(["'])(\.{1,2}\/[^"']+\.js)\1/g, (_m, q, rel) => {
    const abs = path.resolve(ROOT, 'services', 'kb', rel);
    return `from ${q}${pathToFileURL(abs).href}${q}`;
  });
  const out = path.join(dir, 'failsafe.mjs');
  fs.writeFileSync(out, resolved);
  return { url: pathToFileURL(out).href, tmp: dir, rev };
}

const db = new Database(path.join(ROOT, 'data', 'resume_master.db'), { readonly: true });
const preFix = loadPreFix();
const AFTER = await import(pathToFileURL(path.join(ROOT, 'services', 'kb', 'failsafe.js')).href);
const BEFORE = await import(preFix.url);
try { fs.rmSync(preFix.tmp, { recursive: true, force: true }); } catch {}

const resume = (role) =>
  `Ada Lovelace\nSoftware Engineer\n\nEXPERIENCE\n\n${COMPANY} | Jan 2021 - Present\n${role}\n` +
  `- Built payment rails serving millions of merchants.\n- Reduced authorization latency by 30%.\n`;
const msgs = (M, role) => M.validateResumeClaims(db, resume(role)).map(f => `[${f.type}] ${f.message}`);

const REPORTED = 'Software Engineer, Payments Infrastructure, Bangalore';

console.log(`=== AH4 — the KB failsafe, against ${COMPANY}'s real org units`);
console.log(`before failsafe from ${preFix.rev}\n`);

// ── 1. the reported claim ─────────────────────────────────────────────────────────────────────
console.log('── 1. THE REPORTED CLAIM ───────────────────────────────────────────────────────');
const beforeMsgs = msgs(BEFORE, REPORTED);
const afterMsgs = msgs(AFTER, REPORTED);
console.log(`  claim   "${REPORTED}"`);
console.log(`  BEFORE  ${beforeMsgs.length ? beforeMsgs.join(' ;; ') : '(no finding)'}`);
console.log(`  AFTER   ${afterMsgs.length ? afterMsgs.join(' ;; ') : '(no finding)'}`);
check('BEFORE really did flag the location — the defect reproduces',
  beforeMsgs.some(m => /Bangalore/.test(m)), beforeMsgs.join(' ;; '));
check('AFTER produces NO Bangalore flag', !afterMsgs.some(m => /Bangalore/.test(m)),
  afterMsgs.join(' ;; '));
check('and the REAL team is what gets checked instead',
  AFTER.extractTeamClaim({ role: REPORTED }, db) === 'Payments Infrastructure',
  String(AFTER.extractTeamClaim({ role: REPORTED }, db)));

// ── 2. no place is a team ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. NO PLACE OR WORKPLACE TYPE IS TAKEN AS A TEAM ────────────────────────────');
// Drawn from the corpus rather than invented: the actual distinct locations the board has seen.
const corpusLocations = [...new Set(
  db.prepare(`SELECT DISTINCT location FROM scraped_jobs
              WHERE location IS NOT NULL AND TRIM(location) <> ''`).all()
    .flatMap(r => String(r.location).split(/[,;/|•]|\s+-\s+/))
    .map(s => s.trim()).filter(s => s.length >= 3))];
let placeFlags = 0;
for (const place of corpusLocations) {
  if (msgs(AFTER, `Software Engineer, ${place}`).length) placeFlags++;
}
check(`not one of the ${corpusLocations.length} distinct corpus locations is flagged as a team`,
  placeFlags === 0, `${placeFlags} still flagged`);
let beforePlaceFlags = 0;
for (const place of corpusLocations) {
  if (msgs(BEFORE, `Software Engineer, ${place}`).length) beforePlaceFlags++;
}
console.log(`  before: ${beforePlaceFlags} of ${corpusLocations.length} were flagged;  after: ${placeFlags}`);
check('the before/after difference is real, not a fixture that never flagged',
  beforePlaceFlags > 0, `${beforePlaceFlags} flagged before`);
for (const wt of ['Remote', 'Hybrid', 'Onsite', 'US - Remote']) {
  check(`"${wt}" is a workplace type, not a team`, msgs(AFTER, `Software Engineer, ${wt}`).length === 0);
}

// ── 3. the failsafe still does its job ────────────────────────────────────────────────────────
console.log('\n── 3. A GENUINELY WRONG TEAM STILL FLAGS ───────────────────────────────────────');
const invented = msgs(AFTER, 'Software Engineer, Quantum Basket Weaving');
check('an invented team is still flagged', invented.some(m => m.startsWith('[flag]')), invented.join(' ;; '));
check('and the flag no longer names a unit it has no similarity to',
  !invented.some(m => /closest/.test(m)), invented.join(' ;; '));

// ── 4. the audit AH4 asks for ─────────────────────────────────────────────────────────────────
console.log('\n── 4. AUDIT: IS ANY OTHER FIELD MATCHED AGAINST THE WRONG KB DIMENSION? ────────');
const locKeys = new Set(corpusLocations.map(normalizeOrgUnitKey).filter(Boolean));
const units = db.prepare('SELECT company, org_unit FROM company_org_units').all();
const pollutedUnits = units.filter(u => locKeys.has(normalizeOrgUnitKey(u.org_unit)));
console.log(`  company_org_units holds ${units.length} units across ${new Set(units.map(u => u.company)).size} companies`);
check('the KB itself holds no bare location as an org unit — the pollution was one-directional',
  pollutedUnits.length === 0, pollutedUnits.slice(0, 5).map(u => `${u.company}::${u.org_unit}`).join(', '));
// The org layer mines a DEDICATED column, which is why the KB stayed clean while the claim side did not.
const orgLayerSrc = fs.readFileSync(path.join(ROOT, 'services', 'kb', 'orgLayer.js'), 'utf8');
check('the org layer mines scraped_jobs.org_unit_raw, never location',
  /org_unit_raw/.test(orgLayerSrc) && !/\blocation\b/.test(orgLayerSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')));
// The stack half compares a stack claim against the stack table — the right dimension.
const failsafeSrc = fs.readFileSync(path.join(ROOT, 'services', 'kb', 'failsafe.js'), 'utf8');
check('the stack claim is compared against company_technographics, not against org units',
  /function checkStackOverlap[\s\S]{0,400}?FROM company_technographics/.test(failsafeSrc));
check('the recruiter surface reuses validateResumeClaims, so it inherits the fix',
  /function checkCandidateConsistency[\s\S]{0,400}?validateResumeClaims\(db, resumeText\)/.test(failsafeSrc));

db.close();

console.log('');
console.log('='.repeat(96));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
console.log('='.repeat(96));
process.exit(failures ? 1 : 0);
