#!/usr/bin/env node
/**
 * AL8 (task H) — does a CONFIRMED derived mapping reach the resolver, and does the boundary hold?
 *
 * ── WHY THE TRAP MATRIX IS NOT ENOUGH ──────────────────────────────────────────────────────────
 *
 * scripts/a1TrapMatrix.mjs calls autoApply DIRECTLY, so it never passes `derivedLabelMaps` — the
 * option routes/apply.js supplies. Re-running it after this change proves NO REGRESSION, which it
 * did (G1-G5 held, L1/A1 submitted, the sponsorship-inversion question still refused). It cannot
 * prove the new path WORKS, because it never takes it. This does.
 *
 * ⛔ THE FIELD USED BELOW IS A WIRING PROBE, AND THE MAPPING IS DELIBERATELY ARBITRARY.
 *
 * That needs saying plainly. On the fakeAts forms there is NO field that a derived mapping could
 * legitimately resolve, and the reason is a real finding about task H rather than a limitation of
 * the fixture — see the report at the end. So this probe maps "Additional Information" to a profile
 * key it has no business holding, purely to observe whether an injected mapping travels from
 * routes/apply.js -> autoApply -> discoverAndFill -> discoverFields and changes what gets filled.
 * It is NOT a recommendation and it is never confirmed into the real database.
 *
 * The probe earned its place: the first version of this wiring built the merged map in autoApply
 * and then threw it away, because discoverFields recomputed its own from the provider alone. The
 * fill was unchanged and nothing said why.
 *
 * Requires: node scripts/fakeAts.js
 */
import { autoApply, HANDLER_BY_ATTR, PROFILE_KEY_TO_HANDLER } from "../services/applyAutomation.js";
import { getPlatformLabelMap } from "../services/platformDetector.js";
import { labelKey, forbiddenMapping } from "../services/kb/formFieldMappings.js";

const ATS = "http://localhost:4599";
// Ashby's SPA: `_systemfield_*` beside bare GUIDs. The fixture's own comment says that mix "is the
// real form's, and it is why label-based resolution is not optional here" — so it is the right
// place to test a label-driven mechanism.
const URL = `${ATS}/ashby-spa`;

const PAYLOAD = {
  field_map: {
    full_name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace",
    email: "ada@example.com", phone: "+1 555 0100",
    website_url: "https://ada.dev", location: "Boston, MA",
    available_start_date: "2026-09-01",
  },
  handler_map: {}, custom_answers: {},
};

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

const run = async (derivedLabelMaps) => autoApply(URL, PAYLOAD, {
  mode: "preview", jobId: `al8_${derivedLabelMaps ? "with" : "without"}_${Date.now()}`,
  derivedLabelMaps,
});

const filledOf = (r) => (r.answers || []).filter(a => !a.skipped && !a.policy_rejected);
const find = (list, re) => list.find(a => re.test(`${a.label || ""} ${a.name || ""} ${a.field_id || ""}`));

console.log("=== 1. WITHOUT a derived map ===");
const before = await run(null);
const fBefore = filledOf(before);
const addlBefore = find(fBefore, /additional/i);
check("\"Additional Information\" is unfilled", !addlBefore, addlBefore ? `filled "${addlBefore.value}"` : "unfilled");
console.log(`      fields filled: ${fBefore.length}`);

console.log("\n=== 2. WITH an injected mapping (wiring probe — arbitrary by design) ===");
const derived = { ashby: { [labelKey("Additional Information")]: "location" },
                  generic: { [labelKey("Additional Information")]: "location" } };
const after = await run(derived);
const fAfter = filledOf(after);
const addlAfter = find(fAfter, /additional/i);
check("the injected mapping REACHED discoverFields and filled the field", !!addlAfter,
  addlAfter ? `"${addlAfter.value}"` : "still unfilled — the map did not travel to discovery");
check("it resolved at field_map_exact, not label_fuzzy", addlAfter?.provenance === "field_map_exact",
  addlAfter?.provenance ?? "-");
check("exactly one more field is filled", fAfter.length === fBefore.length + 1,
  `${fBefore.length} -> ${fAfter.length}`);

console.log("\n=== 3. the eligibility boundary, in BOTH runs ===");
for (const [what, r] of [["without", fBefore], ["with", fAfter]]) {
  const s = find(r, /sponsor|authoriz|veteran|gender|ethnic|disabilit/i);
  check(`no eligibility or EEO field is answered (${what} derived map)`, !s,
    s ? `answered "${s.label}" = "${s.value}" — a false attestation` : "none answered");
}
check("the recorder refuses a sponsorship label outright",
  !!forbiddenMapping("I am authorized to work without sponsorship", "location"));
check("...and an innocuous key under an inverted sponsorship question",
  !!forbiddenMapping("Do you now or in the future require sponsorship for work authorization?", "location"));
check("a derived entry cannot override an authored eligibility mapping",
  getPlatformLabelMap("greenhouse", { [labelKey("Work Authorization")]: "location" })["Work Authorization"]
    === "work_authorization");

// ── THE FINDING ────────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. how much headroom a derived table actually has ===");
const authored = getPlatformLabelMap("ashby");
const authoredNeedles = Object.keys(authored);
const rows = [];
for (const b of [...(after.blanks || []), ...fAfter]) {
  const label = b.label || b.field || "";
  if (!label) continue;
  const attrText = `${b.name || ""} ${b.field_id || ""}`.toLowerCase();
  const byAttr = Object.keys(HANDLER_BY_ATTR).find(k => attrText.includes(k.toLowerCase()));
  const byLabel = authoredNeedles.find(k => label.toLowerCase().includes(k.toLowerCase()));
  const key = byLabel ? authored[byLabel] : null;
  rows.push({
    label: label.slice(0, 44),
    resolvedBy: byAttr ? "attribute" : byLabel ? "authored label" : "nothing",
    fillable: key ? !!PROFILE_KEY_TO_HANDLER[key] : false,
  });
}
for (const r of rows) console.log(`   ${r.resolvedBy.padEnd(15)} ${r.label}`);
const gap = rows.filter(r => r.resolvedBy === "nothing");
console.log(`\n   ${gap.length} field(s) resolved by NEITHER attribute nor authored label —`);
console.log(`   the only place a derived mapping can ever help.`);
console.log(`   ⛔ ATTRIBUTES ARE CHECKED FIRST, so a derived label mapping is dead for any field`);
console.log(`      whose control name is recognisable. That bounds task H's headroom far more than`);
console.log(`      the task assumed, and it is measurable rather than a guess.`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
