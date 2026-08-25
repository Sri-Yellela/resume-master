import { api } from "./api.js";
import { hasNormalizedSignal, profileSignalKey } from "../../../shared/profileSignals.js";

export const PROFILE_SUGGESTIONS_UPDATED_EVENT = "rm:profile-suggestions-updated";

// AG2 removed buildProfileSuggestionLookup / hasProfileSuggestion / addSkillToProfile /
// addVerbToProfile from here. They unioned inactive+selected+applied into one "has this term been
// seen" answer and then wrote one-way into domain_profiles, which together meant a term the
// scrape-time aggregator had recorded on its own rendered as an already-added chip nobody could
// click or undo. buildProfileClaimLookup and setProfileClaim below replace them, and there is
// deliberately only one way to do this now.

export function emitProfileSuggestionsUpdated(profileId, suggestions = null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROFILE_SUGGESTIONS_UPDATED_EVENT, {
    detail: { profileId, suggestions },
  }));
}

/**
 * The terms THE CANDIDATE HAS CLAIMED (AG2) — as opposed to the ones the system has suggested.
 *
 * The lookup this replaced unioned inactive, selected and applied, which answers "has this term
 * been seen before" and not the question the panel was asking it. Scrape-time
 * aggregation writes `inactive` rows unprompted, so a term the user had never seen — let alone
 * agreed with — rendered as a locked, green, already-claimed chip. That is an auto-opt-in with
 * extra steps.
 *
 * Only 'claimed' and 'applied' mean the person said so. 'applied' is the old one-way ATS-chip
 * click, which was them asserting it just the same.
 */
export function buildProfileClaimLookup(suggestions = {}) {
  const keysOf = list => (list || []).map(item => item.key || profileSignalKey(item.label)).filter(Boolean);
  return {
    skillKeys: new Set(keysOf(suggestions.claimedSkills)),
    verbKeys: new Set(keysOf(suggestions.claimedActionVerbs)),
  };
}

export function hasProfileClaim(suggestions, kind, label) {
  return kind === "action_verb"
    ? hasNormalizedSignal(suggestions?.claimedActionVerbs || [], label)
    : hasNormalizedSignal(suggestions?.claimedSkills || [], label);
}

/**
 * Assert or withdraw a claim. Reversible by design — the point of an opt-in is that it can be
 * opted back out of, and the old add-only endpoint had no undo anywhere in the codebase.
 */
export async function setProfileClaim(profileId, kind, label, claimed) {
  return api(`/api/domain-profiles/${profileId}/claims`, {
    method: "POST",
    body: JSON.stringify({ kind, label, claimed }),
  });
}
