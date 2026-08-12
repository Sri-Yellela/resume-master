import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROFILE_KEY_TO_HANDLER, matchesWholeToken } from "../services/applyAutomation.js";
import { getPlatformLabelMap, detectPlatformFromUrl, usesIframe } from "../services/platformDetector.js";

const detectorSrc   = fs.readFileSync("services/platformDetector.js", "utf8");
const automationSrc = fs.readFileSync("services/applyAutomation.js", "utf8");
const PROVIDERS = [...detectorSrc.matchAll(/^  ([a-z_]+): \{/gm)].map(m => m[1]);

// Non-greenhouse coverage groundwork: the label maps are the resolution fallback for when a
// control's attributes do not identify it, and an audit across all 12 providers found them
// substantially broken. See docs/auto-apply-non-greenhouse.md.

// ── The template-escape bug class ────────────────────────────────────────────

/** The value a `const NAME = \`…\`` template literal actually holds — escapes processed. */
function emittedScript(name) {
  const open = `const ${name} = \``;
  const i = automationSrc.indexOf(open);
  assert.ok(i > 0, `${name} must exist`);
  const raw = automationSrc.slice(i + open.length, automationSrc.indexOf("`;", i));
  return eval("`" + raw + "`"); // eslint-disable-line no-eval -- reproduces the parser exactly
}

test("in-page scripts contain no regex whose backslash was eaten by the template literal", () => {
  // THE BUG: inside a template literal, `\s` collapses to a bare `s`. A needle normaliser written
  // as .replace(/\s+/g, ' ') shipped as .replace(/s+/g, ' ') — replacing runs of the LETTER s. So
  // "First Name" normalised to "fir t name" and never matched, and every multi-word label-map key
  // containing an s silently failed, letting a shorter key like "Name" win instead. It was invisible
  // because the attribute path covered the common fields.
  for (const name of ["DISCOVER_FN_SRC", "FILL_FN_SRC", "APPLY_FN_SRC"]) {
    // Comments stripped first — for the fourth time this session, a comment explaining the fix
    // contained the very pattern it forbids, and its own backslash collapsed identically.
    const emitted = emittedScript(name).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(emitted, /\/s\+\/[gimuy]*/,
      `${name}: a whitespace class in the emitted source lost its backslash`);
  }
});

test("the emitted tokenMatch handles multi-word keys, including ones containing 's'", () => {
  const emitted = emittedScript("DISCOVER_FN_SRC");
  const k = emitted.indexOf("function tokenMatch");
  const fn = emitted.slice(k, emitted.indexOf("\n  }", k) + 4);
  const tokenMatch = new Function(`${fn}; return tokenMatch;`)();

  for (const key of ["First Name", "Last Name", "Years of Experience", "Postal Code",
                     "Sponsorship", "Security Clearance", "Address Line 1", "Email Address"]) {
    assert.equal(tokenMatch(key, key), true, `${JSON.stringify(key)} must match itself`);
  }
  // And it must still be a WHOLE-token match, not a substring.
  assert.equal(tokenMatch("Username", "Name"), false);
  assert.equal(tokenMatch("Legal Name", "Name"), true);

  // The in-page copy and the Node twin must agree, or the two resolution paths diverge.
  for (const [hay, needle] of [["First Name", "First Name"], ["Username", "Name"],
                               ["Legal Name", "Name"], ["Years of Experience", "Years of Experience"]]) {
    assert.equal(tokenMatch(hay, needle), matchesWholeToken(hay, needle),
      `in-page and Node token matching disagree on ${JSON.stringify([hay, needle])}`);
  }
});

// ── The maps themselves ──────────────────────────────────────────────────────

test("no label map points at a profile key that has no handler", () => {
  // A labelMap value must be a key of PROFILE_KEY_TO_HANDLER or resolveHandler silently skips it.
  // Nine such mappings existed: `years_experience` (the real key is years_of_experience),
  // `clearance_level` and `visa_type` — the last two referenced by ELIGIBILITY_HANDLERS, which
  // already listed 'clearance' and 'visa' as valid handlers that nothing produced.
  const dead = [];
  for (const p of PROVIDERS) {
    for (const [label, key] of Object.entries(getPlatformLabelMap(p))) {
      if (!PROFILE_KEY_TO_HANDLER[key]) dead.push(`${p}:"${label}"->${key}`);
    }
  }
  assert.deepEqual(dead, [], "dead label mappings resolve nothing and fail silently");
});

test("a provider label map EXTENDS generic rather than shadowing it", () => {
  const generic = getPlatformLabelMap("generic");
  assert.ok(Object.keys(generic).length >= 20, "generic is the base and must be substantial");

  for (const p of PROVIDERS) {
    const map = getPlatformLabelMap(p);
    for (const label of Object.keys(generic)) {
      assert.ok(label in map, `${p} lost generic's "${label}" — a provider map must not shadow`);
    }
  }
  // Provider-specific values win on a collision, and provider keys are tried first.
  const lever = getPlatformLabelMap("lever");
  assert.equal(lever["Full name"], "full_name", "provider-only entries survive");
  assert.equal(Object.keys(lever)[0], "Full name", "provider entries are tried before generic ones");
});

test("every provider can resolve a plain \"Name\" label", () => {
  // NONE of the 11 non-generic maps had one. On ashby the only name control is labelled exactly
  // "Name", and on greenhouse it is "Legal Name" — so the candidate's own name resolved by a guess
  // or not at all, purely because the provider map replaced generic instead of extending it.
  for (const p of PROVIDERS) {
    const map = getPlatformLabelMap(p);
    const nameKey = Object.keys(map).find(k => k.toLowerCase() === "name");
    assert.ok(nameKey, `${p} cannot resolve a field labelled "Name"`);
    assert.equal(map[nameKey], "full_name");
  }
});

test("first/last name still beat the plain Name entry", () => {
  // Ordering matters: "First Name" must be tried before "Name", or both name halves collapse onto
  // full_name. This is what the live iframe run caught — First Name and Last Name both received
  // "Ada Lovelace".
  for (const p of PROVIDERS) {
    const keys = Object.keys(getPlatformLabelMap(p));
    const first = keys.findIndex(k => k.toLowerCase() === "first name");
    const plain = keys.findIndex(k => k.toLowerCase() === "name");
    if (first === -1) continue;
    assert.ok(first < plain, `${p}: "First Name" must be checked before "Name" (got ${first} vs ${plain})`);
  }
});

test("clearance and visa handlers are reachable, matching what the guards already expect", () => {
  assert.equal(PROFILE_KEY_TO_HANDLER.clearance_level, "clearance");
  assert.equal(PROFILE_KEY_TO_HANDLER.visa_type, "visa");
  assert.equal(PROFILE_KEY_TO_HANDLER.years_experience, "years-experience");
  assert.equal(PROFILE_KEY_TO_HANDLER.years_of_experience, "years-experience");
});

// ── Frame awareness (the non-greenhouse blocker) ─────────────────────────────

test("file upload and typeahead fill are frame-aware", () => {
  // workday, icims and taleo host the whole application in an iframe. A main-frame-only scan found
  // no file input, so with A3's gate checking required file fields every run held on "Resume".
  assert.match(automationSrc, /for \(const ctx of frameList\(page\)\)/,
    "handleTypedFileUploads must walk frames");
  assert.match(automationSrc, /await uploadIntoContext\(ctx, resumePath, coverLetterPath, resumeUploaded, coverUploaded\)/,
    "and thread the uploaded flags so one resume is not attached twice");
  assert.match(automationSrc, /await applyTypeaheadAnswer\(frame, a\)/,
    "typeahead must be filled in the frame that owns the control, not the main document");
});

test("submission across frames is deliberately NOT enabled", () => {
  // Left main-frame-only on purpose: making the submit scan frame-aware would change behaviour on
  // greenhouse, which embeds its form in an iframe on some boards, and that is a live full-auto
  // provider. It belongs with the provider-allowlist decision, gated on A5.
  const i = automationSrc.indexOf("const SUBMIT_RE =");
  const block = automationSrc.slice(i, i + 600);
  assert.match(block, /await page\.\$\$\("button,input\[type='submit'\]"\)/,
    "the submit scan is still main-frame-only; changing it is a gated decision");
});

// ── Scope: the v1 allowlist is unchanged ─────────────────────────────────────

test("the full-auto provider allowlist is unchanged — coverage is gated on A5", () => {
  const applyRoute = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(applyRoute, /V1_AUTO_PROVIDERS = new Set\(\["greenhouse", "lever", "ashby"\]\)/,
    "enabling a new provider for full-auto requires a real greenhouse application first (A5)");
  // Providers outside it must still route to review rather than auto-submitting.
  assert.match(applyRoute, /provider_review_only/);
  const HOSTS = { workday: "myworkdayjobs.com", icims: "icims.com", taleo: "taleo.net" };
  for (const [p, host] of Object.entries(HOSTS)) {
    assert.equal(usesIframe(p), true, `${p} is iframe-hosted, so it needs frame-aware submit first`);
    assert.equal(detectPlatformFromUrl(`https://x.${host}/job/1`), p);
  }
});
