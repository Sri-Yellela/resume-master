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

/**
 * How similar the nearest KB unit must be before the flag is willing to NAME it (AH4).
 *
 * The flag used to name `best.org_unit` whatever it scored, and best is chosen by `score >
 * bestScore` starting at -1 — so when every candidate ties at zero, the FIRST unit iterated wins.
 * Measured against Stripe's real KB (14 units clear the confidence gate): "Bangalore",
 * "San Francisco", "Remote" and "Quantum Basket Weaving" all scored EXACTLY 0.000 and all four
 * were reported as closest to the same arbitrary unit. That is not a threshold set too low; it is
 * a suggestion with no similarity behind it at all, and a suggestion no human would make costs
 * trust in every other finding on the page.
 *
 * A genuinely informative near-miss clears this easily: "Payments Infrastructure" against
 * "Payments" scores 0.500. Below the floor the finding still fires — the claim really does not
 * match anything — it just stops inventing a nearest neighbour to name.
 */
const NAME_CLOSEST_MIN_SIMILARITY = 0.2;

const SENIORITY_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead', 'entry', 'associate',
  'ii', 'iii', 'iv', 'i',
]);

/**
 * PLACES ARE NOT TEAMS (AH4).
 *
 * The observed false flag: "Stripe | Payments Infrastructure, Bangalore" produced
 * `'Bangalore' doesn't match any team we've seen in Stripe's job postings`. Bangalore is the
 * LOCATION. extractTeamClaim took the last comma-separated segment, and in the overwhelmingly
 * common "Title, Team, Location" and "Title, Location" shapes the last segment is where the place
 * lives — so the check was systematically aimed at the one part of the line that could never be a
 * team. Worse, in the three-part shape the REAL team was never checked at all, because the
 * location shadowed it.
 *
 * This is the costly error the KB rules name explicitly: a false "this doesn't match" against a
 * claim that is TRUE. The candidate did work in Bangalore.
 *
 * The vocabulary is READ FROM THE DATA WE ALREADY HAVE rather than hand-listed: every distinct
 * scraped_jobs.location, split on the separators those values use. On this corpus that is 147
 * distinct parts from 1,291 postings, and it already contains "bangalore", "bengaluru",
 * "san francisco", "dublin", "singapore" and the rest. A hand-written city list would be a second
 * source of truth that goes stale the first time the board learns a new market.
 *
 * SHAPES cover the tail the corpus cannot: workplace types (scraped_jobs.workplace_type is
 * remote/hybrid/onsite), the "Remote - X" and "US-X" prefixes those values use, and bare
 * two-letter state or country codes.
 */
const WORKPLACE_TYPE_WORDS = new Set(['remote', 'hybrid', 'onsite', 'on site', 'in office', 'in person']);

const LOCATION_SHAPES = [
  /^(remote|hybrid|onsite|on-?site|in-?office|in-?person)\b/i,
  /\b(remote|hybrid|onsite)$/i,
  /^[a-z]{2}$/i,                                  // a bare state or country code: CA, NY, UK, IN
  /^(us|usa|uk|emea|apac|amer|latam|na|eu)\b/i,   // region prefixes the feeds use
];

let _locationVocabulary = null;
function locationVocabulary(db) {
  if (_locationVocabulary) return _locationVocabulary;
  const vocab = new Set();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT location FROM scraped_jobs WHERE location IS NOT NULL AND TRIM(location) <> ''`
    ).all();
    for (const row of rows) {
      // The same separators the stored values use: "CA • New York", "US - Remote", "Dublin, Ireland".
      for (const part of String(row.location).split(/[,;/|•]|\s+-\s+|\bor\b|\band\b/i)) {
        const key = normalizeOrgUnitKey(part);
        // Single letters and empty fragments would match everything; two characters is the
        // shortest a real place name gets ("NY" is handled by LOCATION_SHAPES anyway).
        if (key && key.length >= 3) vocab.add(key);
      }
    }
  } catch { /* no scraped_jobs, or a schema without location — the shapes still apply */ }
  _locationVocabulary = vocab;
  return vocab;
}

/** Test seam — the vocabulary is memoised, and a test that swaps databases needs it rebuilt. */
function resetLocationVocabulary() { _locationVocabulary = null; }

/** One place, with no conjunction in it: a workplace type, a corpus location, or a location shape. */
function isLocationAtom(db, key) {
  if (!key) return false;
  return WORKPLACE_TYPE_WORDS.has(key)
    || locationVocabulary(db).has(key)
    || LOCATION_SHAPES.some(re => re.test(key));
}

function looksLikeLocation(db, segment) {
  const key = normalizeOrgUnitKey(segment);
  if (!key) return false;
  // Shapes are checked against the RAW segment too, because "US - Remote" loses its hyphen to
  // normalisation and the prefix rule is written against what the feeds actually store.
  if (LOCATION_SHAPES.some(re => re.test(String(segment).trim()))) return true;

  // A CONJUNCTION OF PLACES IS STILL A PLACE, and a dangling conjunction is a fragment of one.
  // The board stores "London OR Dublin", "Chicago and NYC", "San Francisco or Seattle" — 16 of the
  // 145 distinct location strings in this corpus are alternatives like that, and after the first
  // pass of this fix all 16 were still being flagged as teams because the vocabulary holds
  // "london" and "dublin" separately and never the phrase.
  //
  // EVERY part must be a place. "Payments or Risk" is two teams, and this must not swallow it.
  // A single part is the ordinary case and falls out of the same rule.
  const parts = key.split(/\b(?:or|and)\b/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(part => isLocationAtom(db, part));
}

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
function extractTeamClaim(entry, db = null) {
  const candidates = [entry?.role, entry?.meta].filter(Boolean);
  for (const text of candidates) {
    let parts = String(text).split(/,| — | – | - /).map(s => s.trim()).filter(Boolean);
    // AH4: drop trailing places before choosing the team. "Title, Team, Location" leaves the team;
    // "Title, Location" leaves only the title, which is NOT a team claim and must produce no
    // finding at all. Only TRAILING segments are dropped — a unit legitimately named after a place
    // ("Bangalore Finance" is a real Stripe org unit) is not at the end and survives.
    if (db) {
      while (parts.length && looksLikeLocation(db, parts[parts.length - 1])) parts = parts.slice(0, -1);
    }
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

// A typo is a HIGH character-similarity event. Below this, a character-level score between two
// phrases that share no word at all is coincidence of length and alphabet, not a garbled
// articulation of anything: against Stripe's real KB, "Quantum Basket Weaving" scored 0.409 on
// characters alone (Jaccard 0) against "Growth Marketing" and cleared SUGGEST_FIX_MIN_OVERLAP,
// so an invented team was reported to a recruiter as "may be an imprecise reference to" a real
// one. The more units a company has, the more likely some pair collides by chance — which is why
// this only surfaced once the KB held 271 units for Stripe instead of none.
const TYPO_MIN_CHAR_SIMILARITY = 0.8;

// Combined similarity: word-set overlap catches phrase-level differences (reordering, a
// subset/superset of words); character-level similarity catches typo-level differences within
// otherwise-matching words. A real "garbled articulation" of a KB unit can be either kind, so
// the claim is compared against each candidate both ways and the higher score wins — but the
// character-level signal only counts when it is strong enough to actually mean "typo".
function similarity(a, b) {
  const chars = levenshteinSimilarity(a, b);
  return Math.max(jaccardOverlap(a, b), chars >= TYPO_MIN_CHAR_SIMILARITY ? chars : 0);
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

    const teamClaim = extractTeamClaim(entry, db);
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
      // AH4: name the nearest unit only when there IS one. Below the floor the best candidate is
      // whatever happened to be iterated first among a field of zeroes, and "(closest: X)" then
      // reads as a considered judgement about a pairing nothing connects.
      const named = bestScore >= NAME_CLOSEST_MIN_SIMILARITY ? ` (closest: "${best.org_unit}")` : '';
      findings.push({
        type: 'flag',
        severity: 'review',
        company,
        message: `"${teamClaim}" doesn't match any team we've seen in ${company}'s job postings${named}.`,
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
  looksLikeLocation, resetLocationVocabulary, NAME_CLOSEST_MIN_SIMILARITY,
};
