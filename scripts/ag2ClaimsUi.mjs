#!/usr/bin/env node
/**
 * TASK AG2 — the opt-in CLAIM, driven by clicking the real chips in a real browser.
 * ============================================================================================
 * WHY THIS EXISTS
 * test/profileSignalClaims.test.js already proves the store: a claim persists, it is scoped to one
 * profile, it can be withdrawn, and an auto-ingested suggestion is not a claim. Every one of those
 * statements is about a ROW. None of them can see the thing the feature is actually for — whether a
 * person looking at the panel is being told the truth about what they have said.
 *
 * The bug this replaces was exactly that gap. The old lookup unioned inactive+selected+applied, so
 * a term the scrape-time aggregator had recorded on its own rendered as a green, already-added,
 * unclickable chip. Nothing about that is visible from the database: the rows were correct, the
 * status column said 'inactive', and the user was nonetheless looking at an opt-in they had never
 * made. It is only wrong once it is on screen.
 *
 * So this drives the REAL client/src/panels/ATSPanel.jsx in a real Chrome, with a report computed by
 * the REAL scorer from the REAL database row, and CLICKS the chips. Every assertion below reads the
 * answer back out of the DOM, or out of the store the clicks wrote to — never out of a variable
 * this script set.
 *
 * WHY THE STUB IS A DATABASE AND NOT A FIXTURE
 * A hand-rolled claim stub would make this a test of my own bookkeeping: I would decide what
 * "claimed" means in the fake, and the panel would agree with me whether or not it agreed with the
 * server. So /api/domain-profiles/:id/suggestions and /api/domain-profiles/:id/claims are answered
 * by the REAL setProfileSignalClaim / listProfileSignalSuggestions running against a real
 * better-sqlite3 database held in memory, on the schema migrations 013 and 052 define. The clicks
 * therefore travel the whole way: chip -> setProfileClaim -> HTTP -> the actual aggregator -> SQL
 * -> back through listProfileSignalSuggestions -> buildProfileClaimLookup -> chip.
 *
 * WHY THE PANEL IS MOUNTED ON ITS OWN RATHER THAN THROUGH App.jsx
 * ATSPanel only reaches its report body when a job is selected, a profile is active and a base
 * resume is uploaded. Each of those failing renders a DIFFERENT, plausible-looking panel — a
 * stubbed board showing "Upload a profile resume" screenshots cleanly and proves nothing. The
 * component takes `report` as a prop and does not fetch when it has one, so it is mounted directly
 * under the real ThemeProvider, which is where .rm-badge comes from; the chips are the real chips.
 *
 * The profile switch is a PROP CHANGE, not a remount, because that is what the app does:
 * AtsReportPanel renders <ATSPanel activeProfileId={...}/> with no key, so a profile switch updates
 * the prop in place. Remounting here would reset state the real app keeps, and would test a
 * component lifecycle the user never triggers.
 *
 * COSTS NOTHING, TOUCHES NOTHING. data/resume_master.db is opened readonly and the claims are
 * written to :memory:, every /api/* request is answered locally, and every off-localhost request is
 * aborted — no model is called and no font is fetched. That is what makes it safe for
 * scripts/verifyHarnesses.mjs to auto-discover.
 *
 * Usage:  node scripts/ag2ClaimsUi.mjs
 *         AG2_KEEP_OPEN=1 node scripts/ag2ClaimsUi.mjs   # leave the browser open to poke at
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import { resolveBrowserExecutable } from '../services/browserLauncher.js';
import { buildRuntimeAtsBasis, scoreAtsLocally } from '../services/localAtsScorer.js';
import {
  addProfileSignalSuggestions,
  listProfileClaims,
  listProfileSignalSuggestions,
  setProfileSignalClaim,
} from '../services/profileSignalAggregator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'data', 'screenshots');
const PORT = 5197;                                   // ag1/ae5 own 5198, abPanelUi owns 5199
const JOB_ID = 1974;                                 // OpenAI, "Software Engineer, Agent Productivity"
const REPORT_PROFILE_ID = 6;                         // the profile the REPORT is scored against
const USER_ID = 7;                                   // the owner of both in-memory profiles
const PROFILE_A = 1;                                 // what the panel is handed as activeProfileId
const PROFILE_B = 2;                                 // the one a switch moves to
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

/** Poll rather than sleep: the claim round trip is a real HTTP call and a real SQL write. */
async function waitFor(fn, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

// ── The claim store: the real schema, in memory ───────────────────────────────────────────────
/**
 * The two tables the claim path touches, exactly as migrations 052 and 013 define them — copied
 * from test/profileSignalClaims.test.js so the harness and the unit suite cannot drift apart on
 * what "the schema" means. Two profiles, one owner: the profile switch has to have somewhere to go.
 */
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE domain_profiles (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_name TEXT,
      target_titles JSON NOT NULL DEFAULT '[]',
      selected_keywords JSON NOT NULL DEFAULT '[]',
      selected_verbs JSON NOT NULL DEFAULT '[]',
      selected_tools JSON NOT NULL DEFAULT '[]',
      updated_at INTEGER
    );
    CREATE TABLE profile_signal_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES domain_profiles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signal_key TEXT NOT NULL,
      signal_label TEXT NOT NULL,
      signal_kind TEXT NOT NULL,
      structured_field TEXT,
      frequency INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'inactive',
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      selected_at INTEGER,
      applied_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(profile_id, signal_key)
    );
    INSERT INTO users (id) VALUES (7), (8);
    INSERT INTO domain_profiles (id, user_id, profile_name) VALUES (1, 7, 'Backend'), (2, 7, 'Data');
  `);
  return db;
}

// ── The report: computed, never transcribed ───────────────────────────────────────────────────
function buildReport() {
  const dbPath = path.join(ROOT, 'data', 'resume_master.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const job = db.prepare('SELECT * FROM scraped_jobs WHERE id=?').get(JOB_ID);
    // An absent row would leave the panel rendering a report built from an empty description — a
    // blank, passing-looking screenshot with no chips to click. Fatal rather than tolerated.
    if (!job) throw new Error(
      `scraped_jobs id=${JOB_ID} is missing. This harness clicks the chips of the REAL OpenAI ` +
      `"Software Engineer, Agent Productivity" posting; without it there is nothing to claim.`);
    if (!job.description || job.description.length < 500) throw new Error(
      `scraped_jobs id=${JOB_ID} has no usable description (${(job.description || '').length} chars).`);
    const domainProfile = db.prepare('SELECT * FROM domain_profiles WHERE id=?').get(REPORT_PROFILE_ID);
    if (!domainProfile) throw new Error(`domain_profiles id=${REPORT_PROFILE_ID} is missing.`);
    const base = db.prepare('SELECT content FROM profile_base_resumes WHERE profile_id=?').get(REPORT_PROFILE_ID);
    if (!base?.content) throw new Error(`profile_base_resumes for profile ${REPORT_PROFILE_ID} is missing.`);

    // Empty skills and keywords: what the JOB asks for is the whole source of the missing lists,
    // and a populated signal profile would seed them from the other side.
    const signalProfile = { skills: [], keywords: [], yearsExperience: 4, structuredFacts: {} };
    const runtimeBasis = buildRuntimeAtsBasis({ resumeText: base.content, signalProfile, domainProfile });
    const report = scoreAtsLocally({ job, runtimeBasis });

    // Three clickable chips are the minimum this harness needs; fewer means the assertions below
    // would be quietly testing a shorter list than they claim to.
    if ((report.tier1_missing || []).length < 3) throw new Error(
      `the report has only ${(report.tier1_missing || []).length} missing skills — need at least 3.`);
    if ((report.action_verbs_missing || []).length < 1) throw new Error(
      'the report has no missing action verbs — there is no verb chip to claim.');
    return { report, job };
  } finally { db.close(); }
}

// ── The harness page: written into client/ for this run, deleted in the finally block ─────────
const HARNESS_HTML = path.join(ROOT, 'client', 'ag2-harness.html');
const HARNESS_JSX = path.join(ROOT, 'client', 'src', 'ag2Harness.jsx');

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AG2 — claim toggle harness</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      /* The app's own body is transparent — it sits on a page background the shell paints. This
         page has no shell, and a transparent body screenshots as white behind dark-on-dark chips. */
      body { background: #0d0f12; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ag2Harness.jsx"></script>
  </body>
</html>
`;

const JSX = `// AG2 harness entry — written by scripts/ag2ClaimsUi.mjs, deleted when it finishes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import { ATSPanel } from "./panels/ATSPanel.jsx";

const report = window.__AG2_REPORT__ || null;

function Harness() {
  // The profile switch the script drives. A prop change, deliberately: AtsReportPanel renders
  // ATSPanel with no key, so switching profiles in the app updates this prop on a mounted
  // component. Remounting here would hand the panel a fresh state the real app never gives it.
  const [profileId, setProfileId] = useState(${PROFILE_A});
  window.__AG2_SET_PROFILE__ = setProfileId;
  return (
    <div data-ag2-profile={profileId}
         style={{ width: 900, background: "#0d0f12", paddingBottom: 24 }}>
      <div style={{ padding: "14px 16px 0", fontFamily: "system-ui, sans-serif",
                    fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase",
                    color: "#8b95a1" }}>
        {"AG2 — claim toggles · profile " + profileId + " · "}{window.__AG2_JOB__ || ""}
      </div>
      <ATSPanel report={report} score={report && report.score}
                jobId={${JOB_ID}} activeProfileId={profileId} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ThemeProvider><Harness /></ThemeProvider>
);
`;

// ── Vite dev server ──────────────────────────────────────────────────────────────────────────
function startVite() {
  return new Promise((resolve, reject) => {
    // vite's own bin, run under this node. Not `npx`: node on Windows refuses to spawn a .cmd shim
    // without shell:true, and shell:true would mean concatenating arguments into a command line.
    const proc = spawn(process.execPath,
      [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
        '--port', String(PORT), '--strictPort'],
      { cwd: path.join(ROOT, 'client'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b) => {
      // Vite colours its banner, and it colours the PORT separately from the host — so the raw
      // bytes read "localhost:<ESC>[1m5197". Stripping only the bracket part leaves the ESC itself
      // between the colon and the number, and /localhost:5197/ never matches.
      out += b.toString().replace(/\[[0-9;]*m/g, '').replace(//g, '');
      if (new RegExp(`localhost:${PORT}`).test(out)) resolve({ proc, url: `http://localhost:${PORT}` });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`vite did not start:\n${out.slice(-800)}`)), 60000);
  });
}

async function main() {
  console.log('=== AG2 — claiming a term, by clicking it ===\n');
  fs.mkdirSync(SHOTS, { recursive: true });

  const { report, job } = buildReport();
  const label = `${job.company} — ${job.title}`;
  console.log(`posting  scraped_jobs #${JOB_ID}: ${label}`);
  console.log(`report   score ${report.score}` +
    `  skills missing ${(report.tier1_missing || []).length}` +
    `  verbs missing ${(report.action_verbs_missing || []).length}`);

  // WHAT THE USER WILL CLICK. Taken from the report rather than named here, so this cannot drift
  // into claiming a term the panel does not actually show.
  const SEEDED = report.tier1_missing.slice(0, 2);
  const CLICK_SKILLS = SEEDED;                       // the seeded pair, claimed by hand
  const CLICK_VERB = report.action_verbs_missing[0];
  const CLICKED = [...CLICK_SKILLS, CLICK_VERB];
  const WITHDRAW = CLICK_SKILLS[0];

  const db = freshDb();
  // What scrape-time aggregation does, unprompted, with nobody's agreement. These MUST render as
  // ordinary unclaimed chips — the defect AG2 fixes was these appearing as an opt-in already made.
  addProfileSignalSuggestions(db, { userId: USER_ID, profileId: PROFILE_A, kind: 'skill', labels: SEEDED });
  console.log(`seeded   auto-ingested suggestions on profile ${PROFILE_A}: ${JSON.stringify(SEEDED)}`);
  console.log(`clicks   skills ${JSON.stringify(CLICK_SKILLS)}  verb ${JSON.stringify(CLICK_VERB)}\n`);

  const resolution = await resolveBrowserExecutable();
  if (!resolution) { console.error('No Chrome binary.'); process.exit(1); }

  fs.writeFileSync(HARNESS_HTML, HTML);
  fs.writeFileSync(HARNESS_JSX, JSX);

  let vite = null;
  let browser = null;
  try {
    vite = await startVite();
    console.log(`vite     ${vite.url}\n`);

    browser = await puppeteer.launch({
      executablePath: resolution.path, headless: 'new', pipe: true,
      args: ['--no-first-run', '--no-default-browser-check'],
      defaultViewport: { width: 900, height: 1400, deviceScaleFactor: 2 },
    });

    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`      [page error] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') console.log(`      [console] ${m.text()}`); });

    await page.evaluateOnNewDocument((payload, jobLabel) => {
      window.__AG2_REPORT__ = payload;
      window.__AG2_JOB__ = jobLabel;
      // The accent is picked at RANDOM per session, so two loads differ by a hue for reasons that
      // have nothing to do with claims. Pinning it makes the two PNGs comparable by eye.
      try { sessionStorage.setItem('rm_session_accent', 'sky'); } catch {}
    }, report, label);

    // ── The API, answered by the real store ────────────────────────────────────────────────────
    let claimPosts = 0;      // POSTs that have completed a SQL write
    let suggestionGets = 0;  // reads, which is how a profile switch announces itself
    const served = new Set();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = new URL(req.url(), vite.url);
      // OFF-ORIGIN IS ABORTED, not continued. index.css opens with a Google Fonts @import, and a
      // harness that reaches the public internet is neither fast nor honest about what it tested.
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return req.abort();
      if (!url.pathname.startsWith('/api/')) return req.continue();
      served.add(url.pathname);

      // THE SSE STREAM IS LEFT HANGING, deliberately. useSyncEvents opens an EventSource that never
      // completes by design; answering it with JSON makes the browser reject the MIME type and the
      // hook reconnect on a timer, which floods the console for the whole run. An unanswered
      // request is what a healthy stream looks like from here.
      if (url.pathname === '/api/sync/events') return;

      const json = (body, status = 200) =>
        req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });

      const suggestions = url.pathname.match(/^\/api\/domain-profiles\/(\d+)\/suggestions$/);
      if (suggestions) {
        suggestionGets++;
        return json(listProfileSignalSuggestions(db, { userId: USER_ID, profileId: Number(suggestions[1]) }));
      }

      const claims = url.pathname.match(/^\/api\/domain-profiles\/(\d+)\/claims$/);
      if (claims) {
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch {}
        const next = setProfileSignalClaim(db, {
          userId: USER_ID, profileId: Number(claims[1]),
          kind: body.kind, label: body.label, claimed: body.claimed,
        });
        claimPosts++;
        return json(next);
      }

      if (url.pathname === '/api/domain-profiles') {
        // selected_tools / selected_verbs are EMPTY on purpose. Those are the profile's scored term
        // lists, and anything in them renders as a locked chip that cannot be clicked — which would
        // silently remove the very buttons this harness exists to press.
        return json([PROFILE_A, PROFILE_B].map(id => ({
          id, profile_name: id === PROFILE_A ? 'Backend' : 'Data',
          selected_tools: [], selected_verbs: [], selected_keywords: [],
        })));
      }

      if (url.pathname === '/api/auth/me') return json({ authenticated: true, user: { id: USER_ID, username: 'ada' } });
      return json({ ok: true, items: [], results: [], data: [] });
    });

    // ── Reading the panel ──────────────────────────────────────────────────────────────────────
    /**
     * Every chip on screen, with the one fact that matters: is it showing as claimed?
     *
     * THE TICK IS THE TEST. "✓ Kubernetes" is what a person sees and reads as "I said I have this";
     * asserting on a class name or an aria attribute would pass just as happily over a chip that
     * renders identically to its neighbours.
     */
    const readChips = () => page.evaluate(() => {
      const out = [];
      for (const b of document.querySelectorAll('button.rm-badge')) {
        const text = (b.innerText || '').trim();
        const heading = b.parentElement?.parentElement?.querySelector('.rm-section-label');
        out.push({
          text,
          label: text.replace(/^✓\s*/, ''),
          claimed: text.startsWith('✓'),
          disabled: !!b.disabled,
          // innerText is the RENDERED text and .rm-section-label is text-transform:uppercase, so the
          // letters are lowercased here rather than compared against the JSX's own casing.
          section: (heading?.innerText || '').replace(/[^A-Za-z ]/g, '').trim().toLowerCase(),
        });
      }
      return out;
    });
    const claimedLabels = async () => (await readChips()).filter(c => c.claimed).map(c => c.label).sort();
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

    /** Click a chip BY THE TEXT ON IT — the only handle a user has on it either. */
    const clickChip = async (want) => {
      const before = claimPosts;
      const found = await page.evaluate((target) => {
        for (const b of document.querySelectorAll('button.rm-badge')) {
          if ((b.innerText || '').trim().replace(/^✓\s*/, '') === target) { b.click(); return true; }
        }
        return false;
      }, want);
      if (!found) throw new Error(`no chip on screen reads "${want}"`);
      // Wait for the WRITE, not for the paint. The panel updates optimistically, so the tick
      // appears before the row exists; asserting on the database in between would be a race.
      const written = await waitFor(() => claimPosts > before);
      if (!written) throw new Error(`the claim POST for "${want}" never reached the store`);
    };

    /** The panel is only worth screenshotting once it has chips; an empty PNG proves nothing. */
    const waitForPanel = async (what) => {
      const rendered = await page.waitForFunction(
        () => document.querySelectorAll('button.rm-badge').length > 0, { timeout: 30000 })
        .then(() => true).catch(() => false);
      check(`AG2  ${what}`, rendered,
        rendered ? `${(await readChips()).length} chips on screen`
          : `body was: ${JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 200))}`);
      if (!rendered) throw new Error('the panel never rendered — every assertion below would be vacuous');
    };

    const shoot = async (name) => {
      await sleep(400);
      const file = path.join(SHOTS, `ag2-claims-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`      screenshot: ${file}`);
      return file;
    };

    await page.goto(`${vite.url}/ag2-harness.html`, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForPanel('the real ATSPanel rendered with clickable chips');

    // ── 1. NOTHING IS PRE-SELECTED ─────────────────────────────────────────────────────────────
    // Including the two the aggregator wrote on its own. This is the defect the feature exists to
    // fix, so it is checked before anything is clicked and before the store has any claim in it.
    const first = await readChips();
    const preClaimed = first.filter(c => c.claimed).map(c => c.label);
    check('AG2  first render claims nothing — no chip arrives already ticked',
      preClaimed.length === 0,
      preClaimed.length ? `${preClaimed.length} pre-ticked: ${JSON.stringify(preClaimed)}`
        : `all ${first.length} chips are unclaimed`);

    const seededOnScreen = first.filter(c => SEEDED.includes(c.label));
    check('AG2  the auto-ingested suggestions render as ordinary unclaimed, clickable chips',
      seededOnScreen.length === SEEDED.length
      && seededOnScreen.every(c => !c.claimed && !c.disabled),
      JSON.stringify(seededOnScreen.map(c => ({ label: c.label, claimed: c.claimed, disabled: c.disabled }))));
    check('AG2  and the store agrees nothing is claimed before the first click',
      same(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_A }).skills, [])
      && same(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_A }).actionVerbs, []),
      JSON.stringify(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_A })));

    const beforeShot = await shoot('before');

    // ── 2. CLICKING CLAIMS, AND CLAIMS ONLY WHAT WAS CLICKED ───────────────────────────────────
    for (const term of CLICKED) await clickChip(term);
    await waitFor(async () => same(await claimedLabels(), CLICKED));
    const afterClicks = await claimedLabels();
    check('AG2  clicking three chips ticks exactly those three, and nothing else',
      same(afterClicks, CLICKED), `${JSON.stringify(afterClicks)} vs clicked ${JSON.stringify(CLICKED)}`);

    // ── 3. THE CLICKS REACHED THE STORE ────────────────────────────────────────────────────────
    const storedAfterClicks = listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_A });
    check('AG2  the three clicks are rows in the database, not just pixels',
      same(storedAfterClicks.skills, CLICK_SKILLS) && same(storedAfterClicks.actionVerbs, [CLICK_VERB]),
      JSON.stringify(storedAfterClicks));

    const afterShot = await shoot('after');

    // ── 4. CLAIMS DO NOT FOLLOW A PROFILE SWITCH ───────────────────────────────────────────────
    // A claim is something the candidate said about themselves FOR ONE TARGET. Leaking it across
    // profiles would put words in their mouth on a profile they never opened.
    //
    // THE ORDER OF THESE TWO BLOCKS IS THE ASSERTION. This has to run on the SAME live component
    // that was clicked — before any reload — and the first draft of this harness got it backwards.
    // The optimistic tick lives in a `useState` set that survives a prop change but not a remount,
    // so reloading first cleared it and the switch then read a fresh mount that could only have
    // been right. It passed, and it was decorative: with the reload first, this exact check went
    // green over a panel that showed all three of profile 1's claims ticked on profile 2.
    //
    // Any bug in this class — state that should be keyed on the profile but is keyed on the job,
    // or on nothing — is invisible to a reload, because a reload throws the state away instead of
    // re-deriving it. Only a switch on a mounted component asks the question.
    const switchProfile = async (id) => {
      const before = suggestionGets;
      await page.evaluate((next) => window.__AG2_SET_PROFILE__(next), id);
      await page.waitForFunction((next) => !!document.querySelector(`[data-ag2-profile="${next}"]`), {}, id);
      await waitFor(() => suggestionGets > before);
      await sleep(250);
    };

    await switchProfile(PROFILE_B);
    const onOther = await claimedLabels();
    check(`AG2  switching to profile ${PROFILE_B} shows nothing claimed — claims are per profile`,
      onOther.length === 0, onOther.length ? `leaked: ${JSON.stringify(onOther)}` : 'no ticked chip');
    check(`AG2  and profile ${PROFILE_B}'s store is empty too`,
      same(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_B }).skills, [])
      && same(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_B }).actionVerbs, []),
      JSON.stringify(listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_B })));

    await switchProfile(PROFILE_A);
    await waitFor(async () => same(await claimedLabels(), CLICKED));
    const backOnA = await claimedLabels();
    check(`AG2  switching back to profile ${PROFILE_A} finds the three claims unchanged`,
      same(backOnA, CLICKED), JSON.stringify(backOnA));

    // ── 5. A CLAIM SURVIVES A RELOAD ───────────────────────────────────────────────────────────
    // The optimistic tick lives in component state, so this is the check that separates "the UI
    // remembers" from "the claim was recorded" — everything above this line would look identical if
    // nothing had ever been written down. A full reload is safe here because the panel is mounted
    // directly rather than reached through the router, so there is no context state to lose.
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await waitForPanel('the panel came back after a reload');
    await waitFor(async () => same(await claimedLabels(), CLICKED));
    const afterReload = await claimedLabels();
    check('AG2  the three claims survive a reload, read back out of the DOM',
      same(afterReload, CLICKED), JSON.stringify(afterReload));

    // ── 6. A CLAIM CAN BE TAKEN BACK ───────────────────────────────────────────────────────────
    // The point of an opt-in is that it can be opted back out of. The path this replaced had no
    // undo anywhere in the product, which made a misclick permanent.
    await clickChip(WITHDRAW);
    const expectedAfterWithdraw = CLICKED.filter(t => t !== WITHDRAW);
    await waitFor(async () => same(await claimedLabels(), expectedAfterWithdraw));
    const afterWithdraw = await claimedLabels();
    check(`AG2  clicking a claimed chip withdraws it — "${WITHDRAW}" is no longer ticked`,
      same(afterWithdraw, expectedAfterWithdraw), JSON.stringify(afterWithdraw));
    const storedAfterWithdraw = listProfileClaims(db, { userId: USER_ID, profileId: PROFILE_A });
    check('AG2  and the withdrawal reached the store, not only the screen',
      same(storedAfterWithdraw.skills, CLICK_SKILLS.filter(t => t !== WITHDRAW))
      && same(storedAfterWithdraw.actionVerbs, [CLICK_VERB]),
      JSON.stringify(storedAfterWithdraw));

    // ── 7. THE COPY DOES NOT SELL A NUMBER ─────────────────────────────────────────────────────
    // A chip that reads "add this to improve your score" invites someone to tick things they cannot
    // defend in an interview, for a number that is not the thing being decided. The panel has to
    // say the opposite in so many words, on screen, where it is read.
    const panelText = await page.evaluate(() => document.body.innerText);
    check('AG2  the panel says in plain words that claiming does not change the score',
      /does not change this score/i.test(panelText),
      /does not change this score/i.test(panelText) ? 'the disclaimer is on screen' : 'the disclaimer is absent');
    const SCORE_BAIT = [/improve your score/i, /boost your score/i, /increase your score/i];
    const bait = SCORE_BAIT.filter(re => re.test(panelText)).map(re => re.source);
    check('AG2  and nowhere offers a claim as a way to raise the score',
      bait.length === 0, bait.length ? `found: ${bait.join(', ')}` : 'no score-bait copy anywhere');

    // ── 8. A CLAIM DOES NOT SCORE ITSELF ───────────────────────────────────────────────────────
    // buildRuntimeAtsBasis folds selected_tools/selected_verbs into the text the report scores the
    // resume against. A claim landing there would raise the candidate's own score on their say-so.
    const profileRow = db.prepare(
      'SELECT selected_tools, selected_verbs, selected_keywords FROM domain_profiles WHERE id=?').get(PROFILE_A);
    check("AG2  claiming never wrote the profile's scored term lists",
      profileRow.selected_tools === '[]' && profileRow.selected_verbs === '[]',
      JSON.stringify(profileRow));

    check('AG2  the panel was driven against the in-memory store, not a live server',
      served.has(`/api/domain-profiles/${PROFILE_A}/suggestions`)
      && served.has(`/api/domain-profiles/${PROFILE_A}/claims`),
      `${claimPosts} claim writes, ${suggestionGets} reads, routes: ${[...served].join(' ')}`);

    console.log(`\n  ${beforeShot}\n  ${afterShot}`);

    if (process.env.AG2_KEEP_OPEN) {
      console.log('\nAG2_KEEP_OPEN set — leaving the browser open. Ctrl+C to finish.');
      await new Promise(() => {});
    }
  } finally {
    // The harness files are not part of the app and must not survive the run — including when it
    // throws, which is when a stray client/ag2-harness.html would be easiest to commit by accident.
    for (const f of [HARNESS_HTML, HARNESS_JSX]) { try { fs.unlinkSync(f); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (vite) vite.proc.kill();
    try { db.close(); } catch {}
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('\nHARNESS FAILED:', e); process.exit(1); });
