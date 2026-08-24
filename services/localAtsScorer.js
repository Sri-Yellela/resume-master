/**
 * Local ATS report.
 *
 * WHAT A TERM IN THIS REPORT MEANS
 * Every term emitted here is shown to the user as something their resume matched or is MISSING —
 * i.e. as advice about their own document. So a term has to be a thing a person could actually
 * claim. It used to be mined by sliding a 1-3 word window across the job description, which
 * emitted prose: "and scalable. We", "s core productivity", "employees and agents". A window
 * cannot tell a skill from a sentence, so the list read as noise and misled about what the resume
 * lacked.
 *
 * Candidate terms now come from three sources that each already know what a skill is:
 *   1. the candidate's own profile skills, where the posting also asks for them;
 *   2. the posting's own skills_json, extracted by the enrichment model per posting;
 *   3. the shipped domain registries (services/skillVocabulary.js).
 * Verbs come from the registries' actionVerbs plus ACTION_VERB_HINTS, matched as whole verbs.
 *
 * PRECISION OVER RECALL. An empty "missing" list is a correct answer. A list of sentence fragments
 * is not, and it costs the user's trust in every other number on the panel.
 */

import { actionVerbVocabularyTerms, companyStackTerms, skillVocabularyTerms } from "./skillVocabulary.js";

const STOP_WORDS = new Set([
  "about","above","across","after","again","against","also","and","any","are","around",
  "based","been","being","best","both","but","can","candidate","company","daily","each",
  "etc","for","from","have","has","help","high","including","into","job","join","like",
  "more","must","need","needs","our","own","per","plus","preferred","required","requires",
  "responsibilities","responsible","role","skills","some","strong","such","team","teams",
  "than","that","the","their","them","this","through","to","using","with","work","working",
  "you","your",
]);

const WEAK_ACTION_VERBS = new Set([
  "able","allow","apply","assist","bring","capable","demonstrate","do","ensure","get",
  "handle","have","help","include","involve","know","make","need","perform","provide",
  "require","support","understand","use","utilize","want","work",
]);

const ACTION_VERB_HINTS = [
  "architect","automate","benchmark","build","coordinate","debug","deliver","deploy",
  "design","develop","diagnose","drive","evaluate","implement","improve","instrument",
  "integrate","launch","lead","manage","migrate","model","negotiate","optimize",
  "profile","refactor","resolve","scale","ship","streamline","test","validate",
];

/**
 * Words that make a phrase prose rather than a term, when they sit at either END of it.
 * "and scalable", "of experience", "the platform" — the give-away that a phrase was cut out of a
 * sentence rather than named as a skill.
 */
const EDGE_FILLER_WORDS = new Set([
  "a","an","and","are","as","at","be","been","but","by","for","from","in","into","is","it","its",
  "of","on","or","our","over","so","that","the","their","them","these","they","this","those","to",
  "we","were","what","when","which","who","will","with","you","your",
]);

/**
 * Irregular verbs, where stripping a suffix cannot recover the base form. "Built" and "build" are
 * the same claim; without this the registry's "Built" never matches a JD that says "build".
 */
const IRREGULAR_VERB_STEMS = new Map(Object.entries({
  built: "build", rebuilt: "build", led: "lead", drove: "drive", driven: "drive",
  grew: "grow", grown: "grow", brought: "bring", ran: "run", wrote: "write", written: "write",
  oversaw: "oversee", overseen: "oversee", taught: "teach", sought: "seek", chose: "choose",
  spoke: "speak", made: "make", met: "meet", held: "hold", found: "find", began: "begin",
  rose: "rise", won: "win", kept: "keep", left: "leave", sent: "send", spent: "spend",
}));

export function normaliseAtsTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\bci\s*\/\s*cd\b/g, "ci cd")
    .replace(/\brest\s+apis\b/g, "rest api")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#./\s-]+/g, " ")
    .replace(/[./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(apis|skills|tools|systems|services|pipelines|applications)\b/g, m => (
      { apis: "api", skills: "skill", tools: "tool", systems: "system", services: "service", pipelines: "pipeline", applications: "application" }[m] || m
    ))
    .replace(/\b([a-z]{4,})s\b/g, "$1")
    .replace(/\bkubernete\b/g, "kubernetes");
}

function displayTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
}

function tokenise(value) {
  const norm = normaliseAtsTerm(value);
  return norm.match(/[a-z0-9+#]{2,}/g) || [];
}

function compactUnique(items, limit = 40) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const label = displayTerm(item);
    const key = normaliseAtsTerm(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

export function buildRuntimeAtsBasis({ resumeText = "", signalProfile = {}, domainProfile = {} } = {}) {
  const profileKeywords = parseJsonArray(domainProfile.selected_keywords);
  const profileSkills = parseJsonArray(domainProfile.selected_tools);
  const profileVerbs = parseJsonArray(domainProfile.selected_verbs);
  const profileTitles = parseJsonArray(domainProfile.target_titles);
  const structuredFacts = {
    ...(signalProfile?.structuredFacts || {}),
  };
  return {
    resumeText: String(resumeText || ""),
    titles: compactUnique([...(signalProfile?.titles || []), ...profileTitles], 24),
    skills: compactUnique([...(signalProfile?.skills || []), ...(signalProfile?.keywords || []), ...profileSkills, ...profileKeywords], 64),
    actionVerbs: compactUnique(profileVerbs, 32),
    yearsExperience: signalProfile?.yearsExperience ?? null,
    structuredFacts,
  };
}

/**
 * The known-skill index: normalised key -> the term as it should be shown.
 * Built once, lazily, because reading the registries is filesystem work and scoring runs per job.
 */
let _skillIndex = null;
function skillIndex() {
  if (_skillIndex) return _skillIndex;
  const index = new Map();
  for (const term of skillVocabularyTerms()) {
    const key = normaliseAtsTerm(term);
    if (key && key.length >= 2 && !index.has(key)) index.set(key, displayTerm(term));
  }
  _skillIndex = index;
  return index;
}

/** The known-verb index: verb STEM -> the verb as it should be shown. */
let _verbIndex = null;
function verbIndex() {
  if (_verbIndex) return _verbIndex;
  const index = new Map();
  // The registry verbs read "Deployed"; ACTION_VERB_HINTS are lowercase infinitives. They land in
  // one chip list, so they are shown one way.
  const capitalise = v => v.charAt(0).toUpperCase() + v.slice(1);
  for (const verb of [...actionVerbVocabularyTerms(), ...ACTION_VERB_HINTS]) {
    const stem = normaliseActionVerb(verb);
    if (!stem || stem.length < 3 || WEAK_ACTION_VERBS.has(stem) || index.has(stem)) continue;
    index.set(stem, capitalise(displayTerm(verb)));
  }
  _verbIndex = index;
  return index;
}

/** Test seam — the indexes are memoised, and a test that swaps registries needs them rebuilt. */
export function resetAtsVocabularyCache() {
  _skillIndex = null;
  _verbIndex = null;
}

/**
 * Words that only ever appear inside a hyphenated compound in this posting.
 *
 * "customer-facing" and "paved the way" are why "facing" and "paved" reached the panel as verbs.
 * normaliseAtsTerm turns a hyphen into a space, so by the time a term is normalised the compound
 * is indistinguishable from two words — the check has to run against the RAW text. A word is only
 * rejected when it NEVER stands alone here, so "full-stack" does not cost us a JD that also says
 * "stack" on its own.
 */
function compoundOnlyWords(rawText) {
  const raw = String(rawText || "");
  const inCompound = new Set();
  const standalone = new Set();
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9+#]*(?:-[A-Za-z][A-Za-z0-9+#]*)+/g)) {
    for (const part of m[0].split("-")) inCompound.add(part.toLowerCase());
  }
  for (const m of raw.matchAll(/(?<![A-Za-z0-9+#-])[A-Za-z][A-Za-z0-9+#]*(?![A-Za-z0-9+#-])/g)) {
    standalone.add(m[0].toLowerCase());
  }
  const out = new Set();
  for (const word of inCompound) if (!standalone.has(word)) out.add(word);
  return out;
}

/**
 * Structural rejection, applied to EVERY emitted term regardless of which source produced it.
 *
 * The vocabulary sources cannot produce prose, but skills_json is open-vocabulary model output and
 * a profile can hold whatever a user typed. This is the last gate before a term is shown to a
 * person as a claim about their resume, so it runs on all of them.
 */
function buildTermRejector(jobText, company) {
  const compoundOnly = compoundOnlyWords(jobText);
  const companyWords = new Set(tokenise(company).filter(w => w.length > 2 && !STOP_WORDS.has(w)));

  return function rejectTerm(term) {
    const display = displayTerm(term);
    if (!display) return true;

    // Sentence-boundary punctuation inside a term — "and scalable. We", "is not enough;"
    if (/[;:!?]/.test(display)) return true;
    if (/\.\s/.test(display) || /[.,]$/.test(display)) return true;

    const key = normaliseAtsTerm(display);
    if (!key) return true;
    const parts = key.split(" ").filter(Boolean);
    if (!parts.length || parts.length > 4) return true;

    // Single-letter fragments — the "s" of a possessive, the "a" of an article.
    if (parts.some(p => p.length < 2 && !/[0-9+#]/.test(p))) return true;

    // Prose cut mid-sentence announces itself at the edges.
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (EDGE_FILLER_WORDS.has(first) || EDGE_FILLER_WORDS.has(last)) return true;
    if (STOP_WORDS.has(first) || STOP_WORDS.has(last)) return true;

    // The employer's own name is not a skill the candidate is missing.
    if (parts.some(p => companyWords.has(p))) return true;

    // A truncation of a hyphenated compound is not the compound.
    if (parts.length === 1 && compoundOnly.has(first)) return true;

    return false;
  };
}

/**
 * URLs and email addresses, removed before anything is matched.
 *
 * normaliseAtsTerm turns "." into a space, so "https://cdn.openai.com/policies/eeo-policy" becomes
 * the words "cdn openai com policies eeo policy" and a legal-boilerplate link starts reporting CDN
 * as a skill the resume lacks. Same for the "form.asana.com" reporting link, which produced Asana.
 * No posting has ever asked for a skill that appears only inside a URL.
 */
function stripLinks(text) {
  return String(text || "")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, " ")
    .replace(/\b[\w-]+\.(?:com|org|net|io|ai|co|gov|edu)\b\S*/gi, " ");
}

function candidateTermsFromJob(jobText, runtimeBasis, { company = "", jobSkills = [] } = {}) {
  const searchText = stripLinks(jobText);
  const normJob = ` ${normaliseAtsTerm(searchText)} `;
  const rejectTerm = buildTermRejector(searchText, company);
  const terms = [];

  // 1. What the candidate already claims, where this posting also asks for it. Listed first so the
  //    28-term budget is spent on the overlap that actually decides the score.
  for (const sourceTerm of runtimeBasis.skills || []) {
    const key = normaliseAtsTerm(sourceTerm);
    if (key && normJob.includes(` ${key} `)) terms.push(sourceTerm);
  }

  // 2. What the enrichment model extracted for THIS posting. Same source the board's skill chips
  //    and skills_include filtering read, so the panel agrees with the card beside it.
  for (const skill of jobSkills) terms.push(skill);

  // 3. This employer's own stack, where the posting states it.
  for (const term of companyStackTerms(company)) {
    const key = normaliseAtsTerm(term);
    if (key && normJob.includes(` ${key} `)) terms.push(term);
  }

  // 4. The shipped domain registries, where the posting states the term.
  for (const [key, label] of skillIndex()) {
    if (normJob.includes(` ${key} `)) terms.push(label);
  }

  return compactUnique(terms.filter(term => !rejectTerm(term)), 28);
}

/** Every verb stem this posting actually uses, as whole standalone words. */
function jobVerbStems(jobText) {
  const searchText = stripLinks(jobText);
  const compoundOnly = compoundOnlyWords(searchText);
  const stems = new Set();
  for (const token of searchText.match(/[A-Za-z]{2,}/g) || []) {
    const lower = token.toLowerCase();
    // "facing" in "customer-facing" is not the posting asking anyone to face anything.
    if (compoundOnly.has(lower)) continue;
    const stem = normaliseActionVerb(lower);
    if (stem) stems.add(stem);
  }
  return stems;
}

function candidateActionVerbsFromJob(jobText, runtimeBasis) {
  const stems = jobVerbStems(jobText);
  const index = verbIndex();
  const verbs = [];
  // Deduplicated by STEM, not by label. compactUnique would keep "Build" and "Built" as two chips
  // because their labels differ, but they are one verb and the user has either used it or not.
  const taken = new Set();
  const take = (stem, label) => {
    if (taken.has(stem)) return;
    taken.add(stem);
    verbs.push(label);
  };

  // The candidate's own verbs first, so the report shows them in the wording they chose.
  for (const verb of runtimeBasis.actionVerbs || []) {
    const stem = normaliseActionVerb(verb);
    // Vocabulary membership is the whole check: a token is emitted because it IS an action verb,
    // never because it sat next to one or happened to end in -ed/-ing.
    if (stem && index.has(stem) && stems.has(stem)) take(stem, verb);
  }
  for (const [stem, label] of index) {
    if (stems.has(stem)) take(stem, label);
  }

  return compactUnique(verbs, 16);
}

/**
 * Reduce a verb to the stem it shares with its other forms.
 *
 * The irregular map is applied FIRST and then stemmed like anything else, rather than returned
 * early: the suffix rules take "build" to "buil", so an early return of "build" for "built" would
 * leave the two forms on different stems and the panel would list Build and Built as two separate
 * verbs. Whatever this function does, it must do to every form of a verb equally.
 */
function normaliseActionVerb(value) {
  let term = normaliseAtsTerm(value).split(" ")[0] || "";
  if (IRREGULAR_VERB_STEMS.has(term)) term = IRREGULAR_VERB_STEMS.get(term);

  let stripped = false;
  if (term.endsWith("ing") && term.length > 5) { term = term.slice(0, -3); stripped = true; }
  if (term.endsWith("ed") && term.length > 4) { term = term.slice(0, -2); stripped = true; }
  if (term.endsWith("d") && term.length > 4) { term = term.slice(0, -1); stripped = true; }

  // "shipped" -> "shipp" -> "ship"; "debugging" -> "debugg" -> "debug".
  if (stripped && /([bdfglmnprt])\1$/.test(term)) term = term.slice(0, -1);
  // The registries hold past forms ("Coordinated"); ACTION_VERB_HINTS hold infinitives
  // ("coordinate"). Dropping the silent -e puts both on "coordinat".
  if (!stripped && term.length > 4 && term.endsWith("e")) term = term.slice(0, -1);
  // "optimise", "optimize", "optimised", "optimizing" are one verb, on one stem.
  if (term.length > 4) term = term.replace(/i[sz]e?$/, "iz");

  return term;
}

/**
 * The posting's own extracted skills. skills_json carries two shapes by history — plain strings
 * from the feed adapters, {skill,type} objects from enrichJob and Jobo — and may arrive parsed or
 * still encoded. Read all of them rather than making the caller normalise.
 */
function jobSkillTerms(job) {
  const raw = job?.skills_json ?? job?.skills;
  const list = typeof raw === "string" ? parseJsonArray(raw) : (Array.isArray(raw) ? raw : []);
  const out = [];
  for (const entry of list) {
    const value = typeof entry === "string" ? entry : entry?.skill;
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return out;
}

function hasTerm(haystack, term) {
  const key = normaliseAtsTerm(term);
  if (!key) return false;
  const text = ` ${normaliseAtsTerm(haystack)} `;
  if (text.includes(` ${key} `)) return true;
  const parts = key.split(" ").filter(Boolean);
  if (parts.length > 1) return parts.every(part => text.includes(` ${part} `));
  return false;
}

function hasVerb(haystack, verb) {
  const wanted = normaliseActionVerb(verb);
  if (!wanted) return false;
  return tokenise(haystack).some(token => normaliseActionVerb(token) === wanted);
}

function experienceRequirement(jobText) {
  const matches = [...String(jobText || "").matchAll(/(\d+)\s*\+?\s*(?:-|to)?\s*(?:\d+\s*)?years?\s+(?:of\s+)?(?:professional\s+|relevant\s+)?experience/gi)];
  const nums = matches.map(m => Number(m[1])).filter(n => Number.isFinite(n) && n >= 0 && n <= 40);
  return nums.length ? Math.min(...nums) : null;
}

function hardConstraintMisses(jobText, facts = {}) {
  const text = normaliseAtsTerm(jobText);
  const misses = [];
  if (/\bus citizen(ship)?\b|\bu s citizen(ship)?\b/.test(text) && !/u\.?s\.?\s*citizen/i.test(facts.citizenshipStatus || "")) {
    misses.push("U.S. citizenship");
  }
  if (/\bsecurity clearance\b|\bsecret clearance\b|\btop secret\b|\bts sci\b|\bpublic trust\b/.test(text) && !facts.hasClearance) {
    misses.push("Security clearance");
  }
  if (/\bwithout sponsorship\b|\bno sponsorship\b/.test(text) && facts.requiresSponsorship) {
    misses.push("Work authorization without sponsorship");
  }
  return misses;
}

function ratio(matched, total) {
  return total ? matched / total : 1;
}

export function scoreAtsLocally({ job = {}, resumeText = "", runtimeBasis = null, signalProfile = null, domainProfile = null } = {}) {
  const basis = runtimeBasis || buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile });
  const jobText = [
    job.title,
    job.company,
    job.category,
    job.description,
    job.requirements,
    job.skills,
  ].filter(Boolean).join("\n");
  const matchText = [basis.resumeText, basis.skills.join(" "), basis.titles.join(" "), basis.actionVerbs.join(" ")].join("\n");

  const jobTerms = candidateTermsFromJob(jobText, basis, {
    company: job.company || "",
    jobSkills: jobSkillTerms(job),
  });
  const matchedSkills = jobTerms.filter(term => hasTerm(matchText, term));
  const missingSkills = jobTerms.filter(term => !hasTerm(matchText, term));

  const jobVerbs = candidateActionVerbsFromJob(jobText, basis);
  const matchedVerbs = jobVerbs.filter(verb => hasVerb(matchText, verb));
  const missingVerbs = jobVerbs.filter(verb => !hasVerb(matchText, verb));

  const requiredYears = experienceRequirement(jobText);
  const candidateYears = basis.yearsExperience == null ? null : Number(basis.yearsExperience);
  const experienceFit = requiredYears == null
    ? { requiredYears: null, candidateYears, fit: true, summary: "No explicit years-of-experience requirement detected." }
    : {
        requiredYears,
        candidateYears,
        fit: candidateYears != null && candidateYears >= requiredYears,
        summary: candidateYears == null
          ? `Job asks for ${requiredYears}+ years; profile years are not set.`
          : candidateYears >= requiredYears
            ? `Profile experience (${candidateYears} years) meets ${requiredYears}+ year requirement.`
            : `Job asks for ${requiredYears}+ years; profile has ${candidateYears} years.`,
      };
  const hardMisses = hardConstraintMisses(jobText, basis.structuredFacts);

  const skillScore = ratio(matchedSkills.length, jobTerms.length) * 50;
  const verbScore = ratio(matchedVerbs.length, jobVerbs.length) * 15;
  const experienceScore = experienceFit.fit ? 25 : requiredYears == null ? 22 : 8;
  const hardScore = Math.max(0, 10 - hardMisses.length * 5);
  const score = Math.max(0, Math.min(100, Math.round(skillScore + verbScore + experienceScore + hardScore)));

  return {
    source: "local_ats_v1",
    score,
    tier1_matched: compactUnique(matchedSkills, 40),
    tier1_missing: compactUnique(missingSkills, 40),
    action_verbs_matched: compactUnique(matchedVerbs, 24),
    action_verbs_missing: compactUnique(missingVerbs, 24),
    experience: experienceFit,
    hard_constraint_misses: hardMisses,
  };
}
