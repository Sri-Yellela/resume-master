// The half that keeps cost coverage from rotting.
//
// An audit found 4 of 14 model call sites recorded usage. The other 10 — including one call PER
// JOB across hundreds of enrichment rows, and three UNAUTHENTICATED standalone endpoints — spent
// real money and logged nothing, so the admin cost panel showed a confident total that omitted
// most of the traffic. A wrapper alone would have rotted the same way the hardcoded model IDs
// did: the fix was applied once, and the next call site added went straight back to the raw SDK.
//
// This guard fails the build when that happens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WRAPPER = "services/modelCall.js";
// The ONE module allowed to speak a non-Anthropic provider's wire protocol. Groq and Gemini have
// no SDK here on purpose — they are reached with `fetch`, so the shape that would bypass tracking
// is an HTTP call to a provider host, not an SDK method. That shape is therefore scanned for too,
// and this is the single file exempt from it.
const TRANSPORT = "services/providerTransport.js";
// This file quotes the forbidden calls inside its own failure message and its injection fixtures,
// so it must not scan itself. Every OTHER test file is still scanned — a test that calls a
// provider directly is a real untracked call site, not an exemption.
const SELF = "test/modelCallGuard.test.js";
// The catalog holds each provider's base URL as DATA. It is exempt from the hostname scan for that
// reason and for no other — and the exemption is paid for by the test at the bottom of this file,
// which asserts the catalog contains no network call of any kind. Exempting a file that could make
// a call is how a guard acquires its first hole.
const CATALOG = "shared/modelProviders.js";
const ALLOWED = new Set([WRAPPER, TRANSPORT, CATALOG, SELF]);

// ── THE SCAN ────────────────────────────────────────────────────────────────────────────────────
//
// DEFINED ONCE, and used both by the guard below and by the injection test beneath it. It was
// previously written out twice — once as the live scan, once as a copy inside the test that checks
// the scan's coverage — which means the copy could agree with itself while the live one narrowed.
//
// WHY THIS IS BROADER THAN "anthropic.messages.create". The cost-tracking guarantee is that no
// model call happens without a usage_events row. A guard that only knows Anthropic's SDK shape
// enforces that guarantee only for Anthropic: the moment a call site reaches for Groq's
// OpenAI-compatible endpoint or Gemini's `generateContent`, it bypasses the wrapper entirely and
// the suite stays green. That is the same defect the batch shape already demonstrated — the old
// /\.messages\.create\s*\(/ could not see `messages.batches.create` — one provider over.
const PROVIDER_CALL_SHAPES = [
  // Anthropic SDK, including the Batch API. ".messages.create" is not a substring of
  // ".messages.batches.create", which is why the optional group is here and not a looser regex.
  { name: "anthropic sdk", re: /\.messages\.(batches\.)?(create|results)\s*\(/ },
  // OpenAI-compatible SDKs — this is Groq's entire interface, and SambaNova's, and any
  // `new OpenAI({ baseURL })` swap. Covers both the chat and the responses surfaces.
  { name: "openai-compatible sdk", re: /\.(chat\.)?completions\.create\s*\(/ },
  { name: "openai responses sdk", re: /\.responses\.create\s*\(/ },
  // Google GenAI, both the streaming and non-streaming entry points.
  { name: "google genai sdk", re: /\.generateContent(Stream)?\s*\(/ },
  // RAW HTTP TO A PROVIDER HOST. The one that actually matters here: this repo adds no SDK for
  // Groq or Gemini, so an untracked call would not look like an SDK method at all — it would look
  // like a fetch. Hostnames rather than paths, because the path varies per provider.
  {
    name: "direct http to a provider",
    re: /(api\.anthropic\.com|api\.groq\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.sambanova\.ai|api\.cohere\.(ai|com)|api\.mistral\.ai|api\.together\.xyz)/,
  },
];

/** True if `code` contains any provider call shape; returns the shape that matched. */
function providerCallIn(code) {
  return PROVIDER_CALL_SHAPES.find(s => s.re.test(code)) || null;
}

/** Every tracked .js/.jsx file, excluding deps, build output and the wrapper itself. */
function sourceFiles(dir = ".", acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.git|dist|build|coverage|\.cinematic)$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(js|mjs|jsx)$/.test(entry.name)) acc.push(full.split(path.sep).join("/"));
  }
  return acc;
}

/**
 * The live scan, factored out so the INJECTION test below drives this exact function rather than a
 * re-implementation of it. The previous coverage test asserted against a private copy of the
 * regex, which could have agreed with itself while the real guard narrowed.
 */
function scanForProviderCalls(files) {
  const offenders = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // Ignore comments — several files legitimately explain why they no longer call it directly.
      //
      // `[^:]` IS LOAD-BEARING AND WAS FOUND BY THE INJECTION TEST BELOW. A bare /\/\/.*$/ strips
      // from the first `//` on the line, and `https://api.groq.com/...` contains one — so every
      // direct-HTTP provider call was being erased as a "comment" before the scan ever saw it,
      // and the shape that matters most here (no Groq/Gemini SDK is installed, so a bypass IS a
      // fetch) was silently unguardable. Requiring the character before `//` not to be a colon
      // keeps URLs intact while still stripping real comments.
      const code = line.replace(/(^|[^:])\/\/.*$/, "$1").replace(/\/\*.*?\*\//g, "");
      const shape = providerCallIn(code);
      if (shape) offenders.push(`${file}:${i + 1}  (${shape.name})`);
    });
  }
  return offenders;
}

test("no model call by ANY provider outside the wrapper", () => {
  const offenders = scanForProviderCalls(sourceFiles());
  assert.deepEqual(
    offenders, [],
    "These call a model without recording what it cost:\n" +
    offenders.map(o => `  ${o}`).join("\n") +
    `\n\nFIX: import { callModel } from '${WRAPPER}' (adjust the relative path) and replace\n` +
    "      await anthropic.messages.create({ model, ...params })\n" +
    "  with\n" +
    "      await callModel({ anthropic, db, purpose: 'some_feature', userId, model, ...params })\n" +
    "  `purpose` is a stable snake_case feature name and is REQUIRED — it is how spend is\n" +
    "  attributed to a feature rather than only to a model. For background work with no user in\n" +
    "  scope, pass userId: SYSTEM_USER_ID from the same module.\n" +
    "  Do NOT add an exemption here: an untracked call site is exactly the defect this guards."
  );
});

// ── THE GUARD IS SEEN TO FAIL ───────────────────────────────────────────────────────────────────
//
// A guard nobody has watched fail is not evidence. The scan above is a regex over source text, so
// its COVERAGE is a property of the regex and of the file walk that feeds it — and the previous
// version of this test checked only a private copy of the regex, never the walk, and never the
// live function. It therefore could not have caught the case that motivated it: a scan that agrees
// with its own copy while the real one narrows.
//
// So: write a real violating file into the real tree, run the REAL scan, and require it to be
// caught. One case per provider shape, because a provider added later is exactly when this stops
// holding — a Groq call bypasses an Anthropic-only guard completely, with the suite green.
const INJECT_DIR = "test/__guard_injection__";

/** Writes `line` into a real .js file inside the scanned tree and returns the live scan's verdict. */
function injectAndScan(line) {
  const file = path.join(INJECT_DIR, "violation.js");
  fs.mkdirSync(INJECT_DIR, { recursive: true });
  fs.writeFileSync(file, `export async function untracked(client) {\n  ${line}\n}\n`);
  try {
    const files = sourceFiles();
    const normalized = file.split(path.sep).join("/");
    assert.ok(files.includes(normalized), `the file WALK did not reach ${normalized}`);
    return scanForProviderCalls(files).filter(o => o.startsWith(normalized));
  } finally {
    fs.rmSync(INJECT_DIR, { recursive: true, force: true });
  }
}

test("an injected call is CAUGHT, for every provider shape", () => {
  // One per shape in PROVIDER_CALL_SHAPES, plus the Anthropic variants that have bitten before.
  const violations = [
    ["anthropic sdk",              "const m = await client.messages.create({ model });"],
    ["anthropic sdk",              "const m = await client.beta.messages.create({ model });"],
    ["anthropic sdk",              "const b = await client.messages.batches.create({ requests });"],
    ["anthropic sdk",              "for await (const r of client.messages.batches.results(id)) {}"],
    // Groq is OpenAI-compatible, so this is the literal shape a base-URL swap produces.
    ["openai-compatible sdk",      "const m = await groq.chat.completions.create({ model });"],
    ["openai-compatible sdk",      "const m = await client.completions.create({ model });"],
    ["openai responses sdk",       "const m = await client.responses.create({ model });"],
    ["google genai sdk",           "const m = await model.generateContent(prompt);"],
    ["google genai sdk",           "const s = await client.models.generateContentStream(req);"],
    // The one that matters most here: no Groq/Gemini SDK is installed, so a real bypass would be
    // a bare fetch, which no SDK-shaped regex can see.
    ["direct http to a provider",  "const r = await fetch('https://api.groq.com/openai/v1/chat/completions', init);"],
    ["direct http to a provider",  "const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`);"],
    ["direct http to a provider",  "const r = await fetch('https://api.anthropic.com/v1/messages', init);"],
  ];
  for (const [shape, line] of violations) {
    const caught = injectAndScan(line);
    assert.equal(caught.length, 1, `the guard did NOT catch an untracked call site: ${line}`);
    assert.match(caught[0], new RegExp(shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `caught, but attributed to the wrong shape: ${caught[0]}`);
  }
});

test("the scan does not fire on unrelated code", () => {
  // Must not false-positive, or the guard becomes noise and grows exemptions — and an exemption
  // list is how the original four-of-fourteen coverage gap was lived with.
  const mustIgnore = [
    "const messages = buildMessages();",
    "db.prepare('SELECT * FROM messages').all();",
    "await client.messages.countTokens({ messages });",
    "batches.push(job);",
    "const completions = [];",
    "const html = await fetch('https://boards.greenhouse.io/acme');",
  ];
  for (const line of mustIgnore) {
    assert.deepEqual(injectAndScan(line), [], `the scan false-positives on: ${line}`);
  }
});

test("the wrapper is the only thing importing trackApiCall", () => {
  // Two paths to the same table is how the four 'tracked' sites drifted from the other ten.
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file === WRAPPER || file.startsWith("test/")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/import\s*\{[^}]*\btrackApiCall\b[^}]*\}\s*from/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    "trackApiCall must be called only by services/modelCall.js so there is ONE logged path.\n" +
    "Route the call through callModel instead of tracking it separately.");
});

test("every callModel invocation passes a purpose", () => {
  // A call recorded without a purpose is spend that cannot be attributed to a feature.
  const missing = [];
  for (const file of sourceFiles()) {
    if (file === WRAPPER || file.startsWith("test/")) continue;
    const src = fs.readFileSync(file, "utf8");
    // Each call's argument object, up to the model line — purpose is written adjacent to it.
    // Inspect the whole argument window, not just the text before `model`: key order is a style
    // choice, and a site writing `{ anthropic, db, model, purpose }` is perfectly correct.
    for (const m of src.matchAll(/callModel\(\{([\s\S]{0,600})/g)) {
      // Accept property shorthand (`{ purpose }`) as well as `purpose: '…'` — otherwise a
      // perfectly good call site that forwards a `purpose` variable fails this guard.
      if (!/\bpurpose\s*[:,}]/.test(m[1])) {
        missing.push(`${file}: callModel({...}) near "${m[1].trim().slice(0, 60)}"`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "callModel requires a `purpose`:\n" + missing.map(x => `  ${x}`).join("\n"));
});

// ── THE PRICE OF THE CATALOG'S EXEMPTION ────────────────────────────────────────────────────────
//
// shared/modelProviders.js is exempt from the hostname scan because it holds base URLs as data.
// That exemption is only safe while the file cannot itself call anything, so that is asserted
// rather than assumed — otherwise the one file allowed to name every provider host is also a file
// that could quietly fetch one.
test("the provider catalog is data — it makes no network call at all", () => {
  const src = fs.readFileSync(CATALOG, "utf8");
  const callShapes = [
    /\bfetch\s*\(/, /\baxios\b/, /\bhttps?\.(get|request)\s*\(/,
    /\bXMLHttpRequest\b/, /\bnew\s+Request\s*\(/, /\bundici\b/,
  ];
  const found = callShapes.filter(re => re.test(src.replace(/(^|[^:])\/\/.*$/gm, "$1")));
  assert.deepEqual(found.map(String), [],
    `${CATALOG} is exempt from the provider-hostname scan because it is pure data. It must stay ` +
    `that way: move any call into ${TRANSPORT}, which is the module the guard scrutinises.`);
});

// The hostname scan cannot see `fetch(`${spec.baseUrl}/chat/completions`)` — the host is in the
// catalog, not at the call. So the catalog's URLs are themselves treated as a capability: only the
// transport may read them. Without this, any module could import PROVIDERS and fetch a base URL in
// two lines that no hostname regex would ever match.
test("only the transport reads a provider base URL", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file === TRANSPORT || file === CATALOG || file === SELF) continue;
    const src = fs.readFileSync(file, "utf8");
    // Scoped two ways, because a bare /baseUrl/ is noise: `baseUrl` is an ordinary name in this
    // repo for the APP's own URL (server.js builds a password-reset link with one), and a guard
    // that cries wolf acquires an exemption list instead of a meaning.
    //   1. the file must actually import the catalog, and
    //   2. the match must be a PROPERTY READ off a provider spec (`spec.baseUrl`), not a local
    //      variable that merely shares the name.
    if (!/from\s+["'][^"']*modelProviders\.js["']/.test(src)) continue;
    src.split("\n").forEach((line, i) => {
      const code = line.replace(/(^|[^:])\/\/.*$/, "$1");
      if (/\.baseUrl\b/.test(code)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    "These read a provider's base URL outside the transport, which is a model call the hostname\n" +
    "scan cannot see (the host is in the catalog, not at the call site):\n" +
    offenders.map(o => `  ${o}`).join("\n") +
    `\n\nFIX: route through callModel(), which delegates to ${TRANSPORT}.`);
});
