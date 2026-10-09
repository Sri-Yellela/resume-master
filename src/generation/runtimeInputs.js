// The per-request block of the generation prompt — everything that VARIES, which is why it is the
// user message and sits after every cache breakpoint (see promptAssembler.js).
//
// Moved from draft's server.js buildRuntimeInputs. The only change is the INPUT SHAPE: draft passed
// its own database rows (user_profile, domain_profiles with JSON-string columns); an API takes a
// documented object. The RENDERED TEXT is byte-identical to draft's for the same facts — verified
// against draft's function when this moved, and pinned by test/runtimeInputs.test.js — because this
// text is what the model reads, and a "harmless" reformat is a change to every résumé.

// Employers never injected into a prompt, whatever the caller sends.
const EXCLUDED_COMPANIES = ["apple", "netflix", "fidelity", "tiktok", "bytedance"];

export function sanitiseEmployers(employers) {
  if (!employers?.length) return employers;
  return employers.filter(e => !EXCLUDED_COMPANIES.includes((e || "").toLowerCase().trim()));
}

export const MODES = Object.freeze(["GENERATE", "A_PLUS"]);

// ── D70 Phase 1: KEYWORDS INSTEAD OF THE POSTING, behind options.jobContext ──────────────────────
//
// "description" (THE DEFAULT) renders the posting's text exactly as this module always has — the
// bytes are pinned (test/runtimeInputs.test.js) and stay so until draft's A/B passes.
// "keywords" renders a compact block from job.keywords INSTEAD, and the posting's text is not sent
// at all — not in the generation prompt and not to the classifier — even when the caller also sent
// job.description. draft computes job.keywords with its deterministic scorer (no model call): the
// posting terms the résumé evidences, the ones the candidate has claimed, matched and claimed verbs,
// competencies, a few short responsibility phrases and the posting's seniority. What is NEVER in it:
// terms that are missing AND unclaimed, and generic language.
export const JOB_CONTEXTS = Object.freeze(["description", "keywords"]);

/** Bounds on job.keywords — declared in the contract from here, and enforced in validateJobKeywords. */
export const KEYWORD_LIMITS = Object.freeze({
  maxLength: 80,                 // one term, verb or phrase
  seniorityMaxLength: 40,
  maxItems: Object.freeze({ matched: 60, claimed: 40, verbs: 30, competencies: 30, phrases: 12 }),
});
export const KEYWORD_LISTS = Object.freeze(Object.keys(KEYWORD_LIMITS.maxItems));

/** @returns an error message, or null when `keywords` is a valid job.keywords */
export function validateJobKeywords(keywords) {
  if (!keywords || typeof keywords !== "object" || Array.isArray(keywords)) return "job.keywords must be an object";
  for (const k of Object.keys(keywords)) {
    if (!KEYWORD_LISTS.includes(k) && k !== "seniority") return `job.keywords.${k} is not a known field`;
  }
  for (const k of KEYWORD_LISTS) {
    const list = keywords[k];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `job.keywords.${k} must be an array of strings`;
    if (list.length > KEYWORD_LIMITS.maxItems[k]) return `job.keywords.${k} has more than ${KEYWORD_LIMITS.maxItems[k]} items`;
    for (const t of list) {
      if (typeof t !== "string" || !t.trim()) return `job.keywords.${k} must hold non-empty strings`;
      if (t.length > KEYWORD_LIMITS.maxLength) return `job.keywords.${k} has an item longer than ${KEYWORD_LIMITS.maxLength} characters`;
    }
  }
  const s = keywords.seniority;
  if (s !== undefined && s !== null && (typeof s !== "string" || s.length > KEYWORD_LIMITS.seniorityMaxLength)) {
    return `job.keywords.seniority must be a string of at most ${KEYWORD_LIMITS.seniorityMaxLength} characters`;
  }
  return null;
}

/**
 * The keywords block that stands in for the posting when jobContext is "keywords". A line whose
 * list is empty is left out, so the block stays compact. The posting's seniority is labelled as the
 * POSTING's: the claim guard's ceiling is the candidate's own declaration, and the prompt agrees.
 */
export function renderJobKeywords(keywords = {}) {
  const list = (k, sep = ", ") => (keywords[k] || []).map(t => String(t).trim()).filter(Boolean).join(sep);
  const line = (label, value) => value ? `**${label}:** ${value}\n` : "";
  const seniority = typeof keywords.seniority === "string" ? keywords.seniority.trim() : "";
  return `**TARGET JOB — KEYWORDS ONLY (the posting's own text is deliberately not provided; do not reconstruct or imagine it)**
${line("Seniority the POSTING asks for (the posting's level, never the candidate's — never raise a title or level to meet it)", seniority)}${line("Posting terms the base resume already evidences", list("matched"))}${line("Posting terms the CANDIDATE has claimed (candidate-supplied — not yet shown in the base resume)", list("claimed"))}${line("Posting action verbs the candidate matches or has claimed", list("verbs"))}${line("Competencies the posting asks for", list("competencies"))}${line("Responsibility phrases from the posting", list("phrases", "; "))}**How to use the keywords above:** they steer EMPHASIS AND WORDING only — which supported work a bullet
leads with, which technologies it names and which verb opens it. A claimed term follows the same rules
as the candidate's claims: use it only where the base resume already supports the work. You may NOT
invent an employer, a project, a duration, a metric or a responsibility to fit a keyword. A keyword
the base resume cannot carry is simply not used.`;
}

function displayModeForPrompt(mode) {
  const key = String(mode || "").toUpperCase();
  if (key === "CUSTOM_SAMPLER" || key === "A_PLUS") return "A+";
  return "Generate";
}

/**
 * @param candidate  { fullName, phone, email, linkedinUrl, githubUrl, location, yearsOfExperience }
 * @param job        { title, company, category, description, stack }
 * @param profile    the candidate's job profile, or null: { name, seniority, keywords[], tools[], actionVerbs[] }
 * @param claims     skills/verbs the CANDIDATE asserts, or null: { skills[], actionVerbs[] }
 * @param jobContext "description" (default — the pinned bytes) | "keywords" (job.keywords instead of
 *                   the posting; job.description is never rendered). See JOB_CONTEXTS above.
 */
export function buildRuntimeInputs({ candidate = {}, job = {}, baseResumeText = "", mode = "GENERATE",
                                     employers = [], profile = null, claims = null,
                                     jobContext = "description" } = {}) {
  const isAPlus = mode === "CUSTOM_SAMPLER" || mode === "A_PLUS";
  const isGenerate = mode === "TAILORED" || mode === "GENERATE";
  const userLocation = isAPlus ? "" : (candidate?.location || "");
  let employerBlock = "";
  // Apply exclusion list before injecting employer names into prompt
  const safeEmployers = sanitiseEmployers(employers);
  if (isGenerate && safeEmployers?.length >= 2)
    employerBlock = `**Employer 1 (fixed):** ${safeEmployers[0]}\n**Employer 2 (fixed):** ${safeEmployers[1]}\n`;

  const candidateName = candidate?.fullName || "";

  // AF2. The summary is required to state total years, and before this the ONLY number in context
  // asking for a quantity was the JD's own "8+ years required". The profile's own figure is the
  // authority; when it is unset the base resume is, and the prompt says so explicitly.
  const profileYears = Number(candidate?.yearsOfExperience);
  const yearsBlock = Number.isFinite(profileYears) && profileYears > 0
    ? `**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** ${profileYears}\n`
    : `**Candidate years of experience:** not stated — derive from the base resume dates only, never from the JD\n`;

  // The seniority line is the candidate's OWN declaration — they may use it and may not exceed it.
  // The claim guard's ceiling is the same declaration, so the prompt and the guard agree.
  let domainProfileBlock = "";
  if (profile) {
    const kw    = (profile.keywords    || []).join(", ");
    const tools = (profile.tools       || []).join(", ");
    const verbs = (profile.actionVerbs || []).join(", ");
    domainProfileBlock = `
**User domain profile:** ${profile.name}
**Seniority the candidate states they are (their own declaration — you may use it, and may not exceed it):** ${profile.seniority}
**Profile keywords:** ${kw || "—"}
**Profile tools:** ${tools || "—"}
**Profile action verbs:** ${verbs || "—"}
`;
  }

  // AG2. Terms the CANDIDATE has claimed. Skills and verbs only — never a title, level or headline:
  // 6 of 8 real generations adopted a JD's title from a looser wording of this block, and the claim
  // guard refused all six.
  let claimsBlock = "";
  const claimedSkills = (claims?.skills || []).join(", ");
  const claimedVerbs = (claims?.actionVerbs || []).join(", ");
  if (claimedSkills || claimedVerbs) {
    claimsBlock = `
**Skills the CANDIDATE has claimed (candidate-supplied — they assert these are true of them):** ${claimedSkills || "—"}
**Action verbs the CANDIDATE has claimed:** ${claimedVerbs || "—"}
**How to use the claims above:** they are SKILLS AND VERBS ONLY. They may change which technologies
a bullet names and which verb opens it, where the base resume already supports the work being
described. They are NOT a title, a level or a headline: never change the candidate's tagline, role
titles or seniority because of a claim — those come from the base resume alone. You may NOT invent
an employer, a project, a duration, a metric or a responsibility to justify a claim, and you may
NOT add a claimed term to a role that did not involve it. A claim the base resume cannot carry is
simply not used.
`;
  }

  // The one place the posting enters the prompt. "description" is the pinned text, unchanged.
  const jobBlock = jobContext === "keywords"
    ? renderJobKeywords(job.keywords || {})
    : `**TARGET JOB DESCRIPTION**
${job.description||job.title}`;

  return `## RUNTIME INPUTS

**Mode:** ${displayModeForPrompt(mode)}
**Candidate full name:** ${candidateName}
**Phone:** ${candidate?.phone||""}
**Email:** ${candidate?.email||""}
**LinkedIn URL:** ${candidate?.linkedinUrl||""}
**GitHub URL:** ${candidate?.githubUrl||""}
**User location (City, State):** ${userLocation}
${yearsBlock}${employerBlock}${domainProfileBlock}${claimsBlock}
**Target role / job title:** ${job.title}
**Target industry / domain:** ${job.category && job.category !== "Other" ? job.category : job.title || "Technology"}
**Target company:** ${job.company}
**Known tech stack of target company:** ${job.stack||"unknown"}

---

${jobBlock}

---

**BASE RESUME TEXT**
${baseResumeText}`;
}
