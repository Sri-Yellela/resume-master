// THE BOARD'S LISTINGS (TASK AE5) — two per row, a real logo, and Queue Auto in the last slot.
//
// The rendered facts — two equal columns that stack, an <img> that actually appears, a button that
// actually queues — are verified in a real Chrome by scripts/ae5BoardUi.mjs, because none of them
// can be read off the source. What is pinned HERE is the set of structural decisions that made those
// facts possible, and that a later change could undo without touching anything the harness runs on:
// one CompanyIcon rather than three, one domain table rather than two, and the pass list keeping a
// home now that it has lost its place on the card.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const jobCard   = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
const detail    = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8");
const tile      = fs.readFileSync("client/src/components/ui/TileCard.jsx", "utf8");
const icon      = fs.readFileSync("client/src/components/ui/CompanyIcon.jsx", "utf8");

// ── One CompanyIcon ──────────────────────────────────────────────────────────

test("THE DEFECT THAT HID AE5's LOGO FIX: CompanyIcon exists exactly ONCE", () => {
  // It existed three times — JobCard, JobDetailPanel, JobsPanel — byte-identical apart from a
  // default size and a corner radius. The logo fallback was added to JobsPanel's copy; the board
  // renders JobCard's; the change did nothing at all on the surface it was written for. Three
  // copies of a component is not a tidiness complaint, it is a class of silent no-op.
  const defs = [];
  for (const f of [
    "client/src/components/JobCard.jsx", "client/src/components/JobDetailPanel.jsx",
    "client/src/panels/JobsPanel.jsx", "client/src/components/ui/CompanyIcon.jsx",
  ]) {
    const src = fs.readFileSync(f, "utf8");
    if (/function CompanyIcon\s*\(/.test(src)) defs.push(f);
  }
  assert.deepEqual(defs, ["client/src/components/ui/CompanyIcon.jsx"],
    `CompanyIcon is defined in more than one place: ${defs.join(", ")}`);
});

test("every surface that shows a company avatar imports that one", () => {
  for (const [name, src] of [["JobCard", jobCard], ["JobDetailPanel", detail], ["JobsPanel", jobsPanel]]) {
    if (!/<CompanyIcon/.test(src)) continue;
    assert.match(src, /import CompanyIcon from ".*ui\/CompanyIcon\.jsx"/,
      `${name} renders CompanyIcon without importing the shared one`);
  }
});

test("the avatar prefers the row's own logo, then the known table, then the letter", () => {
  // Order matters and all three rungs matter. The row's `companyIconUrl` came from the feed that
  // found the job and is the most specific thing we know; the table fills in the majority of rows,
  // whose feeds carry no logo at all; the lettered tile is what an unknown company gets.
  assert.match(icon, /const resolved = iconUrl \|\| getKnownLogoUrl\(company\)/);
  assert.match(icon, /if \(resolved && !failed\)/);
  assert.match(icon, /onError=\{\(\) => setFailed\(true\)\}/,
    "a URL that 404s has to fall back to the letter at runtime");
});

// ── One domain table ─────────────────────────────────────────────────────────

test("the logo table lives in ONE place, and the server's enrichment reads it from there", () => {
  const shared  = fs.readFileSync("shared/companyLogos.js", "utf8");
  const enrich  = fs.readFileSync("services/jobs/enrichLogos.js", "utf8");
  assert.match(shared, /export const KNOWN_DOMAINS = \{/);
  assert.match(shared, /export function getKnownLogoUrl/);
  // The server-side module must not carry its own copy — a 60-entry table duplicated across the
  // client/server boundary is one half of the app resolving a company differently from the other.
  assert.ok(!/^const KNOWN_DOMAINS = \{/m.test(enrich),
    "enrichLogos.js has its own KNOWN_DOMAINS again");
  assert.match(enrich, /from '\.\.\/\.\.\/shared\/companyLogos\.js'/);
  // And the part that needs the network stayed where the network is.
  assert.match(enrich, /export async function fetchLogoUrl/);
  // Comments stripped: the module's own note EXPLAINS the split by naming axios, and a check that
  // fails on its own rationale is a check nobody keeps.
  const sharedCode = shared.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/axios|require\(|node:/.test(sharedCode),
    "the shared module must stay importable by the browser");
});

test("A GUESS IS NOT A LOGO — an unknown company resolves to null, not a slug", async () => {
  const { getKnownLogoUrl, companyToDomain } = await import("../shared/companyLogos.js");
  // companyToDomain's slug fallback is for the enrichment path, which verifies with a HEAD request.
  // Handing the same guess to an <img> would render a broken image for every small employer.
  assert.equal(companyToDomain("Brightmoor Analytics Group"), "brightmooranalytics.com");
  assert.equal(getKnownLogoUrl("Brightmoor Analytics Group"), null);
  assert.equal(getKnownLogoUrl("OpenAI"), "https://logo.clearbit.com/openai.com");
});

// ── Two per row ──────────────────────────────────────────────────────────────

test("the listings use the shared grid primitive, capped at two columns", () => {
  assert.match(jobsPanel, /import \{ TileGrid \} from "\.\.\/components\/ui\/TileCard\.jsx"/,
    "the Database/Auto Apply card idiom is imported, not reimplemented");
  assert.match(jobsPanel, /<TileGrid min=\{430\} gap=\{14\} maxColumns=\{2\}/);
  assert.match(jobsPanel, /<\/TileGrid>/);
});

test("the cap is opt-in, so the profile and company tiles are untouched", () => {
  // AutoApplyPanel and JobProfilesPanel want "as many as fit", which is the original behaviour and
  // has to stay the default — a cap applied to everything would silently re-lay-out two other panels.
  assert.match(tile, /maxColumns = null/);
  assert.match(tile, /: `minmax\(\$\{min\}px, 1fr\)`/);
  for (const f of ["client/src/panels/AutoApplyPanel.jsx", "client/src/panels/JobProfilesPanel.jsx"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/maxColumns/.test(src), `${f} started passing maxColumns — its grid was not meant to change`);
  }
});

test("the gap is subtracted before the row is divided", () => {
  // N columns of exactly 100/N% plus the gaps between them overflow the row, and auto-fill then
  // collapses to N-1 — the cap would silently do the opposite of what it says.
  assert.match(tile, /calc\(\(100% - \$\{\(maxColumns - 1\) \* gap\}px\) \/ \$\{maxColumns\}\)/);
});

test("the card's own horizontal margin moved onto the grid", () => {
  // A per-card margin inside a grid cell insets each cell separately, so two columns end up with
  // 32px of nothing between them ON TOP of the gap.
  assert.match(jobCard, /margin: 0,/);
  assert.ok(!/margin: "0 16px 8px"/.test(jobCard), "the card is inside a grid now; the grid owns the spacing");
  assert.match(jobsPanel, /style=\{\{ padding: "0 16px 8px" \}\}/);
  // The two lists that are NOT grids had to take that spacing over, or their cards go flush.
  const db = fs.readFileSync("client/src/panels/DatabasePanel.jsx", "utf8");
  assert.equal((db.match(/display:"flex", flexDirection:"column", gap:8, padding:"8px 16px 16px"/g) || []).length, 2,
    "DatabasePanel's two card lists must supply the spacing JobCard stopped carrying");
});

// ── Queue Auto, and where Pass went ──────────────────────────────────────────

test("the listing offers QUEUE AUTO, and reports when the job is already queued", () => {
  assert.match(jobCard, /const \{ addToApplyQueue, applyQueue \} = useAutoApply\(\)/,
    "read off the shared context, the same way ApplyStateChip in this file already does");
  assert.match(jobCard, /const queued = \(applyQueue \|\| \[\]\)\.some\(item => item\.jobId === queueKey\)/);
  assert.match(jobCard, /title=\{queued \? "Already in the auto-apply queue" : "Add to auto-apply queue"\}/);
  assert.match(jobCard, /disabled=\{queued\}/,
    "a button that fires twice would queue the same job twice");
  // Only offered when there is somewhere to apply. A listing with no URL cannot be queued.
  assert.match(jobCard, /const canQueue = !!\(job\.applyUrl \|\| job\.url\) && !!queueKey/);
});

test("THE PASS LIST KEPT A HOME — dislike is a query filter, not a preference", () => {
  // Checked before it was moved, and this is the record of why it could be. `uj.disliked = 0` is a
  // WHERE clause on the board query, the poll query and the facet counts; routes/adminDb.js reports
  // "disliked" as a reason a job was filtered out. Removing the affordance without leaving one
  // somewhere would have made a load-bearing filter unreachable.
  const server = fs.readFileSync("server.js", "utf8");
  assert.ok((server.match(/uj\.disliked\s+IS NULL OR uj\.disliked\s+= 0/g) || []).length >= 2,
    "the board still filters on disliked, so the user must still be able to set it");
  assert.match(server, /app\.patch\("\/api\/jobs\/:id\/disliked"/);
  // And the surface that sets it.
  assert.match(detail, /onDislike && \(/);
  assert.match(detail, /title="Not interested"/);
  assert.match(detail, /Pass\s*<\/ActionBtn>/);
  // JobsPanel still wires it through, so the detail panel's action is live rather than decorative.
  assert.match(jobsPanel, /onDislike: \(\) => toggleDislike\?\.\(selectedJob\.jobId, selectedJob\)/);
});

test("a passed job still READS as passed on the board", () => {
  // The dimmed, greyscaled rendering is how a job you have passed on is distinguishable if it does
  // appear — re-injected in-session, or on a surface that does not filter. It is driven by the ROW,
  // not by the button that used to sit beside it, so it survives the button's removal.
  assert.match(jobCard, /opacity: job\.disliked \? 0\.3 :/);
  assert.match(jobCard, /filter: job\.disliked \? "grayscale\(0\.7\)" : "none"/);
});

test("the card grew no second source of truth for `disliked`", () => {
  // The local `disliked` useState existed only to fill the thumbs-down. Keeping it would leave a
  // write-only copy of a flag whose one reader is `job.disliked`.
  const code = jobCard.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/setDisliked/.test(code), "the local disliked state is back without a control to drive it");
  assert.ok(!/showDislike/.test(code), "showDislike gates nothing now and must not linger as dead surface");
  // Starring still clears it server-side: starring a job you had passed on has to un-pass it.
  assert.match(jobCard, /interact\(\{ starred: next, \.\.\.\(next \? \{ disliked: false \} : \{\}\) \}\)/);
});

// ── Requirement 4: everything else stayed ────────────────────────────────────

test("every other control on the listing survived", () => {
  for (const [what, re] of [
    ["the star",        /inactiveLabel="Save job"/],
    ["the sparkle",     /title=\{done \? "Regenerate" : "Generate resume"\}/],
    ["open-in-new",     /title="Open job listing"/],
    ["the ATS badge",   /<ATSBadge score=/],
    ["freshness",       /\{ago\(job\.postedAt, job\.scrapedAt\)\}/],
    ["the work chip",   /<WorkBadge t=\{job\.workType\}/],
    ["the ATS badge chip", /<TierChip tier=\{job\.automationTier\}\/>/],
    ["the visited state", />visited</],
    ["the apply-state chip", /<ApplyStateChip jobId=/],
  ]) {
    assert.match(jobCard, re, `${what} was dropped from the listing`);
  }
});
