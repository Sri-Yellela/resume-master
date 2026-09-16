// ANONYMOUS SPEND WAS BOUNDED BY A COOKIE THE CALLER CONTROLS.
//
// standaloneRateLimit counted an anonymous caller's runs by req.sessionID. Clearing site data or
// opening an incognito window reset the allowance, so the "1 free run per 30 days" on
// /api/standalone/generate — Sonnet at 8192 max_tokens, the largest per-call cost in the system —
// was a speed bump, not a bound. The Part 1 monetisation audit found it while looking for
// commercial surfaces; it is not one, which is why none of this sits behind the lever.
//
// Three changes, and they are deliberately different KINDS of control:
//   1. IP keying      — closes the reset hole for the callers who just clear cookies.
//   2. Auth on generate — removes the expensive surface from anonymous reach entirely.
//   3. A daily ceiling — bounds the bill even against someone rotating addresses.
//
// /api/standalone/ats stays anonymous on purpose: Haiku at 900 max_tokens, and it is the hook.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const SERVER = fs.readFileSync("server.js", "utf8");

test("an anonymous caller is counted by IP, not by a cookie they control", () => {
  const start = at(SERVER, "function standaloneRateLimit", 0, "limiter");
  const body = SERVER.slice(start, start + 3000);
  assert.match(body, /WHERE client_ip=\? AND service=\? AND used_at>\?/,
    "the anonymous count must key on client_ip");
  assert.doesNotMatch(body, /WHERE session_id=\? AND service=\? AND used_at>\?/,
    "counting anonymous runs by session_id is the hole this closes");
  // The row must still RECORD the ip, or the next request counts zero.
  assert.match(body, /INSERT INTO standalone_usage \(standalone_user_id, session_id, service, client_ip\)/);
});

test("the daily ceiling is checked BEFORE the per-caller allowance", () => {
  // A ceiling evaluated after the per-caller check would only ever bind callers already over
  // their own limit — which is to say, never. Ordering is the whole control here.
  const start = at(SERVER, "function standaloneRateLimit", 0, "limiter");
  const body = SERVER.slice(start, start + 3000);
  const ceiling = body.indexOf("ANON_DAILY_SERVICE_CEILING");
  const perCaller = body.indexOf("const limit = userId ? userMax : anonMax;");
  assert.ok(ceiling > 0 && perCaller > 0, "both checks must exist");
  assert.ok(ceiling < perCaller, "the global ceiling must be evaluated first");
  // Only anonymous traffic counts toward it; a signed-in user is not rationed by other people.
  assert.match(body, /standalone_user_id IS NULL AND service=\? AND used_at>\?/);
});

test("generate requires a standalone account; ats stays anonymous", () => {
  assert.match(SERVER,
    /app\.post\("\/api\/standalone\/generate", requireStandaloneAuth, standaloneRateLimit\("generate", 0, 2\)/,
    "generate must be behind the guard, with the anonymous allowance set to 0");
  // ⛔ The cheap one stays open on purpose. If this flips, the tools funnel loses its hook and the
  // change should be a deliberate decision rather than a copy-paste of the line above.
  assert.match(SERVER, /app\.post\("\/api\/standalone\/ats", standaloneRateLimit\("ats", 1, 3\)/,
    "ats must remain anonymous — it is Haiku, and it is the hook");

  const start = at(SERVER, "function requireStandaloneAuth", 0, "guard");
  const guard = SERVER.slice(start, start + 400);
  assert.match(guard, /status\(401\)/);
  assert.match(guard, /standalone_auth_required/);
  assert.match(guard, /message:/, "the guard must carry human copy, not only a code");
});

test("the guard runs before the limiter, so a refused caller writes no usage row", () => {
  const start = at(SERVER, 'app.post("/api/standalone/generate"', 0, "route");
  const line = SERVER.slice(start, at(SERVER, "\n", start, "end of the generate route line"));
  assert.ok(line.indexOf("requireStandaloneAuth") < line.indexOf("standaloneRateLimit"),
    "auth must precede the rate limiter in the middleware chain");
});

test("none of this is behind the monetisation lever", () => {
  // Spend ceilings are cost controls. They must bind whether or not the product is commercial —
  // this is the same rule test/monetisationLever.test.js asserts from the other direction.
  const start = at(SERVER, "function standaloneRateLimit", 0, "limiter");
  const body = SERVER.slice(start, start + 3000);
  assert.doesNotMatch(body, /monetisationEnabled/);
  const guardStart = at(SERVER, "function requireStandaloneAuth", 0, "guard");
  assert.doesNotMatch(SERVER.slice(guardStart, guardStart + 400), /monetisationEnabled/);
});

test("migration 105 is byte-identical in both runners and only ADDS", () => {
  // The repo's standing rule for migrations, and the one that catches a schema that exists in the
  // boot path but not in scripts/migrations.js (or vice versa).
  const migrations = fs.readFileSync("scripts/migrations.js", "utf8");
  const idA = at(SERVER, '"105_standalone_usage_client_ip"', 0, "server migration");
  const idB = at(migrations, '"105_standalone_usage_client_ip"', 0, "runner migration");
  const blockA = SERVER.slice(idA, at(SERVER, "},", idA, "end of server migration 105"));
  const blockB = migrations.slice(idB, at(migrations, "},", idB, "end of runner migration 105"));
  assert.equal(blockA, blockB, "migration 105 must be identical in both migration paths");
  assert.match(blockA, /ALTER TABLE standalone_usage ADD COLUMN client_ip TEXT;/);
  assert.doesNotMatch(blockA, /DROP|DELETE FROM/, "this migration must be purely additive");
});

test("the public page states the quota the server actually enforces", () => {
  // "3 free scores / month" sat under a "no account required" heading while anonymous callers got
  // one, and "2 free resumes / month" is now a promise the route refuses outright.
  const features = fs.readFileSync("client/src/pages/marketing/FeaturesPage.jsx", "utf8");
  assert.match(features, /1 free score \/ month, 3 with an account/);
  assert.match(features, /2 free resumes \/ month \(sign in required\)/);
  assert.doesNotMatch(features, /limit: "3 free scores \/ month"/);
  assert.doesNotMatch(features, /limit: "2 free resumes \/ month"/);
});
