// The A+ enhancement rewrite — draft's enhanceProfileResume, minus its database and scoring.
// The system prompt and the user message are unchanged. The caller scores original vs enhanced
// with its own weights and decides what to persist; this service persists nothing.
import { callAnthropic, textOf, MODEL_SONNET } from "../model/anthropicCall.js";
import { InvalidRequestError } from "./generate.js";

export const ENHANCE_SYSTEM = `You are a professional resume writer specialising in ATS optimisation.
Rewrite the provided resume to significantly improve its ATS score by:
- Strengthening action verbs (replace weak verbs with domain-specific strong ones)
- Improving keyword density and placement without keyword stuffing
- Selectively incorporating the highest-value ATS additions only when they are realistic for the candidate
- Restructuring bullet points to lead with impact (action -> outcome -> metric)
- Removing filler adjectives and generic phrases
- Ensuring consistent past tense and clean formatting
- Keeping all facts, dates, companies, job titles, and metrics exactly as provided
Do NOT fabricate any information. Do NOT change employment dates, company names, or job titles.
Do NOT keyword-dump. Omit low-value or duplicative additions.
Return ONLY the improved resume text with no commentary, preamble, or explanation.`;

/** @returns { text, usage: UsageRecord[] } */
export async function enhanceResume(client, { resumeText, profile = {}, selectedAdditions = [] } = {}) {
  if (typeof resumeText !== "string" || !resumeText.trim()) throw new InvalidRequestError("resumeText is required");
  const { message, usage } = await callAnthropic(client, {
    purpose: "resume_enhance",
    model: MODEL_SONNET,
    // Deterministic rewrite; ran with no thinking on Sonnet 4. 8000 because Sonnet 5's tokenizer
    // emits ~30% more tokens for the same text and 4000 could truncate the résumé.
    thinking: { type: "disabled" },
    max_tokens: 8000,
    system: ENHANCE_SYSTEM,
    messages: [{ role: "user", content: `PROFILE NAME: ${profile.name}
ROLE FAMILY: ${profile.roleFamily}
DOMAIN: ${profile.domain}
SELECTED ATS ADDITIONS TO CONSIDER:
${selectedAdditions.map((label, idx) => `${idx + 1}. ${label}`).join("\n")}

RESUME TO ENHANCE:

${resumeText}` }],
  });
  return { text: textOf(message).trim(), usage: [usage] };
}
