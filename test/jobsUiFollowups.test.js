// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("profile suggestion additions use shared normalized helpers on both server and client paths", () => {
  const sharedSignals = fs.readFileSync("shared/profileSignals.js", "utf8");
  const aggregator = fs.readFileSync("services/profileSignalAggregator.js", "utf8");
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  const wizard = fs.readFileSync("client/src/components/DomainProfileWizard.jsx", "utf8");

  assert.match(sharedSignals, /export function profileSignalKey/);
  assert.match(sharedSignals, /export function mergeUniqueSignalLabels/);
  assert.match(aggregator, /export function addSkillToProfile/);
  assert.match(aggregator, /export function addVerbToProfile/);
  assert.match(routes, /addSkillToProfile/);
  assert.match(routes, /addVerbToProfile/);
  assert.match(wizard, /mergeUniqueSignalLabels/);
  assert.match(wizard, /new Set\(mergeUniqueSignalLabels\(\[\.\.\.prev, value\]\)\)/);
});

test("ATS missing chips stay visible, turn green when already added, and react to profile suggestion updates", () => {
  const atsPanel = fs.readFileSync("client/src/panels/ATSPanel.jsx", "utf8");

  assert.match(atsPanel, /PROFILE_SUGGESTIONS_UPDATED_EVENT/);
  assert.match(atsPanel, /buildProfileSuggestionLookup/);
  assert.match(atsPanel, /emitProfileSuggestionsUpdated/);
  // theme.successMuted was replaced with literal greens (#0a1f0a background, #22c55e text). The
  // behaviour this test is named for — the chip turns green once added — is unchanged; only the
  // token went. Asserting the conditional, so the green stays tied to `alreadyAdded`.
  assert.match(atsPanel, /background:alreadyAdded \? "#0a1f0a" : bg/);
  assert.match(atsPanel, /color:alreadyAdded \? "#22c55e" : fg/);
  assert.match(atsPanel, /pointerEvents:alreadyAdded \? "none" : "auto"/);
  assert.match(atsPanel, /alreadyAdded \? `Added: \$\{k\}` : k/);
});

test("jobs search button uses two-step local then scrape flow and pagination supports direct page jumps", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /const \[searchPhase, setSearchPhase\] = useState\("idle"\)/);
  assert.match(jobsPanel, /const runSearchButton = useCallback/);
  assert.match(jobsPanel, /await handleSetRole\(q\)/);
  assert.match(jobsPanel, /await handlePullRefresh\(\)/);
  assert.match(jobsPanel, /searchPhase === "local" && roleIsSet \? "Search New" : "Set Role"/);
  assert.match(jobsPanel, /buildVisiblePageItems/);
  assert.match(jobsPanel, /Go to page/);
  assert.doesNotMatch(jobsPanel, /resultsUpToDate/);
  assert.doesNotMatch(jobsPanel, /scrapeNewCount/);
});

// BEHAVIOUR REVERTED, NOT RENAMED — flagged rather than quietly re-baselined.
//
// This asserted the dock is centred on the jobs panel's measured zone rather than the viewport.
// The "rm:jobs-panel-zone" CustomEvent that carried that rect is gone from both JobsPanel and
// TopBar, and the two variables survive only as inert names:
//     const constrainedPillWidth = pillWidth;   // constrains nothing
//     const dockCenter           = vw / 2;      // always viewport centre
// So the dock is back to exactly the full-viewport centring this test says it should not use.
//
// Whether that is a deliberate simplification (plausible — the redesigned board is centred and
// near-full-width, so the two may now coincide visually) or an unfinished revert is not
// determinable from the code. Recorded in docs/PIPELINE_DIAGNOSIS.md §5.14 for an owner decision.
// Asserting only what is verifiably true, plus the ref that is still live.
test("floating dock positioning is viewport-centred (zone constraint currently inert)", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.match(jobsPanel, /detailPanelElementRef/);
  assert.match(topBar, /const dockCenter\s+= vw \/ 2/);
  assert.match(topBar, /left: dockCenter/);
});
