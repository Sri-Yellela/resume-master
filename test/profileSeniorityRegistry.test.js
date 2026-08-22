// THE FIFTH LATENT DIVERGENCE, and it is not the one it looked like.
//
// The reported symptom: ProfilePanel.jsx had a Seniority <select> behind `{false && ...}` offering
// "junior" where the board's experience_level holds "entry". Dead code carrying its own copy of a
// vocabulary — the exact shape of the four divergences X1's registry was built to end.
//
// What the investigation found is that "junior" is NOT a typo for "entry", because these are two
// different dimensions over two different columns with two different kinds of consumer:
//
//   EXPERIENCE_LEVELS   scraped_jobs.experience_level    six values, consumed by SQL. A wrong value
//                                                        matches zero rows and empties a board.
//   PROFILE_SENIORITY   domain_profiles.seniority        four values, consumed by PROSE — its only
//                                                        reader is server.js's resume-generation
//                                                        prompt, "**Target seniority:** ${...}".
//
// Nothing joins those columns and no query compares them, so normalising the profile side onto the
// board's six would not be a de-duplication — it would change the text an LLM reads when it writes
// somebody's resume, and would require deciding what "intern" and "lead" mean to a resume. That is a
// product change, and it is not this one.
//
// So the resolution, stated: the dead <select> is DELETED rather than repointed (a control nobody can
// reach does not need correct options, it needs to not exist), and the vocabulary is registered and
// single-sourced where it is LIVE — DomainProfileWizard's options, its label lookup, and the enum in
// services/classifier.js's prompt, which were three more copies of the same four strings.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROFILE_SENIORITY, EXPERIENCE_LEVELS, values } from "../shared/jobFilterOptions.js";

const read = (p) => fs.readFileSync(p, "utf8");
const code = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const wizard = read("client/src/components/DomainProfileWizard.jsx");
const profilePanel = read("client/src/panels/ProfilePanel.jsx");
const classifier = read("services/classifier.js");

test("PROFILE_SENIORITY is registered, and is deliberately NOT the board's experience levels", () => {
  assert.deepEqual(values(PROFILE_SENIORITY), ["junior", "mid", "senior", "executive"]);
  assert.equal(PROFILE_SENIORITY.column, "domain_profiles.seniority");
  // Not a board filter: no query param, so GET /api/jobs' validator has nothing to validate here.
  assert.equal(PROFILE_SENIORITY.param, null);

  // The divergence is asserted rather than fixed, so that "these should be the same" is a decision
  // on record instead of a thing nobody noticed. If they are ever unified, this test is the one that
  // has to be deleted on purpose.
  assert.notDeepEqual(values(PROFILE_SENIORITY), values(EXPERIENCE_LEVELS));
  assert.ok(values(PROFILE_SENIORITY).includes("junior"));
  assert.ok(!values(EXPERIENCE_LEVELS).includes("junior"));
  assert.ok(values(EXPERIENCE_LEVELS).includes("entry"));
  assert.ok(!values(PROFILE_SENIORITY).includes("entry"));
});

test("the dead ProfilePanel select is gone, not repaired in place", () => {
  const src = code(profilePanel);
  assert.ok(!/<option value="junior">/.test(src), "the hardcoded junior option is back");
  assert.ok(!/<option value="executive">/.test(src));
  // And it was not replaced by a registry-driven select either — the whole control is gone.
  assert.ok(!/PROFILE_SENIORITY/.test(src),
    "ProfilePanel derives seniority options again — the control was supposed to be deleted");
});

test("the wizard's options and its label lookup both derive from the registry", () => {
  assert.match(wizard, /import \{ PROFILE_SENIORITY \} from "\.\.\/\.\.\/\.\.\/shared\/jobFilterOptions\.js";/);
  assert.match(wizard, /PROFILE_SENIORITY\.options\.map/);
  const src = code(wizard);
  // The two literal copies this file used to hold: the options array and a membership-plus-label map.
  assert.ok(!/\{ id: "junior"/.test(src), "the literal options array is back");
  assert.ok(!/\["junior","mid","senior","executive"\]/.test(src), "the literal membership list is back");
  assert.ok(!/junior: "Entry Level"/.test(src), "the literal label map is back");
});

test("the classifier asks the model for exactly the registry's values", () => {
  // The prompt is what WRITES this column, so an enum that drifts from the UI means the model can
  // return a value no control can display — the same two-sides-of-a-contract defect as the rest.
  assert.match(classifier, /import \{ PROFILE_SENIORITY, values \} from "\.\.\/shared\/jobFilterOptions\.js";/);
  assert.match(classifier, /const SENIORITY_ENUM = values\(PROFILE_SENIORITY\)\.join\(" \| "\)/);
  assert.match(classifier, /"seniority": "<one of: \$\{SENIORITY_ENUM\}>"/);
  const src = code(classifier);
  assert.ok(!/junior \| mid \| senior \| executive/.test(src), "the literal enum is back in the prompt");
});

test("no option-vocabulary copy of these four values survives outside the registry", () => {
  // Scoped deliberately. `"junior"` also appears in STOPWORD lists that strip seniority words out of
  // job titles (services/profileTitleFilter.js, services/searchQueryBuilder.js, server.js's keyword
  // tokeniser) — those are text processing, not option vocabularies, and folding them into a filter
  // registry would be wrong. What must not exist is another place that ENUMERATES the four as
  // choices, which is what these two shapes catch.
  const files = [
    "client/src/components/DomainProfileWizard.jsx",
    "client/src/panels/ProfilePanel.jsx",
    "client/src/panels/JobProfilesPanel.jsx",
    "services/classifier.js",
  ].filter((f) => fs.existsSync(f));

  for (const f of files) {
    const src = code(read(f));
    assert.ok(!/junior[\s\S]{0,40}mid[\s\S]{0,40}senior[\s\S]{0,40}executive/.test(src),
      `${f} enumerates the seniority vocabulary again — derive it from PROFILE_SENIORITY`);
    assert.ok(!/<option value="(junior|mid|senior|executive)"/.test(src),
      `${f} has a hardcoded seniority <option>`);
  }
});
