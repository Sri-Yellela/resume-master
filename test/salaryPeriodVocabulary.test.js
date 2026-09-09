// ── An enum column that accepted anything, and the round trip that noticed ──────────────────────
//
// `salary_period` has a three-value vocabulary — annual | hourly | monthly — shared by the board
// filters, enrichJob's validation and the enrichment importer (VALID_SALARY_PERIODS in
// enrichmentTransfer.js). Thirty production rows held the string `peryearsalary`.
//
// Ingestion wrote it. sources/lever.js passes `salaryRange.interval` through verbatim, Lever's own
// value is `per-year-salary`, and normalizeSalaryPeriod stripped the separators and then fell
// through to `return p` — so an unrecognised token became the stored value instead of null.
//
// ⛔ WHAT MADE IT WORTH FIXING RATHER THAN NOTING. The importer validates against the same shared
// vocabulary and is all-or-nothing by design. Those 30 rows therefore made EVERY 500-row export
// batch containing one of them un-importable: a silent ingestion defect disabling the whole
// transfer path. Task AA found it by posting a 500-row export straight back — `wouldWrite 0`,
// which is correct because nothing had changed, and `rejected 30`, which was not.
//
// Nothing else had noticed, and nothing else would have: the value is only visibly wrong if you
// compare it against a vocabulary, and the board's filter simply never matched it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { normalizeJob } from "../services/jobs/schema.js";
import { validateColumn } from "../services/jobs/enrichmentTransfer.js";
// A missing anchor must throw, not become -1 and silently widen the slice to most of server.js.
// sourceAnchorGuard.test.js caught this file using a bare indexOf on its first run.
import { at } from "../test-support/sourceAnchors.js";

const periodOf = (salary_period) =>
  normalizeJob({
    id: "x", title: "Engineer", company: "C", url: "https://e.com/1",
    source: "lever",              // required by normalizeJob, and the source that produced the bug
    salary_period,
  }).salary_period;

test("every Lever interval either maps to the vocabulary or becomes null", () => {
  // Lever's documented set, in the raw form sources/lever.js passes through.
  assert.equal(periodOf("per-year-salary"),  "annual");
  assert.equal(periodOf("per-month-salary"), "monthly");
  assert.equal(periodOf("per-hour-wage"),    "hourly");

  // No honest target in annual|hourly|monthly, so null rather than rounded to the nearest —
  // inventing a period would misstate the pay.
  assert.equal(periodOf("per-week-salary"),  null);
  assert.equal(periodOf("per-day-wage"),     null);
  assert.equal(periodOf("one-time-payment"), null);
});

test("an UNRECOGNISED period becomes null and never the input string", () => {
  // ⛔ THE REGRESSION. `return p` is what put `peryearsalary` in the column — and note that
  // `peryearsalary` is NOT in this list: it is now recognised and maps to annual, because Lever
  // means annual by it. What must never happen again is an unknown token being stored verbatim.
  for (const junk of ["fortnightly", "per fortnight", "??", "annually-ish", "0", "biweekly",
                      "persprint", "peryearsalaryish"]) {
    const got = periodOf(junk);
    assert.equal(got, null, `${junk} must normalise to null, got ${JSON.stringify(got)}`);
  }
});

test("the shapes that were always correct still are", () => {
  for (const [input, want] of [
    ["annual", "annual"], ["yearly", "annual"], ["year", "annual"], ["per year", "annual"],
    ["hourly", "hourly"], ["hour", "hourly"], ["per_hour", "hourly"],
    ["monthly", "monthly"], ["month", "monthly"], ["PER-MONTH", "monthly"],
    [null, null], ["", null], [undefined, null],
  ]) {
    assert.equal(periodOf(input), want, `${JSON.stringify(input)} -> ${want}`);
  }
});

test("whatever normalizeSalaryPeriod emits, the IMPORTER accepts", () => {
  // The two sides are the point. Ingestion and import validate the same column against the same
  // vocabulary, and the round trip only works if ingestion cannot produce a value import rejects.
  const inputs = ["per-year-salary", "per-month-salary", "per-hour-wage", "per-week-salary",
    "one-time-payment", "peryearsalary", "annual", "hourly", "monthly", "nonsense", null];
  for (const raw of inputs) {
    const stored = periodOf(raw);
    if (stored === null) continue;                 // null is never exported as a value to validate
    const v = validateColumn("salary_period", stored);
    assert.ok(v.ok,
      `ingestion produced ${JSON.stringify(stored)} from ${JSON.stringify(raw)} and the importer ` +
      `rejects it: ${v.error} — this is the exact asymmetry that broke the 500-row round trip`);
  }
});

test("migration 104 repairs the stored rows, and is byte-identical in both runners", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const script = fs.readFileSync("scripts/migrations.js", "utf8");
  const ID = 'id: "104_repair_salary_period_vocabulary"';
  const block = (src, label) => {
    const i = at(src, ID, 0, label);
    return src.slice(i, at(src, "\n    },", i, label));
  };
  assert.equal(block(server, "server.js"), block(script, "scripts/migrations.js"),
    "the migration must be byte-identical in server.js and scripts/migrations.js");
  assert.doesNotMatch(block(server, "server.js"), /DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE/i,
    "this migration only rewrites values in one column");

  // And it must actually do the repair. Run the SQL from the file rather than a copy of it, so the
  // test cannot pass against a migration that says something different.
  const db = new Database(":memory:");
  db.exec("CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, salary_period TEXT)");
  const seed = db.prepare("INSERT INTO scraped_jobs (job_id, salary_period) VALUES (?, ?)");
  const cases = [
    ["a", "peryearsalary"], ["b", "per-year-salary"], ["c", "perhourwage"],
    ["d", "permonthsalary"], ["e", "onetimepayment"], ["f", "perweeksalary"],
    ["g", "annual"], ["h", "hourly"], ["i", "monthly"], ["j", null],
  ];
  for (const [id, v] of cases) seed.run(id, v);

  const sqlStart = at(server, "sql: `", at(server, ID, 0, "server.js"), "server.js");
  const sql = server.slice(sqlStart + 6, at(server, "`,", sqlStart, "server.js"));
  db.exec(sql);

  const got = Object.fromEntries(
    db.prepare("SELECT job_id, salary_period FROM scraped_jobs").all()
      .map(r => [r.job_id, r.salary_period])
  );
  assert.equal(got.a, "annual", "peryearsalary — the 30 real production rows");
  assert.equal(got.b, "annual");
  assert.equal(got.c, "hourly");
  assert.equal(got.d, "monthly");
  assert.equal(got.e, null, "one-time-payment has no honest target and must be nulled");
  assert.equal(got.f, null, "per-week-salary likewise");
  assert.equal(got.g, "annual", "already-valid values must be left alone");
  assert.equal(got.h, "hourly");
  assert.equal(got.i, "monthly");
  assert.equal(got.j, null);

  // Nothing outside the vocabulary may survive — including tokens nobody has seen yet.
  const bad = db.prepare(
    "SELECT COUNT(*) n FROM scraped_jobs WHERE salary_period IS NOT NULL " +
    "AND salary_period NOT IN ('annual','hourly','monthly')"
  ).get().n;
  assert.equal(bad, 0, "the catch-all must leave the column inside its vocabulary");
});
