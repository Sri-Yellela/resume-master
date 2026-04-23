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

const TECH_SURFACE_HINT = /(?:\+\+|#|\.js|\/|api|apis|aws|azure|ci|cd|css|db|gcp|git|html|http|ios|java|js|kafka|kubernetes|linux|node|python|react|rest|sql|typescript|ux)/i;

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

function candidateTermsFromJob(jobText, runtimeBasis) {
  const terms = [];
  const normJob = ` ${normaliseAtsTerm(jobText)} `;

  for (const sourceTerm of runtimeBasis.skills || []) {
    const key = normaliseAtsTerm(sourceTerm);
    if (key && normJob.includes(` ${key} `)) terms.push(sourceTerm);
  }

  const rawPhrases = String(jobText || "").match(/\b[A-Za-z][A-Za-z0-9+#./-]*(?:\s+[A-Za-z][A-Za-z0-9+#./-]*){0,2}\b/g) || [];
  for (const raw of rawPhrases) {
    const tokens = tokenise(raw).filter(t => !STOP_WORDS.has(t));
    if (!tokens.length || tokens.length > 3) continue;
    const label = tokens.length === 1 ? tokens[0] : displayTerm(raw);
    if (tokens.length === 1 && !TECH_SURFACE_HINT.test(label) && label.length < 5) continue;
    if (tokens.length === 1 && STOP_WORDS.has(tokens[0])) continue;
    if (tokens.length > 1 || TECH_SURFACE_HINT.test(label)) terms.push(label);
  }

  return compactUnique(terms, 28);
}

function candidateActionVerbsFromJob(jobText, runtimeBasis) {
  const normJob = ` ${normaliseAtsTerm(jobText)} `;
  const verbs = [];
  for (const verb of runtimeBasis.actionVerbs || []) {
    const key = normaliseActionVerb(verb);
    if (key && normJob.includes(` ${key} `)) verbs.push(verb);
  }
  for (const token of tokenise(jobText)) {
    const verb = normaliseActionVerb(token);
    if (!verb || WEAK_ACTION_VERBS.has(verb)) continue;
    if (ACTION_VERB_HINTS.includes(verb) || /(?:ed|ing)$/.test(token)) verbs.push(token);
  }
  return compactUnique(verbs, 16);
}

function normaliseActionVerb(value) {
  let term = normaliseAtsTerm(value).split(" ")[0] || "";
  if (term.endsWith("ing") && term.length > 5) term = term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 4) term = term.slice(0, -2);
  if (term.endsWith("d") && term.length > 4) term = term.slice(0, -1);
  return term;
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

  const jobTerms = candidateTermsFromJob(jobText, basis);
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
