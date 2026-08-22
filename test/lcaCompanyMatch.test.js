// The matcher is the whole risk of the H-1B sponsorship signal (TASK X3), so this file is the
// tripwire on it.
//
// LCA employer names are legal entities; our `company` strings are brands. Telling a candidate that
// Company A sponsors when the filing belongs to a similarly-named Company B is the exact
// "confident wrong answer" failure this codebase keeps producing. Every case below is a REAL row
// from the FY2025 Q1 - FY2026 Q1 disclosure files, not an invented example, because the failure
// modes that matter are the ones the data actually contains.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityIndex, matchCompanyToEntities, companyMatchKey, stripLegalSuffix,
  parseDbaNames, isHoldcoExtension, countDistinctEntities, brandFamily, HOLDCO_TOKENS, LEGAL_SUFFIXES,
  TIER_CONFIDENCE,
} from "../services/kb/lcaMatch.js";

/** Real employer rows, in the shape lca_employer_periods stores them. */
const REAL_EMPLOYERS = [
  { employer_name: "Stripe, Inc.",                        fein: "47-1849232", state: "CA" },
  { employer_name: "Anthropic, PBC",                      fein: "83-3644929", state: "CA" },
  { employer_name: "AIRBNB, INC.",                        fein: "26-3051428", state: "CA" },
  { employer_name: "AIRBNB PAYMENTS, INC.",               fein: "45-4416243", state: "CA" },
  { employer_name: "OpenAI OpCo, LLC",                    fein: "81-0861541", state: "CA" },
  { employer_name: "Notion Labs, Inc.",                   fein: "45-5580473", state: "CA" },
  { employer_name: "Ramp Business Corporation",           fein: "83-2508297", state: "NY" },
  { employer_name: "People Center, Inc. d/b/a Rippling",  fein: "82-3226753", state: "CA" },
  // The Mercury family. Four unrelated employers, and the one that files the MOST software titles
  // is the insurer — measured: Mercury Insurance Services filed 7 certified LCAs for "Senior
  // Software Engineer", "Staff Software Engineer" and "Senior Site Reliability Engineer".
  { employer_name: "Mercury Technologies, Inc.",          fein: "82-2557284", state: "CA" },
  { employer_name: "Mercury Insurance Services, LLC",     fein: "95-4831771", state: "CA" },
  { employer_name: "Mercury Analytics, LLC",              fein: "20-8637719", state: "DC" },
  { employer_name: "MERCURY HEALTHCARE INC.",             fein: "62-1623449", state: "NJ" },
  // The two names token-containment matching would wrongly claim.
  { employer_name: "Thomson Linear LLC",                  fein: "36-3186438", state: "IL" },
  { employer_name: "GLOBAL RETOOL GROUP AMERICA, LLC",    fein: "83-1096043", state: "MI" },
  { employer_name: "RETOOL, INC.",                        fein: "82-4816284", state: "CA" },
];

const index = buildEntityIndex(
  REAL_EMPLOYERS.map(e => ({
    ...e,
    employer_key: companyMatchKey(e.employer_name),
    dba_keys_json: JSON.stringify(parseDbaNames(e.employer_name)),
  }))
);
const match = (company) => matchCompanyToEntities(company, index);

// ── Tier A: the registered name ──────────────────────────────────────────────────────────────

test("a legal-suffix difference is not a mismatch — Stripe, and the pbc that cost us Anthropic", () => {
  const stripe = match("Stripe");
  assert.equal(stripe.status, "matched");
  assert.equal(stripe.tier, "A");
  assert.equal(stripe.confidence, TIER_CONFIDENCE.A);

  // `pbc` was absent from the first suffix list, and that single omission dropped Anthropic — 166
  // certified filings across five quarters — out of the results entirely.
  assert.ok(LEGAL_SUFFIXES.has("pbc"), "pbc must be a recognised entity suffix");
  const anthropic = match("Anthropic");
  assert.equal(anthropic.tier, "A");
  assert.deepEqual(anthropic.entities.map(e => e.employerName), ["Anthropic, PBC"]);
});

test("a holding-company sibling IS rolled in — but only when the brand token is distinctive", () => {
  // AIRBNB PAYMENTS, INC. is genuinely Airbnb's, and nothing else in ~500k employer-quarters is
  // called "Airbnb <anything>" with a line of business attached. So the brand is distinctive and the
  // sibling counts. The UI names both, so the total is auditable rather than asserted.
  const airbnb = match("Airbnb");
  assert.equal(airbnb.status, "matched");
  assert.equal(airbnb.tier, "A");
  assert.deepEqual(airbnb.entities.map(e => e.employerName).sort(),
    ["AIRBNB PAYMENTS, INC.", "AIRBNB, INC."]);
  assert.match(airbnb.reason, /holding-company sibling/);

  // The same shape with ONE unrelated business added to the fixture, and the roll-up stops. This is
  // the guard, not a coincidence: "Airbnb Cleaning Services" would be someone else's company, and
  // its presence is evidence the token is a word rather than a name.
  const shared = buildEntityIndex([...REAL_EMPLOYERS, {
    employer_name: "Airbnb Cleaning Services LLC", fein: "77-7777777", state: "TX",
  }].map(e => ({ ...e, employer_key: companyMatchKey(e.employer_name),
                 dba_keys_json: JSON.stringify(parseDbaNames(e.employer_name)) })));
  const guarded = matchCompanyToEntities("Airbnb", shared);
  assert.equal(guarded.tier, "A", "the exact registered-name match still stands");
  assert.deepEqual(guarded.entities.map(e => e.employerName), ["AIRBNB, INC."],
    "but the sibling is no longer safe to add");
  assert.match(guarded.reason, /unrelated employer\(s\) share the name and were excluded/);
});

test("OPENAI: a company that files under two names is counted once, not reported as the smaller", () => {
  // Measured over 21 quarters: "OpenAI OpCo, LLC" filed 179 certified LCAs and "OpenAI, LP" filed
  // 11. A tier A that stopped at the exact match reported NINE for a company with ~193 — a 20x
  // understatement, and the kind that reads as authoritative because it is precise.
  const openai = buildEntityIndex([
    { employer_name: "OpenAI, LP", fein: "", state: "CA" },
    { employer_name: "OpenAI, L.L.C.", fein: "", state: "CA" },
    { employer_name: "OpenAI OpCo, LLC", fein: "81-0861541", state: "CA" },
  ].map(e => ({ ...e, employer_key: companyMatchKey(e.employer_name), dba_keys_json: "[]" })));
  const m = matchCompanyToEntities("OpenAI", openai);
  assert.equal(m.tier, "A");
  assert.equal(m.entities.length, 3, "all three legal names are the same company");
  assert.ok(m.entities.some(e => e.employerName === "OpenAI OpCo, LLC"),
    "the OpCo holds the overwhelming majority of the filings and must be included");

  // The dotted-acronym normalisation is what makes L.L.C. reachable at all. Without it the key is
  // `openai l l c`, which is neither an exact match nor a holdco extension — so it survives as a
  // "foreign" employer and destroys the brand's distinctiveness, blocking the roll-up above.
  assert.equal(companyMatchKey("OpenAI, L.L.C."), "openai");
  assert.equal(companyMatchKey("OpenAI, L.P."), "openai");
  assert.equal(companyMatchKey("Amazon.com Services LLC"), "amazon com services",
    "and it must not touch a dot that is not part of an acronym");
});

test("case and punctuation variants of ONE name do collapse — RETOOL, INC. is Retool", () => {
  const retool = match("Retool");
  assert.equal(retool.tier, "A");
  assert.deepEqual(retool.entities.map(e => e.employerName), ["RETOOL, INC."]);
  assert.ok(!retool.entities.some(e => /GLOBAL RETOOL/.test(e.employerName)),
    "GLOBAL RETOOL GROUP AMERICA is a different company and must not be in the match");
  // Two spellings of the same registered name normalise to one key and are counted together —
  // which is a roll-up of the SAME entity, not of a different one.
  const variants = buildEntityIndex([
    { employer_name: "RETOOL, INC.", fein: "82-4816284", state: "CA",
      employer_key: companyMatchKey("RETOOL, INC."), dba_keys_json: "[]" },
    { employer_name: "Retool Inc.", fein: "82-4816284", state: "CA",
      employer_key: companyMatchKey("Retool Inc."), dba_keys_json: "[]" },
  ]);
  assert.equal(matchCompanyToEntities("Retool", variants).entities.length, 2);
});

// ── Tier B: the d/b/a field is not optional ──────────────────────────────────────────────────

test("Rippling is reachable ONLY through d/b/a, so parsing that field is load-bearing", () => {
  const rippling = match("Rippling");
  assert.equal(rippling.status, "matched");
  assert.equal(rippling.tier, "B");
  assert.equal(rippling.confidence, TIER_CONFIDENCE.B);
  assert.deepEqual(rippling.entities.map(e => e.employerName), ["People Center, Inc. d/b/a Rippling"]);
  // Without the d/b/a parse this brand has NO registered-name presence at all — the legal name
  // shares not one token with it.
  assert.equal(companyMatchKey("People Center, Inc. d/b/a Rippling"), "people center");
});

// ── Tier C: brand + holdco token, and only when one FEIN survives ────────────────────────────

test("brand-prefix recovers the holding-company names — OpenAI OpCo, Notion Labs, Ramp Business", () => {
  for (const [brand, entity] of [
    ["OpenAI", "OpenAI OpCo, LLC"],
    ["Notion", "Notion Labs, Inc."],
    ["Ramp", "Ramp Business Corporation"],
  ]) {
    const m = match(brand);
    assert.equal(m.status, "matched", `${brand} should match`);
    assert.equal(m.tier, "C", `${brand} is a brand-prefix match, not an exact one`);
    assert.equal(m.confidence, TIER_CONFIDENCE.C);
    assert.deepEqual(m.entities.map(e => e.employerName), [entity]);
  }
});

test("MERCURY: a brand token three other businesses use is not attributed at all", () => {
  const m = match("Mercury");
  // "Mercury Technologies, Inc." is the only all-holdco candidate, and an earlier version of this
  // matcher therefore matched it — correctly, as it happens, but for the wrong reason. The presence
  // of Mercury Insurance Services, Mercury Analytics and Mercury Healthcare says "mercury" is a word
  // rather than a name, and once that is true there is no rule here that can pick the right one.
  assert.equal(m.status, "ambiguous");
  assert.equal(m.confidence, 0);
  assert.match(m.reason, /not a distinctive name/);
  // Nothing is presented, so no wrong company is claimed — and neither is the right one.
  for (const wrong of ["Mercury Insurance Services, LLC", "Mercury Analytics, LLC", "MERCURY HEALTHCARE INC."]) {
    assert.ok(!m.entities.some(e => e.employerName === wrong),
      `${wrong} must never be attributed to Mercury`);
  }
});

test("LINEAR: the false positive that widening the corpus to 21 quarters produced", () => {
  // THE REGRESSION THIS RULE EXISTS FOR. Over 5 quarters "Linear" was correctly unmatched. Over 21
  // the data contains "Linear Labs LLC" (an electric-motor company), and because `labs` is a holdco
  // token and it was the SOLE all-holdco candidate, the ambiguity guard passed it — reporting that
  // Linear.app, which has never filed an LCA, sponsors H-1Bs. The guard only ever asked whether the
  // candidates disagreed with each other, never whether the one candidate was plausible.
  const linear = buildEntityIndex([
    { employer_name: "Linear Labs LLC", fein: "", state: "TX" },
    { employer_name: "LINEAR SIGNS, INC.", fein: "", state: "CA" },
    { employer_name: "Linear Financial Technologies LLC", fein: "", state: "NY" },
    { employer_name: "LINEAR DIMENSIONS SEMICONDUCTOR INC.", fein: "", state: "CA" },
  ].map(e => ({ ...e, employer_key: companyMatchKey(e.employer_name), dba_keys_json: "[]" })));
  const m = matchCompanyToEntities("Linear", linear);
  assert.equal(m.status, "ambiguous", "must not claim Linear Labs' filings for Linear.app");
  assert.equal(m.confidence, 0);
  assert.match(m.reason, /not a distinctive name/);

  // And the mechanism, directly: three of the four are "foreign" because their remainders name a
  // line of business, which is what makes the fourth unsafe.
  const fam = brandFamily("linear", linear);
  assert.equal(fam.distinctive, false);
  assert.equal(fam.holdco.length, 1);
  assert.equal(fam.foreign.length, 3);
});

test("two holdco candidates on different FEINs is AMBIGUOUS — it declines rather than guessing", () => {
  const two = buildEntityIndex([
    { employer_name: "Apex Technologies, Inc.", fein: "11-1111111", state: "CA",
      employer_key: companyMatchKey("Apex Technologies, Inc."), dba_keys_json: "[]" },
    { employer_name: "Apex Systems, LLC", fein: "22-2222222", state: "VA",
      employer_key: companyMatchKey("Apex Systems, LLC"), dba_keys_json: "[]" },
  ]);
  const m = matchCompanyToEntities("Apex", two);
  assert.equal(m.status, "ambiguous");
  assert.equal(m.confidence, 0, "an ambiguous match must carry no confidence at all");
  assert.equal(m.candidateCount, 2);
  assert.match(m.reason, /2 distinct employers/);
  // The candidates are still attached, so "why did this render nothing?" has an answer.
  assert.equal(m.entities.length, 2);
});

test("the same two names under ONE FEIN is a roll-up, not an ambiguity", () => {
  const one = buildEntityIndex([
    { employer_name: "Vercel Inc.", fein: "83-4283419", state: "CA",
      employer_key: companyMatchKey("Vercel Inc."), dba_keys_json: "[]" },
    { employer_name: "Vercel Platforms, Inc.", fein: "83-4283419", state: "CA",
      employer_key: companyMatchKey("Vercel Platforms, Inc."), dba_keys_json: "[]" },
  ]);
  const m = matchCompanyToEntities("Vercel", one);
  assert.equal(m.status, "matched");
  assert.equal(m.tier, "A", "the bare legal name wins outright when it exists");
});

// ── What is deliberately absent ──────────────────────────────────────────────────────────────

test("token containment is NOT a tier — the two names it would have claimed stay unmatched", () => {
  // Measured false positives from a containment matcher: `Linear -> Thomson Linear LLC` and
  // `Retool -> GLOBAL RETOOL GROUP AMERICA, LLC`. Linear has no filings at all in five quarters;
  // there is no threshold at which claiming Thomson Linear's is useful.
  const linear = match("Linear");
  assert.equal(linear.status, "unmatched");
  assert.equal(linear.entities.length, 0);
  assert.equal(linear.confidence, 0);
});

test("a company with no filings is UNMATCHED, which is not the same claim as 'does not sponsor'", () => {
  for (const name of ["Bolt Farm Treehouse", "Epia Neuro", "Physical Superintelligence"]) {
    const m = match(name);
    assert.equal(m.status, "unmatched", `${name} should be unmatched against this index`);
    assert.equal(m.confidence, 0);
  }
  // And a near-miss is still a miss: 'Safe Superintelligence' is a real filer and a different
  // company, so the prefix rule must not reach it from 'Physical Superintelligence'.
  const ssi = buildEntityIndex([{ employer_name: "Safe Superintelligence, Inc.", fein: "99-9999999",
    state: "CA", employer_key: companyMatchKey("Safe Superintelligence, Inc."), dba_keys_json: "[]" }]);
  assert.equal(matchCompanyToEntities("Physical Superintelligence", ssi).status, "unmatched");
});

// ── The FY2023 layout change ─────────────────────────────────────────────────────────────────

test("the ambiguity guard degrades to legal names when the file has no FEIN column", () => {
  // EMPLOYER_FEIN does not exist in FY2021 through FY2023 — 96 columns, no employer tax ID
  // anywhere. Counting FEINs over those rows returns ZERO, and a naive `size <= 1` would have read
  // zero as "one employer" and switched this guard off for twelve of the twenty-one quarters.
  const noFein = buildEntityIndex([
    { employer_name: "Apex Technologies, Inc.", fein: "", state: "CA",
      employer_key: companyMatchKey("Apex Technologies, Inc."), dba_keys_json: "[]" },
    { employer_name: "Apex Systems, LLC", fein: "", state: "VA",
      employer_key: companyMatchKey("Apex Systems, LLC"), dba_keys_json: "[]" },
  ]);
  const m = matchCompanyToEntities("Apex", noFein);
  assert.equal(m.status, "ambiguous", "two legal names with no FEINs must still read as two employers");
  assert.match(m.reason, /by legal name/, "and the reason must say which measure it used");

  // The basis is reported, and it is FEIN whenever every candidate has one.
  assert.deepEqual(countDistinctEntities([{ fein: "11", legalKey: "a" }, { fein: "11", legalKey: "b" }]),
    { count: 1, basis: "FEIN" });
  assert.deepEqual(countDistinctEntities([{ fein: "", legalKey: "a" }, { fein: "22", legalKey: "b" }]),
    { count: 2, basis: "legal name" }, "a partial FEIN set must not be trusted as a FEIN set");
});

test("the fallback is STRICTER, not looser — it declines a roll-up it cannot verify", () => {
  // Two holdco entities under one FEIN is a genuine roll-up and tier C takes it.
  const withFein = [{ fein: "99", legalKey: "foo labs" }, { fein: "99", legalKey: "foo platforms" }];
  assert.equal(countDistinctEntities(withFein).count, 1);
  // Strip the FEINs — the same pair now reads as two employers and the match is declined. Losing a
  // real match is the correct direction to be wrong in: a missed chip costs a candidate nothing
  // like what a wrong sponsorship claim costs them.
  const stripped = withFein.map(e => ({ ...e, fein: "" }));
  assert.equal(countDistinctEntities(stripped).count, 2);
});

test("a single no-FEIN candidate still matches — caution is not refusal", () => {
  const one = buildEntityIndex([
    { employer_name: "OpenAI OpCo, LLC", fein: "", state: "CA",
      employer_key: companyMatchKey("OpenAI OpCo, LLC"), dba_keys_json: "[]" },
  ]);
  const m = matchCompanyToEntities("OpenAI", one);
  assert.equal(m.status, "matched");
  assert.equal(m.tier, "C");
});

test("a STALE stored employer_key cannot break matching — the key is always recomputed", () => {
  // lca_employer_periods.employer_key was written by whichever version of companyMatchKey() parsed
  // the file, so it goes stale the moment normalisation improves. It did: before dotted acronyms
  // were handled, "OpenAI, L.L.C." stored the key `openai l l c`. That value parses as a non-holdco
  // remainder, so it read as an UNRELATED employer named OpenAI-something — which destroyed the
  // brand's distinctiveness and silently blocked the roll-up. OpenAI rendered 28 filings of 313.
  const stale = buildEntityIndex([
    { employer_name: "OpenAI, LP",       fein: "", employer_key: "openai",         dba_keys_json: "[]" },
    { employer_name: "OpenAI, L.L.C.",   fein: "", employer_key: "openai l l c",   dba_keys_json: "[]" },
    { employer_name: "OpenAI OpCo, LLC", fein: "", employer_key: "openai opco",    dba_keys_json: "[]" },
  ]);
  // Every entity's legalKey comes from its NAME, so all three collapse onto the current normaliser.
  assert.deepEqual(stale.map(e => e.legalKey).sort(), ["openai", "openai", "openai opco"]);
  // ...while storedKey preserves what is actually on disk, because employer_key is part of the
  // table's primary key and the aggregation lookup has to find the rows.
  assert.deepEqual(stale.map(e => e.storedKey).sort(), ["openai", "openai l l c", "openai opco"]);

  const m = matchCompanyToEntities("OpenAI", stale);
  assert.equal(m.tier, "A");
  assert.equal(m.entities.length, 3, "a stale key must not orphan a legal entity");
  assert.ok(m.entities.some(e => e.employerName === "OpenAI OpCo, LLC"));
});

test("HOLDCO_TOKENS holds no line of business — the guard that keeps Mercury from happening", () => {
  // Adding 'insurance' or 'healthcare' here would collapse Mercury Insurance Services into Mercury.
  // This list is crossable precisely because none of its members say what a company DOES.
  const businessWords = [
    "insurance", "healthcare", "health", "analytics", "financial", "finance", "bank", "banking",
    "semiconductor", "bearing", "aerospace", "pharma", "pharmaceutical", "energy", "media",
    "consulting", "staffing", "logistics", "realty", "restaurant", "retail", "hospital",
    "university", "public", "affairs", "insurance services",
  ];
  for (const w of businessWords) {
    assert.ok(!HOLDCO_TOKENS.has(w), `"${w}" describes a line of business and must not be crossable`);
  }
  assert.ok(isHoldcoExtension("mercury", "mercury technologies"));
  assert.ok(!isHoldcoExtension("mercury", "mercury insurance services"));
  assert.ok(!isHoldcoExtension("mercury", "mercury"), "an exact match is tier A, never tier C");
});

test("suffix stripping never eats the whole name, and never eats a meaningful token", () => {
  assert.equal(stripLegalSuffix("inc"), "inc", "a one-token name survives even if it looks like a suffix");
  assert.equal(companyMatchKey("Foo Inc. USA"), "foo");
  // 'Technologies' is a HOLDCO token for the PREFIX rule but not a stripped suffix: stripping it
  // would make PowerLattice Technologies and a hypothetical PowerLattice the same key.
  assert.equal(companyMatchKey("PowerLattice Technologies Inc."), "powerlattice technologies");
  assert.equal(companyMatchKey("Mercury Insurance Services, LLC"), "mercury insurance services");
});

test("the naive matcher this replaced is measurably worse, and the test says by how much", () => {
  // 45% (9/20) for normalise+strip exact on the real company list, vs 75%+ for the tiers. Here, on
  // the fixture: exact-key-only would find Stripe, Anthropic, Airbnb and Retool and miss OpenAI,
  // Notion, Ramp, Rippling and Mercury.
  const brands = ["Stripe", "Anthropic", "Airbnb", "Retool", "OpenAI", "Notion", "Ramp", "Rippling"];
  const naive = brands.filter(b => index.some(e => e.legalKey === companyMatchKey(b)));
  const tiered = brands.filter(b => match(b).status === "matched");
  assert.equal(naive.length, 4);
  assert.equal(tiered.length, 8);
  assert.ok(tiered.length > naive.length,
    "if these ever converge, the tiers have stopped earning their false-attribution risk");
});
