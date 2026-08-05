/**
 * Frozen inputs for the provider evaluation harness — see scripts/providerEval/run.js.
 *
 * "Frozen" means these lists are versioned here, independent of whatever the live
 * company_ats_list table happens to contain at eval time, so a re-run six months from now
 * compares providers against the exact same query/company set as the first run. Update this
 * file deliberately (and note it in commit history) rather than editing rows in the DB.
 */

// ~20 companies we already crawl ATS-direct (a snapshot of company_ats_list's seed from
// migration 056, plus 5 more well-known public boards, frozen here for reproducibility).
// Used for: freshness-lag (their first-seen date in our own scraped_jobs vs a provider's)
// and as a coverage/completeness sample set a provider can be checked against directly.
const CANARY_COMPANIES = [
  'Stripe', 'Airbnb', 'Figma', 'Notion', 'OpenAI',
  'Anthropic', 'Rippling', 'Brex', 'Duolingo', 'Scale AI',
  'Ramp', 'Mercury', 'Retool', 'Linear', 'Vercel',
  'Databricks', 'Plaid', 'Coinbase', 'Robinhood', 'Asana',
];

// Fixed niche query set — a handful of representative role searches, not the whole taxonomy.
// The point is a controlled, repeatable comparison, not exhaustive coverage.
const NICHE_QUERIES = [
  'senior software engineer',
  'data scientist',
  'product manager',
  'site reliability engineer',
  'machine learning engineer',
];

// Rubric weights (must sum to 100) — see scripts/providerEval/rubric.js.
const RUBRIC_WEIGHTS = {
  coverage:     30,
  freshness:    20,
  applyUrl:     20,
  completeness: 15,
  cost:         10,
  integration:  5,
};

// Sample sizes for the metrics that require per-row inspection or a live HTTP check —
// bounded so a run stays fast and doesn't hammer providers'/companies' sites.
const APPLY_URL_SAMPLE_SIZE   = 100;
const HAND_VERIFY_SAMPLE_SIZE = 30;
const EXPIRY_SAMPLE_SIZE      = 20;
const EXPIRY_MIN_AGE_DAYS     = 30; // "older listings" for the expiry-hygiene check

// Cost scoring reference: a provider costing this much (or more) per net-new fresh job
// scores 0 on the cost dimension; $0/job scores full marks. Tune once real vendor quotes
// are in hand — this is a placeholder ceiling, not a real benchmark.
const MAX_ACCEPTABLE_COST_PER_JOB_USD = 0.50;

/**
 * Per-provider config that can't be discovered via API: pricing and license terms. Vendor
 * pricing requires an actual quote/contract, and redistribution rights require reading the
 * current ToS — neither is something this script can determine on its own, so both default
 * to conservative/unknown values. Fill in real numbers before trusting the cost score or the
 * license pass/fail flag.
 */
const PROVIDER_META = {
  theirstack: {
    label: 'TheirStack',
    // TODO: replace with the actual quoted monthly cost before trusting the cost score.
    estimatedMonthlyCostUsd: null,
    // TODO: verify against TheirStack's current ToS before flipping this to true.
    consumerRedistributionAllowed: false,
    licenseNotes: 'Unverified — confirm TheirStack ToS permits displaying results directly to our end users (not just internal sourcing/lead-gen use) before enabling.',
  },
  jobo: {
    label: 'Jobo',
    estimatedMonthlyCostUsd: null,
    // Confirmed 2026-08-05: owner has verified Jobo's ToS permits displaying results directly
    // to our end users, not just internal sourcing/lead-gen use — enabling for the live
    // pipeline (services/jobs/sources/jobo.js, Task 8).
    consumerRedistributionAllowed: true,
    licenseNotes: 'Owner-confirmed 2026-08-05: Jobo ToS permits displaying results directly to end users.',
  },
};

export {
  CANARY_COMPANIES,
  NICHE_QUERIES,
  RUBRIC_WEIGHTS,
  APPLY_URL_SAMPLE_SIZE,
  HAND_VERIFY_SAMPLE_SIZE,
  EXPIRY_SAMPLE_SIZE,
  EXPIRY_MIN_AGE_DAYS,
  MAX_ACCEPTABLE_COST_PER_JOB_USD,
  PROVIDER_META,
};
