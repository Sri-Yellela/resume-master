export const PLAN_TIERS = ["BASIC", "PLUS", "PRO"];

export const PLAN_MODE = {
  BASIC: "SIMPLE",
  PLUS: "TAILORED",
  PRO: "CUSTOM_SAMPLER",
};

export function normalisePlanTier(tier) {
  const value = String(tier || "BASIC").toUpperCase();
  return PLAN_TIERS.includes(value) ? value : "BASIC";
}

export function allowedModesForTier(tier) {
  return [PLAN_MODE[normalisePlanTier(tier)]];
}

export function planForMode(mode) {
  if (mode === "CUSTOM_SAMPLER") return "PRO";
  if (mode === "TAILORED") return "PLUS";
  return "BASIC";
}

export function canUseMode(tier, mode) {
  return allowedModesForTier(tier).includes(mode);
}

export function hasPlanAtLeast(tier, requiredTier) {
  return PLAN_TIERS.indexOf(normalisePlanTier(tier)) >= PLAN_TIERS.indexOf(normalisePlanTier(requiredTier));
}

export function nextPlan(tier) {
  const current = normalisePlanTier(tier);
  if (current === "BASIC") return "PLUS";
  if (current === "PLUS") return "PRO";
  return null;
}
