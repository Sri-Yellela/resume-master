// Classifies a résumé + job description into a role family and domain, when the caller did not
// supply a domain module. Moved from draft's services/classifier.js; the prompt is unchanged.
import { callAnthropic, textOf, MODEL_HAIKU } from "../model/anthropicCall.js";
import { getDomainModuleKey } from "./domainModule.js";

// draft's PROFILE_SENIORITY vocabulary (shared/jobFilterOptions.js) — the values a caller's
// profile.seniority is expected to hold, so the model is never asked for one it cannot use.
// Read from draft's registry when this moved (values(PROFILE_SENIORITY)); test/classifier.test.js
// pins it, because the classifier prompt interpolates it and a wrong list changes the prompt.
export const PROFILE_SENIORITY_VALUES = Object.freeze(["junior", "mid", "senior", "executive"]);

export async function classify(client, resumeText, jdText) {
  const prompt = `Classify this resume and job description combination.

Resume (first 2000 chars):
${String(resumeText || "").slice(0, 2000)}

Job Description (first 1500 chars):
${(jdText || "").slice(0, 1500)}

IMPORTANT classification rules:
- Use "data" for machine learning, AI/ML, data science, data engineering, analytics engineering, LLM, GenAI, NLP, computer vision, quantitative research roles. Do NOT classify these as "engineering".
- Use "engineering" ONLY for general software/web/backend/frontend/platform/infrastructure/cloud/devops/SRE roles.
- Use "engineering" for firmware, embedded, BSP, RTOS, UEFI, silicon validation, device driver roles IF the domain is "it_digital". For these roles, prefer domain="it_digital" so the system can route them to the correct sub-bucket.
- Use "pm" for product managers, project managers, program managers, scrum masters, product owners. Do NOT classify PM roles as "engineering" even if they require technical background.
- Use "hr" for recruiting, talent acquisition, HR business partners, people operations, compensation, L&D roles.
- Use "finance" for financial analysts, investment banking, FP&A, treasury, credit, audit, accounting roles.
- Use "design" for UX, UI, product design, graphic design, user research roles.
- Use "marketing" for marketing managers, SEO/SEM, growth, brand, content, social media, PMM roles.
- Use "legal" for attorneys, counsel, compliance officers, paralegal, regulatory affairs roles.
- Use "operations" for supply chain, logistics, procurement, manufacturing, quality, fulfillment roles.
- Broad/shared skills like Python, SQL, cloud, APIs, automation, testing do NOT change the roleFamily — use the role title and domain-specific context to decide.
- If genuinely ambiguous, prefer "general" over a wrong specific category.

Reply ONLY with valid JSON matching this exact schema. No markdown fences, no explanation:
{
  "roleFamily": "<one of: engineering | pm | finance | hr | design | data | legal | operations | general>",
  "domain": "<one of: it_digital | construction | pmo | healthcare | fintech | marketing | media | education | real_estate | manufacturing | general>",
  "seniority": "<one of: ${PROFILE_SENIORITY_VALUES.join(" | ")}>",
  "qualification": "<normalised degree key or null — e.g. bs_cs, ms_cs, mba, jd, md, phd, be_civil, ms_construction_mgmt, ms_finance, cpa, null>",
  "qualificationRaw": "<exact degree string from resume or null>",
  "topTools": ["<most searchable tool 1>", "<most searchable tool 2>"],
  "searchQueries": ["<best job board search string 1>", "<best job board search string 2>"]
}`;

  const { message, usage } = await callAnthropic(client, {
    purpose: "classifier",
    model: MODEL_HAIKU,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = JSON.parse(textOf(message).replace(/```json|```/g, "").trim());
  return { roleFamily: parsed.roleFamily, domain: parsed.domain,
           domainModuleKey: getDomainModuleKey(parsed.roleFamily, parsed.domain), usage };
}
