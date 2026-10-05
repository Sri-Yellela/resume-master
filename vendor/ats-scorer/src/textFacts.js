// A81 (agent-raised 10-04) — the two facts a résumé's TEXT can state plainly: how long the person has
// worked (its dated roles) and a security clearance it says they hold.
//
// WHY: buildRuntimeAtsBasis took years and clearance from `signalProfile` only. A caller that sends
// just `job` + `resumeText` — every AI assistant calling the tools service over MCP — therefore got
// "profile years are not set" on every posting that asked for years, and a clearance requirement was
// ALWAYS a hard-constraint miss, even against a résumé that says "Active TS/SCI".
//
// ⛔ OPT-IN, AND OFF BY DEFAULT. buildRuntimeAtsBasis reads these only when called with
// `factsFromText: true`, and even then a fact the caller's signalProfile states always wins. draft
// never passes the flag (its users have a profile; its scores, stored reports and basis hashes must
// not move), so draft's path is byte-for-byte what it was. The tools service passes it when a request
// carries no signalProfile.
//
// ⛔ CITIZENSHIP IS NOT READ, DELIBERATELY. Nationality is sensitive personal data, inferring it from a
// résumé is unreliable (an employer's country is not a citizenship), and whether a product should do it
// at all is an owner decision, not an engineering one. A citizenship requirement stays a stated miss.
//
// Conservative by construction: a fact is read only from an unambiguous statement, and a statement that
// is hedged ("eligible for", "able to obtain", "expired", "former") is not one. Under-reading leaves the
// report exactly as it was before A81; over-reading would invent a qualification.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const POINT = `(?:${MONTH}\\s+(\\d{4})|(\\d{1,2})\\s*/\\s*(\\d{4})|(\\d{4}))`;
const OPEN = "(present|current|now|today|ongoing|date)";
// "Aug 2022 – Dec 2023", "03/2019 - present", "2018–2021", "June 2015 to May 2018".
const RANGE = new RegExp(`(?<![\\d/])${POINT}\\s*(?:-|–|—|to|until|through)\\s*(?:${POINT}|${OPEN})(?![\\d/])`, "gi");

// A heading line names a section: short, and nothing but the section's name.
const EXPERIENCE_HEADING = /^\s*(?:professional\s+|work\s+|relevant\s+|industry\s+)?(?:experience|employment(?:\s+history)?|work\s+history|career\s+history)\s*:?\s*$/i;
const OTHER_HEADING = /^\s*(?:summary|profile|objective|about|education|academic\b.*|(?:technical\s+)?skills|core\s+competencies|projects?|(?:personal|academic|selected)\s+projects|certifications?|licenses?|publications?|awards?|honou?rs|volunteer(?:ing)?(?:\s+experience)?|leadership(?:\s+experience)?|activities|interests|languages|references|coursework)\s*:?\s*$/i;
const EDUCATION_LINE = /\b(?:university|college|school|institute of|bachelor|master'?s?|b\.?\s?s\.?c?|m\.?\s?s\.?c?|b\.?\s?a\.?|m\.?\s?b\.?\s?a\.?|ph\.?\s?d|degree|gpa|graduat\w*|coursework)\b/i;

/** One date in a range → months since year 0, or null. */
function monthIndex(monthName, year, monthNum, yearOfNum, yearOnly, { start }) {
  if (year) return Number(year) * 12 + (MONTHS[monthName.toLowerCase().slice(0, 3)] || 1) - 1;
  if (yearOfNum) {
    const m = Number(monthNum);
    return m >= 1 && m <= 12 ? Number(yearOfNum) * 12 + m - 1 : null;
  }
  // A bare year: a start counts from January, an end through December of the year BEFORE — so
  // "2019 – 2021" is two years, as a reader would say, not three.
  if (yearOnly) return Number(yearOnly) * 12 + (start ? 0 : -1);
  return null;
}

/** The lines that hold roles: the experience section when there is one, else everything not education. */
function roleLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let inExperience = false, sawExperience = false;
  for (const line of lines) {
    if (line.length <= 60 && EXPERIENCE_HEADING.test(line)) { inExperience = true; sawExperience = true; continue; }
    if (line.length <= 60 && OTHER_HEADING.test(line)) { inExperience = false; continue; }
    if (inExperience) out.push(line);
  }
  return sawExperience ? out : lines.filter(l => !EDUCATION_LINE.test(l));
}

/**
 * Years of experience from the résumé's dated roles: the UNION of their date ranges (overlapping or
 * concurrent roles are counted once), in whole years, rounded DOWN — a résumé is never credited with
 * more than its dates show. Falls back to a stated "N years of experience" when no role is dated.
 *
 * @param {string} text
 * @param {{ asOf?: number | Date }} [opts] "present" means this moment (default: now). Pass it to pin a result.
 * @returns {{ years: number, source: "dated_roles", roles: number } | { years: number, source: "stated_years" } | null}
 */
export function yearsFromResumeText(text, { asOf = Date.now() } = {}) {
  const now = new Date(asOf);
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans = [];
  for (const line of roleLines(text)) {
    for (const m of line.matchAll(RANGE)) {
      const start = monthIndex(m[1], m[2], m[3], m[4], m[5], { start: true });
      const end = m[11] ? nowIdx : monthIndex(m[6], m[7], m[8], m[9], m[10], { start: false });
      if (start == null || end == null) continue;
      const startYear = Math.floor(start / 12);
      if (startYear < 1960 || start > nowIdx || end < start || end - start > 50 * 12) continue;
      spans.push([start, Math.min(end, nowIdx)]);
    }
  }
  if (spans.length) {
    spans.sort((a, b) => a[0] - b[0]);
    let months = 0, [s, e] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= e + 1) { e = Math.max(e, b); continue; }
      months += e - s + 1;
      [s, e] = [a, b];
    }
    months += e - s + 1;
    return { years: Math.floor(months / 12), source: "dated_roles", roles: spans.length };
  }
  const stated = String(text || "").match(/\b(\d{1,2})\+?\s*(?:years?|yrs?)\.?\s+(?:of\s+)?(?:professional\s+|industry\s+|relevant\s+|hands-on\s+|work\s+)?experience\b/i);
  if (stated && Number(stated[1]) <= 50) return { years: Number(stated[1]), source: "stated_years" };
  return null;
}

// A clearance named outright. "Secret" alone is not one ("trade secret"); it needs "clearance" or a
// qualifier that only a clearance takes.
const CLEARANCE = /\b(?:ts\s*\/\s*sci|top[\s-]+secret(?:\s*\/\s*sci)?(?:\s+(?:security\s+)?clearance)?|(?:active|current|dod|doe)\s+secret(?:\s+(?:security\s+)?clearance)?|secret\s+(?:security\s+)?clearance|(?:active|current)\s+(?:security\s+)?clearance|security\s+clearance|public\s+trust(?:\s+clearance)?|(?:doe\s+)?[ql]\s+clearance)\b/gi;
// A hedge anywhere in the same line means the line does not say the person HOLDS it.
const HEDGE = /\b(?:eligib\w*|to\s+obtain|obtainable|able\s+to|ability\s+to|willing\w*|capable\s+of|pursu\w*|seek\w*|expired|lapsed|inactive|former(?:ly)?|previous(?:ly)?|prior|pending|in\s+process|interim|not|no|without|requir\w*|sponsor\w*|can\s+obtain|could\s+obtain|if\s+needed)\b/i;

/**
 * A security clearance the résumé states the person holds, or null. Returns the words it read, so a
 * report can show what it relied on.
 * @returns {{ stated: true, text: string } | null}
 */
export function clearanceFromResumeText(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    if (HEDGE.test(line)) continue;
    const m = line.match(CLEARANCE);
    if (m) return { stated: true, text: m[0].replace(/\s+/g, " ").trim() };
  }
  return null;
}
