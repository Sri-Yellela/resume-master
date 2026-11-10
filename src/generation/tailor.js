// D123 P2 · THE LEAN TAILORING CALL — the model edits bullets and skills; code builds the résumé.
//
// Why (docs/LLM_AUDIT.md in draft, 11-01): the full path sends a ≈ 5,900-token static prompt and gets the WHOLE résumé
// back as HTML — ≈ 3,400–4,000 output tokens, most of it markup and CSS the formatter rebuilds anyway
// (normalizeResumeHtml = renderStructuredResume(buildStructuredResume(html))). Here:
//
//   1. the base résumé is parsed by the SAME parser (buildStructuredResume) — no model;
//   2. the model sees only the bullets (each with an id), the skills rows and the caller's keywords, and returns JSON
//      of CHANGES ONLY: { bullets: { id: newText }, skills: [{ label, values }] };
//   3. code applies the changes, then checks them deterministically (checkLeanChanges): no number a bullet did not
//      already carry, no skill the candidate cannot support, a KB-placed term only at its own employer;
//   4. a violation or unreadable JSON gets ONE repair call, on the stronger model, carrying the exact messages
//      (D123 P2 + P3: Haiku first, Sonnet only after a guard failure on Haiku); anything still refused after that is
//      REVERTED to the candidate's own text — never a third call;
//   5. renderStructuredResume draws the document, and the contractual claim guard (assertResumeClaims) runs on it as
//      on every document this service returns.
//
// Header, employers, titles, dates, education and section order never pass through the model, so it cannot change
// them. The summary is not rewritten here: with options.includeSummary off it is removed (the toggle's meaning), on,
// the candidate's own summary stands.
//
// ⛔ "PUSH ATS, WITHIN THE CANDIDATE'S OWN COMPANIES" (owner 11-01). job.keywords.placements carries posting terms the
// base résumé does not show but the CALLER's knowledge base shows in the stack of one of the candidate's employers.
// Such a term may be named only in a bullet of THAT employer, as part of work the bullet already describes, and may be
// added to Skills. The caller decides the placements; the model words them; the guard holds them to their employer.
import { UNTRUSTED_DATA_RULE, fenceInline } from "../integrity/untrustedText.js";
import { buildStructuredResume, renderStructuredResume } from "../formatting/resumeFormatter.js";
import { callAnthropic, textOf, MODEL_HAIKU, MODEL_SONNET } from "../model/anthropicCall.js";
import { tailorRoute } from "../model/modelClient.js";
import { applyPromptConditionals } from "./promptAssembler.js";
import { bulletCraftText } from "./bulletCraft.js";
import { ResumeUnparsedError } from "../errors.js";

/** Non-space characters a base needs before "no sections" means unreadable rather than empty (a header is ≈ 80). */
export const UNPARSED_MIN_CHARS = 200;

export const TAILOR_MODEL = MODEL_HAIKU;
export const TAILOR_REPAIR_MODEL = MODEL_SONNET;
export const TAILOR_MAX_TOKENS = 2000;
export const BULLET_MAX_CHARS = 320;
// D123 P6a / P6g / P6d (contract 1.8.0): the variants of this one path. "lean" is 1.7.0's call, unchanged; "payload"
// sends the job block and the per-employer gists and lets the model write a new bullet where a gist supports it;
// "code" never calls a model (P6d, the free tier) — and "payload" falls to it when no bullet has anything to gain.
export const VARIANTS = Object.freeze(["lean", "payload", "code"]);
export const GIST_MODEL = MODEL_SONNET;
export const GIST_MAX_TOKENS = 1500;
export const GIST_MAX_CHARS = 400;
export const NEW_BULLETS_PER_ENTRY = 2;
export const BOLD_PER_BULLET = 2;
export const TERM_MAX_BULLETS = 2;
export const COURSEWORK_MAX = 6;

const LEAN_RULES = `You tailor an existing resume to one job posting so it scores as high as honestly possible in an applicant tracking system (ATS). You EDIT; you do not write a new resume.

INPUT: the target job and its keywords, then the resume's bullets (each with an id like e1b2) and its skills rows.

GOAL: every keyword the resume can honestly carry appears VERBATIM (exact spelling and casing of the keyword list) in a bullet or in skills, and bullets lead with the posting's priorities.
- EVIDENCED and CLAIMED terms: work them into the bullets whose work they describe, and make sure each is in skills.
- PLACEABLE terms (term @ employer): the employer's own stack includes it. Use it ONLY in a bullet of that employer, ONLY as a tool or practice inside work the bullet already describes. Never as a new project, responsibility or result. Add it to skills.
- A keyword no bullet can honestly carry is left out. Never force one.

HARD RULES (code checks them; a broken rule is reverted):
- Never add a number, and never drop one: every number a bullet states stays in it.
- Never change employers, titles, dates, levels or seniority, and never claim sole ownership the bullet does not state.
- Skills: keep every existing skill; put posting keywords first in each row; add only evidenced, claimed or placeable terms.
- Leave a bullet OUT of your answer when it gains nothing. Fewer, better edits beat rewriting everything.

OUTPUT: JSON only, no prose, no code fence:
{"bullets":{"e1b1":"new text"},"skills":[{"label":"Languages","values":"Python, SQL"}]}
"skills" holds the full rows in their new order, or is omitted when nothing changes.
Bullet order is set by code (most must-have terms first within each employer); edit a bullet's text, never its place.`;

// D123 P6f: the owner's craft (prompts/bullet_craft.md) is the bullet half of this prompt — the same file the full call
// reads. The lean call never rewrites a summary, so the craft's SUMMARY rules are resolved off.
export const LEAN_SYSTEM = `${LEAN_RULES}

${applyPromptConditionals(bulletCraftText(), { SUMMARY: false }).trim()}

${UNTRUSTED_DATA_RULE}`;

// D123 P6a + P6g: the payload variant's rules. The same craft file follows them (P6f: no second copy of the rules).
const PAYLOAD_RULES = `You tailor an existing resume to one job posting so it scores as high as honestly possible in an applicant tracking system (ATS). You REWORD the candidate's own bullets first; you do not write a new resume.

INPUT: the JOB block (must-have terms, nice-to-have terms, the posting's own action verbs ranked, its level, its responsibilities), then the CANDIDATE block: for each employer, a short gist of the work done there, the posting terms that employer's bullets already show, and the bullets (each with an id like e1b2); then the skills rows.

GOAL: every must-have term the candidate can honestly carry appears VERBATIM (exact spelling and casing) in a bullet or in skills; bullets open with the posting's own verbs where the work fits them.
- REWORD FIRST: change a bullet's wording to use the posting's terms and verbs, keeping its numbers and specifics.
- NEW BULLET: only for a MUST-HAVE term no bullet carries AND the employer's gist plainly covers. It describes work the gist states, in the craft's shape, with NO number. At most ${NEW_BULLETS_PER_ENTRY} per employer. Never for an employer without a gist.
- PLACEABLE terms (term @ employer): only in a bullet of that employer, only as a tool or practice inside work the bullet already describes.
- Bold at most ${BOLD_PER_BULLET} posting terms per bullet, and no term in more than ${TERM_MAX_BULLETS} bullets.
- A term no bullet can honestly carry is left out. Never force one.

HARD RULES (code checks them; a broken rule is reverted):
- Never add a number, and never drop one: every number a bullet states stays in it.
- Never change employers, titles, dates, levels or seniority, and never claim sole ownership the bullet does not state.
- Nothing outside the employer's gist: no new system, product, team or outcome.
- Skills: keep every existing skill; put posting terms first in each row; add only evidenced, claimed, broader or placeable terms.
- Leave a bullet OUT of your answer when it gains nothing.

OUTPUT: JSON only, no prose, no code fence:
{"bullets":{"e1b1":"new text"},"new":{"e1":["a new bullet"]},"skills":[{"label":"Languages","values":"Python, SQL"}]}
"new" and "skills" are omitted when empty. Bullet order is set by code; edit a bullet's text, never its place.`;

export const PAYLOAD_SYSTEM = `${PAYLOAD_RULES}

${applyPromptConditionals(bulletCraftText(), { SUMMARY: false }).trim()}

${UNTRUSTED_DATA_RULE}`;

// D123 P6g (2): the gist is built ONCE per base résumé, on the stronger model; the caller stores it and sends it back.
export const GIST_SYSTEM = `For each employer entry of a resume, write a gist of the work the person did there: 2 to 3 plain sentences, at most ${GIST_MAX_CHARS} characters — their role and scope, the domain, the kinds of systems they built or ran and the outcomes they worked toward.
- Only what the entry's own lines state or plainly imply. Never add a tool, system, number or result.
- No team names, internal project or product code names, client names or anything that reads as confidential.
- No numbers at all.
OUTPUT: JSON only, no prose, no code fence: {"e1":"gist","e2":"gist"} — one key per entry id given.`;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const plain = (s) => String(s ?? "").replace(/\*\*/g, "");

/** Bullets of every entries section, in document order, each with a stable id (e{entry}b{bullet}, 1-based). */
export function indexBullets(structure) {
  const out = [];
  let e = 0;
  for (const section of structure.sections || []) {
    if (section.type !== "entries") continue;
    for (const entry of section.entries || []) {
      e++;
      (entry.bullets || []).forEach((text, i) => out.push({ id: `e${e}b${i + 1}`, section: section.title, entry, index: i, text }));
    }
  }
  return out;
}

function skillsSection(structure) {
  return (structure.sections || []).find(s => s.type === "skills") || null;
}

/** The user message: the job's keywords, then the bullets and skills rows. Nothing else of the résumé is sent. */
export function renderTailorInput({ structure, job = {}, keywords = {} }) {
  const list = (k) => (keywords[k] || []).filter(Boolean).join(", ");
  const placements = (keywords.placements || []).map(p => `${p.term} @ ${p.employer}`).join("; ");
  const line = (label, v) => (v ? `${label}: ${v}\n` : "");
  let out = `TARGET JOB: ${job.title || ""}${job.company ? ` at ${job.company}` : ""}\n`;
  out += line("Posting level (the posting's, never the candidate's)", keywords.seniority || "");
  out += line("EVIDENCED terms (the resume already supports them)", list("matched"));
  out += line("CLAIMED terms (the candidate says they are true)", list("claimed"));
  out += line("PLACEABLE terms (term @ employer whose stack has it)", placements);
  out += line("Posting verbs", list("verbs"));
  out += line("Posting competencies", list("competencies"));
  // ⛔ draft D173 (1): the posting's own phrases are free text — fenced as untrusted data.
  out += line("Posting priorities", fenceInline((keywords.phrases || []).join("; ")));
  out += "\nRESUME BULLETS\n";
  let last = null;
  for (const b of indexBullets(structure)) {
    if (b.entry !== last) {
      last = b.entry;
      out += `[${b.section}] ${[b.entry.company, b.entry.role, b.entry.meta, b.entry.date].filter(Boolean).join(" | ")}\n`;
    }
    out += `  ${b.id}: ${plain(b.text)}\n`;
  }
  const skills = skillsSection(structure);
  if (skills?.rows?.length) {
    out += "\nSKILLS ROWS\n";
    for (const r of skills.rows) out += `  ${r.label ? `${r.label}: ` : ""}${r.values}\n`;
  }
  return out;
}

/** Every entry of every entries section, in document order, with the id its bullets carry (e1, e2 …). */
export function indexEntries(structure) {
  const out = [];
  let e = 0;
  for (const section of structure.sections || []) {
    if (section.type !== "entries") continue;
    for (const entry of section.entries || []) out.push({ id: `e${++e}`, section: section.title, entry });
  }
  return out;
}

/** The caller's gist for an entry: matched on the entry's header line (the caller keys a gist by that header). */
export function gistFor(entry, gists = []) {
  const h = norm(entryHeader(entry));
  if (!h) return "";
  const g = gists.find(x => { const y = norm(x?.employer); return y && (h === y || h.includes(y) || y.includes(h)); });
  return g ? String(g.text || "").slice(0, GIST_MAX_CHARS) : "";
}

const allTerms = (keywords = {}) => [...new Set([...(keywords.mustHave || []), ...(keywords.matched || []), ...(keywords.claimed || []),
  ...(keywords.placements || []).map(p => p.term), ...(keywords.niceToHave || [])].filter(Boolean))];

/**
 * D123 P6a · the payload's user message: the job block, then per employer its gist, the posting terms its bullets
 * already show and the bullets themselves (P6g (1): the originals travel with the gist); then the skills rows.
 */
export function renderPayloadInput({ structure, job = {}, keywords = {}, gists = [] }) {
  const list = (k) => (keywords[k] || []).filter(Boolean).join(", ");
  const line = (label, v) => (v ? `${label}: ${v}\n` : "");
  const placements = (keywords.placements || []).map(p => `${p.term} @ ${p.employer}`).join("; ");
  let out = `JOB\nTARGET: ${job.title || ""}${job.company ? ` at ${job.company}` : ""}\n`;
  out += line("Level (the posting's, never the candidate's)", keywords.seniority || "");
  out += line("MUST-HAVE terms", list("mustHave") || list("matched"));
  out += line("Nice-to-have terms", list("niceToHave"));
  out += line("Posting verbs, most used first", list("verbs"));
  out += line("Responsibilities", fenceInline((keywords.phrases || []).slice(0, 8).join("; ")));
  out += line("EVIDENCED terms (the resume already supports them)", list("matched"));
  out += line("CLAIMED terms (the candidate says they are true)", list("claimed"));
  out += line("PLACEABLE terms (term @ employer whose stack has it)", placements);
  out += "\nCANDIDATE\n";
  const bullets = indexBullets(structure);
  const terms = allTerms(keywords);
  for (const { id, section, entry } of indexEntries(structure)) {
    out += `[${id}] [${section}] ${[entry.company, entry.role, entry.meta, entry.date].filter(Boolean).join(" | ")}\n`;
    const gist = gistFor(entry, gists);
    if (gist) out += `  Gist: ${gist}\n`;
    const mine = bullets.filter(b => b.entry === entry);
    const shown = terms.filter(t => mine.some(b => termIn(b.text, t)));
    if (shown.length) out += `  Terms shown: ${shown.join(", ")}\n`;
    for (const b of mine) out += `  ${b.id}: ${plain(b.text)}\n`;
  }
  const skills = skillsSection(structure);
  if (skills?.rows?.length) {
    out += "\nSKILLS ROWS\n";
    for (const r of skills.rows) out += `  ${r.label ? `${r.label}: ` : ""}${r.values}\n`;
  }
  return out;
}

/** The model's JSON, or null when it is not the shape asked for. */
export function parseChanges(text) {
  const raw = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j;
  try { j = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const bullets = {};
  if (j.bullets && typeof j.bullets === "object" && !Array.isArray(j.bullets)) {
    for (const [id, t] of Object.entries(j.bullets)) if (typeof t === "string" && t.trim()) bullets[id] = t.trim();
  }
  let skills = null;
  if (Array.isArray(j.skills)) {
    skills = j.skills.filter(r => r && typeof r.values === "string").map(r => ({ label: typeof r.label === "string" ? r.label : "", values: r.values }));
  }
  // D123 P6a: new bullets per entry id. Read only by the payload variant; the lean variant never sees the key.
  const added = {};
  if (j.new && typeof j.new === "object" && !Array.isArray(j.new)) {
    for (const [id, list] of Object.entries(j.new)) {
      const texts = (Array.isArray(list) ? list : [list]).filter(t => typeof t === "string" && t.trim()).map(t => t.trim());
      if (/^e\d+$/.test(id) && texts.length) added[id] = texts;
    }
  }
  return Object.keys(added).length ? { bullets, skills, added } : { bullets, skills };
}

// Standalone numbers only: "40,000", "2.5", "78%" count; "S3", "EC2", "p95", "OAuth 2.0" do not (a letter touches them).
// One k / M / B suffix is read as a multiplier (D123 P6e, the audit's R8): "40,000" and "40k" are the same number, so
// rewording one as the other is neither an added nor a dropped number.
const NUMBER_RE = /(?<![A-Za-z0-9.])(\d[\d,]*(?:\.\d+)?)([kKmMbB])?(?![A-Za-z0-9])/g;
const MULT = { k: 1e3, m: 1e6, b: 1e9 };
const numbersOf = (s) => new Set([...plain(s).matchAll(NUMBER_RE)].map(([, n, x]) => {
  const v = Number(n.replace(/,/g, "")) * (x ? MULT[x.toLowerCase()] : 1);
  return String(Math.round(v * 1000) / 1000);
}));
// D123 P6f (3): words that claim sole ownership. A rewrite may use one only when the candidate's own bullet does.
const SOLE_OWNERSHIP_RE = /\b(led|owned|spearheaded|single[- ]handedly|solely|headed)\b/gi;
const ownershipWords = (s) => new Set((plain(s).match(SOLE_OWNERSHIP_RE) || []).map(w => w.toLowerCase().replace(/[- ]/, "-")));
const splitValues = (v) => String(v || "").split(/\s*[,|·;]\s*/).map(x => x.trim()).filter(Boolean);
const termIn = (text, term) => {
  const t = norm(term);
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+#])${esc}($|[^a-z0-9+#])`, "i").test(norm(text));
};
// The parser files "Title, Employer, City" with the title in `company` and the employer in `meta`, and the reverse for
// "Employer — Title", so an employer is looked for in the entry's whole header line.
const entryHeader = (entry) => [entry.company, entry.role, entry.meta].filter(Boolean).join(" | ");
const atEmployer = (entry, employer) => { const h = norm(entryHeader(entry)), y = norm(employer); return !!y && h.includes(y); };

/**
 * The deterministic checks on a set of changes. Returns { violations, bullets, skills }: `bullets` and `skills` are
 * what may be applied (an unknown id is dropped silently — it changes nothing), `violations` what must be repaired or
 * reverted. A removed skill is not a violation: code puts it back (the candidate's skills are never dropped).
 */
export function checkLeanChanges({ structure, baseResumeText = "", changes, keywords = {}, claims = null }) {
  const violations = [];
  const byId = new Map(indexBullets(structure).map(b => [b.id, b]));
  const placements = keywords.placements || [];
  const supported = (term) => termIn(baseResumeText, term)
    || (keywords.matched || []).some(t => norm(t) === norm(term))
    || (keywords.claimed || []).some(t => norm(t) === norm(term))
    || (keywords.broader || []).some(b => norm(b.term) === norm(term))
    || (claims?.skills || []).some(t => norm(t) === norm(term));
  const bullets = {};
  // ⛔ draft 46a: `let`, not `const` — the dash rule below rewrites `text`. With `const`, every edited bullet carrying an en
  // or em dash threw "Assignment to constant variable" AFTER the model call, and the whole generation answered 500
  // (production 11-07 → 11-10: every lean / payload résumé whose model output had a dash).
  for (let [id, text] of Object.entries(changes?.bullets || {})) {
    const b = byId.get(id);
    if (!b) continue;
    if (plain(text).length > BULLET_MAX_CHARS) { violations.push({ kind: "bullet_too_long", id, message: `${id} is longer than ${BULLET_MAX_CHARS} characters.` }); continue; }
    const before = numbersOf(b.text);
    const added = [...numbersOf(text)].filter(n => !before.has(n));
    if (added.length) { violations.push({ kind: "number_not_in_bullet", id, evidence: added, message: `${id} adds ${added.join(", ")}, which the original bullet does not state. Keep the bullet's own numbers and add none.` }); continue; }
    const after = numbersOf(text);
    const dropped = [...before].filter(n => !after.has(n));
    if (dropped.length) { violations.push({ kind: "number_dropped", id, evidence: dropped, message: `${id} drops ${dropped.join(", ")}, which the original bullet states. Keep every number the candidate gave and bring it into the result.` }); continue; }
    const ownBefore = ownershipWords(b.text);
    const claimed = [...ownershipWords(text)].filter(w => !ownBefore.has(w));
    if (claimed.length) { violations.push({ kind: "sole_ownership_claimed", id, evidence: claimed, message: `${id} says "${claimed.join(", ")}", a claim of sole ownership the original bullet does not make. Use a contribution verb from the BULLET CRAFT instead.` }); continue; }
    const misplaced = placements.filter(p => termIn(text, p.term) && !termIn(b.text, p.term) && !supported(p.term) && !atEmployer(b.entry, p.employer));
    if (misplaced.length) { violations.push({ kind: "term_wrong_employer", id, evidence: misplaced.map(p => p.term), message: `${id} names ${misplaced.map(p => `${p.term} (placeable only at ${p.employer})`).join(", ")} in "${entryHeader(b.entry) || "another entry"}".` }); continue; }
    if (/[–—]/.test(text)) text = text.replace(/\s*[–—]\s*/g, ", ");
    bullets[id] = text;
  }
  let skills = null;
  const base = skillsSection(structure);
  if (changes?.skills && base) {
    const baseValues = (base.rows || []).flatMap(r => splitValues(r.values));
    const known = new Set(baseValues.map(norm));
    const unsupported = [];
    const rows = changes.skills.map(r => ({ label: r.label, values: splitValues(r.values).filter(v => {
      if (known.has(norm(v)) || supported(v) || placements.some(p => norm(p.term) === norm(v))) return true;
      unsupported.push(v); return false;
    }) }));
    if (unsupported.length) violations.push({ kind: "skill_not_supported", id: "skills", evidence: unsupported, message: `Skills adds ${unsupported.join(", ")}: not in the resume, not claimed and not placeable.` });
    const kept = new Set(rows.flatMap(r => r.values).map(norm));
    const dropped = baseValues.filter(v => !kept.has(norm(v)));
    if (dropped.length) {
      if (rows.length) rows[rows.length - 1].values.push(...dropped);
      else rows.push({ label: "", values: dropped });
    }
    skills = rows.filter(r => r.values.length).map(r => ({ label: r.label, values: r.values.join(", ") }));
  }
  return { violations, bullets, skills };
}

/** D123 P6g (3): at most BOLD_PER_BULLET bold spans in a bullet — the first ones stay, the rest are unbolded. */
export function capBold(text, max = BOLD_PER_BULLET) {
  let n = 0;
  return String(text).replace(/\*\*([^*]+)\*\*/g, (m, inner) => (++n <= max ? m : inner));
}

/**
 * D123 P6a + P6g · the payload variant's checks: everything checkLeanChanges holds, plus the new bullets and the
 * density cap. Returns { violations, bullets, skills, added } — `added` is { entryId: [text] } that may be applied.
 *
 * A NEW bullet is accepted only when its entry has a gist; it states no number and no sole ownership; it carries at
 * least one posting term that entry's bullets do not; and every posting term in it is in the gist, the entry's own
 * bullets, the candidate's claims or a placement AT that employer ("every bullet stays within its employer's gist",
 * P6e — in code). A term the edits put in more than TERM_MAX_BULLETS bullets is refused in the bullets that added it.
 */
export function checkPayloadChanges({ structure, baseResumeText = "", changes, keywords = {}, claims = null, gists = [] }) {
  const base = checkLeanChanges({ structure, baseResumeText, changes, keywords, claims });
  const violations = [...base.violations];
  const bullets = Object.fromEntries(Object.entries(base.bullets).map(([id, t]) => [id, capBold(t)]));
  const all = indexBullets(structure);
  const entries = new Map(indexEntries(structure).map(x => [x.id, x]));
  const terms = allTerms(keywords);
  const added = {};
  for (const [eid, texts] of Object.entries(changes?.added || {})) {
    const x = entries.get(eid);
    if (!x) continue;
    const gist = gistFor(x.entry, gists);
    const own = all.filter(b => b.entry === x.entry).map(b => b.text);
    texts.forEach((raw, i) => {
      const id = `${eid}+${i + 1}`;
      let text = capBold(raw);
      if (!gist) { violations.push({ kind: "new_bullet_without_gist", id, message: `${eid} has no gist, so no new bullet may be written for it.` }); return; }
      if ((added[eid]?.length || 0) >= NEW_BULLETS_PER_ENTRY) { violations.push({ kind: "too_many_new_bullets", id, message: `${eid} already has ${NEW_BULLETS_PER_ENTRY} new bullets.` }); return; }
      if (plain(text).length > BULLET_MAX_CHARS) { violations.push({ kind: "bullet_too_long", id, message: `${id} is longer than ${BULLET_MAX_CHARS} characters.` }); return; }
      const nums = [...numbersOf(text)];
      if (nums.length) { violations.push({ kind: "number_not_in_bullet", id, evidence: nums, message: `The new bullet for ${eid} states ${nums.join(", ")}. A new bullet carries no number.` }); return; }
      const sole = [...ownershipWords(text)];
      if (sole.length) { violations.push({ kind: "sole_ownership_claimed", id, evidence: sole, message: `The new bullet for ${eid} says "${sole.join(", ")}". Use a contribution verb.` }); return; }
      const carried = terms.filter(t => termIn(text, t));
      if (!carried.some(t => !own.some(o => termIn(o, t)))) { violations.push({ kind: "new_bullet_no_must_have", id, message: `The new bullet for ${eid} adds no posting term its other bullets lack.` }); return; }
      const inScope = (t) => termIn(gist, t) || own.some(o => termIn(o, t))
        || (keywords.claimed || []).some(c => norm(c) === norm(t)) || (claims?.skills || []).some(c => norm(c) === norm(t))
        || (keywords.placements || []).some(p => norm(p.term) === norm(t) && atEmployer(x.entry, p.employer));
      const outside = carried.filter(t => !inScope(t));
      if (outside.length) { violations.push({ kind: "outside_gist", id, evidence: outside, message: `The new bullet for ${eid} names ${outside.join(", ")}, which its gist and bullets do not cover.` }); return; }
      if (/[–—]/.test(text)) text = text.replace(/\s*[–—]\s*/g, ", ");
      (added[eid] ||= []).push(text);
    });
  }
  // The density cap: the candidate's own bullets count first (they are theirs), then the edits in document order.
  const finalTexts = [
    ...all.map(b => ({ id: b.id, text: bullets[b.id] ?? b.text, own: b.text, edited: b.id in bullets })),
    ...Object.entries(added).flatMap(([eid, list]) => list.map((text, i) => ({ id: `${eid}+${i + 1}`, text, own: "", edited: true }))),
  ];
  for (const t of terms) {
    let seen = finalTexts.filter(b => !b.edited && termIn(b.text, t)).length;
    for (const b of finalTexts.filter(b => b.edited && termIn(b.text, t))) {
      if (termIn(b.own, t)) { seen++; continue; }
      if (++seen <= TERM_MAX_BULLETS) continue;
      violations.push({ kind: "term_overused", id: b.id, evidence: [t], message: `${b.id} adds ${t}, which is already in ${TERM_MAX_BULLETS} bullets.` });
      if (b.id.includes("+")) { const [eid, n] = b.id.split("+"); added[eid][Number(n) - 1] = null; }
      else delete bullets[b.id];
    }
  }
  for (const eid of Object.keys(added)) { added[eid] = added[eid].filter(Boolean); if (!added[eid].length) delete added[eid]; }
  return { violations, bullets, skills: base.skills, added };
}

/**
 * D123 P6d · THE FREE TIER, in code: the Skills rows the posting stresses first (each row's posting terms lead it, rows
 * with more of them come first), the caller's broader terms placed beside the skill that implies them, claimed posting
 * terms added, and a "Relevant Coursework" row from the candidate's own courses (most posting-relevant first). No model.
 */
export function codeSkills(structure, keywords = {}, coursework = []) {
  const section = skillsSection(structure);
  if (!section) return null;
  const order = [...(keywords.mustHave || []), ...(keywords.matched || []), ...(keywords.claimed || []), ...(keywords.broader || []).map(b => b.term), ...(keywords.niceToHave || [])].map(norm);
  const rank = (v) => { const i = order.indexOf(norm(v)); return i < 0 ? Infinity : i; };
  let rows = (section.rows || []).filter(r => !/^relevant coursework$/i.test(r.label || "")).map(r => ({ label: r.label, values: splitValues(r.values) }));
  const have = () => new Set(rows.flatMap(r => r.values).map(norm));
  for (const b of keywords.broader || []) {
    if (have().has(norm(b.term))) continue;
    const row = rows.find(r => r.values.some(v => norm(v) === norm(b.from)));
    if (row) row.values.splice(row.values.findIndex(v => norm(v) === norm(b.from)) + 1, 0, b.term);
  }
  const claimed = (keywords.claimed || []).filter(t => !have().has(norm(t)));
  if (claimed.length && rows.length) rows[0].values.push(...claimed);
  rows = rows.map((r, i) => ({ ...r, i, values: r.values.map((v, j) => ({ v, j, k: rank(v) })).sort((a, b) => a.k - b.k || a.j - b.j).map(x => x.v) }));
  const hits = (r) => r.values.filter(v => rank(v) < Infinity).length;
  rows.sort((a, b) => hits(b) - hits(a) || a.i - b.i);
  const out = rows.map(r => ({ label: r.label, values: r.values.join(", ") }));
  const courses = (coursework || []).map(c => String(c).trim()).filter(Boolean);
  if (courses.length) {
    const terms = allTerms(keywords);
    const score = (c) => terms.filter(t => termIn(c, t) || termIn(t, c)).length;
    const picked = courses.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, COURSEWORK_MAX).map(x => x.c);
    out.push({ label: "Relevant Coursework", values: picked.join(", ") });
  }
  return out;
}

/** D123 P6d: does any bullet have something to gain from the model? A term to carry that no bullet carries yet. */
export function bulletsNeedModel(structure, keywords = {}, gists = []) {
  const texts = indexBullets(structure).map(b => b.text);
  const want = [...(keywords.matched || []), ...(keywords.claimed || []), ...(keywords.placements || []).map(p => p.term),
    ...(keywords.mustHave || []).filter(t => gists.some(g => termIn(g?.text, t)))];
  return want.some(t => !texts.some(x => termIn(x, t)));
}

/** The posting's terms a bullet carries (D123 P6f (4)): evidenced, claimed and placeable keywords, counted once each. */
export function mustHaveCount(text, keywords = {}) {
  const terms = new Set([...(keywords.matched || []), ...(keywords.claimed || []), ...(keywords.placements || []).map(p => p.term)]
    .filter(Boolean).map(norm));
  let n = 0;
  for (const t of terms) if (termIn(text, t)) n++;
  return n;
}

/**
 * A new structure with the accepted changes applied; the input is not mutated.
 * D123 P6f (4) ORDER FOR RELEVANCE: within each entry, bullets are ordered by how many of the posting's terms they carry
 * (a stable sort — ties keep the candidate's order). Entries themselves never move: employers stay in date order.
 */
export function applyChanges(structure, { bullets = {}, skills = null, added = null } = {}, { includeSummary = false, keywords = null } = {}) {
  const next = JSON.parse(JSON.stringify(structure));
  const ids = indexBullets(next);
  for (const b of ids) if (bullets[b.id]) b.entry.bullets[b.index] = bullets[b.id];
  // D123 P6a: a new bullet joins its entry's list; the relevance order below places it.
  const entries = indexEntries(next);
  for (const { id, entry } of entries) if (added?.[id]?.length) entry.bullets = [...(entry.bullets || []), ...added[id]];
  if (keywords) {
    for (const entry of new Set([...ids.map(b => b.entry), ...entries.filter(x => added?.[x.id]?.length).map(x => x.entry)])) {
      entry.bullets = entry.bullets.map((text, i) => ({ text, i, n: mustHaveCount(text, keywords) }))
        .sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.text);
    }
  }
  if (skills) { const s = skillsSection(next); if (s) s.rows = skills; }
  if (!includeSummary) next.sections = next.sections.filter(s => s.type !== "summary");
  return next;
}

/// Three call sites, each with its literal purpose (test/d17ModelCallSites.test.js reads them).
// D123 P3: the tailoring call's client and model come from configuration (src/model/modelClient.js tailorRoute) — Anthropic's
// Haiku unless RM_TAILOR_PROVIDER names another, or the request's options.model names one (1.8.0); the repair below always
// stays on Anthropic's Sonnet.
// Sonnet 5 thinks by default and max_tokens covers thinking + output (generate.js says why that matters).
const noThinking = (model) => (model === MODEL_SONNET ? { thinking: { type: "disabled" } } : {});

async function askTailor(route, system, user, usage) {
  const r = await callAnthropic(route.client, {
    purpose: "resume_tailor", model: route.model, max_tokens: TAILOR_MAX_TOKENS, ...noThinking(route.model),
    system, messages: [{ role: "user", content: user }],
  }).catch(e => { if (e?.usage) usage.push(e.usage); throw e; });
  usage.push(r.usage);
  return textOf(r.message);
}

async function askRepair(client, system, user, usage) {
  const r = await callAnthropic(client, {
    purpose: "resume_tailor_repair", model: TAILOR_REPAIR_MODEL, max_tokens: TAILOR_MAX_TOKENS,
    thinking: { type: "disabled" },
    system, messages: [{ role: "user", content: user }],
  }).catch(e => { if (e?.usage) usage.push(e.usage); throw e; });
  usage.push(r.usage);
  return textOf(r.message);
}

/**
 * D123 P6g (2) · the per-employer gists, built ONCE per base résumé on the Sonnet tier. The caller stores them with the
 * résumé, shows them to the candidate (editable) and sends them back with every payload tailoring.
 * @returns { gists: [{ employer, text }], numberless: [{ employer, bullet }], usage }
 *   `employer` is the entry's header line (what gistFor matches on); `numberless` lists the bullets that state no number,
 *   for the caller's optional "add a real number if you have one" prompt (P6g).
 */
export async function buildGists(client, { baseResumeText }) {
  const usage = [];
  const structure = buildStructuredResume(baseResumeText);
  const entries = indexEntries(structure).filter(x => /EXPERIENCE/i.test(x.section || ""));
  const numberless = indexBullets(structure).filter(b => /EXPERIENCE/i.test(b.section || "") && numbersOf(b.text).size === 0)
    .map(b => ({ employer: entryHeader(b.entry), bullet: plain(b.text) }));
  if (!entries.length) return { gists: [], numberless, usage };
  const user = entries.map(({ id, entry }) =>
    `[${id}] ${[entry.company, entry.role, entry.meta, entry.date].filter(Boolean).join(" | ")}\n${(entry.bullets || []).map(b => `  - ${plain(b)}`).join("\n")}`).join("\n");
  try {
    const r = await callAnthropic(client, {
      purpose: "resume_gist", model: GIST_MODEL, max_tokens: GIST_MAX_TOKENS, thinking: { type: "disabled" },
      system: GIST_SYSTEM, messages: [{ role: "user", content: user }],
    }).catch(e => { if (e?.usage) usage.push(e.usage); throw e; });
    usage.push(r.usage);
    const raw = String(textOf(r.message) || "").replace(/```(?:json)?/gi, "").trim();
    let j = null;
    try { j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { j = null; }
    // A gist that states a number is dropped (P6g: gists carry none); an unreadable answer yields no gists, never a guess.
    const gists = entries.map(({ id, entry }) => ({ employer: entryHeader(entry), text: typeof j?.[id] === "string" ? j[id].trim().slice(0, GIST_MAX_CHARS) : "" }))
      .filter(g => g.employer && g.text && numbersOf(g.text).size === 0);
    return { gists, numberless, usage };
  } catch (e) {
    throw Object.assign(e, { usageSoFar: usage });
  }
}

/**
 * @param variant  "lean" (1.7.0) | "payload" (P6a + P6g) | "code" (P6d — no model)
 * @param model    the request's options.model ("haiku" | "sonnet" | "open"), or null for the configured default
 * @returns { html, tailoring: { mode, model, repaired, changed, added?, modelCalled?, refused: [{ id, kind }] }, usage }
 * Throws a ModelCallError (with `usageSoFar`) when a call fails.
 */
export async function tailorResume(client, { baseResumeText, job = {}, keywords = {}, claims = null, includeSummary = false,
                                              variant = "lean", model: choice = null, gists = [], coursework = [], env = process.env }) {
  const usage = [];
  const structure = buildStructuredResume(baseResumeText);
  // ⛔ Never answer a real résumé with its header alone. A base that is real text (≥ UNPARSED_MIN_CHARS of it) and
  // reads as zero sections would render as the name and contact line and still answer 200 — before any model call.
  if (!structure.sections.length && String(baseResumeText || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, "").length >= UNPARSED_MIN_CHARS) {
    throw new ResumeUnparsedError("No section heading in the base résumé could be read (Experience, Education, Skills, Projects, " +
      "Summary), so tailoring would return only its header. Put each heading on its own line, or send the résumé as HTML.");
  }
  const payload = variant === "payload";
  const codeOnly = variant === "code" || (payload && !bulletsNeedModel(structure, keywords, gists));
  // P6d: the free tier's Skills rows and coursework are code's, for "code" and "payload" alike; the model's own skills
  // answer (payload) is checked first and then ordered by the same code, so the two never disagree.
  const coded = variant !== "lean";
  const finish = (accepted, meta) => {
    const skills = coded
      ? codeSkills({ sections: [{ type: "skills", rows: accepted.skills || skillsSection(structure)?.rows || [] }] }, keywords, coursework)
      : accepted.skills;
    const html = renderStructuredResume(applyChanges(structure, { ...accepted, skills }, { includeSummary, keywords }));
    return {
      html,
      tailoring: { mode: variant, ...meta,
                   changed: Object.keys(accepted.bullets).length + (skills ? 1 : 0),
                   ...(payload ? { added: Object.values(accepted.added || {}).reduce((n, l) => n + l.length, 0) } : {}),
                   ...(coded ? { modelCalled: !codeOnly } : {}),
                   refused: accepted.violations.map(v => ({ id: v.id, kind: v.kind })) },
      usage,
    };
  };
  if (codeOnly) return finish({ bullets: {}, skills: null, violations: [] }, { model: "none", repaired: false });

  const route = tailorRoute(env, { anthropicClient: client, defaultModel: TAILOR_MODEL, choice, models: { haiku: MODEL_HAIKU, sonnet: MODEL_SONNET } });
  const system = payload ? PAYLOAD_SYSTEM : LEAN_SYSTEM;
  const user = payload ? renderPayloadInput({ structure, job, keywords, gists }) : renderTailorInput({ structure, job, keywords });
  const check = (changes) => (payload
    ? checkPayloadChanges({ structure, baseResumeText, changes, keywords, claims, gists })
    : checkLeanChanges({ structure, baseResumeText, changes, keywords, claims }));
  let model = route.model;
  try {
    let changes = parseChanges(await askTailor(route, system, user, usage));
    let checked = changes ? check(changes) : null;
    let repaired = false;
    if (!changes || checked.violations.length) {
      // ONE repair, on the stronger model, carrying the exact messages (D123 P2 + P3).
      model = TAILOR_REPAIR_MODEL;
      repaired = true;
      const why = !changes
        ? "Your previous answer was not the JSON asked for. Answer with the JSON object only."
        : `Your previous answer broke these rules; fix only these and keep the rest:\n${checked.violations.map(v => `- ${v.message}`).join("\n")}\nYour previous answer was:\n${JSON.stringify(changes)}`;
      const second = parseChanges(await askRepair(client, system, `${user}\n${why}`, usage));
      if (second) { changes = second; checked = check(changes); }
    }
    // Anything still refused stays the candidate's own text: the checks already left it out of `bullets` / `added`.
    const accepted = checked || { bullets: {}, skills: null, violations: [{ kind: "unreadable_answer", id: "*", message: "no readable answer" }] };
    return finish(accepted, { model, repaired });
  } catch (e) {
    throw Object.assign(e, { usageSoFar: usage });
  }
}
