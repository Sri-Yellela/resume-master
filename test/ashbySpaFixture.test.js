// THE FIXTURE IS THE LIVE FORM'S SHAPE, NOT AN IMPRESSION OF IT.
//
// `/ashby` is a static replica with native controls, and AE1/AE2 came out of the gap between it and
// a real Ashby posting: the submit path had never fired against React-rendered markup with nameless
// required controls and UUID field names. `/ashby-spa` closes that, and the value of closing it
// depends entirely on the transcription being faithful — a fixture that is merely *similar* would
// give the same false confidence the old one did.
//
// So the measurement is written down here as data, and asserted against the fixture. The source is
// `scripts/ae1Diagnose.mjs` run against
// `jobs.ashbyhq.com/openai/0432731c-f229-476e-92b6-d53491e79096/application` on 2026-08-23, which
// reported 15 fields across 3 frames. `scripts/ae7SubmitOnRealShape.mjs` then drives mode:'full'
// against the fixture; this file is what stops the fixture drifting away from what it replicates.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const fake = fs.readFileSync("scripts/fakeAts.js", "utf8");
const spa  = fake.slice(fake.indexOf("function ashbySpaForm("), fake.indexOf("function ashbySpaThanks("));

// ── The measurement ──────────────────────────────────────────────────────────
// label, name, type, required — exactly as discoverFields reported them off the live page. `name: ""`
// is not an omission: those controls genuinely have no name attribute, which is the single most
// important thing this fixture reproduces.
const MEASURED = [
  { label: "",                                    name: "",                                     type: "file",      req: false },
  { label: "Legal Name",                          name: "_systemfield_name",                    type: "text",      req: true  },
  { label: "Preferred Name (if applicable)",      name: "09a328e0-8d57-4f88-86ab-688de1657b17", type: "text",      req: false },
  { label: "Email",                               name: "_systemfield_email",                   type: "text",      req: true  },
  { label: "Resume",                              name: "_systemfield_resume",                  type: "file",      req: true  },
  { label: "Phone Number",                        name: "20f8883c-d278-427c-9465-dc614f612e1f", type: "text",      req: true  },
  { label: "Start typing...",                     name: "",                                     type: "typeahead", req: false },
  { label: "Pick date...",                        name: "",                                     type: "text",      req: true  },
  { label: "Additional Information",              name: "f189fed2-624b-41a1-a76f-0c67a2611d1a", type: "text_area", req: false },
];
const EEOC_PREFIX = "41056061-f039-4b0f-8310-713131d11bda";
const EEOC_GROUPS = [
  { key: "gender",            firstOptionLabel: "Male" },
  { key: "race",              firstOptionLabel: "Hispanic or Latino" },
  { key: "veteran_status",    firstOptionLabel: "I identify as one or more of the classifications of protected veteran listed above" },
  { key: "disability_status", firstOptionLabel: "Yes, I have a disability, or have had one in the past" },
];
const ARBITRATION = "I acknowledge that I have opened, read, and understood the Arbitration " +
  "Agreement. I understand that by submitting my application, I am agreeing to be bound by the " +
  "terms of the Arbitration Agreement.";

test("every named control the live form had is declared, with its exact name", () => {
  for (const f of MEASURED) {
    if (!f.name) continue;
    assert.ok(spa.includes(`name="${f.name}"`),
      `the fixture is missing the live control named ${f.name} (${f.label})`);
  }
});

test("every label is the live form's, character for character", () => {
  // A near-miss label is the whole game: resolution here is label-driven, so "Phone" instead of
  // "Phone Number" would exercise a match the live form does not offer.
  for (const f of MEASURED) {
    if (!f.label) continue;
    assert.ok(spa.includes(f.label), `label not found verbatim: ${JSON.stringify(f.label)}`);
  }
});

test("THE THREE UUID FIELD NAMES — the reason a canonical packet fills nothing", () => {
  // AE2's packet was keyed on `email` / `first_name`. Against these it matches nothing, which is how
  // "Open & fill" managed to fill an empty form. A fixture with friendly names could never show it.
  for (const f of MEASURED.filter(x => /^[0-9a-f]{8}-/.test(x.name))) {
    assert.ok(spa.includes(f.name), `missing UUID-named control ${f.name}`);
  }
  assert.equal(MEASURED.filter(x => /^[0-9a-f]{8}-/.test(x.name)).length, 3);
});

test("THE NAMELESS REQUIRED CONTROL — its only identity is a placeholder", () => {
  // This is why the live run held, and why holding was correct. The date input must have NO name and
  // NO associated label in the default rendering; `placeholder` is getLabel()'s last resort.
  // Read the `dateField` ternary and check each branch separately: the DEFAULT branch is the live
  // case and must be nameless; the ?answerable=1 branch is allowed a name, because giving it one is
  // the entire difference the run script measures.
  const dateBlock = spa.slice(spa.indexOf("const dateField"), spa.indexOf("const autofillAria"));
  const [, answerableBranch, defaultBranch] = dateBlock.split(/\?\s*|\s*:\s*(?=`)/);
  assert.match(defaultBranch, /<input placeholder="Pick date\.\.\." required/,
    "the default date field must be the measured one");
  assert.ok(!/\bname=/.test(defaultBranch),
    "the measured branch must not carry a name, or case A stops being the live case");
  assert.ok(!/<label/.test(defaultBranch),
    "nor an associated label — placeholder is getLabel()'s last resort and that is the point");
  assert.match(answerableBranch, /name="start_date"/,
    "the answerable branch is what makes the submit click reachable");
  // And the typeahead, which is nameless too but NOT required — so it must not block.
  assert.match(spa, /<input placeholder="Start typing\.\.\." role="combobox" aria-autocomplete="list">/);
});

test("the checkboxes are named with their own question text, as measured", () => {
  // The literal is concatenated across three lines in the source, so the joined string is not
  // findable as one substring — assert on the fragments, and on the whole string only after
  // rebuilding it the way the module does.
  const rebuilt = (spa.match(/const ARBITRATION = ([\s\S]*?);\n/) || [, ""])[1]
    .split("+").map(s => s.trim().replace(/^'|'$/g, "")).join("");
  assert.equal(rebuilt, ARBITRATION, "the arbitration question text is not verbatim");
  assert.match(spa, /name="\$\{escapeHtml\(text\)\}"/,
    "the checkbox name must BE the label text — that is what the live form does");
  assert.ok(spa.includes("I confirm I have read the above."));
});

test("the four EEOC radio groups carry the live names and first-option labels", () => {
  // discoverFields dedupes a radio group to one field and labels it with getLabel() of the FIRST
  // radio, so the first option's text is load-bearing, not decoration.
  assert.ok(spa.includes(EEOC_PREFIX) || fake.includes(EEOC_PREFIX), "the EEOC name prefix is missing");
  for (const g of EEOC_GROUPS) {
    assert.ok(spa.includes(`_systemfield_eeoc_${g.key}`) || spa.includes(g.key),
      `EEOC group ${g.key} is missing`);
    assert.ok(spa.includes(g.firstOptionLabel),
      `EEOC group ${g.key} must lead with the option the live form leads with`);
  }
});

test("it renders CLIENT-SIDE, in two chunks", () => {
  // The other half of the reality. A static fixture lets a discovery pass that does not wait for a
  // readiness condition pass anyway — which is how the original blocker went unexplained.
  assert.match(spa, /var chunk1 =/);
  assert.match(spa, /var chunk2 =/);
  assert.match(spa, /setTimeout\(function\(\)\{[\s\S]*?chunk2/,
    "chunk 2 must land after chunk 1, so the control count climbs rather than jumping");
  // The nameless and unlabelled half arrives in the SECOND chunk, so a readiness check that fires on
  // "any field" misses exactly the fields that matter.
  const chunk2 = spa.slice(spa.indexOf("var chunk2 ="), spa.indexOf("setTimeout(function(){"));
  assert.ok(chunk2.includes("Pick date...") || chunk2.includes("dateField"),
    "the unanswerable required field must arrive in the late chunk");
});

test("submission is recorded the way the real one happens, and navigates", () => {
  // Real Ashby collects state in JS and sends it; a native form POST would drop every nameless
  // control, which is the one thing this fixture exists to make visible.
  assert.match(spa, /new FormData\(\)/);
  assert.match(spa, /'unnamed:' \+ lbl/,
    "a nameless control has to be recorded under the label a human reads, or it vanishes silently");
  assert.match(spa, /fetch\('\/_submit\/ashby-spa'/);
  assert.match(spa, /location\.assign\('\/ashby-spa\/thanks'\)/,
    "a real navigation is what earns `url_changed`; asserting it in the fixture would prove nothing");
  const thanks = fake.slice(fake.indexOf("function ashbySpaThanks("));
  assert.match(thanks, /Thank you for your application/,
    "and the confirmation text classifyFlowState actually matches on");
});

test("the three cases the run script needs are all reachable", () => {
  for (const [param, why] of [
    ["answerable",   "makes the date resolvable, so the submit click is reachable at all"],
    ["autofilltrap", "sends the resume to the wrong file input"],
    ["deadsubmit",   "a submit-shaped button that changes nothing (A1 finding N1)"],
  ]) {
    assert.ok(fake.includes(`'${param}'`), `?${param}=1 is not routed — ${why}`);
  }
  assert.match(fake, /if \(path === '\/ashby-spa'\)/);
  assert.match(fake, /if \(path === '\/ashby-spa\/thanks'\)/);
});

test("the DEAD submit really does nothing — or case C proves nothing", () => {
  // If the dead button still posted, `clicked_no_evidence` would be untestable and the most
  // dangerous outcome in the pipeline would have no fixture.
  assert.match(spa, /if \(DEAD\) return;/);
  assert.match(spa, /type="' \+ \(DEAD \? 'button' : 'submit'\) \+ '"/,
    "the dead variant must not be a submit button, or the browser navigates on its own");
});

test("the run script may only ever point at localhost", () => {
  // It runs mode:'full', which clicks submit. This guard is the reason that is safe to have written.
  const runner = fs.readFileSync("scripts/ae7SubmitOnRealShape.mjs", "utf8");
  assert.match(runner, /REFUSING: ATS_URL must be localhost/);
  assert.match(runner, /\^https\?:\\\/\\\/\(localhost\|127\\\.0\\\.0\\\.1\)/);
  assert.match(runner, /mode: "full"/);
  // And it asserts on the RECORD, not on the status the pipeline gave itself.
  assert.match(runner, /_submissions/);
  assert.match(runner, /rec\.files\?\._systemfield_resume\?\.size === RESUME_SIZE/);
});
