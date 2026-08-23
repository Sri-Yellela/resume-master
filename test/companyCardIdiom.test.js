// ── TASK AC3: company cards in the ManageJobProfiles idiom ───────────────────────────────────
//
// The company tier was a HEADING followed by full-width application cards, one per row down the
// whole page — four employers took four screens and no two could be compared. JobProfilesPanel had
// already solved that shape.
//
// The requirement is specific about HOW: "Read ManageJobProfiles and REUSE its card primitive. Do
// not clone the styling into a second implementation; if it is not extractable, say so and report
// why before diverging." So what is asserted here is mostly the REUSE, not the appearance — a
// second implementation that happens to look identical today is the failure mode, and it is
// invisible to a screenshot. The appearance is checked in a real browser by scripts/abPanelUi.mjs,
// which drives BOTH panels so the profile cards can be shown unchanged after the extraction.
//
// IT WAS EXTRACTABLE. The card was inline JSX rather than a component, but it was already a clean
// four-part shape with no profile-specific logic in its LAYOUT: header (title + pill), metadata
// line, inset sub-block, footer action row. Everything profile-specific — the resume upload input,
// the Edit/Switch/Delete handlers — is content, passed in. So it came out whole.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const tile     = read("client/src/components/ui/TileCard.jsx");
const profiles = read("client/src/panels/JobProfilesPanel.jsx");
const panel    = read("client/src/panels/AutoApplyPanel.jsx");
const sections = read("client/src/panels/AutoApplyPanelSections.jsx");

test("AC3: the primitive was EXTRACTED — JobProfilesPanel renders it rather than keeping a copy", () => {
  // The whole requirement. If JobProfilesPanel still holds the inline card, then whatever the Auto
  // Apply panel renders is a second implementation, however similar it looks on the day it lands.
  assert.match(profiles, /import \{ TileGrid, TileCard, TilePill \} from "\.\.\/components\/ui\/TileCard\.jsx"/);
  assert.match(profiles, /<TileGrid min=\{260\} gap=\{14\}>/);
  assert.match(profiles, /<TileCard/);
  assert.match(profiles, /<TilePill>Active<\/TilePill>/);

  // And the inline card it used to hold is gone — not merely unused beside its replacement.
  assert.ok(!/gridTemplateColumns:"repeat\(auto-fill, minmax\(260px, 1fr\)\)"/.test(profiles),
    "JobProfilesPanel still declares its own card grid");
  assert.ok(!/borderRadius:16,\s*\n\s*padding:"16px 18px",\s*\n\s*boxShadow:"var\(--shadow-sm\)"/.test(profiles),
    "JobProfilesPanel still declares its own card frame — the primitive is a clone, not an extraction");
});

test("AC3: the values in the primitive are the profile card's own, not re-invented lookalikes", () => {
  // An "extraction" that rounds 16 to 12 and 18 to 16 on the way out is a rewrite. These are the
  // numbers that were in JobProfilesPanel before the move.
  for (const value of [
    /borderRadius: 16/,                                   // the tile frame
    /padding: "16px 18px"/,
    /boxShadow: "var\(--shadow-sm\)"/,
    /color-mix\(in srgb, var\(--color-primary\) 9%, transparent\)/,  // the active tint
    /borderRadius: 12/,                                   // the inset
    /padding: "10px 12px"/,
    /background: "var\(--color-surface-offset\)"/,
    /minHeight: 36/,                                      // the body line
    /repeat\(auto-fill, minmax\(\$\{min\}px, 1fr\)\)/,     // the grid
  ]) {
    assert.match(tile, value, `a value was changed on the way out of JobProfilesPanel: ${value}`);
  }
  // CSS vars, not the `theme` object: theme.jsx publishes a live bridge between them, so keeping
  // the vars means this is the profile card's own styling language unaltered. Converting it would
  // have been a rewrite that happened to look the same today.
  // Comments stripped: the file's own note EXPLAINS the theme bridge by naming theme.accent, and a
  // check that fails on its own rationale is a check nobody will keep.
  const tileCode = tile.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/theme\./.test(tileCode), "the primitive was translated to theme lookups instead of moved");
});

test("AC3: the Auto Apply panel renders the SAME primitive, in a grid", () => {
  assert.match(panel, /import \{ TileGrid \} from "\.\.\/components\/ui\/TileCard\.jsx"/);
  assert.match(sections, /import \{ TileCard, TilePill \} from "\.\.\/components\/ui\/TileCard\.jsx"/);
  assert.match(sections, /export function CompanyTile\(/);
  assert.match(sections, /<TileCard/);
  // Requirement 3: side by side at desktop, stacked at narrow. auto-fill with a min track does both
  // without a media query — below the min there is room for one and they stack.
  // The COMPANY grids, identified by their own min track. AC4 added a fifth TileGrid for the dated
  // history's three outcome groups — a different thing at a different width — so counting every
  // grid in the file would make this fail on any unrelated reuse of the primitive, which is the
  // opposite of what it is for.
  const grids = [...panel.matchAll(/<TileGrid min=\{(\d+)\}/g)].map(m => Number(m[1]));
  const companyGrids = grids.filter(g => g === 430);
  assert.equal(companyGrids.length, 4,
    `expected four company tile grids, found ${companyGrids.length} (all grids: ${grids.join(', ')})`);
});

test("AC3: all FOUR company groupings became tiles — none was left as a full-width list", () => {
  // needsReview, submitted, broke, heldOnPurpose. Leaving one behind would make the page read as a
  // tiled section above a listed one, which is worse than either alone.
  for (const section of ["needsReview", "submitted", "broke", "heldOnPurpose"]) {
    assert.match(panel, new RegExp(`section="${section}"`), `${section} is still a full-width list`);
  }
  // And the heading-plus-rows shape it replaced is gone from the panel body. CompanyHeading itself
  // survives — the MODAL still uses it, where a tier marker is right and a tile would be a card
  // inside a card.
  assert.ok(!/<CompanyHeading company=\{company\} count=\{items\.length\} theme=\{theme\} \/>[\s\S]{0,400}?<ApplicationRow/.test(panel),
    "a company heading still leads a full-width row list");
});

test("AC3 requirement 2: name, count, a compact application list, and a footer action row", () => {
  assert.match(panel, /title=\{companyLabel\(company\)\}|company=\{company\}/);
  assert.match(panel, /meta=\{`\$\{items\.length\} application\$\{items\.length === 1 \? "" : "s"\} · \$\{toResolve\} thing/);
  assert.match(sections, /export function CompanyApplicationRow\(/);
  assert.match(sections, /\{app\.reasons\.length\} to resolve/);
  assert.match(panel, /Review all \{items\.length\} →/);
  // The footer action must be SCOPED to that company — AC1's lesson, one tier up. A company-level
  // control that opened the everything view would be the same defect in a new place.
  assert.match(panel, /const openCompanyReview = \(company, items\) => openScoped\(\{/);
  assert.match(panel, /onClick=\{\(\) => openCompanyReview\(company, items\)\}/);
});

test("AC3 requirement 4: triage without opening anything — count AND held-vs-broke at card level", () => {
  // Both, at BOTH tiers. The tile says which kind of trouble the employer is in; each row says which
  // kind that application is in. Losing either would make the tile a link rather than a triage
  // surface, which is the whole point of the compaction.
  assert.match(panel, /pillText=\{allGone \? "posting gone" : allProtective \? "held on purpose" : "needs you"\}/);
  assert.match(sections, /app\.postingGone \? "the posting is gone"[\s\S]{0,200}?app\.protective \? "held on purpose" : "did not complete"/);
  // One broken application is enough to stop calling the whole tile deliberate — the same rule
  // groupByApplication uses within one application, applied one tier up.
  assert.match(panel, /const allProtective = items\.every\(a => a\.protective\)/);
});

test("AC3: nothing was dropped from the row on the way to being compact", () => {
  // FEATURE PRESERVATION. The compact row keeps every control the full-width card had except the
  // problem SENTENCES, which moved into the modal AC2 restructured to hold them — and the row still
  // states how many there are, so nothing is hidden without being counted.
  const row = sections.slice(sections.indexOf("export function CompanyApplicationRow"));
  for (const control of [
    /Resume PDF ↗/, /Generate a resume/, /What we filled ↗/, /ATS \{app\.atsScore\}/,
    /The posting ↗/, /Run it again/, /posting gone — cannot be resumed/, /\{resolveLabel \|\| "Open"\}/,
    /Details/,
  ]) {
    assert.match(row, control, `a control was dropped from the compact row: ${control}`);
  }
  // The data hooks survive, so the real-browser AB2 checks can still say WHICH application a row is
  // for and how many problems it has. That count is the defect AB2 fixed; an assertion that
  // silently stopped covering it would be worse than one that fails.
  assert.match(row, /data-rm-card="application"/);
  assert.match(row, /data-rm-obstacles=\{app\.reasons\.length\}/);
});

test("AC3: submitted and broke tiles keep their existing rows verbatim", () => {
  // A submitted application's evidence — the date, the exact resume that went out, the screenshot,
  // whether the site confirmed it — is what a user reaches for when an interview lands. Compacting
  // that would trade away the thing the section exists for, so those tiles wrap ApplicationRow
  // unchanged rather than swapping in the compact row.
  assert.match(panel, /section="submitted"[\s\S]{0,600}?<ApplicationRow key=\{job\.id\} job=\{job\} theme=\{theme\} variant="submitted"/);
  assert.match(panel, /section="broke"[\s\S]{0,1400}?variant="stopped"[\s\S]{0,600}?onGenerateResume=/);
});
