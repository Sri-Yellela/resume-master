// AF residual — A WRITE PATH FOR THE FULL-AUTO KILL SWITCH.
//
// The switch itself has worked since migration 072: fullAutoDisabled() reads app_settings first
// and falls back to APPLY_FULL_AUTO_DISABLED, and routes/apply.js re-checks it PER JOB, so a run
// already in flight stops submitting the moment it flips. What was missing was any way to flip it
// without a SQL console or a redeploy. A kill switch you cannot reach in a hurry is not one.
//
// These are behavioural against a real sqlite table, not source assertions, because every defect
// worth catching here is in the COERCION and the three-state logic, not in whether a route exists.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { at } from "../test-support/sourceAnchors.js";
import {
  fullAutoDisabled, fullAutoState, setSetting, clearSetting, getSetting,
  settingTruthy, FULL_AUTO_KEY,
} from "../services/appSettings.js";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE app_settings (
             key TEXT PRIMARY KEY, value TEXT,
             updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  return db;
}

test("the DB override wins over the env default, in BOTH directions", () => {
  const db = freshDb();
  // This is the property applyGuards.test.js pins by driving the pipeline; asserted here directly
  // so a refactor of the helper fails here first, with a clearer message.
  assert.equal(fullAutoDisabled(db, { APPLY_FULL_AUTO_DISABLED: "1" }), true);
  setSetting(db, FULL_AUTO_KEY, false);
  assert.equal(fullAutoDisabled(db, { APPLY_FULL_AUTO_DISABLED: "1" }), false,
    "an override of false must beat an env default of true");
  setSetting(db, FULL_AUTO_KEY, true);
  assert.equal(fullAutoDisabled(db, { APPLY_FULL_AUTO_DISABLED: "0" }), true,
    "an override of true must beat an env default of false");
  db.close();
});

test("clearing the override is a THIRD state, not the same as setting it false", () => {
  // Without a delete there is no way back to "inherit the deploy default". A PUT of false pins
  // the switch open even if a later deploy sets APPLY_FULL_AUTO_DISABLED=1 — which is a different
  // operational promise, and the one an operator is most likely to get wrong.
  const db = freshDb();
  const env = { APPLY_FULL_AUTO_DISABLED: "1" };

  setSetting(db, FULL_AUTO_KEY, false);
  assert.equal(fullAutoDisabled(db, env), false);
  assert.equal(fullAutoState(db, env).source, "override");

  clearSetting(db, FULL_AUTO_KEY);
  assert.equal(getSetting(db, FULL_AUTO_KEY), null, "the row must be gone, not set to a value");
  assert.equal(fullAutoDisabled(db, env), true, "clearing must fall back to the env default");
  assert.equal(fullAutoState(db, env).source, "env");
  db.close();
});

test("booleans are canonicalised, so a later read cannot depend on the writer's spelling", () => {
  const db = freshDb();
  setSetting(db, FULL_AUTO_KEY, true);
  assert.equal(getSetting(db, FULL_AUTO_KEY), "1");
  setSetting(db, FULL_AUTO_KEY, false);
  assert.equal(getSetting(db, FULL_AUTO_KEY), "0");
  db.close();
});

test("every spelling the rest of the repo accepts is still accepted, and nothing else is", () => {
  for (const on of ["1", "true", "TRUE", "yes", "on", " on "]) assert.equal(settingTruthy(on), true, on);
  // ⛔ "flase" must not read as ON. A kill switch flipped by a typo resumes submitting to real
  // employers, which is why the route takes a strict boolean rather than coercing this.
  for (const off of ["0", "false", "flase", "", null, undefined, "off", "no"]) {
    assert.equal(settingTruthy(off), false, String(off));
  }
});

test("state explains WHY, not just what", () => {
  // An operator about to clear the override needs to know whether clearing changes anything.
  const db = freshDb();
  setSetting(db, FULL_AUTO_KEY, true);
  const s = fullAutoState(db, { APPLY_FULL_AUTO_DISABLED: "0" });
  assert.deepEqual(s, { disabled: true, source: "override", override: "1", envDefault: false, envRaw: "0" });
  db.close();
});

test("an un-migrated database falls through to env instead of throwing", () => {
  // getSetting is called on the apply hot path. If it threw on a DB without app_settings, the
  // pipeline would fail closed for a reason unrelated to the switch.
  const db = new Database(":memory:");
  assert.equal(getSetting(db, FULL_AUTO_KEY), null);
  assert.equal(fullAutoDisabled(db, { APPLY_FULL_AUTO_DISABLED: "1" }), true);
  db.close();
});

test("there is ONE definition of the switch, and the pipeline uses it", () => {
  // The whole reason services/appSettings.js exists. An admin screen and an enforcement path that
  // disagree about whether the switch is on is worse than having no screen: it would show
  // "disabled" while runs kept submitting.
  const apply = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(apply, /import \{ fullAutoDisabled as sharedFullAutoDisabled \} from "\.\.\/services\/appSettings\.js"/);
  const start = at(apply, "function fullAutoDisabled()", 0, "kill switch");
  const body = apply.slice(start, start + 200);
  assert.match(body, /return sharedFullAutoDisabled\(db\);/);
  // A second local copy of the env fallback is exactly what this replaced.
  assert.doesNotMatch(body, /APPLY_FULL_AUTO_DISABLED/);

  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /import \{ fullAutoState, setSetting, clearSetting, FULL_AUTO_KEY \} from "\.\/services\/appSettings\.js"/);
});

test("the write route refuses anything that is not a real boolean", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const start = at(server, 'app.put("/api/admin/full-auto"', 0, "write route");
  const body = server.slice(start, at(server, 'app.delete("/api/admin/full-auto"', start, "delete route"));
  assert.match(body, /typeof disabled !== "boolean"/,
    "a truthy string must not be able to flip a kill switch");
  assert.match(body, /status\(400\)/);
  assert.match(body, /console\.warn/, "a change with real-world consequences must leave a record");
  // app_settings keeps only the current value, so the log is the only trace that it moved.
  assert.match(body, /req\.user\?\.id/, "the record must name who did it");
});

test("all three admin routes exist and are admin-guarded", () => {
  const server = fs.readFileSync("server.js", "utf8");
  for (const m of ["get", "put", "delete"]) {
    assert.match(server, new RegExp(`app\\.${m}\\("/api/admin/full-auto", requireAdmin,`),
      `${m.toUpperCase()} /api/admin/full-auto must exist and be admin-only`);
  }
});
