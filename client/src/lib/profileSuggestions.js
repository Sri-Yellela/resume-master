import { api } from "./api.js";
import { hasNormalizedSignal, profileSignalKey } from "../../../shared/profileSignals.js";

export const PROFILE_SUGGESTIONS_UPDATED_EVENT = "rm:profile-suggestions-updated";

export function buildProfileSuggestionLookup(suggestions = {}) {
  return {
    skillKeys: new Set([
      ...(suggestions.inactiveSkills || []).map(item => item.key || profileSignalKey(item.label)),
      ...(suggestions.selectedSkills || []).map(item => item.key || profileSignalKey(item.label)),
      ...(suggestions.appliedSkills || []).map(item => item.key || profileSignalKey(item.label)),
    ].filter(Boolean)),
    verbKeys: new Set([
      ...(suggestions.inactiveActionVerbs || []).map(item => item.key || profileSignalKey(item.label)),
      ...(suggestions.selectedActionVerbs || []).map(item => item.key || profileSignalKey(item.label)),
      ...(suggestions.appliedActionVerbs || []).map(item => item.key || profileSignalKey(item.label)),
    ].filter(Boolean)),
  };
}

export function hasProfileSuggestion(suggestions, kind, label) {
  return kind === "action_verb"
    ? hasNormalizedSignal([
        ...(suggestions?.inactiveActionVerbs || []),
        ...(suggestions?.selectedActionVerbs || []),
        ...(suggestions?.appliedActionVerbs || []),
      ], label)
    : hasNormalizedSignal([
        ...(suggestions?.inactiveSkills || []),
        ...(suggestions?.selectedSkills || []),
        ...(suggestions?.appliedSkills || []),
      ], label);
}

export function emitProfileSuggestionsUpdated(profileId, suggestions = null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROFILE_SUGGESTIONS_UPDATED_EVENT, {
    detail: { profileId, suggestions },
  }));
}

async function addSuggestion(profileId, kind, label) {
  return api(`/api/domain-profiles/${profileId}/suggestions`, {
    method: "POST",
    body: JSON.stringify({ kind, labels: [label] }),
  });
}

export async function addSkillToProfile(profileId, label) {
  return addSuggestion(profileId, "skill", label);
}

export async function addVerbToProfile(profileId, label) {
  return addSuggestion(profileId, "action_verb", label);
}
