import test from "node:test";
import assert from "node:assert/strict";
import { groupCompaniesByAtsType } from "../services/jobs/aggregator.js";
import { DIRECT_ATS_SOURCES } from "../services/jobs/directApplyFilter.js";
import { readFileSync } from "node:fs";

// searchJobs used to take _ghCompanies / _leverCompanies / _ashbyCompanies as three named
// parameters. Four other ATS plugins were registered, validated at boot, mapped in
// automationTier.js and handled by cacheJobs — and could still only ever be handed an empty
// company list on the live-search path, however many rows company_ats_list held for them. The
// defect was invisible because an ATS plugin given no companies returns an empty result rather
// than an error, which reads as "this provider had nothing today".
//
// The fix is that both call sites group the SAME table through this ONE function. These tests
// pin that, because a second copy of the provider list is exactly what caused it.

const ROWS = [
  { company: "Stripe",     ats_type: "greenhouse",      ats_slug: "stripe" },
  { company: "Spotify",    ats_type: "lever",           ats_slug: "spotify" },
  { company: "Linear",     ats_type: "ashby",           ats_slug: "linear" },
  { company: "Adobe",      ats_type: "workday",         ats_slug: "5|adobe|external_experienced" },
  { company: "Ubisoft",    ats_type: "smartrecruiters", ats_slug: "Ubisoft2" },
  { company: "Blueground", ats_type: "workable",        ats_slug: "blueground" },
  { company: "Channable",  ats_type: "recruitee",       ats_slug: "channable" },
];

test("grouping covers every registered direct-ATS source, not just the original three", () => {
  const map = groupCompaniesByAtsType(ROWS);
  for (const name of DIRECT_ATS_SOURCES) {
    assert.ok(Array.isArray(map[name]), `no bucket for '${name}' — it would be crawled with an empty list`);
    assert.equal(map[name].length, 1, `'${name}' lost its company row`);
  }
  assert.equal(Object.keys(map).length, DIRECT_ATS_SOURCES.size);
});

test("a provider with no companies gets an empty array, never undefined", () => {
  // The plugins default `_companies = []`, so undefined would work by accident. Being explicit
  // keeps "configured but empty" distinguishable from "not a provider we know".
  const map = groupCompaniesByAtsType([{ company: "Stripe", ats_type: "greenhouse", ats_slug: "stripe" }]);
  assert.deepEqual(map.lever, []);
  assert.deepEqual(map.workday, []);
});

test("an ats_type no plugin answers to is dropped, not bucketed under a real provider", () => {
  const map = groupCompaniesByAtsType([
    ...ROWS,
    { company: "Ghost", ats_type: "icims", ats_slug: "ghost" },
    { company: "Null",  ats_type: null,    ats_slug: "x" },
  ]);
  assert.equal(map.icims, undefined);
  const total = Object.values(map).reduce((n, rows) => n + rows.length, 0);
  assert.equal(total, ROWS.length, "the two unroutable rows must not land in any provider's list");
});

test("empty and missing input are handled without throwing", () => {
  for (const input of [[], null, undefined]) {
    const map = groupCompaniesByAtsType(input);
    assert.equal(Object.keys(map).length, DIRECT_ATS_SOURCES.size);
    assert.ok(Object.values(map).every(v => v.length === 0));
  }
});

test("no call site rebuilds the provider list by hand", () => {
  // The regression this file exists for is a SECOND copy of the mapping, so assert that the
  // per-provider filter expression is gone from both call sites rather than only that the
  // helper works. `ats_type === '<provider>'` is the shape that drifted.
  for (const file of ["../services/jobs/aggregator.js", "../server.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const handRolled = src.match(/ats_type\s*===\s*['"]\w+['"]/g) || [];
    assert.deepEqual(handRolled, [], `${file} still filters company_ats_list by ats_type by hand`);
  }
});
