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
 * The four values domain_profiles.seniority can hold, on the same rank scale as SENIORITY_RANK.
 *
 * THIS IS THE CANDIDATE'S OWN DECLARATION, and it is the authority on their level.
 * It is written only by the profile wizard and the profile editor — services/classifier.js produces
 * a seniority for search-query building but nothing writes that into the column. So when it says
 * "senior", a person chose "senior" about themselves.
 *
 * Kept as its own map rather than folded into SENIORITY_RANK: that map's keys also become the
 * regex that decides what counts as a seniority claim IN THE DOCUMENT, and "executive" is a word
 * resumes use in prose ("executive communication", "executive stakeholders"). The declaration
 * vocabulary is an enum; the document vocabulary is English. They are different alphabets.
 *
 * The enum itself lives in shared/jobFilterOptions.js (PROFILE_SENIORITY). A test asserts every
 * option there has a rank here, so adding a fifth cannot silently fall through to "no claim".
 */
const DECLARED_SENIORITY_RANK = new Map(Object.entries({
  junior: 1,
  mid: 3,
  senior: 4,
  executive: 7,
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

function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** Strip tags and decode the few entities that matter, so claims are matched against read text. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/**
 * The document's lines, with block boundaries preserved.
 *
 * htmlToText collapses everything to one line, which is right for "does this text claim eight
 * years" and useless for "which section is that claim in". A section boundary is a block boundary,
 * so the block tags become newlines before the rest are stripped.
 */
function htmlToLines(html) {
  const withBreaks = String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|ul|ol|h[1-6]|section|tr|table|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const SUMMARY_HEADING = /^(?:professional|executive|career|personal)?\s*(?:summary|profile|objective)\b[:\s]*$/i;
const KNOWN_HEADING = /^(?:technical\s+skills|core\s+competencies|skills|experience|professional\s+experience|work\s+experience|employment(?:\s+history)?|education|projects?|academic\s+projects?|certifications?|publications?|awards?|honors?|languages|interests|volunteer|leadership|summary|profile|objective)\b[:\s]*$/i;

/** A line that opens a section rather than saying anything. */
function isSectionHeading(line) {
  if (KNOWN_HEADING.test(line)) return true;
  // Short, shouted and wordless — the shape of a heading in every resume template we emit.
  return line.length <= 40 && /^[A-Z0-9 &,'/-]+$/.test(line) && /[A-Z]{2,}/.test(line);
}

/**
 * The SUMMARY section's prose, or "" when the document has no summary.
 *
 * WHY THE SUMMARY SPECIFICALLY, AND NOT THE WHOLE DOCUMENT
 * The under-claim check needs the document's TOTAL-experience figure, and the summary is where the
 * section rules put it. Reading the whole document instead would take "3 years of Python" in a
 * skills line as a claim to three years of career — a scoped, honest statement — and refuse an
 * honest resume. Over-claiming is still checked document-wide, because a fabricated quantity is
 * fabrication wherever it sits; under-claiming is only meaningful about the headline figure.
 */
export function extractSummaryText(html) {
  const lines = htmlToLines(html);
  const start = lines.findIndex(line => SUMMARY_HEADING.test(line));
  if (start === -1) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isSectionHeading(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join(" ").trim();
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
export function checkResumeClaims({ html, profile, baseResumeText = "", domainProfile = null }) {
  const violations = [];
  const text = htmlToText(html);
  const profileYears = Number(profile?.years_of_experience);
  const hasProfileYears = Number.isFinite(profileYears) && profileYears > 0;

  const claimedYears = maxYearsClaim(text);
  const claimList = extractYearsClaims(text);

  // ── Years, upward ──────────────────────────────────────────────────────────
  // Checked across the WHOLE document: a quantity the candidate cannot defend is fabrication
  // wherever it appears, not only in the summary.
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

  // ── Years, downward (AG3) ──────────────────────────────────────────────────
  // The drift AF2 also saw: a resume whose summary states FEWER years than the profile does. It is
  // not a lie to an employer, so it was left silent — but it is the same defect underneath. The
  // profile is the authority on this number, and a document that disagrees with it in EITHER
  // direction was written from something other than the candidate's own facts. Under-claiming
  // costs them the screen they qualified for, silently, on an unattended run they never read.
  //
  // Scoped to the SUMMARY's figure for the reason extractSummaryText explains. A resume that
  // states no total at all is not caught here: that is a different defect (omission, not
  // disagreement), and the section rules are what require the figure.
  const summaryYears = maxYearsClaim(extractSummaryText(html));
  if (hasProfileYears && summaryYears !== null && summaryYears < profileYears) {
    violations.push({
      kind: "years_below_profile",
      claimed: summaryYears,
      allowed: profileYears,
      evidence: extractYearsClaims(extractSummaryText(html))
        .filter(c => c.years === summaryYears)
        .map(c => c.text),
      message:
        `The generated resume's summary claims ${summaryYears} years of experience; the profile ` +
        `states ${profileYears}. The profile is the authority on this number, and the resume ` +
        `disagreeing with it in either direction means it was not written from the candidate's ` +
        `own facts.`,
    });
  }

  // ── Seniority ──────────────────────────────────────────────────────────────
  //
  // THE CANDIDATE DECIDES THEIR LEVEL; WE MAY NOT STRETCH IT.
  //
  // This used to take the BASE RESUME's wording as the only authority, and refuse anything above
  // it. That was too tight in the ordinary case and wrong about who gets to decide. Most resumes
  // never write a level down — two roles both titled "Software Development Engineer" state none —
  // so the supported rank was 0 and NO seniority word was permitted anywhere in the output. A
  // candidate who had chosen "Senior" in their own profile still could not have "Senior" on their
  // resume. Measured: against a JD titled "Senior Platform Engineer", six of eight generations were
  // refused on this rule.
  //
  // The ceiling is now the HIGHER of what the candidate declared and what the base resume already
  // evidences. Declaring is a deliberate act in the profile wizard, and it is theirs to make — the
  // same reasoning AG2 applies to skills, and the same shape as the years rule, where
  // user_profile.years_of_experience is the authority rather than the dates.
  //
  // What is still refused is the generator reaching past that ceiling — a JD's title is not a
  // promotion, and neither is a claimed skill. That is the "we" in "we don't stretch it": the
  // constraint is on this system, not on the person.
  const baseText = String(baseResumeText || "");
  const declaredWord = String(domainProfile?.seniority || "").trim().toLowerCase();
  const declaredRank = DECLARED_SENIORITY_RANK.get(declaredWord);
  const hasDeclaration = declaredRank !== undefined;
  const supported = baseText.trim() ? maxSeniority(baseText) : null;
  const supportedRank = supported ? supported.rank : 0;

  // With neither a declaration nor a base resume there is nothing to check against, and guessing
  // would be the very fault being guarded — so it is skipped rather than assumed.
  if (hasDeclaration || baseText.trim()) {
    const claimed = maxSeniority(text);
    const ceiling = Math.max(hasDeclaration ? declaredRank : 0, supportedRank);
    if (claimed && claimed.rank > ceiling) {
      const allowed = hasDeclaration && declaredRank >= supportedRank
        ? `"${declaredWord}" (the level you chose on this profile)`
        : supported ? `"${supported.word}" (what the base resume shows)` : "no seniority claim";
      violations.push({
        kind: "seniority_unsupported",
        claimed: claimed.word,
        allowed: hasDeclaration && declaredRank >= supportedRank
          ? declaredWord
          : (supported ? supported.word : "(no seniority stated)"),
        evidence: [claimed.word],
        message:
          `The generated resume claims "${claimed.word}" seniority; this profile allows up to ` +
          `${allowed}. A JD's title is not a promotion — change the level on your profile if it is ` +
          `wrong.`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: {
      claimedYears,
      summaryYears,
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
export function profileContradictionFindings({ html, profile, baseResumeText = "", domainProfile = null }) {
  const { violations } = checkResumeClaims({ html, profile, baseResumeText, domainProfile });
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
