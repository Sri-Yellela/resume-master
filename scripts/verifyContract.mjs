#!/usr/bin/env node
/**
 * Verify a DEPLOYED Resume Master against its contract — the envelope harness, live.
 *
 *   RESUME_MASTER_TOKEN=rmk_… node scripts/verifyContract.mjs --base https://xxx.up.railway.app
 *   … --metered        also run the scenarios that spend money (one real generate, enhance, parse)
 *
 * Runs every scenario marked `live` in src/contract/harness.js against real HTTP with a real
 * token, and checks each real response exactly as `npm test` does in-process: JSON, a declared
 * status, every key and type declared. Without --metered nothing here reaches the model: the
 * free routes, auth refusals and invalid requests (refused before any spend) only.
 *
 * ⛔ THIS IS PHASE B's "VERIFY THERE". A 200 is not evidence — the SPA catch-all answered 200 with
 * index.html five times — which is why the first scenario asserts `service: "resume-master"` and
 * an unknown path must be a JSON 404.
 *
 * The token is read from the environment and never printed.
 */
import { SCENARIOS, checkResponse, requestFor, headersFor } from "../src/contract/harness.js";
import { buildOpenApi } from "../src/contract/build.js";

const args = process.argv.slice(2);
const base = (args[args.indexOf("--base") + 1] || "").replace(/\/$/, "");
const metered = args.includes("--metered");
const token = process.env.RESUME_MASTER_TOKEN;
if (!base || !/^https?:\/\//.test(base)) { console.error("usage: --base https://host"); process.exit(2); }
if (!token) { console.error("RESUME_MASTER_TOKEN is not set"); process.exit(2); }

const components = (await buildOpenApi()).components.schemas;
const run = SCENARIOS.filter(s => s.live && (metered || !s.metered));
let failed = 0;
for (const s of run) {
  const { method, path, body } = requestFor(s);
  const headers = headersFor(s, token);
  let response;
  try {
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    response = { status: res.status, contentType: res.headers.get("content-type"), body: parsed };
  } catch (e) {
    response = { status: 0, contentType: null, body: null, error: e.message };
  }
  const problems = response.error ? [`request failed: ${response.error}`] : checkResponse(s, response, components);
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${s.name}${s.metered ? "  [metered]" : ""}`);
  for (const p of problems) console.log(`        ${p}`);
  if (problems.length) failed++;
}
console.log(`\n${run.length - failed}/${run.length} scenarios conform${metered ? "" : " (metered scenarios skipped — add --metered to spend)"}`);
process.exit(failed ? 1 : 0);
