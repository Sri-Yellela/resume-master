// AH-1 — WHAT IS ACTUALLY RUNNING, ANSWERABLE IN ONE REQUEST.
//
// Answering "is X deployed?" has repeatedly cost an archaeology pass in this repo, and has
// repeatedly been answered WRONG:
//   - docs/NEXT_WORK.md carried a banner saying six commits were undeployed while all six were live
//   - the cleanup brake was "confirmed deployed" by a probe that only ever saw the SPA catch-all
//   - a privacy policy was "verified" against a page whose text lives in a JS bundle
// The standing lesson is "assert a JSON key, never a 200". This endpoint is that key.
//
// These tests are mostly BEHAVIOURAL: the two defects found while writing it were both in the
// VALUES, not in whether the route existed, and a source-string test would have passed over both.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { at } from "../test-support/sourceAnchors.js";

const SERVER = fs.readFileSync("server.js", "utf8");

test("the endpoint never reports a commit it cannot establish", () => {
  // ⛔ A confidently wrong SHA is worse than no SHA: it ends the investigation with the wrong
  // answer, which is the failure mode this endpoint exists to prevent.
  const start = at(SERVER, "function resolveCommit", 0, "commit resolver");
  const body = SERVER.slice(start, at(SERVER, "const CONTRACT_VERSION", start, "end of resolver"));
  assert.match(body, /commit: null, commitSource: "unknown"/,
    "an unresolvable commit must be reported as unknown, not guessed or defaulted");
  assert.match(body, /\/\^\[0-9a-f\]\{7,40\}\$\/i/,
    "an env-provided value must be validated as a SHA before it is trusted");
  assert.match(body, /RAILWAY_GIT_COMMIT_SHA/, "the platform that actually builds this must be read");
});

test("the contract version is read from the contract, not restated", () => {
  const start = at(SERVER, "function resolveContractVersion", 0, "contract resolver");
  const body = SERVER.slice(start, start + 400);
  assert.match(body, /mobile-api\.v1\.json/);
  // A literal "1.1.1" in server.js is a second source of truth that drifts the moment
  // generateMobileContract.mjs bumps the real one.
  assert.doesNotMatch(body, /"1\.\d+\.\d+"/, "the version must not be hardcoded here");
});

test("the newest migration is not chosen by sorting TEXT ids", () => {
  // The bug this pins, found by running it: schema_migrations.id is TEXT and the table holds both
  // numbered and legacy named rows, so `ORDER BY id DESC` returns `contact_messages` — a migration
  // from years ago — as the newest.
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const ins = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?,?)");
  for (const id of ["001_initial_schema", "104_repair_salary_period_vocabulary",
                    "105_standalone_usage_client_ip", "contact_messages"]) ins.run(id, 1000);

  const byId = db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get().id;
  assert.equal(byId, "contact_messages", "textual ordering really does pick the wrong row");

  // What the endpoint does instead.
  const rows = db.prepare("SELECT rowid AS seq, id, applied_at FROM schema_migrations").all();
  const numbered = rows
    .map(r => ({ id: r.id, n: /^(\d+)_/.test(r.id) ? Number(r.id.match(/^(\d+)_/)[1]) : null }))
    .filter(r => r.n !== null)
    .sort((a, b) => a.n - b.n);
  assert.equal(numbered[numbered.length - 1].id, "105_standalone_usage_client_ip");

  // And the second bug: every row on a freshly migrated database shares one applied_at second, so
  // applied_at alone resolves the tie arbitrarily — it reported 001_initial_schema as the latest.
  const latest = rows.slice().sort((a, b) => (b.applied_at - a.applied_at) || (b.seq - a.seq))[0].id;
  assert.equal(latest, "contact_messages", "rowid must break the applied_at tie by insertion order");
  db.close();
});

test("the route reports the high-water mark, which is the question people actually ask", () => {
  const start = at(SERVER, 'app.get("/api/version"', 0, "version route");
  // The whole handler, carved from its own start to the next route definition — a fixed window
  // would silently shrink past the assertions below if the handler grows.
  const body = SERVER.slice(start, at(SERVER, "\napp.", start + 10, "the route after /api/version"));
  assert.match(body, /highestNumbered/, '"has migration NNN landed" is the question this answers');
  assert.match(body, /latestApplied/);
  assert.match(body, /rowid AS seq/, "the tie-break must survive an edit to this query");
  // Asserted against the SQL STRING, not against the prose around it. The first version of this
  // checked `doesNotMatch(body, /ORDER BY id DESC/)` and failed on the ⛔ comment that warns
  // against exactly that ordering — a comment quoting the forbidden thing is indistinguishable
  // from code doing it, when the test reads source as text.
  const sql = body.match(/db\.prepare\((["'`])([\s\S]*?)\1\)/)?.[2] ?? "";
  assert.ok(sql.includes("FROM schema_migrations"), "the migration query must be findable");
  assert.doesNotMatch(sql, /ORDER BY\s+id/i, "textual ordering of TEXT ids is the bug, not the fix");
});

test("a database that cannot be read degrades to nulls, not to a 500", () => {
  // The endpoint's whole value is being callable when something is wrong. If it throws because
  // schema_migrations is missing, it is useless in exactly the situation it is for.
  const start = at(SERVER, 'app.get("/api/version"', 0, "version route");
  const body = SERVER.slice(start, start + 1600);
  assert.match(body, /catch \{[^}]*\}/, "the migration read must be guarded");
  assert.match(body, /count: null, latestApplied: null, highestNumbered: null/,
    "the failure shape must be nulls with the same keys, so a caller can still parse it");
});
