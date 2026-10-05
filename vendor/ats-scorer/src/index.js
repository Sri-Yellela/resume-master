// @draft/ats-scorer — the public surface. Everything a product needs to score, nothing that loads.
// Term weights and synonyms are ARGUMENTS: each product reads its own tables and passes them in.
export * from "./scorer.js";
export * from "./vocabulary.js";
// A81 — years and a stated clearance read from résumé text (opt-in via buildRuntimeAtsBasis factsFromText).
export { yearsFromResumeText, clearanceFromResumeText } from "./textFacts.js";
