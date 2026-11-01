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
import { buildStructuredResume, renderStructuredResume } from "../formatting/resumeFormatter.js";
import { callAnthropic, textOf, MODEL_HAIKU, MODEL_SONNET } from "../model/anthropicCall.js";

export const TAILOR_MODEL = MODEL_HAIKU;
export const TAILOR_REPAIR_MODEL = MODEL_SONNET;
export const TAILOR_MAX_TOKENS = 2000;
export const BULLET_MAX_CHARS = 320;

export const LEAN_SYSTEM = `You tailor an existing resume to one job posting so it scores as high as honestly possible in an applicant tracking system (ATS). You EDIT; you do not write a new resume.

INPUT: the target job and its keywords, then the resume's bullets (each with an id like e1b2) and its skills rows.

GOAL: every keyword the resume can honestly carry appears VERBATIM (exact spelling and casing of the keyword list) in a bullet or in skills, and bullets lead with the posting's priorities.
- EVIDENCED and CLAIMED terms: work them into the bullets whose work they describe, and make sure each is in skills.
- PLACEABLE terms (term @ employer): the employer's own stack includes it. Use it ONLY in a bullet of that employer, ONLY as a tool or practice inside work the bullet already describes. Never as a new project, responsibility or result. Add it to skills.
- A keyword no bullet can honestly carry is left out. Never force one.

HARD RULES (code checks them; a broken rule is reverted):
- Never add a number. Keep every number exactly as the bullet states it. No new metrics, counts, percentages, team sizes, years or durations.
- Never change employers, titles, dates, levels or seniority, and never claim sole ownership the bullet does not state.
- One accomplishment per bullet; start with a strong past-tense verb (present tense is fine for a current role); at most 30 words.
- No em or en dashes. No filler: passionate, results-driven, dynamic, cutting-edge, world-class, best-in-class, synergy, leverage, spearheaded.
- Wrap each posting keyword you use in a bullet in **double asterisks**. Never bold a whole bullet.
- Skills: keep every existing skill; put posting keywords first in each row; add only evidenced, claimed or placeable terms.
- Leave a bullet OUT of your answer when it gains nothing. Fewer, better edits beat rewriting everything.

OUTPUT: JSON only, no prose, no code fence:
{"bullets":{"e1b1":"new text"},"skills":[{"label":"Languages","values":"Python, SQL"}]}
"skills" holds the full rows in their new order, or is omitted when nothing changes.`;

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
  out += line("Posting priorities", (keywords.phrases || []).join("; "));
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
  return { bullets, skills };
}

// Standalone numbers only: "40,000", "2.5", "78%" count; "S3", "EC2", "p95", "OAuth 2.0" do not (a letter touches them).
const NUMBER_RE = /(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])/g;
const numbersOf = (s) => new Set((plain(s).match(NUMBER_RE) || []).map(n => n.replace(/,/g, "")));
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
    || (claims?.skills || []).some(t => norm(t) === norm(term));
  const bullets = {};
  for (const [id, text] of Object.entries(changes?.bullets || {})) {
    const b = byId.get(id);
    if (!b) continue;
    if (plain(text).length > BULLET_MAX_CHARS) { violations.push({ kind: "bullet_too_long", id, message: `${id} is longer than ${BULLET_MAX_CHARS} characters.` }); continue; }
    const before = numbersOf(b.text);
    const added = [...numbersOf(text)].filter(n => !before.has(n));
    if (added.length) { violations.push({ kind: "number_not_in_bullet", id, evidence: added, message: `${id} adds ${added.join(", ")}, which the original bullet does not state. Keep the bullet's own numbers and add none.` }); continue; }
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

/** A new structure with the accepted changes applied; the input is not mutated. */
export function applyChanges(structure, { bullets = {}, skills = null } = {}, { includeSummary = false } = {}) {
  const next = JSON.parse(JSON.stringify(structure));
  const ids = indexBullets(next);
  for (const b of ids) if (bullets[b.id]) b.entry.bullets[b.index] = bullets[b.id];
  if (skills) { const s = skillsSection(next); if (s) s.rows = skills; }
  if (!includeSummary) next.sections = next.sections.filter(s => s.type !== "summary");
  return next;
}

// Two call sites, each with its literal purpose (test/d17ModelCallSites.test.js reads them).
async function askTailor(client, user, usage) {
  const r = await callAnthropic(client, {
    purpose: "resume_tailor", model: TAILOR_MODEL, max_tokens: TAILOR_MAX_TOKENS,
    system: LEAN_SYSTEM, messages: [{ role: "user", content: user }],
  }).catch(e => { if (e?.usage) usage.push(e.usage); throw e; });
  usage.push(r.usage);
  return textOf(r.message);
}

async function askRepair(client, user, usage) {
  const r = await callAnthropic(client, {
    purpose: "resume_tailor_repair", model: TAILOR_REPAIR_MODEL, max_tokens: TAILOR_MAX_TOKENS,
    // Sonnet 5 thinks by default and max_tokens covers thinking + output (generate.js says why that matters).
    thinking: { type: "disabled" },
    system: LEAN_SYSTEM, messages: [{ role: "user", content: user }],
  }).catch(e => { if (e?.usage) usage.push(e.usage); throw e; });
  usage.push(r.usage);
  return textOf(r.message);
}

/**
 * @returns { html, tailoring: { mode: "lean", model, repaired, changed, refused: [{ id, kind }] }, usage }
 * Throws a ModelCallError (with `usageSoFar`) when a call fails.
 */
export async function tailorResume(client, { baseResumeText, job = {}, keywords = {}, claims = null, includeSummary = false }) {
  const usage = [];
  const structure = buildStructuredResume(baseResumeText);
  const user = renderTailorInput({ structure, job, keywords });
  let model = TAILOR_MODEL;
  try {
    let changes = parseChanges(await askTailor(client, user, usage));
    let checked = changes ? checkLeanChanges({ structure, baseResumeText, changes, keywords, claims }) : null;
    let repaired = false;
    if (!changes || checked.violations.length) {
      // ONE repair, on the stronger model, carrying the exact messages (D123 P2 + P3).
      model = TAILOR_REPAIR_MODEL;
      repaired = true;
      const why = !changes
        ? "Your previous answer was not the JSON asked for. Answer with the JSON object only."
        : `Your previous answer broke these rules; fix only these and keep the rest:\n${checked.violations.map(v => `- ${v.message}`).join("\n")}\nYour previous answer was:\n${JSON.stringify(changes)}`;
      const second = parseChanges(await askRepair(client, `${user}\n${why}`, usage));
      if (second) { changes = second; checked = checkLeanChanges({ structure, baseResumeText, changes, keywords, claims }); }
    }
    // Anything still refused stays the candidate's own text: checkLeanChanges already left it out of `bullets`.
    const accepted = checked || { bullets: {}, skills: null, violations: [{ kind: "unreadable_answer", id: "*", message: "no readable answer" }] };
    const html = renderStructuredResume(applyChanges(structure, accepted, { includeSummary }));
    return {
      html,
      tailoring: { mode: "lean", model, repaired, changed: Object.keys(accepted.bullets).length + (accepted.skills ? 1 : 0),
                   refused: accepted.violations.map(v => ({ id: v.id, kind: v.kind })) },
      usage,
    };
  } catch (e) {
    throw Object.assign(e, { usageSoFar: usage });
  }
}
