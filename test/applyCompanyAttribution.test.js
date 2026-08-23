// THE ATS HOST IS NOT THE EMPLOYER (TASK AE3).
//
// Observed: the review modal headed itself "JOBS.ASHBYHQ.COM — 1 APPLICATION" over a card that
// correctly said OpenAI. Diagnosed: not a missing-company fallback. `openPortalReview` built its
// scope label out of `portal.host`, because a portal IS an origin — so the one entry point whose
// unit is an origin was the one that named an origin. Every other entry point already labelled by
// company, which is exactly why the sibling OpenAI application read correctly.
//
// What put that row into a portal batch at all was AE1's false CAPTCHA. The label was wrong
// independently of that and would have been just as wrong for a genuine gate, so it is fixed
// separately and asserted separately.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { companyLabel, isAtsHost, UNKNOWN_COMPANY, ATS_HOST_SUFFIXES, ATS_PROVIDER_NAMES }
  from "../shared/atsHosts.js";
import { DIRECT_ATS_SOURCES } from "../services/jobs/directApplyFilter.js";
import { groupByCompany, groupByApplication } from "../client/src/lib/applyObstacles.js";

// ── The rule ─────────────────────────────────────────────────────────────────

test("THE EXACT STRING THAT CAUSED THIS: jobs.ashbyhq.com is not a company", () => {
  assert.equal(companyLabel("jobs.ashbyhq.com"), UNKNOWN_COMPANY);
  assert.equal(companyLabel("JOBS.ASHBYHQ.COM"), UNKNOWN_COMPANY);
});

test("no ATS host can EVER appear as a company name", () => {
  // Tenant subdomains included, because that is the form these hosts actually take in the wild:
  // a packet's expectedOrigin is `https://jobs.ashbyhq.com`, not `ashbyhq.com`.
  for (const h of ATS_HOST_SUFFIXES) {
    for (const candidate of [h, `jobs.${h}`, `boards.${h}`, `acme.${h}`, `https://jobs.${h}`, `https://jobs.${h}/openai/x`]) {
      assert.equal(companyLabel(candidate), UNKNOWN_COMPANY, `${candidate} must never be a company name`);
    }
  }
  for (const n of ATS_PROVIDER_NAMES) {
    assert.equal(companyLabel(n), UNKNOWN_COMPANY, `${n} must never be a company name`);
  }
});

test("the host list covers every ATS the pipeline already trusts", () => {
  // Guard on the guard, the same shape as uncoveredDirectAtsSources(): onboarding a provider in
  // directApplyFilter or platformDetector must not leave a hole here. Asserted against those two
  // modules rather than restating their contents, so there is no third list to drift.
  for (const source of DIRECT_ATS_SOURCES) {
    assert.ok(ATS_PROVIDER_NAMES.includes(source),
      `DIRECT_ATS_SOURCES has '${source}' with no entry in ATS_PROVIDER_NAMES — it could render as a company`);
  }
  const detector = fs.readFileSync("services/platformDetector.js", "utf8");
  const map = detector.slice(detector.indexOf("const URL_ATS_MAP"), detector.indexOf("];", detector.indexOf("const URL_ATS_MAP")));
  const entries = [...map.matchAll(/pattern:\s*"([^"]+)",\s*platform:\s*"([^"]+)"/g)]
    .map(m => ({ pattern: m[1], platform: m[2] }));
  assert.ok(entries.length >= 15, `expected URL_ATS_MAP entries, found ${entries.length}`);
  for (const { pattern, platform } of entries) {
    assert.ok(ATS_PROVIDER_NAMES.includes(platform),
      `URL_ATS_MAP knows platform '${platform}' with no entry in ATS_PROVIDER_NAMES`);
    assert.ok(ATS_HOST_SUFFIXES.some(h => h.includes(platform)),
      `URL_ATS_MAP knows platform '${platform}' with no host suffix in ATS_HOST_SUFFIXES`);
    // URL_ATS_MAP is matched with `includes`, so a few of its entries are host FRAGMENTS rather than
    // hostnames — 'boards.greenhouse' has no TLD and is never a host on its own. Only the entries
    // that are real hostnames are required to be matched directly; the fragments are covered by the
    // suffix their real host ends in, which the two assertions above pin.
    // "Is this a real hostname" = does it end in a TLD any of our known ATS hosts ends in. A length
    // rule would not do it: 'boards.greenhouse' ends in a dot and ten letters and is still a
    // fragment, which is exactly the case that made a looser check pass a hole through.
    const tlds = new Set(ATS_HOST_SUFFIXES.map(h => h.split(".").pop()));
    if (tlds.has(pattern.split(".").pop())) {
      assert.ok(isAtsHost(pattern) && isAtsHost(`jobs.${pattern}`),
        `URL_ATS_MAP knows '${pattern}' as an ATS host but atsHosts.js would let it render as a company`);
    }
  }
});

// ── The guard on the guard's own false positives ──────────────────────────────

test("A COMPANY WHOSE NAME CONTAINS A DOT IS STILL A COMPANY", () => {
  // Why this is an enumerated list and not a "looks like a hostname" shape test. All three of these
  // are real employers with no spaces and a dot, and a shape heuristic would erase every one.
  for (const real of ["Booking.com", "Match.com", "Care.com", "Chewy.com", "Salesforce.com"]) {
    assert.equal(companyLabel(real), real);
  }
});

test("a provider name inside a longer company name is not matched", () => {
  // The provider check requires the WHOLE string: "Ashby Systems Ltd" is somebody's employer.
  for (const real of ["Ashby Systems Ltd", "Greenhouse Software", "Lever Inc", "Workday"]) {
    assert.equal(companyLabel(real), real === "Workday" ? UNKNOWN_COMPANY : real,
      `${real}: only a bare provider name is refused`);
  }
  // 'Workday' IS the bare provider name, and refusing it is the correct trade: the ATS is vastly
  // more likely to be what a hostname-derived value meant than Workday Inc is to be the employer
  // being applied to through its own product.
  assert.equal(isAtsHost("Workday"), true);
});

test("blank, whitespace, null and undefined all say so plainly", () => {
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(companyLabel(empty), UNKNOWN_COMPANY);
  }
});

test("companyLabel is idempotent, so passing a grouped company back through it is safe", () => {
  assert.equal(companyLabel(companyLabel("OpenAI")), "OpenAI");
  assert.equal(companyLabel(companyLabel(null)), UNKNOWN_COMPANY);
  assert.equal(companyLabel(UNKNOWN_COMPANY), UNKNOWN_COMPANY);
});

// ── Through the real grouping ────────────────────────────────────────────────

test("a row with a company groups under it; a row with only a host does not become an employer", () => {
  const rows = [
    { id: 1, jobId: "j1", company: "OpenAI", title: "Software Engineer, Agent Productivity", finishedAt: 30 },
    { id: 2, jobId: "j2", company: "OpenAI", title: "Research Engineer",                     finishedAt: 20 },
    { id: 3, jobId: "j3", company: "jobs.ashbyhq.com", title: "Something",                   finishedAt: 10 },
    { id: 4, jobId: "j4", company: null,      title: "Cleaned up",                           finishedAt: 5 },
  ];
  const groups = groupByCompany(groupByApplication(rows));
  const names = groups.map(g => g.company);
  assert.ok(names.includes("OpenAI"), "the real employer is named");
  assert.ok(!names.some(n => /ashbyhq/i.test(n)), `an ATS host became a group heading: ${JSON.stringify(names)}`);
  // The host row and the nameless row land in ONE unnameable group, not two headings that render
  // identically.
  assert.equal(names.filter(n => n === UNKNOWN_COMPANY).length, 1);
  assert.equal(groups.find(g => g.company === UNKNOWN_COMPANY).items.length, 2);
  assert.equal(groups.find(g => g.company === "OpenAI").items.length, 2);
});

// ── The call site that produced the header ───────────────────────────────────

test("openPortalReview names the EMPLOYERS in the batch, not the portal host", () => {
  const panel = fs.readFileSync("client/src/panels/AutoApplyPanel.jsx", "utf8");
  const fn = panel.slice(panel.indexOf("const openPortalReview"), panel.indexOf("const openFacet"));
  assert.ok(fn.length > 0, "openPortalReview must exist");
  assert.ok(!/label:\s*`\$\{p\.host\}/.test(fn),
    "the scope label must not be built from the portal host — that IS the defect");
  assert.match(fn, /companyLabel\(/, "the label has to come from the row's company");
  assert.match(fn, /applyGatedJobs/,
    "gated rows live in their own feed, so the companies have to be read from it too");
});

test("EVERY company render site goes through the one chokepoint", () => {
  // The property only holds if there is no second way to turn a company into text. Anything of the
  // form `company || "..."` in a rendered position is a bypass, and a bypass is how the original
  // defect was able to exist at all.
  for (const f of ["client/src/panels/AutoApplyPanel.jsx", "client/src/panels/AutoApplyPanelSections.jsx"]) {
    const src = fs.readFileSync(f, "utf8");
    const bypasses = src.split(/\r?\n/)
      .filter(line => /(?:\w+\.)?company\s*\|\|\s*"/.test(line))
      // Two kinds of line legitimately read the RAW value. Test hooks (`data-rm-*` attributes and
      // the `data={{…}}` payload they are rendered from) are selectors, not display text; a search
      // haystack is compared, never shown.
      .filter(line => !/data-rm-company|data=\{\{/.test(line) && !/toLowerCase\(\)/.test(line))
      .map(line => line.trim());
    assert.deepEqual(bypasses, [],
      `${f} renders a company without companyLabel — an ATS host could reach the screen through it`);
  }
});
