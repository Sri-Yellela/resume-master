// The generation kernel — draft's coreGenerateResume, minus everything that was draft's.
//
// WHAT MOVED: domain resolution, prompt assembly, the model call, deterministic formatting, the
// optional LLM formatting pass, and the claim guard.
// WHAT DID NOT: every database read and write, notifications, the in-flight de-dup, and ATS
// scoring. Scoring stays with the caller on purpose — draft scores with ITS corpus term weights,
// which this stateless service does not have, and a before/after lift is only a lift if both
// numbers come from the same scorer with the same weights.
//
// ⛔ STATELESS. The input arrives, the output is returned, nothing is persisted and no content is
// logged. See docs/API.md — that is a promise to every caller, not an implementation detail.
//
// ⛔ THE CLAIM GUARD IS CONTRACTUAL. It runs on every generated document BEFORE it is returned, and
// a violation means NO document is returned — the caller receives the violations instead. There is
// no option to skip it. In draft it protected draft's own users; as an API it protects every
// caller's candidates from a résumé claiming more than their profile states.
import { assemblePrompt } from "./promptAssembler.js";
import { buildRuntimeInputs, MODES, JOB_CONTEXTS, validateJobKeywords, renderJobKeywords } from "./runtimeInputs.js";
import { getDomainModuleKey } from "./domainModule.js";
import { classify } from "./classifier.js";
import { normalizeResumeHtml } from "../formatting/resumeFormatter.js";
import { FORMATTING_SYSTEM } from "../formatting/formattingSystem.js";
import { assertResumeClaims } from "../integrity/resumeClaimGuard.js";
import { UNTRUSTED_DATA_RULE, stripInvisible } from "../integrity/untrustedText.js";
import { callAnthropic, textOf, MODEL_SONNET, MODEL_HAIKU } from "../model/anthropicCall.js";

import { tailorResume, buildGists, GIST_MAX_CHARS } from "./tailor.js";
import { MODEL_CHOICES, openConfigured } from "../model/modelClient.js";
import { InvalidRequestError } from "../errors.js";
import { INPUT_LIMITS, capString, capRequest } from "./inputLimits.js";
// Re-exported: the class moved to src/errors.js (see there); existing importers keep working.
// ⛔ draft D173 (1): what the claim guard checks the résumé's contacts and links against — the candidate's own fields, and
// the posting text that went in (a link only the posting had is the posting's, never the candidate's).
const ownContactsOf = (c = {}) => [c.name, c.fullName, c.email, c.phone, c.linkedinUrl, c.githubUrl, c.portfolioUrl, c.website].filter(Boolean).join("\n");
const untrustedTextOf = (job = {}) => stripInvisible([job.description, job.title, job.company, ...(job.keywords?.phrases || [])].filter(Boolean).join("\n"));

export { InvalidRequestError };

export const TAILORINGS = Object.freeze(["full", "lean", "payload", "code"]);
const EDITING = new Set(["lean", "payload", "code"]);
// 1.8.0 bounds (D123 P6a / P6d): what the payload's candidate block may carry.
export const GIST_LIMITS = Object.freeze({ maxItems: 12, employerMaxLength: 200, textMaxLength: GIST_MAX_CHARS });
export const COURSEWORK_LIMITS = Object.freeze({ maxItems: 20, maxLength: 80 });

function validateGists(gists) {
  if (!Array.isArray(gists)) return "gists must be an array of { employer, text }";
  if (gists.length > GIST_LIMITS.maxItems) return `gists has more than ${GIST_LIMITS.maxItems} items`;
  for (const g of gists) {
    if (!g || typeof g !== "object" || typeof g.employer !== "string" || !g.employer.trim() || typeof g.text !== "string"
        || g.employer.length > GIST_LIMITS.employerMaxLength || g.text.length > GIST_LIMITS.textMaxLength || Object.keys(g).some(k => k !== "employer" && k !== "text")) {
      return `gists must hold { employer, text }: employer at most ${GIST_LIMITS.employerMaxLength} characters, text at most ${GIST_LIMITS.textMaxLength}`;
    }
  }
  return null;
}

function validateCoursework(list) {
  if (!Array.isArray(list) || list.length > COURSEWORK_LIMITS.maxItems
      || list.some(c => typeof c !== "string" || !c.trim() || c.length > COURSEWORK_LIMITS.maxLength)) {
    return `coursework must be at most ${COURSEWORK_LIMITS.maxItems} non-empty strings of at most ${COURSEWORK_LIMITS.maxLength} characters`;
  }
  return null;
}

function requireString(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new InvalidRequestError(`${name} is required`);
}

/**
 * @param client  an Anthropic SDK client
 * @param input   see docs/API.md — POST /v1/resumes/generate
 * @param env     process.env, injectable so the formatting lever is testable in both states
 * @returns { html, domainModuleKey, claimCheck, usage: UsageRecord[] }
 */
export async function generateResume(client, input = {}, { env = process.env } = {}) {
  const { candidate = {}, job = {}, baseResumeText, profile = null, claims = null, employers = [],
          options = {} } = input;
  const mode = input.mode ?? "GENERATE";
  if (!MODES.includes(mode)) throw new InvalidRequestError(`mode must be one of ${MODES.join(", ")}`);
  requireString(baseResumeText, "baseResumeText");
  requireString(job.title, "job.title");
  // A97: size caps, before any model call (the classifier included) — refused, never truncated.
  capString(baseResumeText, INPUT_LIMITS.baseResumeText, "baseResumeText");
  capString(job.description, INPUT_LIMITS.jobDescription, "job.description");
  capRequest(input, INPUT_LIMITS.generateRequestChars, "a generation request");
  // D70 Phase 3: AL6's cache lever, now on the contract. Absent is TRUE — the measured-best default,
  // and byte-for-byte the request this route sent before the option existed. Anything but a boolean
  // is refused: a string "false" read as truthy would cache while the caller believed it had not.
  if (options.cache !== undefined && typeof options.cache !== "boolean") {
    throw new InvalidRequestError("options.cache must be a boolean");
  }
  // D70 Phase 1: keywords instead of the posting, behind a flag. Absent is "description" — the pinned
  // prompt, byte for byte. "keywords" without job.keywords is refused rather than quietly sending a
  // prompt with no job context at all, and the posting's text is never a fallback in that mode.
  const jobContext = options.jobContext ?? "description";
  if (!JOB_CONTEXTS.includes(jobContext)) {
    throw new InvalidRequestError(`options.jobContext must be one of ${JOB_CONTEXTS.join(", ")}`);
  }
  if (jobContext === "keywords" && job.keywords == null) {
    throw new InvalidRequestError('options.jobContext "keywords" requires job.keywords — in that mode the posting\'s text is not sent, so the keywords are the only job context');
  }
  if (job.keywords != null) {
    const problem = validateJobKeywords(job.keywords);
    if (problem) throw new InvalidRequestError(problem);
  }
  // D123 P2: the lean path. The model edits bullets and skills only, from job.keywords; code builds the document.
  // Absent is "full" — this route's request, byte for byte, as before 1.7.0.
  const tailoring = options.tailoring ?? "full";
  if (!TAILORINGS.includes(tailoring)) throw new InvalidRequestError(`options.tailoring must be one of ${TAILORINGS.join(", ")}`);
  // 1.8.0 (D123): the caller may name the model of an editing tailoring; gists (payload) and coursework (payload, code).
  if (options.model !== undefined) {
    if (!MODEL_CHOICES.includes(options.model)) throw new InvalidRequestError(`options.model must be one of ${MODEL_CHOICES.join(", ")}`);
    if (tailoring !== "lean" && tailoring !== "payload") throw new InvalidRequestError('options.model is read only with options.tailoring "lean" or "payload"');
    if (options.model === "open" && !openConfigured(env)) throw new InvalidRequestError('options.model "open" is not configured on this service');
  }
  if (input.gists !== undefined) {
    if (tailoring !== "payload") throw new InvalidRequestError('gists are read only with options.tailoring "payload"');
    const problem = validateGists(input.gists);
    if (problem) throw new InvalidRequestError(problem);
  }
  if (input.coursework !== undefined) {
    if (tailoring !== "payload" && tailoring !== "code") throw new InvalidRequestError('coursework is read only with options.tailoring "payload" or "code"');
    const problem = validateCoursework(input.coursework);
    if (problem) throw new InvalidRequestError(problem);
  }
  if (tailoring === "lean" && (job.keywords?.mustHave || job.keywords?.niceToHave || job.keywords?.broader)) {
    // The lean call stays 1.7.0's; the payload's fields are refused there rather than silently ignored.
    throw new InvalidRequestError('job.keywords.mustHave, niceToHave and broader are read only with options.tailoring "payload" or "code"');
  }
  if (EDITING.has(tailoring)) {
    if (mode !== "GENERATE") throw new InvalidRequestError(`options.tailoring "${tailoring}" is for mode GENERATE only`);
    if (job.keywords == null) throw new InvalidRequestError(`options.tailoring "${tailoring}" requires job.keywords — the posting text is not sent in that mode`);
    const lean = await tailorResume(client, { baseResumeText, job, keywords: job.keywords, claims, includeSummary: options.includeSummary === true, env,
                                              variant: tailoring, model: options.model ?? null, gists: input.gists || [], coursework: input.coursework || [] });
    let claimResult;
    try {
      claimResult = assertResumeClaims({
        html: lean.html,
        profile: { years_of_experience: candidate.yearsOfExperience ?? null },
        baseResumeText,
        domainProfile: profile ? { seniority: profile.seniority ?? null } : null,
        ownContacts: ownContactsOf(candidate), untrustedText: untrustedTextOf(job),
      });
    } catch (e) {
      throw Object.assign(e, { usageSoFar: lean.usage });
    }
    return { html: lean.html, domainModuleKey: tailoring, claimCheck: { ok: true, inspected: claimResult.checked.inspected },
             tailoring: lean.tailoring, usage: lean.usage };
  }
  if (["placements", "broader", "mustHave", "niceToHave"].some(k => job.keywords?.[k] !== undefined)) {
    // read by the editing paths only; refused elsewhere rather than silently ignored.
    throw new InvalidRequestError('job.keywords.placements is read only with an editing tailoring (lean, payload or code); so are broader, mustHave and niceToHave');
  }
  if (options.model !== undefined || input.gists !== undefined || input.coursework !== undefined) {
    throw new InvalidRequestError("options.model, gists and coursework are read only by an editing tailoring");
  }
  const usage = [];

  // Domain module: explicit key, else role family + domain, else classify (a model call).
  let domainModuleKey = input.domainModuleKey || null;
  if (!domainModuleKey && input.roleFamily) domainModuleKey = getDomainModuleKey(input.roleFamily, input.domain);
  // In keywords mode the classifier reads the keywords block, never the posting.
  const classifierJobText = jobContext === "keywords" ? renderJobKeywords(job.keywords) : job.description || "";
  if (!domainModuleKey) {
    try {
      const c = await classify(client, baseResumeText, classifierJobText);
      usage.push(c.usage);
      domainModuleKey = c.domainModuleKey;
    } catch (e) {
      // Same degradation draft had: a failed classification is not a failed generation.
      if (e?.usage) usage.push(e.usage);
      domainModuleKey = "general";
    }
  }

  // AI1. The summary is opt-in and defaults OFF. The flag reaches the PROMPT, not a post-processor,
  // so no summary is generated to strip.
  const includeSummary = options.includeSummary === true;
  const runtimeInputs = buildRuntimeInputs({ candidate, job, baseResumeText, mode, employers, profile, claims, jobContext });
  const { systemBlocks: assembled } = assemblePrompt(domainModuleKey, mode, runtimeInputs, { SUMMARY: includeSummary },
    { cache: options.cache !== false });
  // ⛔ draft D173 (1): the rule for the fenced posting rides on the first (cached) block — no extra breakpoint.
  const systemBlocks = assembled.map((b, i) => (i === 0 ? { ...b, text: `${b.text}\n\n${UNTRUSTED_DATA_RULE}` } : b));

  const gen = await callAnthropic(client, {
    purpose: "resume_generate",
    model: MODEL_SONNET,
    // Sonnet 5 thinks by default and max_tokens covers thinking + output, so leaving this implicit
    // would eat the HTML budget. Truncated HTML is especially bad: it is parsed into the résumé.
    thinking: { type: "disabled" },
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: "user", content: runtimeInputs }],
  }).catch(e => { if (e?.usage) usage.push(e.usage); throw Object.assign(e, { usageSoFar: usage }); });
  usage.push(gen.usage);
  const html = textOf(gen.message).replace(/```html|```/g, "").trim();

  let formattedHtml = normalizeResumeHtml(html);
  if (env.RESUME_MASTER_LLM_FORMAT === "1") {
    try {
      const fmt = await callAnthropic(client, {
        purpose: "resume_format",
        model: MODEL_HAIKU,
        max_tokens: 4096,
        system: [{ type: "text", text: FORMATTING_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Reformat this resume HTML to match the design specification exactly. Preserve all content:\n\n${html}` }],
      });
      usage.push(fmt.usage);
      const formatted = textOf(fmt.message).replace(/```html|```/g, "").trim();
      if (formatted) formattedHtml = normalizeResumeHtml(formatted);
    } catch (e) {
      if (e?.usage) usage.push(e.usage);
      // The deterministic render stands; the optional pass failing is not a failed generation.
    }
  }

  // ⛔ AF2 — THE JD MAY STEER EMPHASIS, NEVER A QUANTITY OR A LEVEL. Throws ResumeClaimError on a
  // violation and ResumeClaimNotInspectedError if it was handed nothing to read. The document is
  // never returned in either case.
  let claimResult;
  try {
    claimResult = assertResumeClaims({
      html: formattedHtml,
      profile: { years_of_experience: candidate.yearsOfExperience ?? null },
      baseResumeText,
      domainProfile: profile ? { seniority: profile.seniority ?? null } : null,
      ownContacts: ownContactsOf(candidate), untrustedText: untrustedTextOf(job),
    });
  } catch (e) {
    throw Object.assign(e, { usageSoFar: usage });
  }

  return {
    html: formattedHtml,
    domainModuleKey,
    claimCheck: { ok: true, inspected: claimResult.checked.inspected },
    usage,
  };
}

/**
 * 1.8.0 (D123 P6g (2)) · POST /v1/resumes/gists — the per-employer gists of a base résumé, built once on the Sonnet tier.
 * Stateless like every route here: the caller stores the answer with its résumé and sends it back as `gists`.
 */
export async function generateGists(client, input = {}) {
  requireString(input.baseResumeText, "baseResumeText");
  capString(input.baseResumeText, INPUT_LIMITS.baseResumeText, "baseResumeText");
  return buildGists(client, { baseResumeText: input.baseResumeText });
}
