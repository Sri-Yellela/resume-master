import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

/**
 * TASK AH2 — four tabs, four surfaces, one session.
 *
 * The behavioural proof is scripts/ah2MultiTab.mjs, which drives real Chrome: five surfaces in five
 * tabs at once, a real ctrl-click that really opens a sixth, and two tabs showing two different job
 * details. These tests pin the shapes that made it possible, because two of the three defects were
 * invisible to any amount of source reading and one of them was the ABSENCE of markup.
 *
 * WHAT WAS ACTUALLY WRONG, which is not what the report assumed
 * The panels were already deep-linkable — /app/auto-apply has always rendered Auto Apply when you
 * reach it. What did not exist was any way to GET a second tab: the tab row was
 * `<button onClick={navigate}>`, and a button cannot be ctrl/cmd-clicked, middle-clicked or
 * "Open link in new tab"-ed, and is not a link to assistive tech either.
 *
 * The two genuine bugs:
 *   - a job detail had NO ADDRESS. selectedJob was React state; /app/jobs/<id> redirected to the
 *     bare board. One selectedJob per mount, so two details could never coexist.
 *   - the board's view state was shared PER ORIGIN. rm_jobs_profile_ui_v1 held boardTab,
 *     localSearch, sortBy, currentPage and every filter in localStorage keyed by profile, so two
 *     tabs overwrote each other. currentPage cannot be shared by construction.
 */

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const APP      = read("client/src/App.jsx");
const TOPBAR   = read("client/src/components/TopBar.jsx");
const JOBCARD  = read("client/src/components/JobCard.jsx");
const PANEL    = read("client/src/panels/JobsPanel.jsx");
const JOBURL   = read("client/src/lib/jobUrl.js");
const CONTEXT  = read("client/src/contexts/JobBoardContext.jsx");
const SERVER   = read("server.js");

// ── 1. the tab row is openable in a new tab ──────────────────────────────────────────────────
test("every nav tab is a real link, not a button", () => {
  assert.match(TOPBAR, /<a key=\{t\.id\}/);
  assert.match(TOPBAR, /href=\{hrefForTab\?\.\(t\.id\) \|\| undefined\}/);
  assert.doesNotMatch(TOPBAR, /<button key=\{t\.id\} onClick=\{\(\) => onTabChange/);
});

test("a modified click is left to the browser, a plain click still navigates in-app", () => {
  const nav = TOPBAR.slice(at(TOPBAR, '<a key={t.id}'), at(TOPBAR, "{t.label}</a>"));
  // Without this the href would hijack every click into a full page load, which is a worse
  // regression than the missing affordance it is there to add.
  assert.match(nav, /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0/);
  assert.match(nav, /return;/);
  assert.match(nav, /e\.preventDefault\(\);/);
  assert.match(nav, /onTabChange\?\.\(t\.id\)/);
});

test("the href and the click resolve through ONE mapping", () => {
  // A nav whose href points somewhere its own onClick does not is worse than no href at all:
  // left-click and middle-click would land in different places and only one of them would be a bug
  // anyone noticed.
  assert.match(APP, /const pathForTab = useCallback\(\(tab\) => \{/);
  assert.match(APP, /if \(tab === "jobs" \|\| tab === "console"\) return consolePath;/);
  assert.match(APP, /return NAVIGABLE_TABS\.has\(tab\) \? `\/app\/\$\{tab\}` : null;/);
  assert.match(APP, /hrefForTab=\{pathForTab\}/);
  assert.match(APP, /onTabChange=\{handlePanelChange\}/);
  // handlePanelChange must still route through the same rule rather than keeping its own copy.
  const handler = APP.slice(at(APP, "const handlePanelChange = useCallback"), at(APP, "const handleProfileActivate"));
  assert.match(handler, /NAVIGABLE_TABS\.has\(tab\)/);
});

// ── 2. a job detail has an address ───────────────────────────────────────────────────────────
test("the job-detail address is defined in exactly one place", () => {
  assert.match(JOBURL, /export const JOB_URL_PARAM = "job"/);
  assert.match(JOBURL, /export function jobDetailHref\(jobId\)/);
  assert.match(JOBURL, /export function jobIdFromSearch\(search\)/);
  // Both sides import it. Two spellings of "job" would be a link that opens the board and nothing
  // else — a failure that looks exactly like the feature not existing.
  assert.match(JOBCARD, /import \{ jobDetailHref \} from "\.\.\/lib\/jobUrl\.js"/);
  assert.match(PANEL, /import \{ JOB_URL_PARAM, jobIdFromSearch \} from "\.\.\/lib\/jobUrl\.js"/);
  // And neither BUILDS the URL itself. Matched against a quoted/templated literal rather than the
  // bare string, so the prose comment explaining the address does not count as a second copy.
  assert.doesNotMatch(JOBCARD, /[`'"]\/app\/jobs\?job=/);
  assert.doesNotMatch(PANEL, /[`'"]\/app\/jobs\?job=/);
});

test("a job card's title carries that address", () => {
  assert.match(JOBCARD, /function JobTitleLink\(\{ job, isLoggedOut, style, children \}\)/);
  assert.match(JOBCARD, /const href = jobDetailHref\(job\.jobId \|\| job\.id\)/);
  // Logged out there is no /app to link into, and the card's whole click already goes to the
  // employer's posting.
  assert.match(JOBCARD, /if \(isLoggedOut \|\| !href\) return <div style=\{style\}>\{children\}<\/div>/);
  // Used at BOTH title render sites — the card has a tier-1 and a tier-2 layout, and fixing one
  // would leave the affordance missing at whichever width renders the other.
  assert.equal((JOBCARD.match(/<JobTitleLink job=\{job\} isLoggedOut=\{isLoggedOut\}/g) || []).length, 2);
  assert.doesNotMatch(JOBCARD, /whiteSpace:"nowrap" \}\}>\n\s*\{job\.title\}\n\s*<\/div>/);
});

test("the panel resolves a deep-linked job BY ID, not by hoping it is on the page", () => {
  assert.match(PANEL, /api\(`\/api\/jobs\/by-id\/\$\{encodeURIComponent\(wanted\)\}`\)/);
  // The board is paginated, profile-scoped and filtered, so whether a given posting is in the
  // current response is incidental. A deep link that only works when the job happens to be loaded
  // is the no-op failure mode.
  assert.match(SERVER, /app\.get\("\/api\/jobs\/by-id\/:jobId", requireAuth/);
  const route = SERVER.slice(at(SERVER, 'app.get("/api/jobs/by-id/:jobId"'), at(SERVER, 'app.get("/api/jobs/pending"'));
  assert.match(route, /uj\.user_id = \? AND uj\.domain_profile_id = \?/);
  assert.match(route, /WHERE sj\.job_id = \?/);
  assert.match(route, /404\).json\(\{ error: "Job not found" \}\)/);
  // Deliberately NOT is_active-filtered and NOT role-scoped: the caller named a specific posting.
  assert.doesNotMatch(route, /sj\.is_active = 1/);
  assert.doesNotMatch(route, /job_role_map/);
});

test("the deep link survives the profile-cache restore that used to undo it", () => {
  // This is why it is not one setSelectedJob. The profile-cache restore fires when activeProfileKey
  // first arrives and resets the selection to whatever THAT PROFILE last had, which for a tab opened
  // on a link is nothing — so the panel flashed open and shut and the URL went back to a bare
  // /app/jobs. The effect re-applies until something says to stop.
  assert.match(PANEL, /const deepLinkedJobIdRef = useRef\(jobIdFromSearch\(\)\)/);
  assert.match(PANEL, /if \(selectedJob\?\.jobId === deepLinkedJob\.jobId\) return;/);
  // And the state->URL sync must not strip the param before the link has landed.
  assert.match(PANEL, /if \(!next && deepLinkedJobIdRef\.current\) return;/);
  // The id is captured at first render, because the sync effect rewrites the query string — reading
  // window.location later would read this component's own overwrite.
  const declIdx = PANEL.indexOf("const deepLinkedJobIdRef = useRef(jobIdFromSearch())");
  const syncIdx = PANEL.indexOf("window.history.replaceState");
  assert.ok(declIdx !== -1 && syncIdx !== -1 && declIdx < syncIdx);
});

test("the deep link ends on an EXPLICIT signal, never on a timing guess", () => {
  // The first attempt cleared the ref as soon as the effect saw the selection match, which RACED
  // the restore: in the render where activeProfileKey arrives, the restore's setSelectedJob(null) is
  // queued but this effect's closure still holds the old selection, so it saw a match, cleared, and
  // the null landed next render with nothing left to re-apply it. It passed one run and failed the
  // next on the same build — the signature of exactly that kind of guess.
  assert.match(PANEL, /const clearDeepLink = useCallback\(\(\) => \{ deepLinkedJobIdRef\.current = null; \}, \[\]\)/);
  assert.doesNotMatch(PANEL, /if \(activeProfileKey != null\) deepLinkedJobIdRef\.current = null/);

  // Every path by which the deep-linked selection legitimately ends must say so. Missing one means
  // the panel reopens itself after the user closed it.
  assert.match(PANEL, /close: \(\) => \{ clearDeepLink\(\); setSelectedJob\(null\); \}/);        // close button
  assert.match(PANEL, /if \(e\.key === "Escape"\) \{ clearDeepLink\(\); setSelectedJob\(null\); return; \}/); // Escape
  const select = PANEL.slice(at(PANEL, "const handleJobSelect = useCallback"), at(PANEL, "// ── AH2: the open job detail lives IN THE URL"));
  assert.match(select, /clearDeepLink\(\);/);                                                      // picking another card
  // A real profile SWITCH ends it; the FIRST arrival of a profile key does not, because that is the
  // restore the whole arrangement exists to survive.
  assert.match(PANEL, /if \(prevKey\) deepLinkedJobIdRef\.current = null;/);
});

// ── 3. two tabs on the board do not fight ────────────────────────────────────────────────────
test("the board's view snapshot is per tab, with the origin-wide copy as a seed", () => {
  const reader = PANEL.slice(at(PANEL, "function readProfileUiCache"), at(PANEL, "function writeProfileUiCache"));
  // sessionStorage FIRST. Reading localStorage first would make the shared copy authoritative
  // again and reintroduce exactly the clobbering this fixes.
  assert.ok(reader.indexOf("sessionStorage.getItem") < reader.indexOf("localStorage.getItem"));

  const writer = PANEL.slice(at(PANEL, "function writeProfileUiCache"), at(PANEL, "// Upstream scrape requests"));
  assert.match(writer, /put\(sessionStorage\)/);
  assert.match(writer, /put\(localStorage\)/);
  // Two independent try blocks: a full localStorage quota must not be able to take the tab's own
  // copy down with it, which one shared try would have done.
  assert.match(writer, /const put = \(store\) => \{\s*try \{/);
});

test("currentPage is in the per-tab snapshot — it is the key that cannot be shared", () => {
  const writer = PANEL.slice(at(PANEL, "function writeProfileUiCache"), at(PANEL, "// Upstream scrape requests"));
  assert.match(writer, /"boardTab", "localSearch", "sortBy", "currentPage"/);
});

test("deleting a profile clears BOTH stores", () => {
  const fn = CONTEXT.slice(at(CONTEXT, "const deleteProfileCache"), at(CONTEXT, "return ("));
  assert.match(fn, /for \(const store of \[sessionStorage, localStorage\]\)/);
  // Clearing only the seed left a deleted profile's board state alive in whichever tab had it open.
  assert.match(fn, /delete all\[String\(profileId\)\]/);
});
