import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("jobs panel uses deterministic default ratios for each visible panel count", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /if \(count === 1\) return \{ jobs: 100, detail: 0, sandbox: 0, ats: 0 \ }|if \(count === 1\) return \{ jobs: 100, detail: 0, sandbox: 0, ats: 0 \};/);
  assert.match(jobsPanel, /if \(count === 2\)[\s\S]*jobs: 30/);
  assert.match(jobsPanel, /if \(count === 3\)[\s\S]*jobs: 10[\s\S]*detail: showDetail \? 45 : 0[\s\S]*sandbox: showSandbox \? 45 : 0[\s\S]*ats: showAts \? 45 : 0/);
  assert.match(jobsPanel, /return \{\s*jobs: 10,\s*detail: showDetail \? 30 : 0,\s*sandbox: showSandbox \? 35 : 0,\s*ats: showAts \? 25 : 0,/);
});

test("panel reset applies on first render and on newly opened panels, not on closes", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /const initialPanelDefaultsAppliedRef = useRef\(false\)/);
  assert.match(jobsPanel, /const prevPanelVisibilityRef = useRef\(\{ detail: false, sandbox: false, ats: false \}\)/);
  assert.match(jobsPanel, /const openedNewPanel = \(!prev\.detail && showDetail\) \|\| \(!prev\.sandbox && showSandbox\) \|\| \(!prev\.ats && showAts\)/);
  assert.match(jobsPanel, /const shouldApply = !initialPanelDefaultsAppliedRef\.current \|\| openedNewPanel/);
  assert.match(jobsPanel, /initialPanelDefaultsAppliedRef\.current = true/);
});
