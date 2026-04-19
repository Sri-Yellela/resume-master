import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("job board context exposes profile-scoped cache primitives", () => {
  const context = fs.readFileSync("client/src/contexts/JobBoardContext.jsx", "utf8");

  assert.match(context, /activeProfileId/);
  assert.match(context, /setActiveProfileId/);
  assert.match(context, /profileCacheRef = useRef\(new Map\(\)\)/);
  assert.match(context, /getProfileCache/);
  assert.match(context, /setProfileCache/);
  assert.match(context, /deleteProfileCache/);
  assert.match(context, /rm_jobs_profile_ui_v1/);
});

test("profile menu switches optimistically and invalidates deleted profile cache", () => {
  const topBar = fs.readFileSync("client/src/components/TopBar.jsx", "utf8");

  assert.match(topBar, /setActiveProfileId\?\.\(id\);[\s\S]*await api\(`\/api\/domain-profiles\/\$\{id\}\/activate`/);
  assert.match(topBar, /setProfiles\(ps => ps\.map\(pr => \(\{ \.\.\.pr, is_active: pr\.id === id \? 1 : 0 \}\)\)\)/);
  assert.match(topBar, /deleteProfileCache\?\.\(id\)/);
  assert.match(topBar, /setActiveProfileId\?\.\(active\.id\)/);
});

test("jobs panel restores profile cache and guards stale profile responses", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(jobsPanel, /const activeProfileKey = activeProfileId \|\| activeDomainProfile\?\.id \|\| null/);
  assert.match(jobsPanel, /const cached = getProfileCache\?\.\(nextKey\)/);
  assert.match(jobsPanel, /applyProfileSnapshot\(cached\)/);
  assert.match(jobsPanel, /readProfileUiCache\(nextKey\)/);
  assert.match(jobsPanel, /writeProfileUiCache\(activeProfileKey, latestSnapshotRef\.current\)/);
  assert.match(jobsPanel, /requestProfileKey !== activeProfileKeyRef\.current/);
  assert.match(jobsPanel, /requestSeq !== jobsFetchSeqRef\.current/);
  assert.match(jobsPanel, /__profileKey/);
});
