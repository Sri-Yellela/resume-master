#!/usr/bin/env node
/**
 * Run every real-run harness, and FAIL ON A TRUNCATED RUN.
 * ============================================================================================
 * WHY THIS EXISTS
 * `npm test` runs `node --test` — the source-string and unit suite. It does not run any of the
 * harnesses in this directory, and neither does anything else: there is no CI config and no npm
 * script that names one. So roughly 470 assertions covering a real browser, the real extension, the
 * real submit path and a real local ATS ran only when somebody remembered.
 *
 * That is how the drift this script exists to prevent happened. `g1GatePacket` began throwing
 * `SqliteError: no such column: rj.hidden_at` at check 4 of 42 when a migration added a column its
 * hand-rolled fixture never gained — and stayed broken, because nothing ran it. Its exit code was
 * correct the whole time; there was simply no reader.
 *
 * THE RULE THAT WOULD HAVE CAUGHT IT
 * A harness that CRASHES mid-run still prints everything it managed before dying, and if it happens
 * to die after its last assertion it exits 0 and looks healthy. So "no FAIL lines" is not enough:
 * this compares each harness's PASS COUNT against a recorded floor in harnessBaseline.json and
 * treats a drop as a failure. Fewer assertions than last time means assertions stopped running,
 * which is the defect, whatever the exit code says.
 *
 * Raising a floor is deliberate: add checks, run with --update-baseline, commit the new numbers in
 * the same change. Lowering one requires saying why in the commit, which is the point.
 *
 * ⛔ PREREQUISITE: THE APP MUST ALREADY BE RUNNING ON :3001 (`node server.js`).
 * This script starts fakeAts on :4599 and nothing else. Most harnesses drive the real server. The
 * run now refuses to start without it — see assertAppUp() for why that check exists rather than
 * letting the suite discover it 700 seconds at a time.
 *
 * ⛔ WHAT A GREEN RUN HERE DOES NOT MEAN: it is not evidence about the MODEL-CALL path. No harness
 * in this suite exercises provider routing, generation, enrichment or classification — every one
 * that would is in EXCLUDED below precisely because it spends tokens. So a full green board says
 * the apply pipeline, the browser and the extension work; it says nothing about which provider
 * served a call or what it cost. Cost and routing are covered by `npm test`
 * (test/modelCallGuard.test.js, test/providerRouting.test.js) and, for real traffic, only by
 * scripts/al1ProviderQualityDiff.mjs, which is run by hand.
 *
 * Usage:
 *   node scripts/verifyHarnesses.mjs                  # all of them
 *   node scripts/verifyHarnesses.mjs g1 a7            # only those whose name contains an argument
 *   node scripts/verifyHarnesses.mjs --update-baseline
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "scripts", "harnessBaseline.json");
const PORT = 4599;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// EXCLUDED, each for a stated reason. An unexplained exclusion is how a harness stops running
// without anyone deciding that it should.
const EXCLUDED = {
  a1TrapMatrix:        "diagnostic — prints a matrix, asserts nothing",
  a5Preflight:         "read-only gate report against the real database",
  af5CampaignReport:   "read-only campaign report against the real database",
  a5Rehearsal:         "waits for a HUMAN to submit the form",
  a5SeedFixture:       "mutates the developer's database",
  aj2SeedMobileBoard:  "mutates the developer's database — seeds band-boundary rows for the Android client; --clean removes them",
  ah1IdentityShots:    "screenshots; creates a user in the developer's database and needs a built client",
  ah2MultiTab:         "screenshots; drives the real board on :3001 and needs a built client",
  ah3TermPanelShots:   "screenshots; the ATS panel half of ah3TermQuality, which stays in the suite",
  ah4FindingShots:     "screenshots; the finding-strip half of ah4LocationClaims, which stays in the suite",
  ah5FillLogShots:     "screenshots; the panel half of ah5ReuseAndFillLog, which stays in the suite",
  ah6RecentRunDefault: "screenshots; drives the real panel in a browser, like abPanelUi which covers the no-history case",
  ae1Diagnose:         "instrument, not a harness",
  ae1LiveVerify:       "points at a REAL EMPLOYER — never automated",
  g0ActiveTabSpike:    "spike; needs a manually loaded unpacked extension",
  buildExtension:      "build tool",
  publishExtension:    "build tool",
  generateMobileContract: "build tool — writes contract/; its --check mode already runs on every `npm test` via test/mobileApiContract.test.js",
  freePort:            "utility",
  importJobUrls:       "utility, writes to the database",
  ingestLca:           "utility, downloads a dataset",
  runEnrichment:       "utility, spends model tokens",
  al1ProviderQualityDiff: "REAL enrichment on BOTH providers — the Anthropic arm spends tokens on every row; run it by hand",
  al4LcaResolution:    "OFFLINE asset generation — model calls over public LCA company names; run it by hand",
  al3SynonymRhoEffect: "measurement, not a harness — re-scores the graded 30 against a read-only backup and prints rho; asserts nothing",
  al3SkillSynonyms:    "OFFLINE asset generation — spends model tokens over the corpus vocabulary; run it by hand, and only when the review sheet is being rebuilt",
  af2ClaimVerify:      "REAL generation — spends model tokens on every run; run it by hand",
  ai1SummaryVerify:    "REAL generation x2 + PDF render — spends model tokens on every run; run it by hand",
  ag2ClaimsGeneration: "REAL generation — spends model tokens on every run; run it by hand",
  ag3ClaimSample:      "REAL generation x12 — spends model tokens on every run; run it by hand",
  ak2AtsGradingSet:    "utility, writes the grading sheet to docs/ and asserts nothing",
  ak2BandSurfaces:     "screenshots; drives the real board in a browser to prove the bands reach pixels",
  fakeAts:             "the fixture server itself",
  verifyHarnesses:     "this runner",
};

const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const filters = args.filter(a => !a.startsWith("--"));

const all = fs.readdirSync(path.join(ROOT, "scripts"))
  .filter(f => /\.mjs$/.test(f))
  .map(f => f.replace(/\.mjs$/, ""))
  .filter(n => !(n in EXCLUDED))
  .filter(n => !filters.length || filters.some(f => n.toLowerCase().includes(f.toLowerCase())))
  .sort();

// A resume the file-upload harnesses need. Several exit early with "Set A1_RESUME to an existing PDF
// path" — which is a silent skip if nobody reads stdout, so it is supplied rather than required.
const RESUME = path.join(os.tmpdir(), "harness-resume.pdf");
if (!fs.existsSync(RESUME)) {
  fs.writeFileSync(RESUME,
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n");
}

async function atsUp() {
  try {
    const r = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// ── THE PREREQUISITE THIS RUNNER DOES NOT SATISFY ITSELF ────────────────────────────────────────
//
// This script starts fakeAts on :4599. It does NOT start the app, and most harnesses drive it on
// :3001 — that has to be running already, by hand (`node server.js`).
//
// ⛔ WITHOUT IT, THE RUN LOOKS EXACTLY LIKE A HANG. Each harness's stdout is buffered until it
// exits and each gets a 700-second kill timeout, so a suite launched against a dead :3001 emits
// NOTHING for hours while every harness times out in turn. AL1 spent 30 minutes watching a
// zero-byte output file before working out that nothing was wrong with the harnesses. That is
// Shape 3 — a silent failure indistinguishable from slow progress — in the one tool whose job is
// to catch silent failures.
//
// So it is checked once, up front, and refuses to start. A fast, specific refusal beats a long,
// ambiguous nothing.
const APP_PORT = process.env.PORT || 3001;

async function assertAppUp() {
  try {
    const r = await fetch(`http://localhost:${APP_PORT}/`, { signal: AbortSignal.timeout(3000) });
    if (r.ok || r.status === 401 || r.status === 302) {
      console.log(`app on :${APP_PORT} — up`);
      return;
    }
    console.error(`\n⛔ the app on :${APP_PORT} answered ${r.status}, which is not a healthy server.`);
  } catch {
    console.error(
      `\n⛔ NOTHING IS LISTENING ON :${APP_PORT}.\n\n` +
      `   This runner starts fakeAts (:${PORT}) but NOT the app — most harnesses drive the real\n` +
      `   server and it has to be running already:\n\n` +
      `       node server.js\n\n` +
      `   Refusing to start, because the alternative is silence: each harness buffers its output\n` +
      `   until it exits and is killed after 700s, so a suite run against a dead port prints\n` +
      `   nothing at all for hours and then reports every harness as failed.\n`
    );
  }
  process.exit(2);
}

let ats = null;
async function startAts() {
  if (await atsUp()) { console.log(`fakeAts already listening on :${PORT}`); return; }
  ats = spawn(process.execPath, [path.join(ROOT, "scripts", "fakeAts.js")],
    { cwd: ROOT, stdio: "ignore", detached: false });
  for (let i = 0; i < 40; i++) { if (await atsUp()) return; await sleep(250); }
  throw new Error(`fakeAts did not come up on :${PORT}`);
}

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, "scripts", `${name}.mjs`)], {
      cwd: ROOT,
      // NOBODY IS WATCHING. ab1HeldHandoff delivers a real OS keypress, and when Windows refuses
      // foreground it used to print "press Ctrl+Shift+Y manually, 45s" and wait — which is right
      // interactively and, here, burns 45s per attempt and then fails thirteen assertions about a
      // handoff nobody invoked. Any harness with a human-in-the-loop path reads this and takes the
      // other branch: report the environment once, verify nothing, and say so.
      env: { ...process.env, A1_RESUME: RESUME, RM_UNATTENDED: '1' },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 700_000);
    p.on("close", (code) => {
      clearTimeout(kill);
      const lines = out.split(/\r?\n/);
      resolve({
        name, code,
        pass: lines.filter(l => /^PASS\b/.test(l)).length,
        fail: lines.filter(l => /^FAIL\b/.test(l)).length,
        failLines: lines.filter(l => /^FAIL\b/.test(l)),
        crashed: /SqliteError|ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|TypeError:/.test(out),
        ms: Date.now() - started,
        out,
      });
    });
  });
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
const results = [];

console.log("=".repeat(96));
console.log(`REAL-RUN HARNESSES — ${all.length} to run. A truncated run is a failure.`);
console.log("=".repeat(96));
await assertAppUp();
await startAts();

for (const name of all) {
  process.stdout.write(`  ${name.padEnd(24)}`);
  await fetch(`http://localhost:${PORT}/_reset`, { method: "POST" }).catch(() => {});
  const r = await run(name);
  const floor = baseline[name]?.pass ?? null;
  r.truncated = floor != null && r.pass < floor;
  r.ok = r.code === 0 && r.fail === 0 && !r.crashed && !r.truncated && r.pass > 0;
  results.push(r);
  console.log(`${r.ok ? "OK  " : "BAD "} pass=${String(r.pass).padStart(3)}` +
    `${floor != null ? `/${String(floor).padStart(3)}` : "    "} fail=${r.fail} exit=${r.code} ` +
    `${(r.ms / 1000).toFixed(0)}s` +
    `${r.truncated ? "  <- TRUNCATED, fewer assertions than the baseline" : ""}` +
    `${r.crashed ? "  <- CRASHED mid-run" : ""}` +
    `${r.pass === 0 ? "  <- ran NO assertions" : ""}`);
}

if (ats) { try { ats.kill(); } catch {} }

if (updateBaseline) {
  // MERGED, not replaced. With a filter active only a subset ran, and writing just those would
  // silently delete every other floor — turning the file that detects truncation into the thing
  // that hides it. Untouched entries are carried through verbatim.
  const next = { ...baseline };
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    if (r.fail || r.crashed || r.pass === 0) {
      console.error(`\nREFUSING to baseline ${r.name}: it is not green (pass=${r.pass} fail=${r.fail}).`);
      process.exit(1);
    }
    const before = baseline[r.name]?.pass;
    if (before != null && r.pass < before) {
      console.error(`\nREFUSING to LOWER ${r.name}: ${before} -> ${r.pass}. A drop means assertions ` +
        `stopped running. If that is intended, delete the entry and say why in the commit.`);
      process.exit(1);
    }
    next[r.name] = { pass: r.pass };
    if (before !== r.pass) console.log(`  ${r.name}: ${before ?? "(new)"} -> ${r.pass}`);
  }
  // Entries whose harness no longer exists are dropped, so a deleted harness cannot leave a floor
  // nothing can ever satisfy.
  for (const name of Object.keys(next)) {
    if (!fs.existsSync(path.join(ROOT, "scripts", `${name}.mjs`))) {
      console.log(`  ${name}: dropped (scripts/${name}.mjs no longer exists)`);
      delete next[name];
    }
  }
  const ordered = {};
  for (const k of Object.keys(next).sort()) ordered[k] = next[k];
  fs.writeFileSync(BASELINE, JSON.stringify(ordered, null, 2) + "\n");
  console.log(`\nbaseline written: ${path.relative(ROOT, BASELINE)} (${Object.keys(ordered).length} harnesses` +
    `${filters.length ? `, ${results.length} updated, the rest carried through` : ""})`);
  process.exit(0);
}

const bad = results.filter(r => !r.ok);
console.log("\n" + "-".repeat(96));
console.log(`${results.length - bad.length}/${results.length} green` +
  `, ${results.reduce((n, r) => n + r.pass, 0)} assertions passed`);
for (const r of bad) {
  console.log(`\n${r.name}:`);
  if (r.truncated) console.log(`  TRUNCATED — ${r.pass} assertions, baseline says at least ${baseline[r.name].pass}`);
  if (r.crashed)   console.log("  CRASHED mid-run — see the tail below");
  for (const l of r.failLines.slice(0, 8)) console.log("  " + l);
  if (r.crashed || (!r.failLines.length && r.code !== 0)) {
    console.log(r.out.split(/\r?\n/).filter(Boolean).slice(-12).map(l => "    " + l).join("\n"));
  }
}
for (const [n, why] of Object.entries(EXCLUDED)) {
  if (filters.length) break;
  if (n === "verifyHarnesses" || n === "fakeAts") continue;
  console.log(`  skipped ${n.padEnd(22)} ${why}`);
}
process.exit(bad.length ? 1 : 0);
