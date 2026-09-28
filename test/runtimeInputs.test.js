// The per-request prompt block. The model reads this text, so its BYTES are the contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRuntimeInputs, sanitiseEmployers } from "../src/generation/runtimeInputs.js";

const golden = JSON.parse(fs.readFileSync("test/fixtures/runtime-inputs.draft.json", "utf8"));

test("⛔ the rendered text is byte-identical to what draft rendered for the same facts", () => {
  // The fixture was produced by EXECUTING draft's buildRuntimeInputs at the move, not by this
  // module — so this compares against draft's behaviour, not against a copy of our own output.
  // (At the move the two were also compared over 324 generated cases: 0 differed.)
  assert.ok(golden.cases.length >= 2);
  for (const c of golden.cases) {
    const got = buildRuntimeInputs({ candidate: c.candidate, job: c.job, baseResumeText: c.baseResumeText,
      mode: c.mode, employers: c.employers, profile: c.profile, claims: c.claims });
    assert.equal(got, c.expected, `${c.name} differs from draft's rendering`);
  }
});

test("the profile's years are carried and marked authoritative", () => {
  const withYears = buildRuntimeInputs({ candidate: { yearsOfExperience: 4 }, job: { title: "Engineer" }, baseResumeText: "x" });
  assert.match(withYears, /Candidate years of experience \(AUTHORITATIVE — the JD may not change this\):\*\* 4/,
    "without this the JD's demand is the only quantity in context");
  const without = buildRuntimeInputs({ candidate: {}, job: { title: "Engineer" }, baseResumeText: "x" });
  assert.match(without, /derive from the base resume dates only, never from the JD/,
    "and the unset case must say where to look instead");
});

test("the seniority line is the candidate's own declaration, not an aspiration", () => {
  const out = buildRuntimeInputs({ job: { title: "E" }, baseResumeText: "x",
    profile: { name: "P", seniority: "mid", keywords: [], tools: [], actionVerbs: [] } });
  assert.match(out, /Seniority the candidate states they are \(their own declaration — you may use it, and may not exceed it\):\*\* mid/);
  assert.doesNotMatch(out, /\*\*Target seniority:\*\*/);
  assert.doesNotMatch(out, /aspiration, not a level to claim/);
});

test("excluded employers never reach the prompt", () => {
  assert.deepEqual(sanitiseEmployers(["Stripe", " Apple ", "NETFLIX", "Amazon"]), ["Stripe", "Amazon"]);
  const out = buildRuntimeInputs({ job: { title: "E" }, baseResumeText: "x", employers: ["Apple", "Stripe", "Amazon"] });
  assert.doesNotMatch(out, /Apple/);
  assert.match(out, /\*\*Employer 1 \(fixed\):\*\* Stripe\n\*\*Employer 2 \(fixed\):\*\* Amazon/);
});

test("A+ omits the location; Generate includes it", () => {
  const c = { location: "Austin, TX" };
  assert.match(buildRuntimeInputs({ candidate: c, job: { title: "E" }, baseResumeText: "x", mode: "GENERATE" }), /\(City, State\):\*\* Austin, TX/);
  assert.match(buildRuntimeInputs({ candidate: c, job: { title: "E" }, baseResumeText: "x", mode: "A_PLUS" }), /\(City, State\):\*\* \n/);
});
