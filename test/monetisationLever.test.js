import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";
import { parseMonetisationEnabled, monetisationEnabledFromEnv, MONETISATION_FLAG } from "../shared/monetisation.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PARSER. The ON state of this flag is a legal statement about the Chrome Web Store trader
// declaration, so every ambiguous input has to land on OFF. These cases are the ones that would
// actually appear in a deploy config, not invented edge cases: an unset variable, an empty string
// a shell expanded to nothing, and the four spellings of "yes" a human would reasonably type.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("an absent or ambiguous flag is OFF, and only explicit affirmatives are ON", () => {
  for (const off of [undefined, null, "", "0", "false", "FALSE", "no", "off", "maybe", " ", "truthy", 0, false]) {
    assert.equal(parseMonetisationEnabled(off), false, `${JSON.stringify(off)} must be OFF`);
  }
  for (const on of ["1", "true", "TRUE", "True", "yes", "YES", "on", " on ", true]) {
    assert.equal(parseMonetisationEnabled(on), true, `${JSON.stringify(on)} must be ON`);
  }
});

test("the env reader defaults to OFF when the variable is missing entirely", () => {
  assert.equal(monetisationEnabledFromEnv({}), false);
  assert.equal(monetisationEnabledFromEnv({ [MONETISATION_FLAG]: "1" }), true);
  // A neighbouring variable with a similar name must not be mistaken for the lever.
  assert.equal(monetisationEnabledFromEnv({ MONETISATION: "1" }), false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE LEVER, NOT SEVERAL. The whole point of the design is that no surface decides for itself.
// These assertions are what makes "one lever" checkable rather than merely intended.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("every server-side enforcement point consults the lever, and none invents its own flag", () => {
  const server  = fs.readFileSync("server.js", "utf8");
  const apply   = fs.readFileSync("routes/apply.js", "utf8");
  const account = fs.readFileSync("routes/account.js", "utf8");

  // All three gates in server.js short-circuit BEFORE computing a tier or minting a 403.
  for (const fn of ["function requireModeEntitlement", "function requireToolEntitlement", "function requirePlan"]) {
    const start = at(server, fn, 0, "gate");
    const body  = server.slice(start, start + 420);
    assert.match(body, /if \(!monetisationEnabled\(\)\) return true;/, `${fn} must consult the lever`);
    // The lever check has to come first. A gate that computes the tier, decides to refuse, and
    // only then asks about the lever would still be correct today and is one careless edit away
    // from emitting the 403 this task exists to make unreachable.
    assert.ok(body.indexOf("monetisationEnabled()") < body.indexOf("normalisePlanTier"),
      `${fn} must check the lever before reading a plan tier`);
  }

  // The fourth enforcement point is in another file and cannot reach those helpers.
  assert.match(apply, /if \(monetisationEnabled\(\) && resolvedTool === "a_plus_resume"/);

  // Every reader derives from the ONE parser rather than reading process.env itself.
  for (const [name, src] of [["server.js", server], ["routes/apply.js", apply], ["routes/account.js", account]]) {
    assert.match(src, /monetisationEnabledFromEnv/, `${name} must use the shared parser`);
    assert.doesNotMatch(src, /process\.env\.MONETISATION_ENABLED/,
      `${name} must not read the flag directly — that is a second parser`);
    assert.doesNotMatch(src, /MONETISATION_ENABLED\s*=/,
      `${name} must not cache the flag into a constant — both states must stay reachable in one process`);
  }
});

test("the upgrade-request route is absent, not refused-with-an-upsell, when the lever is off", () => {
  const account = fs.readFileSync("routes/account.js", "utf8");
  const start = at(account, '"/api/plans/request-upgrade"', 0, "upgrade route");
  const body  = account.slice(start, start + 400);
  assert.match(body, /if \(!monetisationEnabled\(\)\) return res\.status\(404\)/);
  // 403 upgrade_required here would tell the caller that upgrades exist and they are not entitled,
  // which is the commercial claim, not merely the commercial transaction.
  assert.doesNotMatch(body.slice(0, 200), /upgrade_required/);
});

test("the client has exactly one reader of the lever and it is served, not built in", () => {
  const ctx = fs.readFileSync("client/src/lib/monetisation.jsx", "utf8");
  // Through api(), which carries the tab auth context — the rule every /api call site in this
  // client follows, and which authCredentialLifecycle.test.js enforces.
  assert.match(ctx, /api\("\/api\/config"\)/);
  // A build-time flag is the second source of truth shared/monetisation.js forbids.
  assert.doesNotMatch(ctx, /import\.meta\.env/);
  // Unknown must resolve to OFF, or the marketing pages flash pricing copy on first paint.
  assert.match(ctx, /useState\(null\)/);
  assert.match(ctx, /enabled: enabled === true/);

  const server = fs.readFileSync("server.js", "utf8");
  // Public on purpose: the pages carrying the commercial copy render logged out.
  assert.match(server, /app\.get\("\/api\/config", \(_req, res\) => res\.json\(\{ monetisationEnabled: monetisationEnabled\(\) \}\)\)/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GATES STILL EXIST. Removing them was never the goal — §5.15 added the A+ entitlement check
// because repairing the tool/toolType plumbing would otherwise have opened a plan-tier bypass, and
// that reasoning survives the lever. If someone "simplifies" by deleting the machinery, this fails.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("the entitlement machinery is intact and still computes tiers", () => {
  const ent = fs.readFileSync("services/entitlements.js", "utf8");
  for (const sym of ["PLAN_TIERS", "normalisePlanTier", "canUseGenerate", "canUseAPlusResume",
                     "hasPlanAtLeast", "allowedModesForTier", "planForMode", "nextPlan"]) {
    assert.match(ent, new RegExp(`export (const|function) ${sym}\\b`), `${sym} must survive`);
  }
  const server = fs.readFileSync("server.js", "utf8");
  // The 403 bodies are still there, still shaped the same, for the day the lever goes on.
  assert.match(server, /error: "upgrade_required"/);
  assert.match(server, /requiredTier,/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ SPEND CEILINGS ARE NOT COMMERCIAL SURFACES. They protect the owner's bill, which is the only
// real money in this system today, and the lever must not be able to touch them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("the apply caps are independent of the lever in both states", () => {
  const apply = fs.readFileSync("routes/apply.js", "utf8");
  for (const cap of ["APPLY_DAILY_CAP", "APPLY_DAILY_QUEUE_CAP", "APPLY_DAILY_APPROVAL_CAP"]) {
    const start = at(apply, `const ${cap}`, 0, cap);
    const decl  = apply.slice(start, start + 160);
    assert.match(decl, /envInt\(/, `${cap} must stay env-driven`);
    assert.doesNotMatch(decl, /monetisationEnabled|planTier|plan_tier/,
      `${cap} is a COST control and must not read the lever or a tier`);
  }
  const server = fs.readFileSync("server.js", "utf8");
  const start = at(server, "function standaloneRateLimit", 0, "standalone limiter");
  const body  = server.slice(start, start + 900);
  assert.doesNotMatch(body, /monetisationEnabled/,
    "the anonymous spend limiter is a cost control and must not read the lever");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TRADER DECLARATION. Requirement 7: the consequence must be recorded beside the flag, because a
// comment beside a flag is where the next person will actually read it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("the trader-declaration consequence is recorded beside the lever", () => {
  const shared = fs.readFileSync("shared/monetisation.js", "utf8");
  assert.match(shared, /trader/i);
  assert.match(shared, /NON-TRADER/);
  assert.match(shared, /UPDATE THE DECLARATION IN THE SAME CHANGE/);
});
