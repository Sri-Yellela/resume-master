/**
 * Resume claim guard (AF2) — the JD may steer emphasis, never a quantity.
 *
 * THE DISTINCTION THIS ENFORCES
 * A candidate answering "4 years" on a form is making a choice they defend at interview. A generated
 * resume claiming 8 years because the JD asked for 8 is fabrication, and layer1_global_rules.md
 * forbids it outright: "Never fabricate credentials, clearances, regulated approvals, seniority...".
 * Under semi the candidate reads the resume before it goes. Under full-auto it is attached and
 * submitted unread, so the only thing standing between a JD's demand and a false claim to an
 * employer is a check that runs at generation time.
 *
 * WHY A FAILURE AND NOT A WARNING
 * A warning is a thing nobody reads on an unattended run. An inflated resume that reached an
 * employer cannot be recalled, and it is the candidate's name on it. So this refuses the artifact.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never rewrites a claim down to a plausible one — that is the same fabrication with a smaller
 * number, and §7 forbids it in both directions. It reports what is wrong and declines the output.
 */

const SPELLED = new Map(Object.entries({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
}));

/**
 * Seniority, ranked so two titles can be compared. Only words that assert a LEVEL are here — a bare
 * "Software Engineer" asserts none and is rank 0, which is why an unranked title can never be the
 * thing that trips the check. "Architect" is deliberately absent: it names a role, not a level.
 */
const SENIORITY_RANK = new Map(Object.entries({
  intern: 0, trainee: 0,
  entry: 1, junior: 1, jr: 1, graduate: 1,
  associate: 2,
  mid: 3, intermediate: 3,
  senior: 4, sr: 4,
  lead: 5, staff: 5, supervising: 5,
  principal: 6,
  distinguished: 7, fellow: 7, director: 7, head: 7,
  vp: 8, chief: 8, cto: 8,
}));

/**
 * The nouns that make a phrase a JOB TITLE rather than prose.
 *
 * A seniority word only counts when it qualifies one of these. Scanning the whole document for
 * "lead" or "head" flags a bullet that says "lead the migration" or a skills row mentioning
 * "headless" — and because a violation REFUSES the artifact, a false positive is a broken product,
 * not a noisy log line. So the check reads titles, which is where a seniority claim actually lives.
 */
const ROLE_NOUNS = [
  "engineer", "engineering", "developer", "programmer", "architect", "scientist", "analyst",
  "manager", "designer", "consultant", "administrator", "specialist", "technologist", "researcher",
];

const SENIORITY_WORDS_RE = [...SENIORITY_RANK.keys()].join("|");
const ROLE_NOUNS_RE = ROLE_NOUNS.join("|");
// "Senior Software Engineer", "Staff Backend Developer", "Director of Engineering" — a level word,
// then up to three intervening words, then the role noun it qualifies.
const TITLE_CLAIM_RE = new RegExp(
  `\\b(${SENIORITY_WORDS_RE})\\b(?:\\s+(?:of|the|a)\\b)?(?:\\s+[a-z][a-z+#./-]*){0,3}\\s+\\b(?:${ROLE_NOUNS_RE})\\b`,
  "gi",
);

/** Strip tags and decode the few entities that matter, so claims are matched against read text. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every years-of-experience quantity the text asserts, largest first.
 *
 * A RANGE RESOLVES TO ITS TOP ("5-7 years" claims seven), because the top is what an employer reads
 * and what the candidate would have to defend. Same for "8+".
 */
export function extractYearsClaims(text) {
  const t = String(text ?? "").toLowerCase();
  const claims = [];

  // "4 years", "4+ years", "4.5 years", "5-7 years", "over 8 years", "8 yrs"
  const NUMERIC = /(?:(\d{1,2}(?:\.\d)?)\s*(?:-|–|—|\s+to\s+)\s*)?(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\b/g;
  for (const m of t.matchAll(NUMERIC)) {
    const top = parseFloat(m[2]);
    if (Number.isFinite(top) && top > 0 && top <= 60) claims.push({ years: top, text: m[0].trim() });
  }

  // Spelled out — a model asked for prose sometimes writes "eight years".
  const words = [...SPELLED.keys()].join("|");
  const SPELLED_RE = new RegExp(`\\b(${words})\\s*\\+?\\s*(?:years?|yrs?)\\b`, "g");
  for (const m of t.matchAll(SPELLED_RE)) {
    claims.push({ years: SPELLED.get(m[1]), text: m[0].trim() });
  }

  // "a decade", "half a decade" — the only idioms common enough to matter.
  //
  // "half a decade" is consumed FIRST and removed, because it contains "a decade": scanning both
  // over the same text reads five years as ten, and an over-reading here refuses an honest resume.
  let decades = t;
  for (const m of decades.matchAll(/\bhalf\s+a\s+decade\b/g)) claims.push({ years: 5, text: m[0].trim() });
  decades = decades.replace(/\bhalf\s+a\s+decade\b/g, " ");
  for (const m of decades.matchAll(/\b(?:a|one)\s+decade\b/g)) claims.push({ years: 10, text: m[0].trim() });
  for (const m of decades.matchAll(/\btwo\s+decades\b/g)) claims.push({ years: 20, text: m[0].trim() });

  return claims.sort((a, b) => b.years - a.years);
}

/** The largest years figure the text claims, or null when it claims none. */
export function maxYearsClaim(text) {
  const [top] = extractYearsClaims(text);
  return top ? top.years : null;
}

/**
 * Every seniority level the text asserts AS A TITLE, strongest first.
 * Word-boundary matched throughout, so "senior" never fires on "seniority" nor "head" on "header".
 */
export function extractSeniorityClaims(text) {
  const t = String(text ?? "").toLowerCase();
  const found = new Map();
  for (const m of t.matchAll(TITLE_CLAIM_RE)) {
    const word = m[1].toLowerCase();
    const rank = SENIORITY_RANK.get(word);
    if (rank === undefined) continue;
    if (!found.has(word)) found.set(word, { word, rank, phrase: m[0].trim() });
  }
  return [...found.values()].sort((a, b) => b.rank - a.rank);
}

/** The strongest seniority the text asserts, or null. */
export function maxSeniority(text) {
  const [top] = extractSeniorityClaims(text);
  return top || null;
}

/**
 * Check a GENERATED resume against the candidate's own facts.
 *
 * @param {object}  o
 * @param {string}  o.html             the generated resume
 * @param {object}  o.profile          user_profile row — years_of_experience is the authority
 * @param {string}  o.baseResumeText   the base resume, which is what supports a seniority claim
 * @returns {{ok: boolean, violations: Array, checked: object}}
 */
export function checkResumeClaims({ html, profile, baseResumeText = "" }) {
  const violations = [];
  const text = htmlToText(html);
  const profileYears = Number(profile?.years_of_experience);
  const hasProfileYears = Number.isFinite(profileYears) && profileYears > 0;

  const claimedYears = maxYearsClaim(text);
  const claimList = extractYearsClaims(text);

  // ── Years ──────────────────────────────────────────────────────────────────
  // Only ever an UPPER bound. Claiming fewer years than the profile states is the candidate's
  // business — modest is not a lie — so an under-claim is silent.
  if (hasProfileYears && claimedYears !== null && claimedYears > profileYears) {
    violations.push({
      kind: "years_exceed_profile",
      claimed: claimedYears,
      allowed: profileYears,
      evidence: claimList.filter(c => c.years > profileYears).map(c => c.text),
      message:
        `The generated resume claims ${claimedYears} years of experience; the profile states ` +
        `${profileYears}. A JD may steer what is emphasised, never how much experience the ` +
        `candidate has.`,
    });
  }

  // ── Seniority ──────────────────────────────────────────────────────────────
  // Supported by the BASE RESUME, which is the record of what the candidate actually held. With no
  // base resume there is nothing to check against, and guessing would be the very fault being
  // guarded — so it is skipped rather than assumed.
  const baseText = String(baseResumeText || "");
  if (baseText.trim()) {
    const claimed = maxSeniority(text);
    const supported = maxSeniority(baseText);
    const supportedRank = supported ? supported.rank : 0;
    if (claimed && claimed.rank > supportedRank) {
      violations.push({
        kind: "seniority_unsupported",
        claimed: claimed.word,
        allowed: supported ? supported.word : "(no seniority stated)",
        evidence: [claimed.word],
        message:
          `The generated resume claims "${claimed.word}" seniority; the base resume supports ` +
          `${supported ? `"${supported.word}"` : "no seniority claim"}. A JD's title is not a ` +
          `promotion.`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: {
      claimedYears,
      profileYears: hasProfileYears ? profileYears : null,
      claimedSeniority: maxSeniority(text)?.word ?? null,
      supportedSeniority: baseText.trim() ? (maxSeniority(baseText)?.word ?? null) : null,
    },
  };
}

/** Thrown when a generated resume contradicts the candidate's own facts. */
export class ResumeClaimError extends Error {
  constructor(result) {
    super(`resume_claim_violation: ${result.violations.map(v => v.message).join(" ")}`);
    this.name = "ResumeClaimError";
    this.code = "resume_claim_violation";
    this.violations = result.violations;
    this.checked = result.checked;
  }
}

/**
 * The generation-time assertion. Throws on violation — see "WHY A FAILURE AND NOT A WARNING".
 */
export function assertResumeClaims(args) {
  const result = checkResumeClaims(args);
  if (!result.ok) throw new ResumeClaimError(result);
  return result;
}

/**
 * The same checks expressed as kbFindings, so the 9.6 failsafe surface reports a resume that
 * contradicts the candidate's own profile alongside one that contradicts a company's KB. Same rule,
 * turned inward: flag, never rewrite.
 */
export function profileContradictionFindings({ html, profile, baseResumeText = "" }) {
  const { violations } = checkResumeClaims({ html, profile, baseResumeText });
  return violations.map(v => ({
    type: "flag",
    severity: "review",
    company: null,
    scope: "profile",
    kind: v.kind,
    message: v.message,
    evidence: v.evidence,
  }));
}
