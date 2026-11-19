// @draft/ats-scorer — the public surface. Everything a product needs to score, nothing that loads.
// Term weights and synonyms are ARGUMENTS: each product reads its own tables and passes them in.
export * from "./scorer.js";
export * from "./vocabulary.js";
// A81 — years and a stated clearance read from résumé text (opt-in via buildRuntimeAtsBasis factsFromText).
export { yearsFromResumeText, clearanceFromResumeText } from "./textFacts.js";
// D192 (4) — the contextual score (ATS contract 2.0.0): role fit, responsibility overlap, tech-stack compatibility.
export * from "./contextual.js";
// D192 (4d) — claim plausibility: does each experience bullet add up against what is known about that employer.
export * from "./plausibility.js";
