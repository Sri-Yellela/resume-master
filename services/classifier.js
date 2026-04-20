// ============================================================
// services/classifier.js — Resume domain and role classifier
// ============================================================
// What this file does:
//   Makes a Haiku call with both resume text and JD text to classify
//   the role family, domain, seniority, qualification, and generate
//   search queries. Returns a structured result used by:
//   - promptAssembler.js (to select the correct domain module)
//   - searchQueryBuilder.js (to build Apify query variants)
//   - qualificationResolver.js (to resolve qualification key)
//
// What to change here if intent changes:
//   - To add a new role family or domain: add to the enum strings in
//     the Haiku prompt below and update domainModuleKey derivation
//   - To change the Haiku model: update MODEL_ID
//   - To change classification output fields: update the schema below
//     AND update all callers in server.js
//
// Depends on: Anthropic SDK (passed as argument), no file dependencies
// ============================================================

const MODEL_ID = "claude-haiku-4-5-20251001";

// TO CHANGE DOMAIN MAPPING: edit the derivation logic in getDomainModuleKey()
// below AND add/remove a corresponding file in prompts/layer2_domains/
export async function classify(anthropic, resumeText, jdText, options = {}) {
  const prompt = `Classify this resume and job description combination.

Resume (first 2000 chars):
${resumeText.slice(0, 2000)}

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
  "seniority": "<one of: junior | mid | senior | executive>",
  "qualification": "<normalised degree key or null — e.g. bs_cs, ms_cs, mba, jd, md, phd, be_civil, ms_construction_mgmt, ms_finance, cpa, null>",
  "qualificationRaw": "<exact degree string from resume or null>",
  "topTools": ["<most searchable tool 1>", "<most searchable tool 2>"],
  "searchQueries": ["<best job board search string 1>", "<best job board search string 2>"]
}`;

  const msg = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  try { options.onUsage?.(msg.usage, MODEL_ID); } catch {}

  const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(raw);

  // Derive the domain module key from roleFamily + domain
  parsed.domainModuleKey = getDomainModuleKey(parsed.roleFamily, parsed.domain);
  return parsed;
}

// TO CHANGE DOMAIN MAPPING: edit the derivation logic below and
// add/remove a corresponding file in prompts/layer2_domains/
function getDomainModuleKey(roleFamily, domain) {
  if (roleFamily === "pm") {
    if (domain === "construction")                          return "pm_construction";
    if (domain === "healthcare")                            return "pm_healthcare";
    if (domain === "it_digital" || domain === "pmo")        return "pm_it";
    return "pm_general";
  }
  const directMap = {
    engineering: "engineering",
    finance:     "finance",
    hr:          "hr",
    design:      "design",
    data:        "data",
    legal:       "legal",
    operations:  "operations",
  };
  return directMap[roleFamily] || "general";
}
