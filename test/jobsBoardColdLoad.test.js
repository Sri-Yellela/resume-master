// Regression guard for the cold-load board wipe.
//
// Symptom: on every fresh login the board loaded its jobs, rendered them, and then blanked to
// "0 jobs" with the generic "search for a role above" empty state about 300ms later. Only a
// manual reload brought it back, and nothing was logged — the board just quietly lied about
// having no jobs. Confirmed identical at 1966a03, so it long predated the tier work.
//
// Cause, traced in a real browser: the debounced local-search effect has the dep array
// [localSearch]. localSearch starts "" and never changes on a cold load, so the effect ran
// exactly once — at mount — and its 300ms timer kept the `fetchJobs` closure from the FIRST
// render. On that render /api/domain-profiles had not answered, so activeDomainProfile was null.
// When the timer fired, that dead closure took fetchJobs' "no active profile" branch and called
// setJobs([]), erasing the jobs a later, healthy fetch had already delivered. Nothing refetched
// afterwards because no dependency had changed.
//
// Two independent defects, so two independent guards — either alone would have prevented the
// wipe, and both are cheap:
//   1. the effect must not fire on mount at all, and must call through fetchJobsRef so a stale
//      closure is impossible;
//   2. fetchJobs must not clear the board merely because the profile list has not arrived yet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

function debounceEffect() {
  const i = panel.indexOf("// Debounced backend search");
  assert.notEqual(i, -1, "the debounced-search effect's comment anchor moved");
  const end = panel.indexOf("}, [localSearch]", i);
  assert.notEqual(end, -1, "the debounced-search effect no longer keys off [localSearch]");
  return panel.slice(i, end);
}

test("the debounced search does not fire on mount", () => {
  const body = debounceEffect();
  assert.match(body, /searchDebounceReady/,
    "no mount-skip guard: the effect fires once at mount for a search string nobody typed");
  assert.match(body, /if \(!searchDebounceReady\.current\) \{ searchDebounceReady\.current = true; return; \}/);
});

test("the mount-skip is checked before the user guard, or the first real search is swallowed", () => {
  const body = debounceEffect();
  const skipAt = body.indexOf("searchDebounceReady.current = true");
  const userAt = body.indexOf("if (!user) return;");
  assert.ok(skipAt !== -1 && userAt !== -1);
  assert.ok(skipAt < userAt,
    "mounting logged-out would leave the flag unset, so the user's first typed search would be " +
    "consumed by the mount-skip instead of searching");
});

test("the debounced search calls through fetchJobsRef, never a captured fetchJobs", () => {
  const body = debounceEffect();
  assert.match(body, /fetchJobsRef\.current\?\.\(1\)/,
    "calling the captured fetchJobs here re-creates the stale-closure wipe: the timer outlives " +
    "the render it was created in, and that render had no profile yet");
  assert.ok(!/[^.]\bfetchJobs\(1\)/.test(body), "still calls the captured fetchJobs directly");
});

test("fetchJobs does not clear the board while the profile list is still loading", () => {
  const i = panel.indexOf("if (!activeDomainProfile) {");
  assert.notEqual(i, -1);
  const branch = panel.slice(i, at(panel, "return;", i));
  assert.match(branch, /profilesLoadedRef\.current/,
    "the no-profile branch clears unconditionally, so any caller arriving before " +
    "/api/domain-profiles answers wipes an already-loaded board");
  // The clear must be INSIDE the loaded check, not merely mentioned nearby.
  const guardAt = branch.indexOf("if (profilesLoadedRef.current)");
  const clearAt = branch.indexOf("setJobs([])");
  assert.ok(guardAt !== -1 && clearAt !== -1 && guardAt < clearAt,
    "setJobs([]) must sit inside the profiles-loaded check");
});

test("profilesLoadedRef is only set once the profiles request actually resolves", () => {
  // If it were initialised true, or set before the await, the guard above would be decorative.
  assert.match(panel, /const profilesLoadedRef = useRef\(false\)/);
  const i = panel.indexOf('api("/api/domain-profiles")');
  const block = panel.slice(i, i + 600);
  assert.match(block, /\.then\(rows => \{[\s\S]*profilesLoadedRef\.current = true/,
    "the flag must be set in the .then, so an unanswered or failed request still counts as " +
    "'not loaded' and the board is left alone");
});

test("an empty profile list still clears the board — the legitimate case is preserved", () => {
  // A new account genuinely has no profiles: profilesLoadedRef becomes true with an empty list,
  // so the clear runs and setupBlock takes over. The fix must not have disabled that.
  const i = panel.indexOf('api("/api/domain-profiles")');
  const block = panel.slice(i, i + 600);
  assert.match(block, /const profiles = Array\.isArray\(rows\) \? rows : \[\];/);
  assert.match(block, /profilesLoadedRef\.current = true;\s*\n\s*setDomainProfiles\(profiles\);/,
    "the flag is set for every resolved response, including an empty list");
});
