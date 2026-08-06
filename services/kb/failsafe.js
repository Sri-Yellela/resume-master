/**
 * Company KB — resume failsafe gate (Task 9.6).
 *
 * Validates a GENERATED resume's claims (companies + teams/orgs + stacks) against the company
 * KB (org layer: company_org_units from Task 9.5; stack layer: company_technographics from
 * Task 5) and returns findings for the user to review. FLAGS, NEVER FABRICATES: this module
 * never rewrites a claim, never auto-changes the resume, and never writes back to the KB — the
 * KB is company/postings ground truth; the resume is the thing being checked, one-directionally.
 * It also never reads base_resume/user_profile/simple_apply_profile to VALIDATE against (only
 * the already-generated html being checked, which is expected input, not a KB write).
 *
 * Extraction reuses services/resumeFormatter.js's buildStructuredResume() — the SAME parser
 * normalizeResumeHtml() already runs on every generated resume — rather than a new HTML
 * scraper or a second LLM call. Org-unit comparison reuses services/kb/orgLayer.js's
 * normalizeOrgUnitKey so a claim and a real unit are compared with the exact same
 * normalization the KB itself uses to cluster postings.
 */

import { buildStructuredResume } from '../resumeFormatter.js';
import { normalizeOrgUnitKey } from './orgLayer.js';

// A confirmed unit, or a proposed one with reasonable evidence, counts as "real" for checking
// purposes — a barely-proposed unit (thin evidence) must never be used to flag/suggest against,
// per "Low KB confidence or no KB for that company -> NO finding."
const MIN_CONFIDENCE_TO_CHECK_AGAINST = 0.5;

// Token-overlap (Jaccard, over normalizeOrgUnitKey's word sets) thresholds for the org-unit
// comparison — documented, tunable:
//   === 1              exact match -> no finding (corroborated)
//   >= SUGGEST_FIX_MIN_OVERLAP, < 1 -> suggest_fix (garbled articulation of a real unit)
//   <  SUGGEST_FIX_MIN_OVERLAP      -> flag (no real unit resembles this claim)
const SUGGEST_FIX_MIN_OVERLAP = 0.4;

const SENIORITY_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead', 'entry', 'associate',
  'ii', 'iii', 'iv', 'i',
]);

function stripSeniority(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(w => !SENIORITY_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')))
    .join(' ')
    .trim();
}

// Derives a team/org claim from an EXPERIENCE entry's role/meta text — the common
// "Senior Engineer, Payments Platform" or "Senior Engineer — Payments Platform" shape. The
// LAST comma/dash-separated segment is the team/org candidate (the title comes first);
// entries with no such separator make no team claim at all (nothing to check — silent).
function extractTeamClaim(entry) {
  const candidates = [entry?.role, entry?.meta].filter(Boolean);
  for (const text of candidates) {
    const parts = String(text).split(/,| — | – | - /).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const claim = stripSeniority(parts[parts.length - 1]);
      if (claim && claim.split(/\s+/).length <= 6) return claim;
    }
  }
  return null;
}

function extractStackClaim(entry) {
  if (!entry?.tech) return [];
  return String(entry.tech).split(/,|\||\/|;/).map(s => s.trim()).filter(Boolean);
}

function jaccardOverlap(a, b) {
  const setA = new Set(String(a || '').split(' ').filter(Boolean));
  const setB = new Set(String(b || '').split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

// Character-level similarity (1 - normalized edit distance) — catches TYPO-level garbling
// ("Platfrom" vs "Platform") that word-set Jaccard misses entirely, since a single-character
// typo makes two words compare as completely non-overlapping at the word level.
function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// Combined similarity: word-set overlap catches phrase-level differences (reordering, a
// subset/superset of words); character-level similarity catches typo-level differences within
// otherwise-matching words. A real "garbled articulation" of a KB unit can be either kind, so
// the claim is compared against each candidate both ways and the higher score wins.
function similarity(a, b) {
  return Math.max(jaccardOverlap(a, b), levenshteinSimilarity(a, b));
}

// Stack claims NEVER produce a standalone finding (see the plan's design decision #3) — only
// supplementary evidence attached to an org-unit finding that already fired for the same
// entry. A false "this doesn't match" is the costly error the task explicitly warns against,
// and stack data is far more prone to false positives (past roles, legitimately rare tools)
// than "does this team name exist" is.
function checkStackOverlap(db, company, stackClaim) {
  if (!stackClaim.length) return null;
  const rows = db.prepare(`SELECT skill FROM company_technographics WHERE company = ?`).all(company);
  if (!rows.length) return null; // no KB stack data for this company — silent
  const knownSkills = new Set(rows.map(r => r.skill.toLowerCase()));
  const hasOverlap = stackClaim.some(s => knownSkills.has(s.toLowerCase()));
  if (hasOverlap) return null; // some overlap — nothing worth noting
  return `Claimed stack (${stackClaim.join(', ')}) has no overlap with ${company}'s known postings stack.`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} html - the generated resume's HTML (already-formatted, as returned to the client)
 * @returns {Array<object>} findings — [] when there is nothing to say (the default/common case,
 *   so most generations are visually unchanged on the client)
 */
function validateResumeClaims(db, html) {
  const findings = [];
  if (!html) return findings;

  let structure;
  try { structure = buildStructuredResume(html); } catch { return findings; }

  const experienceSection = structure.sections?.find(s => s.title === 'EXPERIENCE');
  const entries = experienceSection?.entries || [];

  const getUnitsStmt = db.prepare(`SELECT org_unit, confidence, status FROM company_org_units WHERE company = ?`);

  for (const entry of entries) {
    const company = entry.company?.trim();
    if (!company) continue;

    const teamClaim = extractTeamClaim(entry);
    if (!teamClaim) continue; // no team claim in this entry — nothing to check

    const claimKey = normalizeOrgUnitKey(teamClaim);
    if (!claimKey) continue;

    const units = getUnitsStmt.all(company)
      .filter(u => u.status === 'confirmed' || u.confidence >= MIN_CONFIDENCE_TO_CHECK_AGAINST);
    if (!units.length) continue; // no KB signal for this company — silent, never guess

    let best = null, bestScore = -1;
    for (const u of units) {
      const score = similarity(claimKey, normalizeOrgUnitKey(u.org_unit));
      if (score > bestScore) { best = u; bestScore = score; }
    }
    if (bestScore >= 0.999) continue; // exact (or near-float-equal) match — corroborated, no finding

    const stackClaim = extractStackClaim(entry);
    const stackNote = checkStackOverlap(db, company, stackClaim);
    const evidence = stackNote ? [stackNote] : [];

    if (bestScore >= SUGGEST_FIX_MIN_OVERLAP) {
      findings.push({
        type: 'suggest_fix',
        severity: 'info',
        company,
        message: `"${teamClaim}" looks like it may be an imprecise reference to ${company}'s "${best.org_unit}" team.`,
        diff: { from: teamClaim, to: best.org_unit },
        evidence,
      });
    } else {
      findings.push({
        type: 'flag',
        severity: 'review',
        company,
        message: `"${teamClaim}" doesn't match any team we've seen in ${company}'s job postings (closest: "${best.org_unit}").`,
        evidence,
      });
    }
  }

  return findings;
}

/**
 * Recruiter surface (FE-6): does a CANDIDATE'S pasted resume cohere with a specific company's
 * KB? Reuses validateResumeClaims as-is — same extraction, same comparison, same
 * flag-vs-suggest_fix routing — just scoped to one company and framed as advisory (never a
 * verdict on the person; the KB is public company structure, not a background check).
 * Stateless: takes resumeText as a plain argument and returns a plain result — nothing is
 * persisted, no table is written, the text lives only for the duration of this call.
 * @param {import('better-sqlite3').Database} db
 * @param {string} company
 * @param {string} resumeText
 */
function checkCandidateConsistency(db, company, resumeText) {
  const findings = validateResumeClaims(db, resumeText).filter(f => f.company === company);

  let mentionsCompany = false;
  try {
    const structure = buildStructuredResume(resumeText);
    const entries = structure.sections?.find(s => s.title === 'EXPERIENCE')?.entries || [];
    mentionsCompany = entries.some(e => (e.company || '').trim().toLowerCase() === company.toLowerCase());
  } catch { /* malformed input — treat as no mention, findings (already []) still returned */ }

  const status = !mentionsCompany ? 'no_claim' : findings.length ? 'flagged' : 'consistent';
  return { company, status, findings };
}

export {
  validateResumeClaims, checkCandidateConsistency, extractTeamClaim, extractStackClaim,
  jaccardOverlap, levenshteinSimilarity, similarity,
};
