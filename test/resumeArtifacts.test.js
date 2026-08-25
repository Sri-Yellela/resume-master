// SCRAPING � SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Generate and A+ artifacts are tracked independently in the sandbox", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const sandbox = fs.readFileSync("client/src/panels/SandboxPanel.jsx", "utf8");
  const jobCard = fs.readFileSync("client/src/components/JobCard.jsx", "utf8");
  const detail = fs.readFileSync("client/src/components/JobDetailPanel.jsx", "utf8");

  // The tool constants moved to client/src/lib/applyTools.js so AutoApplyContext could build the
  // same apply-run request from the same values instead of keeping a second copy of them (W5).
  // The invariant is unchanged: two tools, these two labels, declared exactly once.
  const applyTools = fs.readFileSync("client/src/lib/applyTools.js", "utf8");
  assert.match(applyTools, /export const TOOL_LABELS\s+= \{ \[GENERATE_TOOL\]: "Generate", \[A_PLUS_TOOL\]: "A\+ Resume" \}/);
  assert.match(jobsPanel, /import \{ GENERATE_TOOL, A_PLUS_TOOL, TOOL_LABELS, normalizeTool \} from "\.\.\/lib\/applyTools\.js"/);
  assert.match(jobsPanel, /function mergeArtifact/);
  assert.match(jobsPanel, /variants\[tool\]/);
  assert.match(sandbox, /variantKeys\.length > 1/);
  assert.match(sandbox, /setSelectedTool\(tool\)/);
  assert.match(jobCard, /const generateLoading = st === "generate"/);
  // The companion `aPlusLoading` assertion is gone with the dead local it pinned (§5.14). A+ is
  // not a JobCard button — it lives in JobDetailPanel — so the card never read that flag. The
  // independent TRACKING this test is actually about is asserted on jobsPanel and sandbox above;
  // the card only needs its own flag for the button it does own.
  assert.match(detail, /disabled=\{!!st\}/);
});

test("download/export marks the selected artifact as kept for downstream use", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

  assert.match(server, /039_resume_version_tool_artifacts/);
  assert.match(server, /tool_type TEXT NOT NULL DEFAULT 'generate'/);
  assert.match(server, /is_kept INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /app\.post\("\/api\/resumes\/:jobId\/keep"/);
  assert.match(server, /const keptExists = !!db\.prepare/);
  assert.match(server, /UPDATE resume_versions SET is_kept=1/);
  assert.match(jobsPanel, /\/api\/resumes\/\$\{current\.jobId\}\/keep/);
  assert.match(jobsPanel, /applyMode: current\?\.tool === A_PLUS_TOOL \? "CUSTOM_SAMPLER" : applyMode/);
});

test("A+ prompt overlay requires stronger honest ATS coverage", () => {
  const layered = fs.readFileSync("prompts/layer3_modes/a_plus.md", "utf8");

  assert.match(layered, /A\+ Coverage Mandate/);
  assert.match(layered, /missing-keyword ledger/);
  assert.match(layered, /Semantic bridge/);
  assert.match(layered, /A\+ Resume is more aggressive than Generate/);
  assert.match(layered, /Technical Skills placement/);
});

test("cached artifacts reuse stored ATS reports and deterministic formatting by default", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /041_resume_ats_cache_metadata/);
  assert.match(server, /ATS_SCORE_PROMPT_VERSION/);
  assert.match(server, /buildAtsCacheKey/);
  assert.match(server, /atsCached:true/);
  assert.match(server, /normalizeResumeHtml\(html\)/);
  assert.match(server, /RESUME_MASTER_LLM_FORMAT === "1"/);
  assert.doesNotMatch(server, /let formattedHtml = html;\s*try \{/);
});

test("prompt assembler caches stable mode overlays", () => {
  const assembler = fs.readFileSync("services/promptAssembler.js", "utf8");
  // Reads layer3Resolved, not layer3Text: AI1 resolves the prompt-file conditionals before the
  // block is built, so the text that is cached is the text that is SENT. Asserting against the
  // raw file variable would pass while a resolved-but-uncached block went out on every call.
  assert.match(assembler, /\.\.\.\(layer3Resolved \? \{ cache_control: \{ type: "ephemeral" \} \} : \{\}\)/);
});

test("admin job review remains narrow to classification reassignment", () => {
  const adminDb = fs.readFileSync("routes/adminDb.js", "utf8");
  const dbInspector = fs.readFileSync("client/src/pages/admin/DBInspector.jsx", "utf8");

  assert.match(adminDb, /\/job-review\/reassign/);
  assert.match(dbInspector, /JobReviewTab/);
  assert.doesNotMatch(adminDb, /UPDATE scraped_jobs SET title|UPDATE scraped_jobs SET company|UPDATE scraped_jobs SET description/);
  assert.doesNotMatch(dbInspector, /textarea[^>]+description|name="title"|name="company"/);
});

test("resume sandbox distinguishes idle, error, and missing artifact states", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const sandbox = fs.readFileSync("client/src/panels/SandboxPanel.jsx", "utf8");
  const server = fs.readFileSync("server.js", "utf8");

  assert.match(jobsPanel, /No generated artifact yet\. Keep the pre-generation state neutral\./);
  assert.doesNotMatch(jobsPanel, /No resume data found/);
  assert.match(jobsPanel, /status:"loading"/);
  assert.match(jobsPanel, /status:"error"/);
  assert.match(jobsPanel, /status:"missing", missing:true/);
  assert.match(sandbox, /Resume artifact missing/);
  assert.match(sandbox, /activeEntry\?\.error && !activeEntry\?\.missing/);
  assert.match(server, /uj\.resume_generated = 1\s+AND r\.html IS NOT NULL/);
});

test("resume sandbox layout keeps scroll ownership inside the preview pane", () => {
  const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");
  const sandbox = fs.readFileSync("client/src/panels/SandboxPanel.jsx", "utf8");

  // Still about SCROLL OWNERSHIP — the sandbox must never hand its scrollbar to the page — but the
  // owner moved. The sandbox used to be a fixed-height react-resizable-panels column that scrolled
  // itself; it is a popup panel now, and PanelShell's body is the single scroll container shared by
  // all three panel types. So these assertions moved with the mechanism.
  const shell = fs.readFileSync("client/src/components/PanelShell.jsx", "utf8");
  assert.match(shell, /flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",/);
  // overscrollBehavior is the part the old inline pane never had: without it, reaching the end of
  // the preview starts scrolling the app behind the panel.
  assert.match(shell, /overscrollBehavior: "contain"/);
  // And the sandbox must NOT nest a second scroller inside that body.
  assert.match(sandbox, /overflowY: "visible"/);
  assert.ok(!/overflowY: "auto"/.test(sandbox),
    "the sandbox is scrolling itself again — that puts a second scrollbar inside PanelShell's body");
  // The board keeps the only column; the panels overlay it rather than taking space from it.
  assert.match(jobsPanel, /PanelGroup orientation="horizontal" style=\{\{ flex: 1, minHeight:0, minWidth:0, overflow: "hidden" \}\}/);
});
