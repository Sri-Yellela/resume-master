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
  assert.match(atsPanel, /background:alreadyAdded \? theme\.successMuted : bg/);
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

test("floating dock is constrained to the jobs panel zone instead of the full viewport", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.match(jobsPanel, /window\.dispatchEvent\(new CustomEvent\("rm:jobs-panel-zone"/);
  assert.match(jobsPanel, /detailPanelElementRef/);
  assert.match(topBar, /window\.addEventListener\("rm:jobs-panel-zone"/);
  assert.match(topBar, /const dockCenter = jobsZone \? jobsZone\.left \+ jobsZone\.width \/ 2 : vw \/ 2/);
  assert.match(topBar, /const constrainedPillWidth = Math\.min\(pillWidth, dockMaxWidth \|\| pillWidth\)/);
  assert.match(topBar, /left: dockCenter/);
});
