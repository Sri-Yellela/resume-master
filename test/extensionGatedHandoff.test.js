// TASK G2 — the extension handoff.
//
// The real-run half is scripts/g2ExtensionHandoff.mjs: real Chrome, real activeTab grant taken by a
// real keypress, real file input. What is here is what that run cannot guard cheaply — the manifest
// invariants that would quietly undo the design's security property, and the matcher's refusal to
// place an eligibility answer it is not certain about.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { matchAnswersToFields } from "../extension/gated-handoff.js";

const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));

// ── Manifest invariants ──────────────────────────────────────────────────────
// Each of these is a line that, if it changed, would leave every other test passing while the
// design's actual guarantee was gone.

test("the extension requests no host permission for any portal origin", () => {
  // The whole security property: access to a gated portal is granted per tab, per gesture, by the
  // user. A host permission for one would replace that with a standing grant, and would be a Web
  // Store review problem besides.
  for (const h of manifest.host_permissions || []) {
    assert.ok(!h.includes("<all_urls>"), "<all_urls> must never appear");
    assert.ok(!/myworkdayjobs|amazon\.jobs|metacareers|greenhouse\.io\/\*$/.test(h) || h.startsWith("https://*.greenhouse.io/"),
      `${h} looks like a portal host permission`);
  }
  assert.ok(!(manifest.host_permissions || []).some(h => /localhost|127\.0\.0\.1/.test(h)),
    "a dev host permission must never ship");
});

test("externally_connectable stays absent — the extension pulls, nothing pushes in", () => {
  assert.ok(!("externally_connectable" in manifest),
    "adding this would let a website message the extension; the design inverts that deliberately");
});

test("permissions are still exactly activeTab, scripting and storage", () => {
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage"]);
});

test("the gated handoff is invoked by a user gesture, which is what grants activeTab", () => {
  const cmd = manifest.commands?.["fill-gated-application"];
  assert.ok(cmd, "the command must exist");
  assert.ok(cmd.suggested_key?.default, "it must have a default binding");
  // Ctrl+Shift+G is Chrome's own find-previous, so Chrome silently refuses to bind it and the
  // command exists with no key at all — which looks identical to a working build until invoked.
  assert.notEqual(cmd.suggested_key.default, "Ctrl+Shift+G",
    "Chrome reserves Ctrl+Shift+G and will leave the command unbound");
});

test("no bundled extension script points at localhost", () => {
  for (const f of fs.readdirSync("extension").filter(n => n.endsWith(".js"))) {
    const text = fs.readFileSync(`extension/${f}`, "utf8");
    for (const line of text.split("\n")) {
      assert.ok(
        !/^\s*(?:const|let|var)\s+\w+\s*=\s*["']https?:\/\/(localhost|127\.)/.test(line),
        `${f} has the dev switch flipped: ${line.trim().slice(0, 80)}`,
      );
    }
  }
});

test("the handoff never submits", () => {
  const src = fs.readFileSync("extension/gated-handoff.js", "utf8");
  assert.doesNotMatch(src, /\.submit\s*\(/, "the last action is the candidate's, always");
  assert.doesNotMatch(src, /requestSubmit/);
  // A click on a submit control would be the same thing by another route.
  assert.doesNotMatch(src, /type=["']submit["']\][^)]*\)\s*\.click/);
});

// ── Matching ─────────────────────────────────────────────────────────────────

const field = (over) => ({
  index: 0, name: null, id: null, type: "text", label: "", required: false, options: null, ...over,
});

test("an answer matches its control by name", () => {
  const { plan } = matchAnswersToFields(
    [{ name: "email", field: "Email", value: "a@b.com", provenance: "field_map_exact" }],
    [field({ index: 0, name: "email", label: "Email" })],
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].value, "a@b.com");
  assert.equal(plan[0].matchedBy, "exact");
});

test("a control is never filled twice", () => {
  const { plan, unmatched } = matchAnswersToFields(
    [
      { name: "full_name", field: "Full name", value: "Ada Lovelace", provenance: "field_map_exact" },
      { name: "name", field: "Full name", value: "Ada", provenance: "label_fuzzy" },
    ],
    [field({ index: 0, name: "full_name", label: "Full name" })],
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].value, "Ada Lovelace");
  assert.equal(unmatched.length, 1);
});

test("AN ELIGIBILITY ANSWER IS NEVER PLACED BY A LABEL MATCH", () => {
  // The A1 inversion trap, and the reason this rule exists. "Do you require sponsorship?" and "Are
  // you authorized to work without sponsorship?" share almost every word and are opposite questions.
  // A label match that got it wrong would be a false attestation to an employer, not a filling bug —
  // so an eligibility answer is placed on an exact control match or not at all.
  const { plan, unmatched } = matchAnswersToFields(
    [{
      name: "requires_sponsorship", field: "Do you now or in the future require sponsorship for work authorization?",
      value: "No", provenance: "field_map_exact", eligibility: true,
    }],
    [field({ index: 0, name: "authorized_no_sponsorship", label: "I am authorized to work without sponsorship" })],
  );
  assert.equal(plan.length, 0, "nothing may be placed");
  assert.equal(unmatched[0].reason, "eligibility_requires_exact_match");
  assert.equal(unmatched[0].eligibility, true);
});

test("an eligibility answer IS placed when the control matches exactly", () => {
  const { plan, unmatched } = matchAnswersToFields(
    [{ name: "requires_sponsorship", field: "Sponsorship?", value: "No", provenance: "field_map_exact", eligibility: true }],
    [field({ index: 0, name: "requires_sponsorship", label: "Do you require sponsorship?" })],
  );
  assert.equal(unmatched.length, 0);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].matchedBy, "exact");
  assert.equal(plan[0].eligibility, true);
});

test("a non-eligibility answer may match on a normalised label", () => {
  const { plan } = matchAnswersToFields(
    [{ name: "current_company", field: "Current company", value: "Acme", provenance: "field_map_exact" }],
    [field({ index: 0, name: "org", label: "Current Company" })],
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].matchedBy, "label");
});

test("an answer with no value is not a fill instruction", () => {
  const { plan, unmatched } = matchAnswersToFields(
    [{ name: "phone", field: "Phone", value: "", provenance: null }],
    [field({ index: 0, name: "phone", label: "Phone" })],
  );
  assert.equal(plan.length, 0);
  assert.equal(unmatched.length, 0, "an empty answer is not an unmatched one either");
});

test("the plan carries provenance through, so G3's overlay has something to render", () => {
  const { plan } = matchAnswersToFields(
    [{ name: "email", field: "Email", value: "a@b.com", provenance: "handler_exact", confidence: 1.0 }],
    [field({ index: 0, name: "email", label: "Email" })],
  );
  assert.equal(plan[0].provenance, "handler_exact");
  assert.equal(plan[0].confidence, 1.0);
});

// ── Build ────────────────────────────────────────────────────────────────────

test("the bundler follows ES imports, so a module the service worker needs cannot be dropped", () => {
  // background.js is "type": "module". Before this, collectRequiredFiles looked only at the manifest
  // and HTML entry points, so `import './gated-handoff.js'` was invisible to it and the zip would
  // have shipped a service worker whose first import 404s — a bundle that validates and is dead on
  // load, discovered only after a Web Store review had been spent on it.
  const build = fs.readFileSync("scripts/buildExtension.mjs", "utf8");
  assert.match(build, /import\|export/, "the collector must scan for import/export specifiers");
  assert.match(build, /startsWith\('\.\/'\)/, "only relative specifiers are ours to bundle");
});
