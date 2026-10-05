// Types for @draft/ats-scorer.
//
// ⛔ THE SIGNATURE IS THE POINT. `termWeights` used to be typed as nothing, so four measurement
// harnesses passed loadTermWeights' ENVELOPE where a Map was expected and silently scored
// unweighted. Here the accepted shapes are spelled out, and at runtime anything else is a
// TypeError (resolveTermWeights / resolveSynonyms) — the type is a hint, the throw is the guard.

/** Map<normalisedTerm, weight>. An empty Map means "unweighted", deliberately. */
export type TermWeightMap = Map<string, number>;

/** What a product's weight loader returns. A `stale` envelope is REFUSED, and scores unweighted. */
export interface TermWeightEnvelope {
  weights: TermWeightMap;
  stale: boolean;
  computedAt?: number | null;
  corpusSize?: number | null;
  [key: string]: unknown;
}

/** null/undefined = unweighted on purpose. Any other shape throws. */
export type TermWeights = TermWeightMap | TermWeightEnvelope | null | undefined;

/**
 * Map<normalisedTerm, equivalents[]>, built by the CALLER from CONFIRMED rows only. Applied ONE HOP,
 * never transitively. null/undefined = no synonyms. Any other shape throws.
 */
export type Synonyms = Map<string, string[]> | null | undefined;

export interface RuntimeAtsBasis {
  resumeText: string;
  titles: string[];
  skills: string[];
  actionVerbs: string[];
  claimedSkills: string[];
  claimedActionVerbs: string[];
  yearsExperience: number | null;
  seniority: string | null;
  structuredFacts: Record<string, unknown>;
  termWeights: TermWeights | null;
  /** A81 — present ONLY when built with factsFromText: true. What was read from the résumé text. */
  factsFromText?: { yearsExperience: YearsFromText | null; clearance: ClearanceFromText | null; notRead: string[] };
}

/** A81 — years read from the résumé text. */
export type YearsFromText = { years: number; source: "dated_roles"; roles: number } | { years: number; source: "stated_years" };
/** A81 — a clearance the résumé states is held. */
export interface ClearanceFromText { stated: true; text: string }

export interface AtsJob {
  title?: string | null;
  company?: string | null;
  category?: string | null;
  description?: string | null;
  requirements?: string | null;
  skills?: string | null;
  skills_json?: string | null;
  [column: string]: unknown;
}

export interface AtsReport {
  source: string;
  /** null when the scorer DECLINED for want of signal — never a zero. */
  score: number | null;
  scorable: boolean;
  decline_reasons: string[];
  weighting: { applied: boolean; terms: number };
  seniority_cap: { applied: false } | { applied: true; cap: number; raw_score: number; reason: string };
  claimed_matches: string[];
  tier1_matched: string[];
  tier1_missing: string[];
  competencies_matched: string[];
  competencies_missing: string[];
  action_verbs_matched: string[];
  action_verbs_missing: string[];
  action_verbs_generic: string[];
  experience: unknown;
  hard_constraint_misses: unknown[];
  /** A81 — present ONLY when the basis was built with factsFromText: true. */
  facts_from_text?: { years_experience: YearsFromText | null; clearance: ClearanceFromText | null; not_read: string[] };
}

export interface BuildBasisArgs {
  resumeText?: string;
  signalProfile?: Record<string, unknown> | null;
  domainProfile?: Record<string, unknown> | null;
  termWeights?: TermWeights;
  claims?: { skills?: string[]; actionVerbs?: string[] } | null;
  /**
   * A81 — read years (dated roles) and a stated clearance from resumeText where signalProfile leaves
   * them unset. OFF by default: without it the basis is exactly as before. Citizenship is never read.
   */
  factsFromText?: boolean;
  /** What "present" means when reading dated roles (default: now). */
  asOf?: number | Date;
}

export interface ScoreArgs extends BuildBasisArgs {
  job?: AtsJob;
  runtimeBasis?: RuntimeAtsBasis | null;
  synonyms?: Synonyms;
}

export const LOCAL_ATS_SOURCE: string;
/** What a cached report must match to be served — changes when the buckets do, not only the score. */
export const ATS_REPORT_CACHE_KEY: string;
export const SKILL_POINTS: number;
export const VERB_POINTS: number;
export const EXPERIENCE_POINTS: number;
/** The experience ratio when the posting states no years requirement. */
export const NO_REQUIREMENT_EXPERIENCE_RATIO: number;
/** The experience ratio when the candidate meets the requirement — equal to the no-requirement rate (1.2.0). */
export const MEETS_EXPERIENCE_RATIO: number;
export const HARD_MISS_PENALTY: number;
export const NEUTRAL_TERM_WEIGHT: number;
export const MIN_SCORABLE_TERMS: number;
export const REGISTRY_DIR: string;
export const REGISTRY_FILES: readonly string[];

export function scoreAtsLocally(args?: ScoreArgs): AtsReport;
export function buildRuntimeAtsBasis(args?: BuildBasisArgs): RuntimeAtsBasis;
export function resolveTermWeights(input: TermWeights): TermWeightMap | null;
export function resolveSynonyms(input: Synonyms): Map<string, string[]> | null;
export function normaliseAtsTerm(value: unknown): string;
export function isJuniorPosting(title: unknown): boolean;
export function seniorityCapFor(title: unknown, seniority: unknown): { cap: number; reason: string } | null;
export function resetAtsVocabularyCache(): void;
export function skillVocabularyTerms(): string[];
export function actionVerbVocabularyTerms(): string[];
export function companyStackTerms(company: unknown): string[];
export function resetSkillVocabularyCache(): void;
export function yearsFromResumeText(text: unknown, opts?: { asOf?: number | Date }): YearsFromText | null;
export function clearanceFromResumeText(text: unknown): ClearanceFromText | null;
