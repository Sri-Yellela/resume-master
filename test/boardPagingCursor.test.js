import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planPageFetch, recordPageCursor } from "../client/src/lib/boardPaging.js";

/**
 * THE WEB BOARD'S PAGING MODE, and the defect it fixes.
 * ================================================================================================
 *
 * Disliking a job removes it from the server's result set — the default board excludes disliked
 * rows. So pressing Next after disliking four asks for an offset four rows further into a list that
 * is four rows SHORTER, and four jobs are stepped over and never shown.
 *
 * On this board the skip is invisible twice over, which is why it survived: the list does not
 * visibly shrink (JobsPanel re-injects session-disliked rows so they stay on screen, faded), and
 * `total` still counts the skipped rows, so the pager's arithmetic looks right.
 *
 * WHAT IS AND IS NOT BEING CLAIMED HERE. This tests the DECISION — which mode answers which
 * navigation — because that is the whole change and it is the part that can be got wrong silently.
 * It does not prove the board renders correctly; scripts/aj2BoardCursor.mjs drives a real browser
 * against a stubbed API that implements a real cursor, and asserts no job is skipped on screen.
 */

// ── the decision table ─────────────────────────────────────────────────────────────────────────

test("NEXT uses the cursor — this is the navigation the defect lives in", () => {
  const plan = planPageFetch({ target: 2, currentPage: 1, nextCursor: "c1", stack: [null] });
  assert.equal(plan.mode, "cursor");
  assert.equal(plan.cursor, "c1");
  assert.equal(plan.resetChain, false);
});

test("NEXT falls back to offset when no cursor was issued", () => {
  // A last page hands back nextCursor:null, and a cached/restored board has no chain at all.
  // Degrading to the previous behaviour is correct; refusing to navigate is not.
  const plan = planPageFetch({ target: 2, currentPage: 1, nextCursor: null, stack: [null] });
  assert.equal(plan.mode, "offset");
  assert.equal(plan.cursor, null);
  assert.equal(plan.resetChain, false, "a step must not discard a chain it simply could not use");
});

test("PREV replays the request that produced the earlier page", () => {
  // No backwards cursor is needed, and none exists. Going back re-runs the request that built the
  // page — which stays valid even when the row it was issued from has since been disliked, because
  // a cursor carries sort VALUES, not a reference to a row.
  const stack = [null, "c1", "c2"];          // page1 offset, page2 via c1, page3 via c2
  const plan = planPageFetch({ target: 2, currentPage: 3, nextCursor: "c3", stack });
  assert.equal(plan.cursor, "c1");
  assert.equal(plan.mode, "cursor");
  assert.equal(plan.resetChain, false);
});

test("PREV to page 1 uses OFFSET, and must not be mistaken for a broken chain", () => {
  // The bug this pins. stack[0] is `null` — a REAL value meaning "page 1 was fetched by offset".
  // A falsy check here would treat it as "no chain", take the jump branch, and discard a perfectly
  // good chain on every return to page 1.
  const stack = [null, "c1"];
  const plan = planPageFetch({ target: 1, currentPage: 2, nextCursor: "c2", stack });
  assert.equal(plan.cursor, null);
  assert.equal(plan.mode, "offset");
  assert.equal(plan.resetChain, false, "returning to page 1 must not discard the chain");
});

test("PREV into a page this chain never fetched falls back to offset, still without resetting", () => {
  // Same rule as the forward case: a step is a step. Only a jump discards the chain.
  const plan = planPageFetch({ target: 4, currentPage: 5, nextCursor: null, stack: [] });
  assert.equal(plan.cursor, null);
  assert.equal(plan.mode, "offset");
  assert.equal(plan.resetChain, false);
});

test("A JUMP uses offset and resets the chain — a cursor cannot answer 'page 17'", () => {
  // Deliberately NOT fixed by the cursor. The user asked for a POSITION, and offset is the only
  // thing that can answer one. Removing the numbered pager to make everything a cursor would delete
  // random page access — a working feature — to fix a defect that does not live there.
  const plan = planPageFetch({ target: 17, currentPage: 2, nextCursor: "c2", stack: [null, "c1"] });
  assert.equal(plan.mode, "offset");
  assert.equal(plan.cursor, null);
  assert.equal(plan.resetChain, true,
    "after a jump the chain no longer describes where the user is; the next step re-establishes it");
});

test("REFRESHING the page on screen is not a navigation and keeps the chain", () => {
  const plan = planPageFetch({ target: 3, currentPage: 3, nextCursor: "c3", stack: [null, "c1", "c2"] });
  assert.equal(plan.resetChain, false,
    "a refresh after generating a resume must not discard the chain the user is paging through");
});

// ── the stack ──────────────────────────────────────────────────────────────────────────────────

test("recordPageCursor truncates, so an abandoned branch cannot be replayed", () => {
  // Walk to page 3, go back to page 2, then take a DIFFERENT next. Without truncation the stack
  // would still hold page 3's cursor from the abandoned branch, and a later Prev would replay a
  // request belonging to a page the user never came from.
  let stack = [];
  stack = recordPageCursor(stack, 1, null);
  stack = recordPageCursor(stack, 2, "c1");
  stack = recordPageCursor(stack, 3, "c2");
  assert.deepEqual(stack, [null, "c1", "c2"]);

  stack = recordPageCursor(stack, 2, "c1");            // Prev back to 2
  assert.deepEqual(stack, [null, "c1"], "page 3's cursor must not survive going back");
});

test("recordPageCursor does not mutate the stack it is given", () => {
  // The stack lives in a ref. Mutating in place would make the value React sees depend on when it
  // happened to read it, which is the class of bug that only shows up under a re-render.
  const original = [null, "c1"];
  const next = recordPageCursor(original, 3, "c2");
  assert.deepEqual(original, [null, "c1"]);
  assert.deepEqual(next, [null, "c1", "c2"]);
});

test("a full walk forward then back replays exactly the requests that built each page", () => {
  // The property that matters end to end: page N is always fetched by the same request, whichever
  // direction you arrive from. Anything else means the content shifts when you go back.
  let stack = [], nextCursor = null, page = 1;
  const issued = {};                       // page -> the cursor used to fetch it
  const server = { 1: "c1", 2: "c2", 3: "c3", 4: null };   // what each page hands back

  for (page = 1; page <= 4; page++) {
    const plan = page === 1
      ? { cursor: null }
      : planPageFetch({ target: page, currentPage: page - 1, nextCursor, stack });
    issued[page] = plan.cursor;
    stack = recordPageCursor(stack, page, plan.cursor);
    nextCursor = server[page];
  }
  assert.deepEqual(issued, { 1: null, 2: "c1", 3: "c2", 4: "c3" });

  // Now walk back, asserting each Prev reproduces the cursor that originally built that page.
  for (let target = 3; target >= 1; target--) {
    const plan = planPageFetch({ target, currentPage: target + 1, nextCursor, stack });
    assert.equal(plan.cursor, issued[target],
      `Prev to page ${target} must replay the request that built it`);
  }
});

// ── the wiring ─────────────────────────────────────────────────────────────────────────────────

test("JobsPanel routes every navigation through the shared policy", () => {
  // The decision is only worth testing if the component actually asks it. A second copy of the
  // rule inside the click handler is exactly the shape of defect this repository keeps finding.
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  assert.match(panel, /import \{ planPageFetch, recordPageCursor \} from "\.\.\/lib\/boardPaging\.js"/);
  assert.match(panel, /const plan = planPageFetch\(\{/, "goPage must use the shared policy");
  assert.match(panel, /recordPageCursor\(cursorStackRef\.current, page, cursor\)/);
  // And no hand-rolled second decision alongside it.
  assert.ok(!/p === currentPage \+ 1 && nextCursorRef/.test(panel),
    "the inline paging decision must be gone, not merely duplicated");
});

test("the querystring carries cursor OR page, never both", () => {
  // The server ignores `page` when `cursor` is present. Sending both would put a page number in
  // every request that has no bearing on the answer — which reads as meaningful in a network log
  // for months afterwards.
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  assert.match(panel, /if \(cursor\) p\.set\("cursor", cursor\);\s*\n\s*else\s+p\.set\("page", String\(page\)\)/);
});

test("the chain is invalidated from buildParams, not from a hand-listed dependency array", () => {
  // A cursor is bound to the ordering it was issued under, so any filter or sort change
  // invalidates the chain. Deriving the key from buildParams means a filter added later cannot
  // forget to invalidate it — and that omission would not throw, it would silently resume against
  // the wrong ordering.
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  assert.match(panel, /const paramsKey = buildParams\(1, null, options\.overrides \|\| \{\}\)/);
  assert.match(panel, /paramsKey !== paramsKeyRef\.current/);
});

test("a rejected cursor retries by offset instead of surfacing an error", () => {
  // The server answers 400 cursor_sort_mismatch rather than silently resuming against a different
  // ordering. That is a message to the CLIENT, not to the user: the only correct recovery is to
  // ask again by position, and showing "Request failed (400)" for it would be a dead end.
  const panel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  assert.match(panel, /cursor_sort_mismatch/);
  assert.match(panel, /cursor_malformed/);
  assert.match(panel, /falling back to offset/);
});
