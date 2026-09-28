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
 */
export function buildRuntimeInputs({ candidate = {}, job = {}, baseResumeText = "", mode = "GENERATE",
                                     employers = [], profile = null, claims = null } = {}) {
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

**TARGET JOB DESCRIPTION**
${job.description||job.title}

---

**BASE RESUME TEXT**
${baseResumeText}`;
}
