import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROFILE_KEY_TO_HANDLER, matchesWholeToken, buildAnswers } from "../services/applyAutomation.js";
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

test("website / github / linkedin labels are not cross-wired", () => {
  // greenhouse and generic both mapped "Website" -> github_url, so a field labelled "Website"
  // received the candidate's GitHub URL: wrong information submitted to an employer. These three
  // are the confusable set, and a mis-mapping between them is invisible at a glance because the
  // value is a plausible URL either way.
  const EXPECT = { website: "website_url", github: "github_url", linkedin: "linkedin_url", portfolio: "portfolio_url" };
  for (const p of PROVIDERS) {
    for (const [label, key] of Object.entries(getPlatformLabelMap(p))) {
      for (const [token, correct] of Object.entries(EXPECT)) {
        if (!new RegExp(`\\b${token}\\b`, "i").test(label)) continue;
        assert.equal(key, correct,
          `${p}: label ${JSON.stringify(label)} mentions ${token} but maps to ${key}`);
      }
    }
  }
});

test("a Website field takes the website, and is left blank rather than given the GitHub URL", () => {
  const websiteField = [{
    field_id: "w", name: "w", type: "text", label: "Website", is_required: false,
    options: [], handler_type: null, handler_source: null, current_value: "",
  }];
  // Resolves via the label map -> handler 'website' -> the website value.
  const [a] = buildAnswers(websiteField, {
    field_map: { website: "https://ada.dev", github: "https://github.com/ada" },
  });
  assert.equal(a.value, "https://ada.dev");

  // With no website on file the field must go unanswered, NOT receive the GitHub URL. server.js's
  // field_map.website used to fall back to github then linkedin, which fired precisely when there
  // was nothing true to say.
  const answers = buildAnswers(websiteField, {
    field_map: { github: "https://github.com/ada", linkedin: "https://linkedin.com/in/ada" },
  });
  assert.equal(answers.filter(x => !x.skipped).length, 0,
    "an empty website must stay empty rather than borrowing another profile URL");
});

test("buildAutofillPayload does not substitute github/linkedin for a missing website", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.doesNotMatch(server, /website:\s*normaliseUrl\([^)]*\)\s*\|\|\s*githubUrl/,
    "field_map.website must not fall back to the GitHub URL");
  assert.match(server, /website:normaliseUrl\(profile\?\.website_url\|\|""\),/);
  // handler_map was always strict; the two must agree, since handler_map is consulted first and the
  // disagreement was only observable when website_url was empty.
  assert.match(server, /'website':\s*normaliseUrl\(profile\?\.website_url \|\| ''\)/);
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

test("the submit scan is frame-aware but scoped to frames we actually filled", () => {
  // ENABLED (was deliberately withheld). Main-frame-only scanning made submission arbitrary on
  // greenhouse, which embeds its form in an iframe on some boards and not others: identical
  // applications either went out or silently stopped at no_submit_button depending on the embed.
  //
  // The scope restriction is the safety property. Iterating EVERY frame would let a submit-shaped
  // button in an untouched third-party frame (an ad, a captcha, an analytics widget) be clicked;
  // main-frame-only used to prevent that by accident, so it is now prevented on purpose.
  assert.match(automationSrc, /const submitCandidates = \[page\.mainFrame\(\), \.\.\.touchedFrames\]/,
    "candidates must be the main frame plus frames that received an approved answer");
  assert.match(automationSrc, /if \(approved\.length\) touched\.add\(frame\);/,
    "a frame only becomes a candidate once we have filled something in it");
  assert.doesNotMatch(automationSrc, /for \(const ctx of frameList\(page\)\) \{\s*if \(clicked\)/,
    "the submit scan must not walk every frame indiscriminately");
});

test("submission evidence is gathered where the submission happened", () => {
  // An iframe-hosted form leaves the main document's URL and body untouched, so main-frame-only
  // checks would report clicked_no_evidence for a submission that genuinely succeeded — N1's
  // guarantee inverted into a false negative, which is how a real submission gets retried.
  assert.match(automationSrc, /classifyFlowState\(clickedFrame, null\)/,
    "the submitting frame must be classified too");
  assert.match(automationSrc, /frame_confirmation_page/);
  assert.match(automationSrc, /frame_url_changed/);
  // And the claim stays evidence-based: no evidence still means not submitted.
  assert.match(automationSrc, /submitEvidence = "clicked_no_evidence"/);
  assert.match(automationSrc, /submitReasonCode = "submit_unverified"/);
  // Which frame submitted is recorded, so a cross-frame claim is checkable after the fact.
  assert.match(automationSrc, /\|frame/);
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
