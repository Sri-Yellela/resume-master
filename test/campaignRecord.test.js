/**
 * AF5's campaign record — the two facts a semi run had in hand and threw away.
 *
 * The watcher itself is proven against a real browser by scripts/af5CorrectionWatch.mjs; a node test
 * cannot open one. These cover the parts that are checkable here: the migration, the wiring at both
 * call sites, the degradation guard, and the in-page probe's own logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";
import { CORRECTION_WATCH_SRC, installCorrectionWatcher } from "../services/applyAutomation.js";

const applySrc = fs.readFileSync("routes/apply.js", "utf8");
const autoSrc = fs.readFileSync("services/applyAutomation.js", "utf8");

// ── Migration 088 ────────────────────────────────────────────────────────────

test("migration 088 is present, additive, and byte-identical in both migration paths", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const block = (src) => {
    const i = src.indexOf('id: "088_apply_run_jobs_campaign_record"');
    assert.ok(i > 0, "migration 088 must exist");
    return src.slice(i, src.indexOf("\n    },", i));
  };
  assert.equal(block(server), block(script),
    "the migration must be byte-identical in server.js and scripts/migrations.js");
  assert.doesNotMatch(block(server), /DROP\s+TABLE|DROP\s+COLUMN|RENAME/i, "additive only");
  assert.match(block(server), /ADD COLUMN fields_discovered INTEGER/);
  assert.match(block(server), /ADD COLUMN corrections_json TEXT/);
});

test("the migration applies, and both columns default to NULL", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)");
  for (const m of MIGRATIONS) {
    for (const stmt of m.sql.split(";").map(s => s.trim()).filter(Boolean)) db.exec(stmt);
  }
  const cols = db.prepare("PRAGMA table_info(apply_run_jobs)").all();
  const byName = Object.fromEntries(cols.map(c => [c.name, c]));
  assert.ok(byName.fields_discovered, "fields_discovered must exist");
  assert.ok(byName.corrections_json, "corrections_json must exist");
  // NULL, not 0. "We did not look" and "we looked and found nothing" are different facts, and a
  // default of 0 would make every un-measured run indistinguishable from a discovery failure.
  assert.equal(byName.fields_discovered.dflt_value, null);
  assert.equal(byName.corrections_json.dflt_value, null);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("BOTH semi call sites pass onCorrections — one of them was the artifact path", () => {
  // CASE A (an existing resume artifact) and CASE B (generate-then-review) are separate autoApply
  // calls, and applyMode is "semi" for both when mode !== "auto". Wiring one and not the other would
  // record corrections for some runs and silently not others.
  assert.equal((applySrc.match(/onCorrections: recordCorrections/g) || []).length, 2);
  const semiCall = applySrc.slice(applySrc.indexOf('mode: "semi"'));
  assert.match(semiCall.slice(0, 400), /onCorrections/);
});

test("the correction record is written on its own, not inside the audit block", () => {
  // A semi run returns while the browser is open, so the audit row is already complete by the time
  // the human edits anything. Writing corrections there would always write nothing.
  assert.match(applySrc, /const recordCorrections = \(corrections\) =>/);
  assert.match(applySrc, /UPDATE apply_run_jobs SET corrections_json=\? WHERE id=\?/);
});

test("a missing corrections_json degrades the note, never the application", () => {
  assert.match(applySrc, /function canRecordCorrections\(\)/);
  assert.match(applySrc, /CAMPAIGN RECORD DEGRADED/);
  assert.match(applySrc, /The application is unaffected/);
  // And the write is actually guarded by it.
  const fn = applySrc.slice(applySrc.indexOf("const recordCorrections"), applySrc.indexOf("const recordCorrections") + 900);
  assert.match(fn, /!canRecordCorrections\(\)/);
});

test("fields_discovered is an audit column, so a stale schema costs only itself", () => {
  const cols = applySrc.slice(applySrc.indexOf("const AUDIT_COLUMNS"), applySrc.indexOf("let auditColumnsCache"));
  assert.match(cols, /"fields_discovered"/);
  assert.match(applySrc, /fields_discovered: Number\.isFinite\(result\.fieldsDiscovered\)/);
  // Null when the run never reached discovery — not 0.
  assert.match(applySrc, /fields_discovered: Number\.isFinite\(result\.fieldsDiscovered\) \? result\.fieldsDiscovered : null/);
});

test("the terminal return reports fieldsDiscovered — it previously only appeared on hold paths", () => {
  // The completing run is the only kind a semi campaign produces, and it was the one path that did
  // not report the denominator.
  assert.match(autoSrc, /fieldsDiscovered: firstPassFieldCount \?\? 0,\n      pageTitle,/,
    "the terminal return must carry fieldsDiscovered");
});

test("autoApply accepts onCorrections and installs the watcher only for semi", () => {
  assert.match(autoSrc, /onCorrections\s+= null,/);
  // The install sits inside the `awaiting_user` (semi) branch, after the missing-required scan.
  const semiStart = autoSrc.indexOf('status    = "awaiting_user";');
  // Bounded by the end of the branch rather than a character count, so the assertion cannot start
  // passing or failing because a comment above it grew.
  const semiBranch = autoSrc.slice(semiStart, autoSrc.indexOf('console.log(`[autoApply] done', semiStart));
  assert.match(semiBranch, /installCorrectionWatcher\(page, resolvedAnswers, onCorrections\)/);
  // Exactly ONE call site, and it is the one above. An unattended run has nobody there to correct
  // anything, so installing a watcher and an interval on that path would be pure overhead on a page
  // the run is about to submit to.
  assert.equal((autoSrc.match(/await installCorrectionWatcher\(/g) || []).length, 1,
    "the watcher must be installed on the semi path only");
});

// ── The in-page probe ────────────────────────────────────────────────────────

test("the probe is an EXPRESSION, like the other injected sources", () => {
  // frame.evaluate() evaluates the string as an expression, so a bare arrow declaration would come
  // back as a function object rather than run. Same constraint as APPLY_FN_SRC / GATE_EVIDENCE_SRC.
  assert.match(CORRECTION_WATCH_SRC.trim(), /^\(filled, bindingName\) => \{/);
  assert.match(CORRECTION_WATCH_SRC, /return Object\.keys\(filled\)\.length;/);
});

test("the probe resolves controls the same way the FILLER does", () => {
  // If it used a different selector it could read a lookalike element and report a correction to a
  // field that was never filled.
  assert.match(CORRECTION_WATCH_SRC, /document\.getElementById\(key\) \|\| document\.querySelector\('\[name="' \+ safe \+ '"\]'\)/);
});

test("the probe escapes a double quote before putting a name in an attribute selector", () => {
  // Bracketed ATS names are fine unquoted-in-quotes; a literal double quote would break the selector
  // and throw inside the page on every poll.
  assert.match(CORRECTION_WATCH_SRC, /replace\(\/"\/g, '\\\\"'\)/);
});

test("the probe polls as well as listens", () => {
  for (const ev of ["change", "input", "submit"]) {
    assert.ok(CORRECTION_WATCH_SRC.includes(`'${ev}'`), `must listen for ${ev}`);
  }
  assert.match(CORRECTION_WATCH_SRC, /beforeunload/);
  assert.match(CORRECTION_WATCH_SRC, /setInterval\(report, 2000\)/,
    "a click-driven submit can navigate before any listener runs");
});

test("a control that has GONE is not reported as a correction", () => {
  assert.match(CORRECTION_WATCH_SRC, /if \(!el\) continue;/);
});

test("the probe reads a radio GROUP, not the element it was handed", () => {
  assert.match(CORRECTION_WATCH_SRC, /input\[type="radio"\]\[name="/);
  assert.match(CORRECTION_WATCH_SRC, /el\.checked \? 'true' : 'false'/, "and a checkbox by its checked state");
});

test("the probe never fetches — a correction note must not put answers on the network", () => {
  // On a real employer's origin a fetch to our server is cross-origin, and using one to make a local
  // note would send the candidate's answers over the wire for no reason.
  assert.doesNotMatch(CORRECTION_WATCH_SRC, /fetch\(|XMLHttpRequest|sendBeacon/);
  assert.match(CORRECTION_WATCH_SRC, /window\[bindingName\]\(json\)/);
});

// ── What counts as a correction ──────────────────────────────────────────────

test("only fields that were actually WRITTEN are watched", async () => {
  // A page stub: installCorrectionWatcher must return 0 without touching it when there is nothing
  // to watch, so no binding is installed and no interval runs on the employer's page.
  let exposed = 0, evaluated = 0;
  const page = {
    exposeFunction: async () => { exposed++; },
    evaluate: async () => { evaluated++; return 0; },
  };
  const nothingWritten = [
    { field_id: "a", label: "A", value: null },
    { field_id: "b", label: "B", value: "", provenance: "label_fuzzy" },
    { field_id: "c", label: "C", value: "x", skipped: true },
    { field_id: "d", label: "D", value: "x", policy_rejected: true },
    { label: "no id at all", value: "x" },
  ];
  assert.equal(await installCorrectionWatcher(page, nothingWritten, () => {}), 0);
  assert.equal(exposed, 0, "no binding should be installed");
  assert.equal(evaluated, 0, "no script should be injected");
});

test("the watcher passes the resolver's value AND provenance into the page", async () => {
  let injected = null;
  const page = {
    exposeFunction: async () => {},
    evaluate: async (src) => { injected = src; return 1; },
  };
  await installCorrectionWatcher(page, [
    { field_id: "org", name: "org", label: "Current Company", value: "Analytical Engines",
      provenance: "label_fuzzy", confidence: 0.3 },
  ], () => {});
  assert.ok(injected.includes('"Analytical Engines"'), "the baseline value must reach the page");
  assert.ok(injected.includes('"label_fuzzy"'),
    "and the provenance, because that is what names the defect");
  assert.ok(injected.includes("__rmReportCorrections"));
});

test("a watcher that cannot install is a lost note, not a lost application", async () => {
  const page = {
    exposeFunction: async () => { throw new Error("Target closed"); },
    evaluate: async () => 0,
  };
  let threw = false;
  try {
    const n = await installCorrectionWatcher(page, [
      { field_id: "a", name: "a", label: "A", value: "x", provenance: "field_map_exact" },
    ], () => {});
    assert.equal(n, 0);
  } catch { threw = true; }
  assert.equal(threw, false, "an install failure must never propagate into the run");
});

test("a malformed report from the page is dropped, not thrown", async () => {
  let handler = null;
  const page = {
    exposeFunction: async (_name, fn) => { handler = fn; },
    evaluate: async () => 1,
  };
  const seen = [];
  await installCorrectionWatcher(page, [
    { field_id: "a", name: "a", label: "A", value: "x", provenance: "field_map_exact" },
  ], (c) => seen.push(c));
  assert.doesNotThrow(() => handler("not json"));
  assert.doesNotThrow(() => handler('{"not":"an array"}'));
  assert.equal(seen.length, 0);
  handler('[{"field":"A","was":"x","now":"y","provenance":"field_map_exact"}]');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].now, "y");
});
