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

/**
 * The report format's version, and the cache key for every stored report.
 *
 * BUMPED FROM local_ats_v1 BECAUSE THE TERMS CHANGED, NOT THE SHAPE.
 * Reports are cached in four places — scraped_jobs.ats_report, ats_only_reports, resumes.ats_report
 * and resume_versions.ats_report — and the read path serves a cached report whenever its `source`
 * matches. A v1 report is a list of sentence fragments. Leaving the version alone would have meant
 * every job already scored kept showing "and scalable. We" forever, and the fix would have appeared
 * to work only on jobs nobody had looked at yet.
 *
 * Anything comparing against this must import it rather than spell it, so a future bump cannot
 * leave a stale reader behind.
 *
 * BUMPED AGAIN TO v3 FOR AH3, for the same reason and with the same consequence. A v2 report files
 * "problem decomposition" under SKILLS MISSING, pads SKILLS MATCHED with "provided" and "science",
 * and lists "Manage" as a gap. Those reports are cached against every job already scored, so
 * leaving the version alone would have fixed the report only for postings nobody had opened —
 * which is exactly how AG1's fragment fix appeared to work and did not (e566dbc).
 */
export const LOCAL_ATS_SOURCE = "local_ats_v3";

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
 * Real action verbs that name a RELATIONSHIP TO WORK rather than a specific act (AH3).
 *
 * Distinct from WEAK_ACTION_VERBS above, which are not action verbs at all ("help", "ensure",
 * "use") and are dropped from the vocabulary entirely. These are genuine verbs a resume can use —
 * they are just claimable by almost anyone in almost any role, so listing them under MISSING
 * asserts a gap that is not real. "Your resume is missing Manage" tells an engineer nothing.
 *
 * They are GROUPED, not suppressed. The posting does use this language, and saying "these are
 * generic" is information; deleting them silently is not.
 *
 * THE CRITERION IS STATED, NOT MEASURED, and that is deliberate. Document frequency across the
 * corpus does not separate them: Managed appears in 44% of the 1,291 postings and Delivered in 42%,
 * which puts them mid-pack, BELOW Built (93%), Designed (72%) and Developed (58%) — verbs whose
 * absence from a resume is worth saying. A frequency threshold would sweep up the useful ones and
 * keep these, so it is the wrong instrument. The distinction is semantic: "Automated",
 * "Instrumented", "Refactored", "Migrated", "Debugged" name a thing that was done; "Managed",
 * "Delivered", "Owned", "Drove", "Supported" name a stance toward work that anyone can assert.
 */
const GENERIC_ACTION_VERB_WORDS = [
  "coordinate", "deliver", "drive", "execute", "grow", "manage", "oversee", "own",
  "partner", "report", "secure", "track",
];
// STEMMED through the same function the index is keyed by, never spelled as raw infinitives.
// Written out by hand, the first version of this set matched only "deliver": the stemmer turns
// "Managed" into "manag", "Coordinated" into "coordinat" and "Drove" into "driv", so eleven of the
// twelve entries silently matched nothing and the verbs went on being reported as gaps. A set whose
// keys are produced by a different rule than the keys it is tested against is not a set.
// Built lazily: normaliseActionVerb reads IRREGULAR_VERB_STEMS, which is a const declared further
// down, so stemming at module scope here is a temporal-dead-zone ReferenceError at import time.
let _genericVerbStems = null;
function genericVerbStems() {
  if (!_genericVerbStems) {
    _genericVerbStems = new Set(GENERIC_ACTION_VERB_WORDS.map(normaliseActionVerb).filter(Boolean));
  }
  return _genericVerbStems;
}

/**
 * Terms in the shipped registries that describe a QUALITY rather than a skill (AH3).
 *
 * The registries are overwhelmingly concrete — engineering.keywords is "distributed systems",
 * "CI/CD", "concurrency", "observability" — but a handful of entries, mostly from the non-technical
 * domains, are competencies wearing a keyword's clothes. Measured document frequency over the
 * corpus, as the scorer itself sees these postings: communication 55%, strategy 43%,
 * cross-functional collaboration 39%, cross-functional 38%, leadership 27%. A term over half the
 * job market states is not a differentiator, and it is not a skill either.
 *
 * These are not dropped. They move to the competencies bucket, where being widely wanted is
 * expected rather than embarrassing, and where the reader can judge them as qualities.
 */
const COMPETENCY_REGISTRY_TERMS = new Set([
  "communication", "written communication", "verbal communication", "executive communication",
  "collaboration", "cross-functional", "cross-functional collaboration", "cross functional",
  "leadership", "technical leadership", "team leadership", "people leadership",
  "strategy", "strategic thinking", "problem solving", "problem-solving",
  "stakeholder management", "relationship building", "attention to detail",
  "mentoring", "mentorship", "coaching", "ownership", "adaptability", "culture",
]);

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

/**
 * The posting's terms, split into SKILLS and COMPETENCIES.
 *
 * WHAT BELONGS IN EACH BUCKET (AH3)
 *   SKILL       — a named tool, technology, platform or domain technique. Checkable: either the
 *                 resume shows it or it does not. typescript, node, kubernetes, distributed
 *                 systems, A/B testing.
 *   COMPETENCY  — a quality or way of working. Real, wanted, and not checkable the same way.
 *                 problem decomposition, intellectual curiosity, cross-functional collaboration.
 *
 * A term reaches SKILLS only from a source that already knows what a skill is: the shipped
 * registries, this employer's stack, or the posting's enrichment-typed HARD skills. This is the
 * closed set skillVocabulary.js's own header argues for, now applied to the last source that was
 * bypassing it.
 *
 * THAT BYPASS WAS THE "NOISE IN MATCHED" DEFECT. The candidate's profile skills used to be pushed
 * in unconditionally, and those are resume-extracted tokens, not a curated list. Reproduced on the
 * real fixture profile against the Notion New Grad posting, SKILLS MATCHED read:
 *
 *   engineering | provided | science | bachelor | current | environment | skills | specific
 *
 * Eight of nine "matched skills" were ordinary English words that happened to appear in both
 * documents. That is worse than the reported "systems" and "time", and it inflates the score as
 * well as the report, because every one of them counts as a match.
 *
 * The candidate's own terms still come FIRST — they order the budget and preserve the user's own
 * wording — but ordering is all they do now. They can no longer admit a term.
 */
function candidateTermsFromJob(jobText, runtimeBasis, { company = "", jobSkills = { hard: [], soft: [] } } = {}) {
  const searchText = stripLinks(jobText);
  const normJob = ` ${normaliseAtsTerm(searchText)} `;
  const rejectTerm = buildTermRejector(searchText, company);

  // The closed set: every term this posting could legitimately be said to ask for as a SKILL.
  // Keyed by normalised form so the candidate's wording and the registry's resolve to one entry.
  const admissible = new Map();
  const admit = (term) => {
    const key = normaliseAtsTerm(term);
    if (key && !admissible.has(key)) admissible.set(key, term);
  };
  // What the enrichment typed SOFT for this posting can never be admitted as a skill, whatever
  // else names it. The registry is a global list and inevitably overlaps: "data analysis" and
  // "project management" are keywords in it AND are typed soft by the enrichment on postings that
  // use them as competencies. Without this, the registry pass re-admitted them and 170 soft-typed
  // terms across the corpus were still landing in the skills bucket after the split. The
  // per-posting judgement is the more specific one, so it wins.
  const softKeys = new Set((jobSkills.soft || []).map(normaliseAtsTerm).filter(Boolean));
  const admitUnlessSoft = (term) => {
    const key = normaliseAtsTerm(term);
    if (key && !softKeys.has(key)) admit(term);
  };
  for (const skill of jobSkills.hard || []) admitUnlessSoft(skill);
  for (const term of companyStackTerms(company)) {
    const key = normaliseAtsTerm(term);
    if (key && normJob.includes(` ${key} `)) admitUnlessSoft(term);
  }
  for (const [key, label] of skillIndex()) {
    if (normJob.includes(` ${key} `)) admitUnlessSoft(label);
  }

  const skills = [];
  const competencies = [];
  const taken = new Set();
  const place = (term) => {
    const key = normaliseAtsTerm(term);
    if (!key || taken.has(key) || rejectTerm(term)) return;
    taken.add(key);
    (COMPETENCY_REGISTRY_TERMS.has(key) ? competencies : skills).push(term);
  };

  // 1. The candidate's own wording, for the terms already admitted above. Ordering only.
  for (const sourceTerm of runtimeBasis.skills || []) {
    const key = normaliseAtsTerm(sourceTerm);
    if (key && admissible.has(key)) place(sourceTerm);
  }
  // 2. Everything else the posting asks for.
  for (const term of admissible.values()) place(term);
  // 3. The posting's competencies, which the enrichment already typed as soft.
  const fromPosting = [];
  for (const term of jobSkills.soft || []) {
    const key = normaliseAtsTerm(term);
    if (!key || taken.has(key) || rejectTerm(term)) continue;
    taken.add(key);
    fromPosting.push(term);
  }

  // PRECISION OVER RECALL, applied within the bucket. The registry's generic "problem solving" and
  // the posting's own "thoughtful problem-solving" are one idea in two wordings, and showing both
  // is the padding this task is about. Where the posting says something more specific, its wording
  // wins and the registry's shorter version is dropped — a strict WHOLE-WORD subset only, so
  // "communication" goes when "written communication" is present but "data" would never swallow
  // "data pipelines" in the other direction.
  const postingWords = fromPosting.map(t => new Set(normaliseAtsTerm(t).split(" ").filter(Boolean)));
  const isSubsumed = (term) => {
    const words = normaliseAtsTerm(term).split(" ").filter(Boolean);
    if (!words.length) return false;
    return postingWords.some(set => set.size > words.length && words.every(w => set.has(w)));
  };

  return {
    skills: compactUnique(skills, 28),
    // A smaller budget than skills, on purpose. Competencies are the softer half of the report and
    // a long list of them is what makes a panel read as padding.
    competencies: compactUnique([...competencies.filter(t => !isSubsumed(t)), ...fromPosting], 12),
  };
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

  const generic = [];
  // AH3: a verb that names a stance toward work rather than a specific act is set aside here
  // instead of joining the gap list. See GENERIC_ACTION_VERBS for why the criterion is semantic
  // and not a frequency threshold.
  const takeGeneric = (stem, label) => {
    if (taken.has(stem)) return;
    taken.add(stem);
    generic.push(label);
  };
  const generics = genericVerbStems();
  const route = (stem, label) => (generics.has(stem) ? takeGeneric : take)(stem, label);

  // The candidate's own verbs first, so the report shows them in the wording they chose.
  for (const verb of runtimeBasis.actionVerbs || []) {
    const stem = normaliseActionVerb(verb);
    // Vocabulary membership is the whole check: a token is emitted because it IS an action verb,
    // never because it sat next to one or happened to end in -ed/-ing.
    if (stem && index.has(stem) && stems.has(stem)) route(stem, verb);
  }
  for (const [stem, label] of index) {
    if (stems.has(stem)) route(stem, label);
  }

  return { verbs: compactUnique(verbs, 16), generic: compactUnique(generic, 10) };
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
/**
 * The posting's enrichment-extracted skills, SPLIT BY THE TYPE THE ENRICHMENT ALREADY GAVE THEM.
 *
 * AH3's miscategorisation, in one line: this function used to read `entry.skill` and throw
 * `entry.type` away. So the Notion New Grad posting, whose skills_json is
 *
 *   {TypeScript, hard} {Node.js, hard} {Python, hard}
 *   {impact-driven approach to technology, soft} {thoughtful problem-solving, soft}
 *   {problem decomposition, soft} {collaboration, soft}
 *
 * produced ONE list, and "thoughtful problem-solving" and "problem decomposition" were shown as
 * SKILLS MISSING beside typescript and node. They read as verbs mis-filed as skills because they
 * are neither — they are competencies, and the model had already said so.
 *
 * Measured across the 1,291 enriched postings in the corpus: 10,389 hard entries and 7,377 soft,
 * with ZERO untyped. The judgement was there for every term; nothing had to be invented to use it.
 */
function jobSkillTerms(job) {
  const raw = job?.skills_json ?? job?.skills;
  const list = typeof raw === "string" ? parseJsonArray(raw) : (Array.isArray(raw) ? raw : []);
  const hard = [];
  const soft = [];
  for (const entry of list) {
    const value = typeof entry === "string" ? entry : entry?.skill;
    if (typeof value !== "string" || !value.trim()) continue;
    // A bare string, or an unrecognised type, counts as hard. An untyped term is one we have no
    // judgement about, and the skills bucket is where it has always gone — silently reclassifying
    // it as a competency would be inventing a judgement to fill a gap.
    (entry?.type === "soft" ? soft : hard).push(value.trim());
  }
  return { hard, soft };
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

  const { skills: jobTerms, competencies: jobCompetencies } = candidateTermsFromJob(jobText, basis, {
    company: job.company || "",
    jobSkills: jobSkillTerms(job),
  });
  const matchedSkills = jobTerms.filter(term => hasTerm(matchText, term));
  const missingSkills = jobTerms.filter(term => !hasTerm(matchText, term));
  const matchedCompetencies = jobCompetencies.filter(term => hasTerm(matchText, term));
  const missingCompetencies = jobCompetencies.filter(term => !hasTerm(matchText, term));

  const { verbs: jobVerbs, generic: genericVerbs } = candidateActionVerbsFromJob(jobText, basis);
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

  // THE SCORE IS COMPUTED OVER THE UNION, NOT OVER THE BUCKETS.
  //
  // AH3 split the report into skills, competencies and generic language. That is a change to how
  // the report READS, and it must not quietly re-weight what the number MEANS: the posting asks for
  // "collaboration" and for "Managed" whether or not we file them under a softer heading, and a
  // score that dropped them would move every ATS gate in the product — including the auto-apply
  // threshold that was calibrated against this scorer three commits ago.
  //
  // The score DOES move for a different reason, and that one is intended: the skills bucket is now
  // a closed set, so resume-extracted words like "provided" and "science" no longer count as
  // matches. They were inflating both the numerator and the report.
  const scoredTerms = jobTerms.length + jobCompetencies.length;
  const scoredMatches = matchedSkills.length + matchedCompetencies.length;
  const scoredVerbs = jobVerbs.length + genericVerbs.length;
  const scoredVerbMatches = matchedVerbs.length + genericVerbs.filter(v => hasVerb(matchText, v)).length;
  const skillScore = ratio(scoredMatches, scoredTerms) * 50;
  const verbScore = ratio(scoredVerbMatches, scoredVerbs) * 15;
  const experienceScore = experienceFit.fit ? 25 : requiredYears == null ? 22 : 8;
  const hardScore = Math.max(0, 10 - hardMisses.length * 5);
  const score = Math.max(0, Math.min(100, Math.round(skillScore + verbScore + experienceScore + hardScore)));

  return {
    source: LOCAL_ATS_SOURCE,
    score,
    tier1_matched: compactUnique(matchedSkills, 40),
    tier1_missing: compactUnique(missingSkills, 40),
    // AH3's third bucket. Competencies are real and wanted, but they are qualities, not skills —
    // "problem decomposition" belongs beside "intellectual curiosity", not beside typescript.
    competencies_matched: compactUnique(matchedCompetencies, 12),
    competencies_missing: compactUnique(missingCompetencies, 12),
    action_verbs_matched: compactUnique(matchedVerbs, 24),
    action_verbs_missing: compactUnique(missingVerbs, 24),
    // Verbs the posting uses that almost any candidate could claim. Shown as language, never as a
    // gap: "your resume is missing Manage" asserts a shortfall that is not real.
    action_verbs_generic: compactUnique(genericVerbs, 10),
    experience: experienceFit,
    hard_constraint_misses: hardMisses,
  };
}
