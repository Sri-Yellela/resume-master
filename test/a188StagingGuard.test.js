// ⛔ draft A188 (46g) · the tools service's staging guard — RM_ENV=staging refuses a production credential at boot.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { checkStaging, applyStagingGuard, STAGING_MUST_BE_BLANK, STAGING_URL_VARS, STAGING_MODEL_KEY_LABEL } from "../src/stagingGuard.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const S = { RM_ENV: "staging" };
const quiet = { log() {}, error() {} };

test("a188: without RM_ENV=staging nothing changes", () => {
  const env = { RESEND_API_KEY: "re_x", ANTHROPIC_API_KEY: "k" };
  assert.deepEqual(checkStaging(env), { staging: false, refused: [], forced: {} });
  let exited = null; applyStagingGuard(env, { exit: (c) => { exited = c; }, log: quiet }); assert.equal(exited, null);
});

test("a188: each production credential refuses by NAME, never its value; the capped staging key passes", () => {
  for (const k of STAGING_MUST_BE_BLANK) {
    const r = checkStaging({ ...S, [k]: "SECRET-VALUE-9" });
    assert.ok(r.refused.some(l => l.startsWith(`${k}:`)), k);
    assert.ok(!JSON.stringify(r).includes("SECRET-VALUE-9"));
  }
  for (const k of STAGING_URL_VARS) for (const u of ["https://resumemaster.one", "https://api.jobsviadraft.com/v1"]) {
    assert.ok(checkStaging({ ...S, [k]: u }).refused.some(l => l.startsWith(`${k}:`)), `${k} ${u}`);
  }
  assert.ok(checkStaging({ ...S, ANTHROPIC_API_KEY: "k", ANTHROPIC_KEY_LABEL: "tools-prod" }).refused.length === 1);
  assert.deepEqual(checkStaging({ ...S, ANTHROPIC_API_KEY: "k", ANTHROPIC_KEY_LABEL: STAGING_MODEL_KEY_LABEL }).refused, []);
  assert.deepEqual(checkStaging({ ...S, RM_PUBLIC_URL: "https://resume-master-staging.up.railway.app" }).refused, []);
});

test("a188: a refused boot exits 1 and forces nothing; a clean one forces anonymous /mcp off", () => {
  const bad = { ...S, RESEND_API_KEY: "re_x", RM_MCP_ANONYMOUS: "x" }; let exited = null;
  applyStagingGuard(bad, { exit: (c) => { exited = c; }, log: quiet });
  assert.equal(exited, 1); assert.equal(bad.RM_MCP_ANONYMOUS, "x");
  const ok = { ...S, RM_MCP_ANONYMOUS: "x" }; exited = null;
  applyStagingGuard(ok, { exit: (c) => { exited = c; }, log: quiet });
  assert.equal(exited, null); assert.equal(ok.RM_MCP_ANONYMOUS, "");
});

test("a188: every name the guard reads is one the service really reads", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name) && !/stagingGuard/.test(e.name)) files.push(f); } };
  walk("src"); files.push("server.js");
  const src = files.map(read).join("\n");
  for (const k of [...STAGING_MUST_BE_BLANK, ...STAGING_URL_VARS, "ANTHROPIC_API_KEY", "ANTHROPIC_KEY_LABEL", "RM_MCP_ANONYMOUS"]) {
    assert.ok(new RegExp(`env\\??\\.${k}\\b`).test(src), `${k} is read`);
  }
});

test("a188: wired first in server.js; createApp marks staging responses noindex", () => {
  const server = read("server.js").split("\n").filter(l => /^import /.test(l));
  assert.equal(server[0], 'import "./src/stagingGuardBoot.js";   // ⛔ draft A188: a staging deploy with a production credential exits HERE');
  assert.match(read("src/http/app.js"), /if \(isStaging\(env\)\) app\.use\(\(_req, res, next\) => \{ res\.setHeader\("X-Robots-Tag", "noindex, nofollow"\); next\(\); \}\);/);
});

test("a188: a real boot with a production mail key on staging exits 1 without listening", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-staging-"));
  const env = { ...process.env, RM_ENV: "staging", RESEND_API_KEY: "re_PROD", ANTHROPIC_API_KEY: "", PORT: "0", RM_DB_PATH: path.join(dir, "rm.db") };
  const p = spawn(process.execPath, ["server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
  const code = await new Promise(r => { p.on("exit", r); setTimeout(() => { p.kill(); r("timeout"); }, 30000); });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  assert.equal(code, 1, out.slice(-400));
  assert.match(out, /RESEND_API_KEY: must be blank on staging/);
  assert.ok(!/listening/i.test(out) && !out.includes("re_PROD"));
});
