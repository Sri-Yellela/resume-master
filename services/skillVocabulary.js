/**
 * The vocabulary the ATS report is allowed to name.
 *
 * WHY THIS FILE EXISTS AND WHAT IT IS NOT
 * It is NOT a new list of skills. Every term here is read out of two registries that already ship
 * with the product and are already the authority elsewhere:
 *
 *   data/DOMAIN_METADATA_REGISTRY.json — the keywords/tools/actionVerbs a user picks from when
 *     building a domain profile. domain_profiles.selected_keywords / selected_tools /
 *     selected_verbs are drawn from exactly these, so the ATS report and the profile it scores
 *     against now speak the same language.
 *   data/DOMAIN_TOOL_REGISTRY.json — the per-company stack lists used to keep generation honest
 *     about what a company actually runs.
 *
 * The point is a CLOSED SET. Before this, the ATS report mined candidate terms by sliding a 1-3
 * word window over the job description, so it emitted "and scalable. We" and "s core productivity"
 * — contiguous prose, not skills. A window has no way to know a phrase is a skill. A vocabulary
 * does, because someone wrote the terms down on purpose.
 *
 * DEGRADATION IS DELIBERATE
 * If neither JSON file can be read (Railway has restricted the container filesystem before — see
 * the BUILTIN_REGISTRY fallback in routes/domainProfiles.js), these return empty and the report
 * falls back to its two DB-backed sources: the candidate's own profile skills and the posting's
 * enrichment-extracted skills_json. A shorter report is the correct failure here; inventing terms
 * to fill it is the bug this file removes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readRegistry(filename) {
  const candidates = [
    path.join(__dirname, "..", "data", filename),
    path.join(process.cwd(), "data", filename),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* try next candidate */ }
  }
  return null;
}

function pushAll(into, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) into.push(item.trim());
  }
}

let _skills = null;
let _verbs = null;
let _stacks = null;

/** Company keys are brand names — compare them stripped of case, punctuation and Inc/Ltd noise. */
function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|technologies|labs)\b/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function load() {
  if (_skills && _verbs && _stacks) return;
  const skills = [];
  const verbs = [];
  const stacks = new Map();

  const metadata = readRegistry("DOMAIN_METADATA_REGISTRY.json");
  for (const domain of Object.values(metadata || {})) {
    if (!domain || typeof domain !== "object") continue;
    pushAll(skills, domain.tools);
    pushAll(skills, domain.keywords);
    pushAll(verbs, domain.actionVerbs);
  }

  const tools = readRegistry("DOMAIN_TOOL_REGISTRY.json");
  for (const [key, company] of Object.entries(tools || {})) {
    if (key.startsWith("__") || !company || typeof company !== "object") continue;
    const stack = [];
    // stack only. notStack is what a company deliberately does NOT run, and naming one of those as
    // a skill the resume is missing would be advice to claim something the employer never asked for.
    pushAll(stack, company.stack);
    if (stack.length) stacks.set(companyKey(key), stack);
  }

  _skills = skills;
  _verbs = verbs;
  _stacks = stacks;
}

/** Raw display-cased skill terms from the shipped registries. Order is stable across calls. */
export function skillVocabularyTerms() {
  load();
  return _skills;
}

/** Raw display-cased action verbs from the shipped registries. */
export function actionVerbVocabularyTerms() {
  load();
  return _verbs;
}

/**
 * The stack terms for ONE company, or [] when the registry does not cover it.
 *
 * Scoped deliberately. DOMAIN_TOOL_REGISTRY is keyed by company because a stack is a fact about
 * that employer — pooling all 60 into one global list made Cloudflare's "Workers" match the phrase
 * "Los Angeles County workers" in an OpenAI posting's legal boilerplate and report it as a skill
 * the resume was missing. An unknown company yields nothing, which is the right way to be wrong.
 */
export function companyStackTerms(company) {
  load();
  const key = companyKey(company);
  return (key && _stacks.get(key)) || [];
}

/** Test seam — forces the next call to re-read the registry files. */
export function resetSkillVocabularyCache() {
  _skills = null;
  _verbs = null;
  _stacks = null;
}
