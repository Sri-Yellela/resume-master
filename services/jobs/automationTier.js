/**
 * Automation tier — what a candidate will actually face when they open a posting's apply
 * destination, decided at BROWSE time instead of mid-run.
 *
 * services/applyAutomation.js's classifyFlowState() already answers this question, but only once
 * a browser has navigated to the page and the run is already holding: it returns
 * 'login_required' / 'captcha_required' after the fact. This module is the predictive version of
 * the same knowledge, derived from the two things a scraped_jobs row already carries — its source
 * and its apply destination — so the board can say "this one needs an account" before the user
 * queues it rather than after.
 *
 * The tiers are a promise about what the run will hit, so they must agree with what
 * classifyFlowState actually reports:
 *
 *   direct   no account needed — greenhouse / lever / ashby single-page apply. classifyFlowState
 *            reaches 'form_ready' or 'submit_ready' on these.
 *   guest    an account is offered but a guest path exists — smartrecruiters / workable /
 *            bamboohr public forms. Usually 'form_ready'; may hold.
 *   account  self-service account required — workday tenants, icims, taleo, jobvite. These are
 *            exactly the destinations classifyFlowState answers 'login_required' on, which is why
 *            they must never be offered as full-auto.
 *   gated    account PLUS a CAPTCHA or identity check — the aggregator middlemen in
 *            directApplyFilter.js's BLOCKED_URL_PATTERNS. NOT automatable, and nothing here or
 *            downstream attempts to defeat the challenge; the tier exists so the user is told.
 *   unknown  platform 'generic', an unrecognised source, or no destination URL at all.
 *
 * `unknown` is a real answer, not a bucket for leftovers. A company's own careers page might
 * apply cleanly in one click or might sit behind an SSO wall, and we have not looked — collapsing
 * that into `manual` would state a fact nothing verified, in the same way enrichment's null
 * columns must never render as a false negative. It is presented as a promise in NEITHER
 * direction.
 *
 * ONE mapping, one function. Every consumer — the four scraped_jobs writers, the recompute
 * script, the board filter — calls deriveAutomationTier(). A second copy of this table is the
 * failure mode that left half the codebase calling a retired model id.
 */
"use strict";

import { detectPlatformFromUrl } from "../platformDetector.js";
import { DIRECT_ATS_SOURCES } from "./directApplyFilter.js";

// The vocabulary, in decreasing order of what we can promise. Exported so the SQL filter and the
// recompute script validate against the same list rather than re-typing the strings.
const AUTOMATION_TIERS = ["direct", "guest", "account", "gated", "unknown"];

/**
 * Platform → tier. Keys are platformDetector.js's own platform names (URL_ATS_MAP /
 * PLATFORM_LABEL_MAPS), so onboarding a provider there and here is one decision in two places
 * that already have to agree — rather than a third vocabulary invented for this file.
 *
 * bamboohr sits in `guest`, not `direct`: its `<company>.bamboohr.com/jobs/view.php` form is
 * public and needs no account, but it is not one of the three single-page ATSes we have actually
 * watched a run complete on end to end, and `direct` is the tier the queue treats as a promise.
 */
const PLATFORM_TIER = {
  greenhouse:      "direct",
  lever:           "direct",
  ashby:           "direct",
  recruitee:       "direct",
  smartrecruiters: "guest",
  workable:        "guest",
  bamboohr:        "guest",
  workday:         "account",
  icims:           "account",
  taleo:           "account",
  jobvite:         "account",
  // linkedin is in platformDetector's URL map and is an account + anti-bot challenge, so it is
  // gated by platform as well as by the blocked-URL check below — whichever fires first agrees.
  linkedin:        "gated",
};

/**
 * The gated set is directApplyFilter.js's BLOCKED_URL_PATTERNS, not a second list. That module is
 * already the single source of truth for "this URL is an aggregator middleman that makes you hold
 * an account somewhere else", which is precisely the `gated` definition; duplicating it here would
 * let the two drift and leave a destination blocked from the board but advertised as automatable.
 */
const BLOCKED_URL_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /indeed\.com\/rc\//i,
  /glassdoor\.com\/job-listing/i,
  /monster\.com\//i,
  /ziprecruiter\.com\//i,
  /careerbuilder\.com\//i,
  /simplyhired\.com\//i,
];

// A source name is only a platform hint when it IS one of platformDetector's platform names.
// 'jobo', 'adzuna', 'serpapi' are feeds that carry other providers' URLs, so they tell us nothing
// on their own and fall through to the URL.
function platformForSource(source) {
  const s = String(source || "").trim().toLowerCase();
  if (!s) return null;
  return Object.prototype.hasOwnProperty.call(PLATFORM_TIER, s) ? s : null;
}

/**
 * The ONE derivation. Pure — no database, no network, no clock.
 *
 * @param {string|null} source     scraped_jobs.source
 * @param {string|null} applyUrl   scraped_jobs.apply_url ?? scraped_jobs.url (the destination the
 *                                 user actually lands on; only the LinkedIn writer populates
 *                                 apply_url, every other writer leaves it null and carries the
 *                                 destination in url)
 * @returns {'direct'|'guest'|'account'|'gated'|'unknown'}
 */
function deriveAutomationTier(source, applyUrl) {
  const url = typeof applyUrl === "string" ? applyUrl.trim() : "";

  // No destination = nothing to classify. Not `direct` by omission — see the module note on why
  // absence of evidence is reported as absence rather than as a clean apply path.
  if (!url) return "unknown";

  if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) return "gated";

  // The URL wins over the source when it recognises a provider, because the URL IS the apply
  // destination: a row sourced from one feed but pointing at another provider's form (production
  // carries exactly this — every `jobo` row's URL is a jobs.ashbyhq.com apply page) is decided by
  // where the user lands, not by which crawler found it.
  const urlPlatform = detectPlatformFromUrl(url);
  if (urlPlatform && urlPlatform !== "generic" && PLATFORM_TIER[urlPlatform]) {
    return PLATFORM_TIER[urlPlatform];
  }

  // URL unrecognised: fall back to the source when the source itself names a provider. This is the
  // common greenhouse case — a company-hosted board like `stripe.com/jobs/search?gh_jid=…` carries
  // no greenhouse.io hostname, so the URL reads 'generic' while the source is authoritative.
  const sourcePlatform = platformForSource(source);
  if (sourcePlatform) return PLATFORM_TIER[sourcePlatform];

  return "unknown";
}

// True only for the tiers a run can complete without a human authenticating first. `guest` counts
// (a guest path exists); `account` and `gated` do not, and `unknown` does not because we would be
// promising something we have not checked.
function isAutomatable(tier) {
  return tier === "direct" || tier === "guest";
}

/**
 * Guard: every source directApplyFilter.js trusts as a direct-ATS integration must have a tier
 * here, or onboarding a new ATS silently produces `unknown` rows for a provider we do have a
 * mapping for. Returns the uncovered names rather than throwing, so a test can assert on it
 * without a module-load side effect. Note `workday` IS a DIRECT_ATS_SOURCE and is deliberately
 * `account`, not `direct` — "the company's own ATS" (which is what that set means, and what the
 * dedup priority uses it for) is not the same claim as "no login".
 */
function uncoveredDirectAtsSources() {
  return [...DIRECT_ATS_SOURCES].filter(s => !Object.prototype.hasOwnProperty.call(PLATFORM_TIER, s));
}

export {
  deriveAutomationTier,
  isAutomatable,
  uncoveredDirectAtsSources,
  AUTOMATION_TIERS,
  PLATFORM_TIER,
};
