import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

import { mapJobRow } from "../services/jobs/mapJobRow.js";
import {
  JOB_FIELDS, JOB_REQUIRED_FIELDS, JOB_OPTIONAL_FIELDS, JOB_FIELD_TYPES,
  ENUMS, MOBILE_TIER_GATING, CONTRACT_VERSION,
} from "../services/api/mobileContract.js";
import { MOBILE_ENDPOINTS, RETIRED_ENDPOINTS, ERROR_SHAPES, MOBILE_GAPS } from "../services/api/mobileEndpoints.js";
import { RESPONSE_SCHEMAS } from "../services/api/mobileSchemas.js";
import { buildOpenApi, buildTypeScript, renderJson, normaliseForHash } from "../services/api/buildMobileContract.js";
import {
  EXPERIENCE_LEVELS, WORK_MODELS, AUTOMATION_TIERS, values,
} from "../shared/jobFilterOptions.js";
import { at } from "../test-support/sourceAnchors.js";

/**
 * TASK AJ1 — THE CONTRACT TEST.
 * ================================================================================================
 *
 * WHY THIS TEST IS THE DELIVERABLE, AND THE SCHEMA FILE IS MERELY ITS OUTPUT
 *
 * The API is now a contract across a REPOSITORY BOUNDARY, with four consumers: client/, extension/,
 * and two mobile repositories that are not in this tree. A published schema alone does not help —
 * it is a document, and documents rot. `docs/mobile-linkedin-import.md` is written in the present
 * indicative about a mobile feature that has never existed, and nothing caught that for three
 * months. This repository's whole defect history is contract mismatches that failed SILENTLY:
 * mapJobRow vs normalizeApiJob, popup vs hotkey writing to different tables, three hardcoded tab
 * lists, half-migrated model IDs, `tool` vs `toolType`, mode "manual" coerced to "auto".
 *
 * Being in the same tree is what eventually made each of those findable. A separate repository
 * removes that. So the loud failure has to be built, and this is it.
 *
 * WHAT IT ACTUALLY CATCHES — the one that matters is `THE WHITELIST IS THE CONTRACT` below.
 * Remove a field from mapJobRow and this test fails naming the field, in this repository, before
 * the change is pushed — rather than in a store review of an app that decodes a struct which no
 * longer matches. Verified by doing exactly that; see docs/aj1-mobile-contract.md.
 *
 * The pattern is test/privacyReconciliation.test.js's: a join asserted in EVERY direction, where an
 * orphan in any column is a failure. Same idea as the appTabs single source and
 * test/filterOptionContract.test.js.
 */

const SERVER = fs.readFileSync("server.js", "utf8");
const APPLY = fs.readFileSync("routes/apply.js", "utf8");
const ACCOUNT = fs.readFileSync("routes/account.js", "utf8");
const DOMAIN_PROFILES = fs.readFileSync("routes/domainProfiles.js", "utf8");

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE WHITELIST IS THE CONTRACT
// ════════════════════════════════════════════════════════════════════════════════════════════

test("THE WHITELIST IS THE CONTRACT — the published job shape IS mapJobRow's key set", () => {
  // Executed, not parsed. A regex over the source would agree with the source TEXT; calling the
  // function agrees with the source BEHAVIOUR, which is what a client actually receives.
  const live = Object.keys(mapJobRow({}));

  assert.deepEqual([...JOB_FIELDS].sort(), [...live].sort(),
    "The contract's job field list and mapJobRow disagree. mapJobRow is the field WHITELIST and " +
    "the binding constraint on everything reaching a client — if it changed, the contract must be " +
    "regenerated:\n  node scripts/generateMobileContract.mjs");

  // A floor. If mapJobRow were ever refactored into something this probe cannot see, `live` would
  // go empty and every assertion here would pass vacuously — which is the failure mode that lets a
  // guard rot without anyone noticing.
  assert.ok(live.length >= 30, `mapJobRow yielded only ${live.length} fields — the probe itself broke`);
});

test("REMOVING A FIELD FROM mapJobRow BREAKS THE BUILD — the join, in both directions", () => {
  // This is the reconciliation, and it is what makes the test above unbypassable. The two
  // directions catch opposite mistakes and BOTH are silent failures without it:
  //
  //   a mapJobRow field with no declared type  -> it would ship to mobile untyped
  //   a declared type with no mapJobRow field  -> the contract would promise a field the API
  //                                               stopped sending, and the phone would decode null
  const declared = new Set(Object.keys(JOB_FIELD_TYPES));
  const actual = new Set(Object.keys(mapJobRow({})));

  const undeclared = [...actual].filter(f => !declared.has(f)).sort();
  assert.deepEqual(undeclared, [],
    "mapJobRow gained field(s) with no entry in JOB_FIELD_TYPES. Add each one — with a description " +
    "saying what null MEANS for it, because a nullable field whose null is undocumented is how a " +
    "'no signal yet' becomes a rendered false negative:\n  " + undeclared.join("\n  "));

  const orphaned = [...declared].filter(f => !actual.has(f)).sort();
  assert.deepEqual(orphaned, [],
    "The contract declares field(s) that mapJobRow NO LONGER RETURNS. A mobile client decoding " +
    "this contract expects them, and will get undefined. Either restore the field or bump the " +
    "contract's MAJOR version and remove it here:\n  " + orphaned.join("\n  "));
});

test("ABSENT IS NOT NULL — the required/optional split matches what JSON.stringify actually does", () => {
  // The distinction a hand-written contract gets wrong, and the one that crashes a native decoder.
  // Eight mapJobRow fields are plain pass-throughs with no `?? null`, so for a row whose column is
  // NULL they are `undefined` — and JSON.stringify DELETES an undefined property. They arrive
  // ABSENT, not null. Swift and Kotlin decoders treat those differently: a non-optional field
  // tolerates an explicit null far more readily than a missing key.
  const probe = mapJobRow({});
  const serialised = JSON.parse(JSON.stringify(probe));

  for (const field of JOB_OPTIONAL_FIELDS) {
    assert.equal(probe[field], undefined, `${field} is listed optional but has a defined default`);
    assert.ok(!(field in serialised),
      `${field} is listed optional but SURVIVES JSON.stringify — it should be typed required`);
  }
  for (const field of JOB_REQUIRED_FIELDS) {
    assert.ok(field in serialised,
      `${field} is typed required but VANISHES from the JSON body for an empty row`);
  }
  assert.equal(JOB_OPTIONAL_FIELDS.length + JOB_REQUIRED_FIELDS.length, JOB_FIELDS.length,
    "every field must be exactly one of required or optional — no field may be both or neither");
});

test("the generated Job schema carries every mapJobRow field and nothing invented", () => {
  const job = buildOpenApi().components.schemas.Job;
  assert.deepEqual(Object.keys(job.properties).sort(), [...JOB_FIELDS].sort());
  assert.deepEqual([...job.required].sort(), [...JOB_REQUIRED_FIELDS].sort());
  assert.equal(job.additionalProperties, false,
    "additionalProperties must stay false: a client generating a strict decoder needs to know the " +
    "shape is closed, and mapJobRow's whole nature is that it IS closed");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE COMMITTED ARTEFACTS ARE CURRENT
// ════════════════════════════════════════════════════════════════════════════════════════════

test("the committed contract is not stale — regenerating changes nothing", () => {
  // The check that makes the two mobile repositories safe: it fails on `npm test` the moment
  // somebody edits mapJobRow, an enum, or an endpoint without regenerating.
  //
  // Compared newline-normalised, deliberately. core.autocrlf=true and there is no .gitattributes,
  // so a raw-byte comparison fails on a fresh Windows checkout of byte-identical content — and a
  // test that fails for the wrong reason is a test that gets deleted.
  const cases = [
    ["contract/mobile-api.v1.json", renderJson(buildOpenApi())],
    ["contract/mobile-api.v1.d.ts", buildTypeScript()],
  ];
  for (const [file, expected] of cases) {
    assert.ok(fs.existsSync(file), `${file} is missing — run: node scripts/generateMobileContract.mjs`);
    assert.equal(
      normaliseForHash(fs.readFileSync(file, "utf8")),
      normaliseForHash(expected),
      `${file} is STALE. The source of truth changed and the contract was not regenerated. The two ` +
      `mobile repositories consume this file, so shipping it stale is how they break silently.\n` +
      `Run: node scripts/generateMobileContract.mjs`);
  }
});

test("the checksums the mobile repos assert against match the files they describe", () => {
  const sums = JSON.parse(fs.readFileSync("contract/CHECKSUMS.json", "utf8"));
  assert.equal(sums.contractVersion, CONTRACT_VERSION);
  for (const [name, expected] of Object.entries(sums.files)) {
    const actual = crypto.createHash("sha256")
      .update(normaliseForHash(fs.readFileSync(`contract/${name}`, "utf8")), "utf8").digest("hex");
    assert.equal(actual, expected,
      `contract/${name} does not match its recorded checksum. A mobile repo pinning this checksum ` +
      `would reject a copy that is actually correct, or accept one that is not.`);
  }
});

test("generation is DETERMINISTIC — two builds of unchanged source are byte-identical", () => {
  // Without this the staleness check above is worthless: if generation varied, every run would
  // report drift, and the check would be turned off for being noisy. So: no timestamp, no git sha,
  // no unordered map iteration anywhere in the generator.
  assert.equal(renderJson(buildOpenApi()), renderJson(buildOpenApi()));
  assert.equal(buildTypeScript(), buildTypeScript());
  const json = renderJson(buildOpenApi());
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json),
    "the generated contract contains an ISO timestamp — that makes every regeneration a diff");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE CONTRACT DESCRIBES ROUTES THAT ACTUALLY EXIST
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Every /api route in source, as "METHOD /api/path" with express-style :params. */
function collectRoutes() {
  const METHODS = "get|post|put|patch|delete|all";
  const out = new Set();
  const direct = (src) => {
    for (const m of src.matchAll(new RegExp(`\\bapp\\.(${METHODS})\\(\\s*"(/api/[^"]*)"`, "g"))) {
      out.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  };
  const routed = (src, prefix) => {
    for (const m of src.matchAll(new RegExp(`\\brouter\\.(${METHODS})\\(\\s*"([^"]*)"`, "g"))) {
      out.add(`${m[1].toUpperCase()} ${prefix}${m[2] === "/" ? "" : m[2]}`);
    }
  };
  direct(SERVER); direct(APPLY);
  routed(ACCOUNT, "");
  routed(DOMAIN_PROFILES, "/api/domain-profiles");
  return out;
}

/** The contract writes OpenAPI {param}; express writes :param. */
const toExpress = (p) => p.replace(/\{(\w+)\}/g, ":$1");

test("EVERY ENDPOINT IN THE CONTRACT IS A REAL ROUTE — the contract cannot promise a phantom", () => {
  // The failure this prevents is specific and expensive: a mobile team builds a screen against a
  // path that was renamed or never existed, and finds out at integration. Same reasoning as
  // privacyReconciliation's "every symbol the reconciliation cites actually exists" — a citation
  // only helps if it is real.
  const routes = collectRoutes();
  assert.ok(routes.size > 150, `route enumeration found only ${routes.size} — the regexes broke`);

  const missing = MOBILE_ENDPOINTS
    .map(ep => `${ep.method} ${toExpress(ep.path)}`)
    .filter(key => !routes.has(key))
    .sort();

  assert.deepEqual(missing, [],
    "The contract publishes endpoint(s) that do not exist in this server's source. A mobile repo " +
    "will build against them:\n  " + missing.join("\n  "));
});

test("no published endpoint is one of the retirements", () => {
  // The two lists are written by hand in the same file and it would be easy to publish something
  // that 410s — which is worse than not publishing it, because the contract would be actively
  // instructing a new client to call a dead route.
  const retired = new Set(RETIRED_ENDPOINTS.map(r => toExpress(r.path)));
  const conflicts = MOBILE_ENDPOINTS
    .filter(ep => retired.has(toExpress(ep.path)))
    .map(ep => `${ep.method} ${ep.path}`);
  assert.deepEqual(conflicts, [], `the contract publishes RETIRED endpoint(s): ${conflicts.join(", ")}`);
});

test("EVERY RETIREMENT REALLY ANSWERS 410 — a tombstone that isn't one is a false warning", () => {
  // Requirement 5. A retirement list that drifts is worse than none: it tells a greenfield client
  // not to call something that in fact works, or leaves a genuinely dead route unlisted.
  const all = SERVER + APPLY + ACCOUNT;
  for (const r of RETIRED_ENDPOINTS) {
    // The literal path as it appears in source: regex routes and wildcards are matched on their stem.
    const stem = r.path.replace(/\{[^}]+\}/g, "").replace(/\/\*$/, "").replace(/\/$/, "");
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // /api/imported-jobs is mounted as a REGEX route, so in source its slashes are written
    // escaped: /^\/api\/imported-jobs(\/.*)?$/. Matching the plain path would miss it and report a
    // live tombstone as missing — so every slash tolerates an optional preceding backslash.
    const pattern = escaped.split("/").join("\\\\?/");
    assert.match(all, new RegExp(pattern),
      `retired endpoint ${r.path} is not mentioned in server.js, routes/apply.js or routes/account.js`);
  }
  assert.equal(RETIRED_ENDPOINTS.length, 6,
    "the retirement count changed — confirm the new state against source and update this floor");
  assert.ok(RETIRED_ENDPOINTS.every(r => r.status === 410),
    "every retirement must be a 410: 404 reads as 'wrong URL, check your typing', and 410 reads " +
    "as 'this is gone on purpose', which is the true statement");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. VOCABULARIES ARE IMPORTED, NEVER RESTATED
// ════════════════════════════════════════════════════════════════════════════════════════════

test("enums come from the existing single sources — the contract is not a fifth copy", () => {
  // A third copy of the tier list is the exact bug this whole task exists to prevent: it is how
  // half the codebase came to call a retired model id, and how a select emitting 'mid level' met a
  // column holding 'mid' and matched zero rows forever.
  assert.deepEqual([...ENUMS.experienceLevel], values(EXPERIENCE_LEVELS));
  assert.deepEqual([...ENUMS.workplaceType], values(WORK_MODELS));
  assert.deepEqual([...ENUMS.automationTier], values(AUTOMATION_TIERS));

  const contractSource = fs.readFileSync("services/api/mobileContract.js", "utf8");
  const body = contractSource.slice(at(contractSource, "export const ENUMS"));
  for (const tier of values(AUTOMATION_TIERS)) {
    assert.ok(!new RegExp(`["']${tier}["']\\s*,`).test(body.slice(0, at(body, "})"))),
      `ENUMS restates the literal "${tier}" instead of importing it from shared/jobFilterOptions.js`);
  }
});

test("MOBILE TIER GATING COVERS EVERY TIER — a new tier cannot default to 'completable'", () => {
  // Requirement 7. If a sixth tier is added to shared/jobFilterOptions.js and nothing here changes,
  // a client doing `GATING[tier]?.completableOnMobile` gets undefined — falsy, which happens to be
  // safe — but a client doing `!== false` would offer one-tap apply on a tier nobody classified.
  // Making it a hard failure removes the coin flip.
  const tiers = values(AUTOMATION_TIERS);
  assert.deepEqual(Object.keys(MOBILE_TIER_GATING).sort(), [...tiers].sort(),
    "MOBILE_TIER_GATING and the automation tier vocabulary disagree. Every tier needs an explicit " +
    "mobile verdict and a reason.");

  assert.equal(MOBILE_TIER_GATING.gated.completableOnMobile, false,
    "a gated job CANNOT be completed on a phone: the gated handoff's security property is the " +
    "desktop browser holding the portal session, borrowed under the extension's activeTab. There " +
    "is no mobile mechanism that preserves it.");
  assert.equal(MOBILE_TIER_GATING.unknown.completableOnMobile, false,
    "'unknown' is a promise in NEITHER direction and must not be offered as one-tap apply");

  for (const [tier, def] of Object.entries(MOBILE_TIER_GATING)) {
    assert.ok(def.reason && def.reason.length > 20, `tier ${tier} has no substantive reason`);
  }
});

test("the apply status vocabulary is derived from the partition, not listed", () => {
  // Deriving it from OUTCOME_STATUSES means a status added WITHOUT being filed into an outcome
  // group cannot reach the contract — the same totality guarantee applyRunHistory already asserts.
  assert.ok(ENUMS.applyStatus.includes("held_gate"));
  assert.ok(ENUMS.applyStatus.includes("superseded"));
  assert.deepEqual([...ENUMS.applyOutcome], ["aborted", "completed", "pending"]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE DOCUMENT IS INTERNALLY COMPLETE
// ════════════════════════════════════════════════════════════════════════════════════════════

test("every endpoint resolves to a defined response schema and defined error shapes", () => {
  for (const ep of MOBILE_ENDPOINTS) {
    assert.ok(RESPONSE_SCHEMAS[ep.response],
      `${ep.method} ${ep.path} names response schema "${ep.response}", which is not defined`);
    for (const e of ep.errors || []) {
      assert.ok(ERROR_SHAPES[e], `${ep.method} ${ep.path} names unknown error shape "${e}"`);
    }
    assert.ok(ep.summary?.length > 10, `${ep.method} ${ep.path} has no usable summary`);
  }
});

test("every $ref in the generated document resolves", () => {
  // A dangling $ref makes a code generator emit `any`, and `any` in a published contract is a lie
  // that type-checks — the mobile side would compile and decode nothing.
  const doc = buildOpenApi();
  const defined = new Set(Object.keys(doc.components.schemas));
  const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)]
    .map(m => m[1]);
  const dangling = [...new Set(refs)].filter(r => !defined.has(r)).sort();
  assert.deepEqual(dangling, [], `unresolved $ref(s): ${dangling.join(", ")}`);
  assert.ok(refs.length > 20, "suspiciously few $refs — the document may not have been built");
});

test("every AUTHENTICATED endpoint declares bearer security", () => {
  const doc = buildOpenApi();
  for (const ep of MOBILE_ENDPOINTS) {
    if (ep.auth !== "bearer") continue;
    const op = doc.paths[ep.path][ep.method.toLowerCase()];
    assert.ok(op.security?.some(s => "bearerAuth" in s),
      `${ep.method} ${ep.path} requires auth but the document does not say so — a generated client ` +
      `would omit the header and get a 401 it cannot explain`);
  }
});

test("the mobile gaps are published INSIDE the contract, not only in prose", () => {
  // Requirement 8. A gap recorded only in a markdown file in THIS repository is invisible to the
  // mobile teams, who consume `contract/` and may never read docs/. Pagination in particular is
  // not a nicety: the swipe feed mutates the set it is paging through, so offset paging SKIPS jobs
  // silently — the user never sees them and nothing reports the loss.
  const doc = buildOpenApi();
  assert.ok(doc["x-mobile-gaps"].pagination, "the pagination gap must be in the published document");
  assert.match(doc["x-mobile-gaps"].pagination.why, /disliked/,
    "the pagination gap must explain WHY offset paging is wrong here, not merely that a cursor is nicer");
  for (const [name, gap] of Object.entries(MOBILE_GAPS)) {
    assert.ok(gap.what && gap.why && gap.fix, `gap "${name}" must state what, why and the fix`);
  }
});

test("the contract states the auth model the audit left open, and states it as resolved", () => {
  const doc = buildOpenApi();
  const auth = doc["x-auth-model"];
  assert.match(auth.renewal, /SLIDES/, "sliding renewal (decision 6a) must be published");
  assert.ok(auth.absoluteSeconds > auth.idleSeconds,
    "the absolute cap must exceed the idle window, or renewal could never extend anything");
  assert.match(auth.sessionBinding, /sessionLess|NULL/,
    "decision 6b — the sessionLess mobile mint — must be published");
  assert.match(auth.crossUser, /VERIFIED/,
    "the cross-user claim must say it was verified by a real run, not asserted");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 6. THE SERVER-SIDE DECISIONS ARE REALLY IN THE SERVER
// ════════════════════════════════════════════════════════════════════════════════════════════

test("AJ1 6a — sliding renewal exists, is clamped, and only ever moves the deadline FORWARD", () => {
  const bind = SERVER.slice(at(SERVER, "function bindAuthContext"));
  const body = bind.slice(0, at(bind, "\nfunction requireAuth"));
  assert.match(body, /AUTH_CONTEXT_IDLE_SECONDS/, "renewal must use the named idle window");
  assert.match(body, /AUTH_CONTEXT_ABSOLUTE_SECONDS/,
    "renewal MUST be clamped by an absolute cap — without it 'active' means 'immortal', and a " +
    "leaked token in the hands of anything that polls would never expire");
  assert.match(body, /Math\.min/, "the clamp must be a min against the absolute deadline");
  assert.match(body, /slidTo > row\.expires_at/,
    "the write must be guarded so renewal only extends. Math.min can otherwise return a value " +
    "BEHIND the stored expiry and silently shorten a live session — worse than the bug it fixes");
  assert.match(body, /expires_at=\?/, "the renewal must actually write expires_at");
});

test("AJ1 6b — the mobile mint is sessionLess, and independently revocable from the extension's", () => {
  const mint = SERVER.slice(at(SERVER, 'app.get("/api/auth/mobile-token"'));
  const route = mint.slice(0, 900);
  assert.match(route, /sessionLess: true/,
    "a login-issued token stores session_sid = req.sessionID, which is meaningless for a " +
    "cookie-less client AND is swept by revokeBrowserAuthContexts");
  assert.match(route, /userAgent: "resume-master-mobile"/);
  assert.match(SERVER, /revoke-mobile-token/, "mobile tokens need their own revoke");
  assert.match(SERVER, /user_agent='resume-master-mobile'/,
    "the mobile revoke must key on the mobile user agent, so revoking the phone does not kill the " +
    "extension and vice versa");
  // The property that makes the whole design work.
  const issue = SERVER.slice(at(SERVER, "function issueAuthContext"));
  assert.match(issue.slice(0, 1800), /options\.sessionLess \? null : \(req\.sessionID \|\| null\)/,
    "sessionLess must store NULL, which revokeBrowserAuthContexts deliberately never sweeps");
});

test("the 7-day literal is gone — the window is named in one place", () => {
  // A second copy of `7 * 24 * 60 * 60` is how the idle window and the renewal window come to
  // disagree, which would express itself as users being signed out at a time neither number
  // predicts. Exactly the shape of the three hardcoded tab lists.
  const issue = SERVER.slice(at(SERVER, "function issueAuthContext"), at(SERVER, "function revokeBrowserAuthContexts"));
  assert.ok(!/now \+ 7 \* 24 \* 60 \* 60/.test(issue),
    "issueAuthContext still hardcodes the 7-day window instead of using AUTH_CONTEXT_IDLE_SECONDS");
  assert.match(SERVER, /const AUTH_CONTEXT_IDLE_SECONDS = 7 \* 24 \* 60 \* 60;/);
});
