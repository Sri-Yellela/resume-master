#!/usr/bin/env node
// A55 — walk every endpoint AS AN OUTSIDER and write down what a stranger sees.
//
//   node scripts/outsiderWalk.mjs            -> prints a markdown table (docs/OUTSIDER_WALK.md is its output)
//
// In-process, against the real app with a freshly minted token for a client called "outsider" and NO
// model key — so nothing is spent, and the model-backed routes show what they answer before any
// spend (validation) and when the model is absent. A live walk against the deployed service is
// `npm run verify:live` (token required); this one answers a different question: is each answer
// LEGIBLE to someone who has never seen our source?
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();
const { token, entry } = mintToken("outsider");
const app = createApp({ anthropic: null, version: { version: "walk" }, log: () => {}, clients: parseClientTokens(entry) });
const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const MCP_HEADERS = { accept: "application/json, text/event-stream" };
const steps = [
  ["GET", "/health", null, {}],
  ["GET", "/v1/version", null, {}],
  ["POST", "/v1/ats/score", { job: { title: "Backend Engineer", description: "Go, PostgreSQL, Kubernetes. Build services." }, resumeText: "Go, PostgreSQL engineer." }, { noAuth: true, label: "no token" }],
  ["POST", "/v1/ats/score", { job: { title: "Backend Engineer", description: "Go" }, resumeText: "Go" }, { wrongAuth: true, label: "a malformed token" }],
  ["POST", "/v1/ats/score", { job: { title: "Backend Engineer", description: "We need Go, PostgreSQL, Kubernetes, gRPC, Terraform and AWS. Build backend services and APIs. Collaborate with product." }, resumeText: "Backend engineer, 4 years. Go, PostgreSQL, Kubernetes, Docker, AWS. Built APIs and services." }, { label: "a real score" }],
  ["POST", "/v1/ats/score", { job: { title: "Role", description: "Join us." }, resumeText: "Python" }, { label: "too little to score" }],
  ["POST", "/v1/ats/score", { resumeText: "x" }, { label: "job missing" }],
  ["POST", "/v1/ats/score", { job: { title: "x", description: "y" }, resumeText: "x", termWeights: { kafka: 3 } }, { label: "termWeights as an object, not pairs" }],
  ["POST", "/v1/resumes/format", { html: "<p>JANE DOE</p><p>SUMMARY</p><p>Built things.</p>" }, { label: "format" }],
  ["POST", "/v1/resumes/format", {}, { label: "html missing" }],
  ["POST", "/v1/resumes/format", null, { raw: "{not json", label: "malformed JSON" }],
  ["POST", "/v1/resumes/generate", { job: { title: "x" } }, { label: "generate, baseResumeText missing (no model key here)" }],
  ["POST", "/v1/resumes/parse-pdf", { pdfBase64: "not base64!!" }, { label: "parse-pdf, not base64 (no model key here)" }],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stranger", version: "0" } } }, { headers: MCP_HEADERS, label: "MCP initialize" }],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { headers: MCP_HEADERS, label: "MCP tools/list" }],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "score_ats_fit", arguments: { job: { title: "Backend Engineer", description: "Go, PostgreSQL, Kubernetes. Build services." }, resumeText: "Go, PostgreSQL engineer." } } }, { headers: MCP_HEADERS, label: "MCP score_ats_fit" }],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "score_ats_fit", arguments: { resumeText: "x" } } }, { headers: MCP_HEADERS, label: "MCP score_ats_fit, job missing" }],
  ["POST", "/mcp", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "generate_resume", arguments: {} } }, { headers: MCP_HEADERS, label: "MCP unknown tool" }],
  ["GET", "/mcp", null, { headers: MCP_HEADERS, label: "MCP GET (no SSE)" }],
  ["GET", "/v1/nope", null, { label: "unknown path" }],
];

const rows = [];
for (const [method, path, body, o] of steps) {
  const headers = { "content-type": "application/json", ...(o.headers || {}) };
  if (!o.noAuth) headers.authorization = o.wrongAuth ? "Bearer rmk_x.short" : `Bearer ${token}`;
  if (path === "/health" || path === "/v1/version") delete headers.authorization;
  const r = await fetch(base + path, { method, headers, body: o.raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let shown = text;
  try {
    const j = JSON.parse(text);
    const brief = j.result?.tools ? { tools: j.result.tools.map(t => t.name) }
      : j.result?.content ? { isError: !!j.result.isError, lead: j.result.content[0]?.text?.split("\n")[0]?.slice(0, 140) }
      : j.report ? { report: { score: j.report.score, scorable: j.report.scorable, decline_reasons: j.report.decline_reasons } }
      : j.html ? { html: `${j.html.length} chars` } : j;
    shown = JSON.stringify(brief);
  } catch { /* not JSON */ }
  const legible = /"message"|"meaning"|"lead"|"tools"|"report"|"html"|"service"|"ok"/.test(shown) || r.status < 300;
  rows.push(`| ${o.label || path} | \`${method} ${path}\` | ${r.status} | \`${shown.slice(0, 220).replace(/\|/g, "\\|")}\` | ${legible ? "yes" : "**no — a code with no sentence**"} |`);
}
server.close();
console.log("| Step | Request | Status | What a stranger gets back | Says what to do? |\n|---|---|---|---|---|\n" + rows.join("\n"));
