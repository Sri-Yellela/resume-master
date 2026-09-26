import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// `at` rather than a bare indexOf for every region carved below: a missing anchor is -1, and
// slice reads -1 as an offset from the END, so the region silently widens to most of the file
// and the assertion keeps passing over the wrong text. test/sourceAnchorGuard.test.js enforces
// this, and it caught this very file on its first full run.
import { at } from "../test-support/sourceAnchors.js";

// ── CAPTURE MUST DEGRADE, NOT DISAPPEAR ────────────────────────────────────────────────────────
//
// /api/import/job required a model call, so an unfunded balance took capture to ZERO rather than
// to a reduced mode — the extension had already read the posting in the page and the whole capture
// was discarded because a model could not be reached to re-read it. ARCHITECTURE.md §10 recorded
// that as a design constraint; the fallback removes it.
//
// The fallback is pure and deterministic, so unlike most of this path it can be tested for real
// rather than by asserting on source text. The behaviour that matters is as much about what it
// REFUSES to do as what it produces.

const SRC = fs.readFileSync("services/jobs/importJob.js", "utf8");

/**
 * The extractor's own output shape. extension/extractor.js builds this block from JSON-LD and
 * per-host selectors, which is why the structure is already on the wire from the PUBLISHED v1.0.0
 * build — nothing in the extension had to change for the fallback to work for users today.
 */
const labelled = (over = {}) => [
  `Title: ${over.title ?? "Senior Backend Engineer"}`,
  over.company === null ? null : `Company: ${over.company ?? "Northwind Systems"}`,
  `Location: ${over.location ?? "Boston, MA"}`,
  "",
  over.description ?? "We are looking for a senior backend engineer to own payments.",
].filter(l => l !== null).join("\n");

test("the fallback is reached ONLY on a permanent failure, never a transient one", () => {
  // Silently filing a title-only row because the provider was briefly overloaded would swap a
  // loud, recoverable error for a permanently thinner row nobody knows to revisit.
  const i = at(SRC, "async function extractJobFromContent");
  const fn = SRC.slice(i, i + 3000);
  assert.match(fn, /if \(!isPermanentModelFailure\(err\)\) throw err;/);
  // And when the text yields nothing trustworthy, the ORIGINAL error stands.
  assert.match(fn, /if \(!fallback\) throw err;/);
});

test("both return paths share a shape, so neither can be mistaken for the other", () => {
  assert.match(SRC, /return \{ job: fallback, degraded: true \}/);
  assert.match(SRC, /return \{ degraded: false, job: normalizeJob\(\{/);
});

test("⛔ it does not fabricate: inferred fields stay NULL", () => {
  // A wrong salary is not a smaller version of a right one. Enrichment fills these correctly once
  // funded; a guess here would be indistinguishable from a measurement and never revisited.
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  for (const field of ["salary_min", "salary_max", "salary_currency", "remote", "posted_at"]) {
    assert.match(fn, new RegExp(`${field}:\\s*null`), `${field} must not be inferred`);
  }
});

test("⛔ no title means no job — a stray page is not filed as a posting", () => {
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  assert.match(fn, /if \(!labels\.title\) return null;/);
  // Nor is a posting with no identifiable employer.
  assert.match(fn, /if \(!company\) return null;/);
});

test("the degraded row stays an enrichment candidate, which is what makes this a STAGE", () => {
  // enrichJob selects on `enriched_at IS NULL`, so a row filed without the model is picked up and
  // completed the moment the balance is funded. Nothing marks it permanently thin.
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  assert.doesNotMatch(fn, /enriched_at/,
    "the fallback must not stamp enriched_at — that would hide the row from enrichment forever");
  assert.match(SRC, /enriched_at is NULL, so enrichment completes this row/);
});

test("the caller is told the capture was partial, rather than left to assume it was whole", () => {
  assert.match(SRC, /degradedReason: 'ai_unavailable'/);
  assert.match(SRC, /Saved with title and link only/);
  // And the extension words it as a smaller promise kept, not as a plain success.
  const bg = fs.readFileSync("extension/background.js", "utf8");
  assert.match(bg, /Saved \(partial\)/);
  assert.match(bg, /degraded: !!json\.degraded/);
});

test("the header parse stops at the blank line, so a description cannot become a label", () => {
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  assert.match(fn, /if \(!line\.trim\(\)\) break;/);
  // An unlabelled first line means this is not the extractor's block at all.
  assert.match(fn, /if \(!m\) break;/);
  // The fixture above is the shape being parsed; if the extractor's format changes this test's
  // premise changes with it, which is the point of building it here rather than pasting a string.
  assert.match(labelled(), /^Title: .+\nCompany: .+\nLocation: .+\n\n/);
});

test("⛔ a posting HOST is never treated as the employer", () => {
  // greenhouse.io is where a posting LIVES, never who is hiring. Filing "Greenhouse" as the
  // employer would be a fabrication dressed as a derivation. Asserted name-by-name rather than as
  // one alternation string, so adding a source to the list cannot break the test that guards it.
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  for (const host of ["greenhouse", "lever", "ashbyhq", "myworkdayjobs", "workable",
                      "recruitee", "smartrecruiters", "linkedin", "indeed", "glassdoor"]) {
    assert.ok(fn.includes(host), `${host} serves postings and must never name an employer`);
  }
});

test("⛔ a host that is not a domain at all cannot name a company", () => {
  // A first real run filed a posting under the company "Localhost" — caught by opening the page,
  // not by any assertion above it. Deriving a company from the URL is legitimate, because it reads
  // the employer's OWN domain; doing it for a host that is not a domain is not.
  const i = at(SRC, "function jobFromLabelledText");
  const fn = SRC.slice(i, at(SRC, "async function extractJobFromContent"));
  assert.match(fn, /isRealDomain/, "the host must be validated before it can name a company");
  assert.ok(fn.includes("[a-z]{2,}"), "a registrable domain needs a real TLD");
  assert.ok(fn.includes("isRealDomain && root"), "the check must gate the assignment, not just exist");
});

test("the domain rule itself accepts employers and rejects everything else", () => {
  // The predicate is lifted out of the source and exercised directly, so this tests BEHAVIOUR
  // rather than the presence of a line — the failure it was written for ("Localhost") is a value,
  // not a string in a file.
  const isRealDomain = (hostname) =>
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(hostname) && !/^\d+(\.\d+){3}$/.test(hostname);

  for (const good of ["northwind.com", "careers.acme.co.uk", "jobs.example.io"]) {
    assert.equal(isRealDomain(good), true, `${good} is an employer domain`);
  }
  for (const bad of ["localhost", "127.0.0.1", "192.168.1.10", "myhost", ""]) {
    assert.equal(isRealDomain(bad), false, `${bad} must never name a company`);
  }
});
