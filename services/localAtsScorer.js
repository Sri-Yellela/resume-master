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
export const LOCAL_ATS_SOURCE = "local_ats_v4";

/**
 * The 100 points, and why they moved in AK1.
 *
 * Measured on the live board under the v3 split (skill 50 / verb 15 / experience 25 / hard 10):
 *
 *   component            sd across board     correlation with final score
 *   skill                     2.01                    r = 0.21
 *   experience                7.53                    r = 0.96
 *   hard constraints          0.39                    r = -0.02
 *
 * The score was the experience flag wearing a skills costume. Two of the four components were doing
 * no ranking work at all, and the one the product talks about — do you have the skills — was doing
 * a fifth of it.
 *
 * VERBS LOST HALF THEIR BUDGET BECAUSE THEY ARE NEARLY CONSTANT. Across ten sampled postings the
 * matched verb list was almost always the identical pair "Built, Collaborated" and the missing list
 * was near-identical too. A component that returns the same value for every job cannot order
 * anything, and holding 15 points made it pure additive noise. It keeps a small budget because a
 * resume written entirely without action verbs is a real, if rare, weakness.
 *
 * EXPERIENCE KEPT ITS BUDGET BUT LOST ITS CLIFF. The 17-point step between "meets" and "does not"
 * is what produced the bimodal distribution; experienceScoreFor now grades it. Same weight, honest
 * shape.
 *
 * HARD CONSTRAINTS BECAME A PENALTY INSTEAD OF A BUDGET, AND THAT MATTERS MORE THAN IT SOUNDS.
 * v3 awarded 10 points for having no clearance/citizenship/sponsorship problem, and experience paid
 * out even when the posting stated no requirement. Between them a posting with ZERO skill overlap
 * still collected ~33 of 100 for nothing but the absence of a detected problem, which is why the
 * board's floor sat around 30 and why an obviously unqualified match could not score genuinely low.
 * Not being disqualified is not evidence of fit. Constraints now only ever subtract.
 */
export const SKILL_POINTS = 70;
export const VERB_POINTS = 8;
export const EXPERIENCE_POINTS = 22;
/** Each hard constraint the candidate fails. Subtracted, never awarded. */
export const HARD_MISS_PENALTY = 15;

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

export function buildRuntimeAtsBasis({ resumeText = "", signalProfile = {}, domainProfile = {}, termWeights = null } = {}) {
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
    // Corpus weights ride along on the basis so the four call sites in server.js load them once per
    // request rather than once per job. Null is a supported state: the scorer falls back to
    // unweighted counting, which is exactly v3's behaviour.
    termWeights: termWeights || null,
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
/**
 * Skill names that are also ordinary English words, and cannot be admitted on a substring alone.
 *
 * DIAGNOSED FROM A REAL INVERSION. "Staff UX Researcher, Incubations (Mixed Methods)" scored 30
 * against a backend resume — its third-highest engineering-ish score — and the reason was that the
 * registry admitted `Go` because the posting contains the English word "go". The candidate lists Go,
 * so it matched, and a UX research role collected skill credit for a programming language nobody
 * mentioned.
 *
 * The registry pass is a SUBSTRING test against the posting, which is exactly the wrong instrument
 * for a term like this. So for these, the substring is not enough: the term is admitted only when
 * the enrichment's skills_json also names it — i.e. when something that actually READ the posting
 * judged it a skill. Trust the reader, not the substring.
 *
 * Deliberately short and only the genuinely ambiguous cases. A long list here would start dropping
 * real skills from real postings, which is the opposite failure.
 */
const AMBIGUOUS_SKILL_WORDS = new Set([
  "go", "r", "c", "swift", "rust", "dart", "ruby", "scratch", "processing", "spring", "struts",
  "unity", "shell", "bash", "spark", "hive", "pig", "storm", "kafka", "flink", "beam", "arrow",
]);

function isAmbiguousUncorroborated(key, enrichedKeys) {
  if (!AMBIGUOUS_SKILL_WORDS.has(key)) return false;
  return !enrichedKeys.has(key);
}

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
  const enrichedKeys = new Set([...(jobSkills.hard || []), ...(jobSkills.soft || [])]
    .map(normaliseAtsTerm).filter(Boolean));
  for (const term of companyStackTerms(company)) {
    const key = normaliseAtsTerm(term);
    if (key && normJob.includes(` ${key} `) && !isAmbiguousUncorroborated(key, enrichedKeys)) {
      admitUnlessSoft(term);
    }
  }
  for (const [key, label] of skillIndex()) {
    if (normJob.includes(` ${key} `) && !isAmbiguousUncorroborated(key, enrichedKeys)) {
      admitUnlessSoft(label);
    }
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

/**
 * How far apart the words of a multi-word term may sit and still count as that term.
 *
 * A phrase match is the honest case ("distributed systems" really appears). The slack exists only so
 * that a reordering or one inserted word still matches — "design of distributed systems" for
 * "distributed systems design" — because requiring an exact phrase would report real experience as
 * a gap. Beyond this window the words are not a phrase, they are coincidence.
 *
 * 1 IS MEASURED, NOT PICKED. Sweeping the value against the live board and the coffee-machine probe:
 *
 *   slack   true adjacent matches   scattered artifacts   "machine learning" false-matched?
 *     0             247                   0 (0.0%)                 no
 *     1             247                   2 (0.8%)                 no
 *     2             247                   2 (0.8%)                 no
 *     3             247                   2 (0.8%)                 YES
 *
 * True matches are unaffected throughout — they take the exact-phrase path above. At 3 the window is
 * wide enough to rejoin "learning ... coffee machine", which is the exact failure being fixed, so the
 * usable range is 0-2 and 1 is the middle of it: one inserted or reordered word, and no more.
 */
const TERM_PROXIMITY_SLACK = 1;

/**
 * Pre-tokenised resume text. Built ONCE per score, for two reasons.
 *
 * Correctness: proximity needs token POSITIONS, and the old check had none.
 * Cost: hasTerm re-normalised the entire resume on every one of ~40 terms per job, which is most of
 * the measured 10.3 ms/job. The swipe feed scores on the critical path of a card, so this is not a
 * micro-optimisation.
 */
function buildMatchIndex(haystack) {
  const text = ` ${normaliseAtsTerm(haystack)} `;
  const tokens = text.match(/[a-z0-9+#]+/g) || [];
  const positions = new Map();
  tokens.forEach((tok, i) => {
    let list = positions.get(tok);
    if (!list) { list = []; positions.set(tok, list); }
    list.push(i);
  });
  return { text, positions };
}

/**
 * Does the resume actually contain this term?
 *
 * THE BUG THIS REPLACES, BECAUSE IT WILL LOOK LIKE AN OVER-COMPLICATION OTHERWISE
 * The previous fallback was `parts.every(part => text.includes(part))` — every word of the term
 * appearing SOMEWHERE in the resume, in any order, at any distance. So a resume reading "I design
 * learning materials for a coffee machine vendor" matched `machine learning`, and on the live board
 * 22.8% of all multi-word matches were this artifact: `engineering management` credited to "business
 * administration management", `state management` credited to "city state".
 *
 * That is the "confidently wrong" failure that costs the most trust — it does not merely inflate the
 * number, it tells the candidate they have a skill they do not have. Adjacency, then a bounded
 * window, and nothing further.
 */
function hasTerm(index, term) {
  const key = normaliseAtsTerm(term);
  if (!key) return false;
  if (index.text.includes(` ${key} `)) return true;
  const parts = key.split(" ").filter(Boolean);
  if (parts.length < 2) return false;

  const lists = [];
  for (const part of parts) {
    const list = index.positions.get(part);
    if (!list) return false;           // a word missing entirely settles it
    lists.push(list);
  }
  // Smallest window containing one position from each list. Sweep the first word's occurrences and
  // ask whether the others fall inside the allowed span; the lists are short, so this stays cheap.
  const span = parts.length + TERM_PROXIMITY_SLACK;
  for (const start of lists[0]) {
    let lo = start;
    let hi = start;
    let ok = true;
    for (let i = 1; i < lists.length; i++) {
      let best = null;
      let bestDist = Infinity;
      for (const p of lists[i]) {
        const dist = Math.max(hi, p) - Math.min(lo, p);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      if (best == null) { ok = false; break; }
      lo = Math.min(lo, best);
      hi = Math.max(hi, best);
      if (hi - lo > span) { ok = false; break; }
    }
    if (ok && hi - lo <= span) return true;
  }
  return false;
}

function hasVerb(index, verb) {
  const wanted = normaliseActionVerb(verb);
  if (!wanted) return false;
  for (const token of index.positions.keys()) {
    if (normaliseActionVerb(token) === wanted) return true;
  }
  return false;
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

/**
 * The weighted match ratio. Falls back to plain counting when there is no weight table, so an
 * unweighted deployment scores exactly as it did before rather than not at all.
 */
function weightedRatio(matchedTerms, allTerms, termWeights) {
  if (!allTerms.length) return null;
  if (!termWeights || !termWeights.size) {
    return matchedTerms.length / allTerms.length;
  }
  const weightOf = t => termWeights.get(normaliseAtsTerm(t)) ?? NEUTRAL_TERM_WEIGHT;
  let total = 0;
  let hit = 0;
  for (const t of allTerms) total += weightOf(t);
  for (const t of matchedTerms) hit += weightOf(t);
  return total > 0 ? hit / total : matchedTerms.length / allTerms.length;
}

/**
 * Mirrors atsTermWeights.NEUTRAL_WEIGHT. Duplicated as a literal rather than imported because this
 * module must not depend on the weight module — see the one-way note in services/atsTermWeights.js.
 */
export const NEUTRAL_TERM_WEIGHT = 1.0;

/**
 * Below this many scored terms the posting has not told us enough to score it.
 *
 * WHY THIS EXISTS: ratio() returns 1 on an empty denominator, so a posting from which nothing was
 * extracted used to score a full 50/50 on skills and emerge around 50 — a fabricated number
 * indistinguishable from a real mediocre fit. "Not enough signal to score" is an honest answer and
 * a better product than a confident 50.
 */
export const MIN_SCORABLE_TERMS = 4;

/**
 * Graded experience fit, replacing a 17-point binary cliff.
 *
 * THE CLIFF WAS THE WHOLE SCORE. Measured on the live board before this change, the experience
 * component correlated r=0.96 with the final score while the skill component managed r=0.21; with
 * the requirement satisfied the entire remaining spread was sd 2.87 on a 0-100 scale. A single
 * boolean was doing the ranking and the skills were decoration.
 *
 * Two changes. The penalty is now GRADED by how far short the candidate falls — being one year
 * under a 5-year ask is not the same as being eight years under, and the old code scored them
 * identically. And being far OVER is now penalised too, mildly: a senior role far above the
 * profile is a poor fit that pure term overlap would happily score high, which is exactly the
 * adversarial case a swipe feed must not get wrong.
 */
function experienceRatio(requiredYears, candidateYears) {
  // null means "this component carries no information", NOT "score it zero" and NOT "score it
  // full". See the renormalisation note in scoreAtsLocally — a component with nothing to say is
  // dropped from the average rather than voting.
  if (requiredYears == null) return null;
  if (candidateYears == null) return 0.55;  // the profile, not the job, is the incomplete one
  const gap = candidateYears - requiredYears;
  if (gap >= 0) {
    // Over-qualification is a soft signal, so the taper is gentle and floors at 70%.
    const over = Math.max(0, gap - 4);
    return Math.max(0.7, 1 - over * 0.06);
  }
  const short = -gap;
  if (short <= 1) return 0.8;
  if (short <= 2) return 0.6;
  if (short <= 4) return 0.35;
  return 0.1;
}

export function scoreAtsLocally({ job = {}, resumeText = "", runtimeBasis = null, signalProfile = null, domainProfile = null, termWeights = null } = {}) {
  const basis = runtimeBasis || buildRuntimeAtsBasis({ resumeText, signalProfile, domainProfile });
  const weights = termWeights || basis.termWeights || null;
  const jobText = [
    job.title,
    job.company,
    job.category,
    job.description,
    job.requirements,
    job.skills,
  ].filter(Boolean).join("\n");
  const matchText = [basis.resumeText, basis.skills.join(" "), basis.titles.join(" "), basis.actionVerbs.join(" ")].join("\n");
  const matchIndex = buildMatchIndex(matchText);

  const { skills: jobTerms, competencies: jobCompetencies } = candidateTermsFromJob(jobText, basis, {
    company: job.company || "",
    jobSkills: jobSkillTerms(job),
  });
  const matchedSkills = jobTerms.filter(term => hasTerm(matchIndex, term));
  const missingSkills = jobTerms.filter(term => !hasTerm(matchIndex, term));
  const matchedCompetencies = jobCompetencies.filter(term => hasTerm(matchIndex, term));
  const missingCompetencies = jobCompetencies.filter(term => !hasTerm(matchIndex, term));

  const { verbs: jobVerbs, generic: genericVerbs } = candidateActionVerbsFromJob(jobText, basis);
  const matchedVerbs = jobVerbs.filter(verb => hasVerb(matchIndex, verb));
  const missingVerbs = jobVerbs.filter(verb => !hasVerb(matchIndex, verb));

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
  // score that dropped them would move every ATS gate in the product.
  const allScored = [...jobTerms, ...jobCompetencies];
  const allMatched = [...matchedSkills, ...matchedCompetencies];
  const scoredTerms = allScored.length;
  const scoredVerbs = jobVerbs.length + genericVerbs.length;
  const scoredVerbMatches = matchedVerbs.length + genericVerbs.filter(v => hasVerb(matchIndex, v)).length;

  // AK1 — DECLINE TO SCORE RATHER THAN FABRICATE.
  //
  // ratio() returns 1 on an empty denominator, so a posting nothing could be extracted from used to
  // take a full 50/50 on skills and emerge near 50 — a confident, entirely invented number that
  // read exactly like a real mediocre fit. The three conditions below are the cases where the
  // engine genuinely has no basis for an opinion, and saying so is the honest product.
  // The conditions are about SIGNAL, not about length. An earlier draft declined any resume under
  // 200 characters, which is the kind of arbitrary threshold that reads as rigour and is not: a
  // short resume that matches nothing already scores low, honestly, and does not need a special
  // case. What genuinely cannot be scored is a posting nothing was extracted from, or a profile
  // with nothing on either side to match against.
  const declineReasons = [];
  if (scoredTerms < MIN_SCORABLE_TERMS) {
    declineReasons.push(`Only ${scoredTerms} scorable term${scoredTerms === 1 ? "" : "s"} could be extracted from this posting.`);
  }
  if (!(basis.resumeText || "").trim() && !basis.skills.length && !basis.titles.length) {
    declineReasons.push("No resume text and no profile skills to score against.");
  }

  // AK1 — WEIGHTED, so that matching `python` is worth more than matching `systems`.
  // Weights are corpus-derived (services/atsTermWeights.js) and PASSED IN; when absent this is
  // exactly the old unweighted ratio, so a deployment without a weight table is unchanged.
  const skillRatio = weightedRatio(allMatched, allScored, weights);
  const verbRatio = scoredVerbs ? scoredVerbMatches / scoredVerbs : null;
  const expRatio = experienceRatio(requiredYears, candidateYears);

  // AN UNKNOWN EXPERIENCE REQUIREMENT SCORES AT THE NEUTRAL RATE, AND THAT IS A MEASURED CHOICE.
  //
  // The obvious-looking alternative is to RENORMALISE — drop a component that carries no
  // information from both numerator and denominator, so the remaining components are scored on
  // their own scale. It was implemented and measured against the 30-posting judged set, and it made
  // the ranking WORSE: Spearman rho 0.448 -> 0.242, Kendall 0.322 -> 0.176, mis-ordered pairs
  // 33.6% -> 41.0%.
  //
  // The reason is worth keeping, because it is counter-intuitive and someone will try this again.
  // Renormalising lowers the floor (a zero-overlap job correctly drops from 26 to 10) but it also
  // amplifies the SKILL component's noise, and skill recall on this corpus is poor — postings
  // describe requirements abstractly ("multiple programming languages", "full-stack software
  // engineering") that no concrete resume matches lexically. So excellent matches collapsed too:
  // "Software Engineer, Payments, Risk" 28 -> 12, "TechOps Integration Reliability" 23 -> 5. Worse,
  // it handed the ranking back to the experience flag from the other direction — postings that DO
  // state a satisfied year requirement kept a full component and floated to the top, which is how a
  // Fraud Strategist and two Sales Manager roles came to outrank a backend engineering job.
  //
  // A constant under every score is a floor, which is a cosmetic problem. A component whose weight
  // depends on whether the posting happened to mention years is a ranking problem, which is the one
  // that matters. The flat rate stays until skill recall is good enough to carry the extra variance.
  const experienceScore = (expRatio == null ? 0.85 : expRatio) * EXPERIENCE_POINTS;
  const skillScore = (skillRatio == null ? 1 : skillRatio) * SKILL_POINTS;
  const verbScore = (verbRatio == null ? 1 : verbRatio) * VERB_POINTS;
  const hardPenalty = hardMisses.length * HARD_MISS_PENALTY;
  const score = declineReasons.length
    ? null
    : Math.max(0, Math.min(100, Math.round(skillScore + verbScore + experienceScore - hardPenalty)));

  return {
    source: LOCAL_ATS_SOURCE,
    score,
    // Null score and the reason it is null, so a caller never has to infer "0 or missing?".
    scorable: declineReasons.length === 0,
    decline_reasons: declineReasons,
    // Provenance of the weighting, so a reader can tell a weighted score from an unweighted one.
    weighting: weights && weights.size
      ? { applied: true, terms: weights.size }
      : { applied: false, terms: 0 },
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
