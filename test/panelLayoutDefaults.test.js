import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("jobs panel uses deterministic default ratios for each visible panel count", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /if \(openPanels\.length === 0\) return \{ jobs: 100, detail: 0, sandbox: 0, ats: 0 \};/);
  assert.match(jobsPanel, /if \(openPanels\.length === 1\)[\s\S]*jobs: 30/);
  assert.match(jobsPanel, /const jobs = 6/);
  assert.match(jobsPanel, /const residualWidth = 100 - jobs/);
  assert.match(jobsPanel, /const hasResumePanel = openPanels\.includes\("sandbox"\)/);
  assert.match(jobsPanel, /\(residualWidth - 10\) \/ openPanels\.length/);
  assert.match(jobsPanel, /hasResumePanel && key === "sandbox" \? baseShare \+ 10 : baseShare/);
  assert.match(jobsPanel, /minSize=\{6\}/);
});

test("panel reset applies on first render and on every open or close transition", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /const initialPanelDefaultsAppliedRef = useRef\(false\)/);
  assert.match(jobsPanel, /const prevPanelVisibilityRef = useRef\(\{ detail: false, sandbox: false, ats: false \}\)/);
  assert.match(jobsPanel, /const visibilityChanged = prev\.detail !== showDetail \|\| prev\.sandbox !== showSandbox \|\| prev\.ats !== showAts/);
  assert.match(jobsPanel, /const shouldApply = !initialPanelDefaultsAppliedRef\.current \|\| visibilityChanged/);
  assert.doesNotMatch(jobsPanel, /openedNewPanel/);
  assert.match(jobsPanel, /initialPanelDefaultsAppliedRef\.current = true/);
});
