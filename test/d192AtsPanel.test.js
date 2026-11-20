// ⭐ draft D192 (3d) (owner 11-19, "approving all open items" — rm-audit M5): the ATS check is a panel INSIDE the workspace —
// the properties panel's Résumé tab scores the open document against a job and shows the number painted by its band, the
// four parts (draft's ATS card, option C) and the plausibility flags from /v2/ats/score, each with a Dismiss that holds
// across re-scores. One module draws it everywhere (public/ats-panel.js). No model (D190).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { atsCardHtml, plausibilityHtml, resultHtml, flagsOf, bandClass } from "../public/ats-panel.js";
import { createApp } from "../src/http/app.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const PLAUS = { entries: [
  { employer: "Kestrel Payments", status: "flags", flags: [
    { kind: "tech", tech: "Salesforce", bullet: "Ran Salesforce for the sales team", key: "tech|kestrel|a", reason: "Kestrel Payments' postings never mention Salesforce or any CRM — check this" },
    { kind: "domain", bullet: "Built a sales incentive compensation model", key: "domain|kestrel|b", reason: "Kestrel Payments has no sales or compensation roles in its postings" }] },
  { employer: "Northwind", status: "no_data", flags: [] }] };

test("d192AtsPanelInWorkspace: the properties panel has a Résumé tab that mounts the ONE ATS panel over the open document", () => {
  const html = read("public/workspace/index.html"), ws = read("public/workspace/workspace.js");
  assert.match(html, /data-ptab="resume"[^>]*>Résumé</);
  assert.match(html, /<section class="ws-panel" data-panel="resume" id="ws-resume" hidden><\/section>/);
  assert.match(html, /<link rel="stylesheet" href="\/ats-panel\.css">/);
  assert.match(ws, /const \{ mountAtsPanel \} = await import\("\/ats-panel\.js"\);/);
  assert.match(ws, /resumeText: documentText,/, "the résumé is the document's own text, the edits included");
  assert.match(ws, /const documentText = \(\) => \(session\.bytes \? session\.pages\.map\(st => linesOn\(st\.n - 1\)/);
  assert.match(ws, /atsRefresh\?\.\(\);/, "the panel's source line follows the document");
});

test("d192AtsPanelCard: the number painted by its band, the four parts, the biggest gain — no band word", () => {
  const rep = { score: 52, tier1_matched: ["ruby", "kafka"], tier1_missing: ["terraform"] };
  const c = { score: 61, parts: { role_fit: { status: "ok", score: 80, relation: "same_role", level_gap: 0, posting: { subcategory: "swe.backend", level: "senior" } },
    responsibility_overlap: { status: "ok", score: 40, phrases: 3, matched: ["build payment infrastructure"], missing: ["lead a team of 5"] },
    tech_stack: { status: "ok", score: 30, exact: [{ tech: "Apache Kafka" }], gaps: [{ tech: "Terraform", share: 0.4 }] } },
    dissimilarities: [{ kind: "stack_gap", tech: "Terraform", share: 0.4 }] };
  const h = atsCardHtml(rep, c);
  assert.match(h, /<span class="ats-num strong">61%<\/span>/, "the number, its band as its colour");
  for (const part of ["Skills", "Role", "The work", "Their stack"]) assert.ok(h.includes(`<span>${part}</span>`), part);
  assert.match(h, /Biggest gain: Terraform — in 40% of their jobs/);
  assert.doesNotMatch(h, /Strong|Moderate|Weak/, "no band word");
  assert.equal(bandClass(43.9), "moderate"); assert.equal(bandClass(25), "weak"); assert.equal(bandClass(null), "nosignal");
  assert.match(resultHtml({ outcome: "declined", report: { decline_reasons: ["too few terms"] } }), /Not enough signal[\s\S]*This is not a low score/);
});

test("d192AtsPanelPlausibility: one ⚠ row per flag with its reason; Dismiss hides it and it stays dismissed; nothing to say → nothing drawn", () => {
  assert.equal(flagsOf(PLAUS).length, 2);
  const all = plausibilityHtml(PLAUS, { dismissable: true });
  assert.equal((all.match(/class="plaus-row"/g) || []).length, 2);
  assert.match(all, /2 to check/);
  assert.match(all, /data-dismiss="tech\|kestrel\|a">Dismiss</);
  assert.match(all, /Kestrel Payments · “Ran Salesforce for the sales team”/);
  const one = plausibilityHtml(PLAUS, { dismissable: true, dismissed: new Set(["tech|kestrel|a"]) });
  assert.equal((one.match(/class="plaus-row"/g) || []).length, 1, "the dismissed flag is not drawn");
  assert.match(one, /1 to check/); assert.match(one, /1 dismissed — show/);
  const shown = plausibilityHtml(PLAUS, { dismissable: true, dismissed: new Set(["tech|kestrel|a"]), showDismissed: true });
  assert.match(shown, /data-undismiss="tech\|kestrel\|a">Bring it back</);
  assert.equal(plausibilityHtml({ entries: [{ employer: "Northwind", status: "no_data", flags: [] }] }), "", "no data is never a flag");
  const view = read("public/ats-panel.js");
  assert.match(view, /localStorage\.setItem\(DISMISSED/, "dismissed flags are kept by key in this browser, across re-scores");
});

test("d192AtsPanelNoModel + one route: the panel's one call is the deterministic site check, with X-RM-Client: web", () => {
  const view = read("public/ats-panel.js");
  assert.equal((view.match(/fetch\(/g) || []).length, 1);
  assert.match(view, /fetch\("\/v1\/site\/tools\/ats", \{/);
  assert.match(view, /headers: \{ "content-type": "application\/json", "x-rm-client": "web" \}/);
  assert.doesNotMatch(view, /anthropic|\/tools\/generate|\/tools\/enhance|\/v1\/resumes\//i);
  const css = read("public/ats-panel.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "every colour is a token");
  assert.doesNotMatch(css, /border-radius: (999|50%)/, "no capsule (D60)");
});

test("d192AtsPanelServed: the module and its stylesheet are served, and the site check answers with the plausibility block", async () => {
  const app = createApp({ log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of ["/ats-panel.js", "/ats-panel.css"]) assert.equal((await fetch(base + f)).status, 200, f);
    const r = await fetch(`${base}/v1/site/tools/ats`, { method: "POST", headers: { "content-type": "application/json", "x-rm-client": "web" },
      body: JSON.stringify({ resumeText: "Experience\nBackend Engineer — Northwind\n- Built APIs in Ruby and Java on Kafka\nSkills\nRuby, Java, Kafka, SQL",
        job: { title: "Backend Engineer", description: "Build APIs in Ruby and Java. Kafka, SQL, AWS. 5+ years of backend systems." } }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok("plausibility" in j && "contextual" in j, "the v2 blocks the panel draws");
  } finally { await new Promise(r => { server.close(r); server.closeAllConnections?.(); }); }
});

test("draft 46z (owner 11-20: 'just state more to add context'): the card states each part's figures and one row for the whole card", async () => {
  const { partFacts, atsCardHtml } = await import("../public/ats-panel.js");
  const rep = { score: 62, tier1_matched: ["typescript", "react", "aws"], tier1_missing: ["node.js", "looker"], action_verbs_matched: ["Built"], action_verbs_missing: ["Designed"] };
  const c = { score: 58, parts: {
    skill_match: { score: 62, status: "ok", weight: 0.5 },
    role_fit: { score: 65, status: "ok", relation: "same_family", level_gap: 1, domain_lift: 10, weight: 0.2, posting: { subcategory: "swe.backend", level: "senior" }, resume: { level: "mid" } },
    responsibility_overlap: { score: 40, status: "ok", phrases: 5, matched: ["a", "b"], missing: ["c", "d", "e"], weight: 0.15 },
    tech_stack: { score: 73, status: "ok", exact: [{ tech: "TypeScript", share: 0.9 }], ecosystem: [{ yours: "Spring", theirs: "Node.js", share: 0.7 }], gaps: [{ tech: "Looker", share: 0.4 }], weight: 0.15 } },
    similarities: { domains: ["healthcare"] }, dissimilarities: [] };
  const f = partFacts(rep, c);
  assert.deepEqual(f.Skills, ["3 of 5 skills", "1 of 2 action verbs", "weighs 50%"]);
  assert.deepEqual(f.Role, ["1 level apart", "+10 for a shared field", "weighs 20%"]);
  assert.deepEqual(f["The work"], ["3 duties to show", "weighs 15%"]);
  assert.deepEqual(f["Their stack"], ["TypeScript 90%, Node.js 70%, Looker 40% of their jobs", "1 of 3 of their tools exact · 1 close", "weighs 15%"]);
  assert.deepEqual(f.card, ["skill match 62 · in context 58", "healthcare in common"]);
  const h = atsCardHtml(rep, c);
  assert.match(h, /data-ats-facts="card">skill match 62 · in context 58 · healthcare in common</);
  assert.match(h, /data-ats-facts="Their stack">TypeScript 90%, Node\.js 70%, Looker 40% of their jobs/);
});
