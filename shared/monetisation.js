// shared/monetisation.js
//
// THE MONETISATION LEVER. One flag, read by the server and by the client, default OFF.
//
// ⛔ TURNING THIS ON HAS A LEGAL CONSEQUENCE, NOT JUST A UI ONE.
// The Chrome Web Store trader declaration for this extension is currently set to NON-TRADER, on
// the stated basis that no entity is registered, no payment can be taken, and the product makes no
// commercial claim. Every one of those is true only while this flag is off. Switching it on makes
// the product present a paid relationship — tiers, upgrade prompts, a pricing page that says paid
// upgrades are coming — and at that point the non-trader declaration is inaccurate. It is a legal
// statement, not a settings field. UPDATE THE DECLARATION IN THE SAME CHANGE THAT FLIPS THIS FLAG.
// (The owner's position, recorded 2026-09-09: no LLC, no payments taken, ~1000 applications across
// users is the bar for incorporating.)
//
// WHAT THE LEVER DOES AND DOES NOT DO
//   - It decides whether the entitlement gates are CONSULTED. It does not decide whether they
//     EXIST. Every gate, and every test of every gate, stays exactly where it is — the machinery
//     was built deliberately and is needed the moment this turns on. See services/entitlements.js.
//   - OFF MEANS ABSENT, NOT DISABLED. A greyed-out Upgrade button still claims a paid tier exists.
//     With the lever off there is no pricing page, no tier badge, no upgrade prompt, and no
//     `upgrade_required` response anywhere — a gated feature is simply available.
//   - ⛔ IT DOES NOT TOUCH SPEND CEILINGS. APPLY_DAILY_CAP, APPLY_DAILY_QUEUE_CAP,
//     APPLY_DAILY_APPROVAL_CAP and the standalone per-session limits are COST CONTROLS, not
//     upsells. They protect the owner's bill, which is the only real money in this system today,
//     and they behave identically in both states. Only their WORDING may change: a cap that says
//     "upgrade to raise this limit" becomes a plain statement of the limit.
//
// WHY ONE FLAG AND NOT SEVERAL
// Two switches that can disagree is this codebase's most-repeated defect shape — mapJobRow vs the
// client mapper, popup vs hotkey, three hardcoded tab lists, 'mid level' vs 'mid'. So there is
// exactly one environment variable, parsed in exactly one place, and the client is TOLD its value
// by the server (GET /api/config) rather than being built with its own copy. A build-time client
// flag would have been simpler and would have created precisely the second source of truth this
// comment exists to forbid: a client built with monetisation on, deployed against a server with it
// off, shows prices for tiers the server will not enforce.

export const MONETISATION_FLAG = "MONETISATION_ENABLED";

/**
 * The single parser. Anything not explicitly affirmative is OFF, including undefined, "", "0",
 * "false", and any typo — the safe direction for a flag whose ON state is a legal statement.
 */
export function parseMonetisationEnabled(raw) {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/** Server-side convenience: read the flag from an env bag (defaults to process.env). */
export function monetisationEnabledFromEnv(env) {
  const bag = env || (typeof process !== "undefined" ? process.env : {});
  return parseMonetisationEnabled(bag?.[MONETISATION_FLAG]);
}
