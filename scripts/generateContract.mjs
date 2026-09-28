#!/usr/bin/env node
/**
 * Write the Resume Master API contract — GENERATED, never hand-written.
 *
 *   node scripts/generateContract.mjs           # write contract/
 *   node scripts/generateContract.mjs --check   # exit 1 if contract/ is stale; writes nothing
 *
 * contract/ holds:
 *   resume-master-api.v1.json   OpenAPI 3.1 — derived shapes by EXECUTION, envelopes declared
 *   resume-master-api.v1.d.ts   the same, as TypeScript
 *   CHECKSUMS.json              sha256 over LF-normalised UTF-8 — a consumer (draft) vendors these
 *                               files and asserts its copy in one line, with no network
 *   VERSIONS.json               contract version -> SHAPE hash. Append-only
 *
 * ⛔ A SHAPE CHANGE WITHOUT A VERSION BUMP IS REFUSED. If the shape hash no longer matches the one
 * recorded for CONTRACT_VERSION, this exits non-zero and tells you to bump it — so a consumer can
 * never receive a different shape under a version number it has already seen. Rewording a
 * description is not a shape change; the hash ignores prose.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, buildTypeScript, renderJson, sha256, shapeHash, normaliseForHash } from "../src/contract/build.js";
import { CONTRACT_VERSION } from "../src/contract/endpoints.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, "contract");
const VERSIONS = path.join(OUT_DIR, "VERSIONS.json");

export async function renderArtifacts() {
  const doc = await buildOpenApi();
  const json = renderJson(doc);
  const types = await buildTypeScript();
  const hash = shapeHash(doc);
  const recorded = fs.existsSync(VERSIONS) ? JSON.parse(fs.readFileSync(VERSIONS, "utf8")) : {};
  if (recorded[CONTRACT_VERSION] && recorded[CONTRACT_VERSION] !== hash) {
    throw new Error(`the contract SHAPE changed but CONTRACT_VERSION is still ${CONTRACT_VERSION}. ` +
      `Bump it in src/contract/endpoints.js — a consumer must never see two shapes under one version.`);
  }
  const versions = { ...recorded, [CONTRACT_VERSION]: hash };
  const checksums = {
    contractVersion: CONTRACT_VERSION, shapeHash: hash,
    algorithm: "sha256 over LF-normalised UTF-8",
    note: "LF-normalised on purpose: checkouts differ in line endings, and a raw-byte hash would fail spuriously.",
    files: { "resume-master-api.v1.json": sha256(json), "resume-master-api.v1.d.ts": sha256(types) },
  };
  return {
    "resume-master-api.v1.json": json,
    "resume-master-api.v1.d.ts": types,
    "CHECKSUMS.json": JSON.stringify(checksums, null, 2) + "\n",
    "VERSIONS.json": JSON.stringify(versions, null, 2) + "\n",
  };
}

export async function staleFiles() {
  const artifacts = await renderArtifacts();
  return Object.entries(artifacts).filter(([name, expected]) => {
    const file = path.join(OUT_DIR, name);
    return !fs.existsSync(file) || normaliseForHash(fs.readFileSync(file, "utf8")) !== normaliseForHash(expected);
  }).map(([name]) => name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--check")) {
      const stale = await staleFiles();
      for (const n of stale) console.log(`FAIL  contract/${n} is STALE — the source changed and was not regenerated`);
      if (!stale.length) console.log("PASS  contract/ matches the implementation");
      process.exit(stale.length ? 1 : 0);
    }
    const artifacts = await renderArtifacts();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, text] of Object.entries(artifacts)) fs.writeFileSync(path.join(OUT_DIR, name), text);
    console.log(`wrote contract/ (v${JSON.parse(artifacts["CHECKSUMS.json"]).contractVersion})`);
  } catch (e) {
    console.error("⛔ " + e.message);
    process.exit(1);
  }
}
