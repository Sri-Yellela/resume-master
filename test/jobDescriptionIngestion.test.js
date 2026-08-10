import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../services/jobs/htmlToText.js";
import { normalizeGreenhouseJob } from "../services/jobs/sources/greenhouse.js";
import { normalizeAshbyJob } from "../services/jobs/sources/ashby.js";

// Root cause of the all-NULL enrichment diagnosed in docs/PIPELINE_DIAGNOSIS.md: greenhouse
// (95% of the active board) and ashby stored NO description at all, so enrichJob.js fed the
// model an empty posting, correctly got null for every field back, and stamped the row
// complete. These tests pin the ingestion side of that — the field names and query params
// below were verified against the live APIs, and a silent rename upstream is exactly the
// failure mode that produced the outage.

test("htmlToText decodes entity-encoded markup before stripping tags", () => {
  // Greenhouse returns its HTML entity-ENCODED: the raw string contains "&lt;p&gt;", not
  // "<p>". A tag-strip alone matches nothing here, which is how the description silently
  // survived as markup-looking text (or, with the old `description: null`, not at all).
  const raw = "&lt;h2&gt;&lt;strong&gt;About&lt;/strong&gt;&lt;/h2&gt;\n&lt;p&gt;We build things.&lt;/p&gt;";
  const text = htmlToText(raw);
  assert.ok(!text.includes("<"), "no markup may survive");
  assert.ok(!text.includes("&lt;"), "no encoded markup may survive");
  assert.match(text, /About/);
  assert.match(text, /We build things\./);
});

test("htmlToText resolves double-encoded text entities", () => {
  // "&amp;amp;" is "&amp;" after one decode pass and "&" only after the second. The second
  // pass runs on already tag-free text, so it cannot resurrect markup.
  assert.equal(htmlToText("&lt;p&gt;R&amp;amp;D&lt;/p&gt;"), "R&D");
});

test("htmlToText preserves list structure so requirements don't run together", () => {
  const text = htmlToText("&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;");
  const lines = text.split("\n").filter(Boolean);
  assert.deepEqual(lines, ["• Python", "• Go"],
    "list items must land on separate lines, not concatenate into one blob");
});

test("htmlToText drops script/style contents rather than inlining code as prose", () => {
  const text = htmlToText("&lt;p&gt;Real text&lt;/p&gt;&lt;script&gt;var x = 1;&lt;/script&gt;");
  assert.match(text, /Real text/);
  assert.ok(!text.includes("var x"), "script bodies are code, not description text");
});

test("htmlToText returns null for empty/absent input rather than an empty string", () => {
  // normalizeJob treats null as "source can't supply this"; "" would be a false positive that
  // makes an empty posting look enriched-able.
  assert.equal(htmlToText(undefined), null);
  assert.equal(htmlToText(""), null);
  assert.equal(htmlToText("   "), null);
  assert.equal(htmlToText("&lt;p&gt;&lt;/p&gt;"), null);
});

test("greenhouse normalizer populates description and summary from job.content", () => {
  // Regression: greenhouse.js hardcoded `description: null`, and its fetch omitted
  // ?content=true so `content` wasn't even present in the response.
  const job = {
    id: 123, title: "Backend Engineer", location: { name: "Remote" },
    absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
    updated_at: "2026-08-01T00:00:00Z",
    content: "&lt;p&gt;Build APIs in Python.&lt;/p&gt;",
  };
  const normalized = normalizeGreenhouseJob(job, "Acme");
  assert.equal(normalized.description, "Build APIs in Python.");
  // schema.js derives `summary` from the description — has_summary was 0 board-wide purely
  // because there was never a description to derive it from.
  assert.equal(normalized.summary, "Build APIs in Python.");
});

test("greenhouse normalizer leaves description null when content is absent", () => {
  const normalized = normalizeGreenhouseJob(
    { id: 1, title: "Engineer", location: { name: "NYC" }, absolute_url: "https://x.co/1" },
    "Acme"
  );
  assert.equal(normalized.description, null, "a missing field must stay null, not become ''");
});

test("ashby normalizer reads descriptionPlain, not the nonexistent descriptionSections", () => {
  // Regression: the adapter read `job.descriptionSections`, which the posting-api board
  // endpoint does not return — every row silently got null.
  const normalized = normalizeAshbyJob({
    id: "abc", title: "Platform Engineer", location: "Remote", applyUrl: "https://jobs.ashbyhq.com/acme/abc",
    descriptionPlain: "We are hiring a platform engineer.",
    descriptionHtml: "<p>We are hiring a platform engineer.</p>",
  }, "Acme");
  assert.equal(normalized.description, "We are hiring a platform engineer.");
});

test("ashby normalizer falls back to descriptionHtml when plain text is absent", () => {
  const normalized = normalizeAshbyJob({
    id: "abc", title: "Platform Engineer", location: "Remote", applyUrl: "https://jobs.ashbyhq.com/acme/abc",
    descriptionHtml: "<p>Hiring a <strong>platform</strong> engineer.</p>",
  }, "Acme");
  assert.match(normalized.description, /Hiring a platform engineer\./);
  assert.ok(!normalized.description.includes("<"), "HTML fallback must be stripped to plain text");
});

test("ashby normalizer picks the Salary component, not whatever is first", () => {
  // summaryComponents is a MIXED list (Salary/Bonus/EquityPercentage) in no guaranteed order.
  // The adapter took [0] blindly, so a leading Bonus entry was stored as base pay.
  const normalized = normalizeAshbyJob({
    id: "abc", title: "Engineer", location: "Remote", applyUrl: "https://jobs.ashbyhq.com/acme/abc",
    descriptionPlain: "Role.",
    compensation: {
      summaryComponents: [
        { compensationType: "Bonus",  interval: "1 YEAR", currencyCode: "USD", minValue: 5000,   maxValue: 10000 },
        { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 150000, maxValue: 200000 },
      ],
    },
  }, "Acme");
  assert.equal(normalized.salary_min, 150000, "must not read the bonus range as salary");
  assert.equal(normalized.salary_max, 200000);
  assert.equal(normalized.salary_currency, "USD");
  // Ashby sends "1 YEAR"; schema.js's normalizeSalaryPeriod only knows year/yearly/annual, so
  // the raw value would have passed through as the bogus period "1year".
  assert.equal(normalized.salary_period, "annual");
  assert.equal(normalized.salary_max_usd, 200000, "USD ranges should populate the USD columns");
});

test("ashby normalizer yields null salary when no Salary component exists", () => {
  const normalized = normalizeAshbyJob({
    id: "abc", title: "Engineer", location: "Remote", applyUrl: "https://jobs.ashbyhq.com/acme/abc",
    descriptionPlain: "Role.",
    compensation: { summaryComponents: [{ compensationType: "EquityPercentage", minValue: 0.1, maxValue: 0.5 }] },
  }, "Acme");
  assert.equal(normalized.salary_min, null, "equity is not salary");
  assert.equal(normalized.salary_max, null);
});

test("ashby normalizer maps workplaceType, falling back to isRemote", () => {
  const mk = (fields) => normalizeAshbyJob({
    id: "a", title: "Engineer", location: "X", applyUrl: "https://x.co/a", descriptionPlain: "R.", ...fields,
  }, "Acme").workplace_type;

  assert.equal(mk({ workplaceType: "Hybrid" }), "hybrid");
  assert.equal(mk({ workplaceType: "On-site" }), "onsite", "hyphenated form must normalize");
  assert.equal(mk({ workplaceType: "Remote" }), "remote");
  // Legacy behaviour retained for boards that omit workplaceType entirely.
  assert.equal(mk({ isRemote: true }), "remote");
});
