// Which prompts/layer2_domains/*.md module a generation uses.
//
// ONE implementation. draft had two that disagreed — services/qualificationResolver.js (the one
// generation actually used) and a private copy in services/classifier.js that returned "pm_general"
// where the first falls through. This is the first, the one generation's output was produced by.
//
// ⚠ KNOWN, CARRIED ACROSS DELIBERATELY, AND REPORTED RATHER THAN FIXED IN THE MOVE:
//  · `marketing` maps to nothing, so prompts/layer2_domains/marketing.md is unreachable and a
//    marketing profile gets general.md. Fixing it changes every marketing résumé — an owner decision.
//  · draft's qualification fallback read data/QUALIFICATION_ROLE_MAP.json, which draft's
//    .dockerignore kept out of the production image, so in production it always fell through to
//    "general". This service has no qualification map; that IS production's behaviour.

export function getDomainModuleKey(roleFamily, domain) {
  if (roleFamily === "pm") {
    if (domain === "construction")                          return "pm_construction";
    if (domain === "healthcare")                            return "pm_healthcare";
    if (domain === "it_digital" || domain === "pmo")        return "pm_it";
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
