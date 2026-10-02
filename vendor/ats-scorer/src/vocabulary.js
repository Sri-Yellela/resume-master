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
 *   data/DOMAIN_TOOL_REGISTRY.json — per-company stack terms, admitted as a skill only when that
 *     company's own posting names them (scorer.js). Not a source of facts about a company, and not
 *     read by generation (A64, 2026-10-02: the old "keeps generation honest" was never true).
 *
 * The point is a CLOSED SET. Before this, the ATS report mined candidate terms by sliding a 1-3
 * word window over the job description, so it emitted "and scalable. We" and "s core productivity"
 * — contiguous prose, not skills. A window has no way to know a phrase is a skill. A vocabulary
 * does, because someone wrote the terms down on purpose.
 *
 * ⛔ A MISSING REGISTRY THROWS. IT USED TO DEGRADE SILENTLY, AND THE PREMISE FOR THAT WAS WRONG.
 * This file used to fall back to empty when neither JSON could be read, on the grounds that
 * "Railway has restricted the container filesystem before". It had not. draft's own .dockerignore
 * excludes data/ (all but ROLE_ALIAS_MAP.json) and has since 2026-04-23, and Railway builds with
 * that Dockerfile — so the production image never contained either registry, and every production
 * score was computed against an empty vocabulary while every local measurement used the full one.
 *
 * Measured on the graded 30 (A1, 2026-09-27): an empty vocabulary moves 27 of 30 scores and RAISES
 * rho from 0.746 to 0.791. A fallback that changes nine scores in ten and improves the headline
 * metric is a fallback nobody will ever notice firing. So the registries now ship INSIDE this
 * package (../data), are read from there and nowhere else — no process.cwd() fallback, which would
 * quietly pick up whichever product's copy happened to sit in the working directory — and their
 * absence is a packaging defect that fails loudly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the package's own registries live. Exported so a drift test can compare against it. */
export const REGISTRY_DIR = path.join(__dirname, "..", "data");
export const REGISTRY_FILES = Object.freeze(["DOMAIN_METADATA_REGISTRY.json", "DOMAIN_TOOL_REGISTRY.json"]);

function readRegistry(filename) {
  const p = path.join(REGISTRY_DIR, filename);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`@draft/ats-scorer: registry ${filename} is missing or unreadable at ${p} — ` +
                    `the package is incomplete, and scoring without it would silently change most scores (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) {
    throw new Error(`@draft/ats-scorer: registry ${filename} at ${p} is empty`);
  }
  return parsed;
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
