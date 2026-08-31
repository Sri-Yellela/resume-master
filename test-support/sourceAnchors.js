// ── FINDING AN ANCHOR IN SOURCE TEXT, LOUDLY ────────────────────────────────────────────────────
//
// THE DEFECT THIS EXISTS TO FIX, which is subtle enough that it survived 182 call sites.
//
// Most tests in this suite assert against a REGION of a source file, carved out with indexOf:
//
//     const fn = src.slice(src.indexOf("function buildRuntimeInputs"), src.indexOf("// PDF gen"));
//     assert.match(fn, /something/);
//
// When an anchor moves — a function is renamed, a divider comment is reworded, a block is
// reordered — `indexOf` returns **-1**. It does not throw. And `slice` does not treat -1 as an
// error either: it reads a negative index as an offset from the END of the string. So:
//
//     slice(-1, 5000)   ->  starts at the LAST CHARACTER, yields ""      (assertions may now fail
//                                                                        for a reason that has
//                                                                        nothing to do with the code)
//     slice(1200, -1)   ->  runs to one char from the end of the WHOLE FILE — a region hundreds of
//                           times larger than intended, which very often still contains the string
//                           being matched, so the test KEEPS PASSING while checking nothing.
//
// The second case is the dangerous one: the test does not fail, it silently stops being about the
// thing it names. That is this project's Shape 5 — a test that pins the wrong thing — and it was
// found for real: three tests anchored on divider comments that a UTF-8 repair was about to
// rewrite. Had those been left alone, repairing the dividers would not have failed CI; the tests
// would have widened to most of server.js and gone on passing.
//
// So: never let a missing anchor become a number. `at()` throws.
//
// WHY A HELPER AND NOT A LINT RULE. The failure is at runtime and the fix has to be at the call
// site, because only the call site knows which two anchors were meant. A rule could flag the shape
// but could not repair it, and a flagged-but-unfixed shape is how 182 of these accumulated.
//
// WHY THIS DIRECTORY. `node --test` with no arguments discovers `**/test/**/*.js` — EVERY .js file
// under test/, not just *.test.js. A helper placed at test/helpers/ is loaded and executed as if it
// were a test file (verified: a throwing file there fails the run; the same file here does not).
// Hence test-support/, which matches none of the default patterns.

/**
 * Index of `needle` in `source`, or throw.
 *
 * Drop-in for `source.indexOf(needle[, from])` at any site whose result feeds a slice.
 *
 * @param {string} source     the text being searched
 * @param {string|RegExp} needle  the anchor
 * @param {number} [fromIndex] same meaning as String#indexOf's second argument
 * @param {string} [label]    optional context for the error, e.g. the file the source came from
 * @returns {number} a real index, never -1
 */
export function at(source, needle, fromIndex = 0, label = "") {
  // Arrays are accepted as well as strings. `[].indexOf` returns -1 exactly like the string form,
  // and `[].slice` reads a negative start from the end exactly like the string form, so an array
  // anchor is the same defect wearing different clothes.
  if (typeof source !== "string" && !Array.isArray(source)) {
    throw new TypeError(`at(): source must be a string or array, got ${typeof source}`);
  }
  const index = (needle instanceof RegExp && typeof source === "string")
    ? searchFrom(source, needle, fromIndex)
    : source.indexOf(needle, fromIndex);
  if (index === -1) throw new Error(missingAnchor(needle, fromIndex, label));
  return index;
}

/**
 * Index of the LAST `needle` in `source`, or throw. Drop-in for `source.lastIndexOf(...)`.
 */
export function lastAt(source, needle, fromIndex = undefined, label = "") {
  if (typeof source !== "string" && !Array.isArray(source)) {
    throw new TypeError(`lastAt(): source must be a string or array, got ${typeof source}`);
  }
  const index = fromIndex === undefined
    ? source.lastIndexOf(needle)
    : source.lastIndexOf(needle, fromIndex);
  if (index === -1) throw new Error(missingAnchor(needle, fromIndex, label));
  return index;
}

function searchFrom(source, re, fromIndex) {
  const rest = source.slice(fromIndex);
  const m = rest.search(re);
  return m === -1 ? -1 : m + fromIndex;
}

function missingAnchor(needle, fromIndex, label) {
  const shown = String(needle).replace(/\n/g, "\\n").slice(0, 120);
  return [
    `source anchor not found: "${shown}"`,
    label ? ` in ${label}` : "",
    fromIndex ? ` (searching from index ${fromIndex})` : "",
    "\n\nThe code this test reads has moved or been reworded. Update the anchor to match the",
    "\ncurrent source — do NOT delete this call and go back to a bare indexOf: -1 is a legal",
    "\nslice argument, so the test would resume passing while asserting over the wrong region.",
  ].join("");
}
