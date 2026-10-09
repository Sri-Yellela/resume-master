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
import { buildRuntimeInputs, MODES } from "./runtimeInputs.js";
import { getDomainModuleKey } from "./domainModule.js";
import { classify } from "./classifier.js";
import { normalizeResumeHtml } from "../formatting/resumeFormatter.js";
import { FORMATTING_SYSTEM } from "../formatting/formattingSystem.js";
import { assertResumeClaims } from "../integrity/resumeClaimGuard.js";
import { callAnthropic, textOf, MODEL_SONNET, MODEL_HAIKU } from "../model/anthropicCall.js";

import { InvalidRequestError } from "../errors.js";
// Re-exported: the class moved to src/errors.js (see there); existing importers keep working.
export { InvalidRequestError };

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
  // D70 Phase 3: AL6's cache lever, now on the contract. Absent is TRUE — the measured-best default,
  // and byte-for-byte the request this route sent before the option existed. Anything but a boolean
  // is refused: a string "false" read as truthy would cache while the caller believed it had not.
  if (options.cache !== undefined && typeof options.cache !== "boolean") {
    throw new InvalidRequestError("options.cache must be a boolean");
  }
  const usage = [];

  // Domain module: explicit key, else role family + domain, else classify (a model call).
  let domainModuleKey = input.domainModuleKey || null;
  if (!domainModuleKey && input.roleFamily) domainModuleKey = getDomainModuleKey(input.roleFamily, input.domain);
  if (!domainModuleKey) {
    try {
      const c = await classify(client, baseResumeText, job.description || "");
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
  const runtimeInputs = buildRuntimeInputs({ candidate, job, baseResumeText, mode, employers, profile, claims });
  const { systemBlocks } = assemblePrompt(domainModuleKey, mode, runtimeInputs, { SUMMARY: includeSummary },
    { cache: options.cache !== false });

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
