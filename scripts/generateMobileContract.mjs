#!/usr/bin/env node
/**
 * Write the published mobile API contract.
 * ============================================================================================
 *
 *   node scripts/generateMobileContract.mjs           # write contract/
 *   node scripts/generateMobileContract.mjs --check    # exit 1 if the committed files are stale
 *
 * --check is what CI and test/mobileApiContract.test.js want: it regenerates in memory and
 * compares, changing nothing on disk. Running it is how you find out that someone edited
 * mapJobRow without regenerating — which is the entire point of the exercise, because the two
 * mobile repositories are not in this tree and nothing else would notice.
 *
 * WHY A CHECKSUM FILE RATHER THAN A DIFF. The mobile repos consume `contract/` by copying it in
 * (see contract/README.md for why that beat a submodule and an npm package). A copy needs a way to
 * answer "is my copy current?" without cloning this repository — a checksum they can assert in
 * their own test suite does that in one line and needs no network.
 *
 * Excluded from scripts/verifyHarnesses.mjs: it is a build tool, not a harness. It asserts nothing
 * about a running system, and --check is already run by the node test suite on every `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildOpenApi, buildTypeScript, renderJson, normaliseForHash,
} from "../services/api/buildMobileContract.js";
import { CONTRACT_VERSION } from "../services/api/mobileContract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "contract");
const check = process.argv.includes("--check");

const sha256 = (text) => crypto.createHash("sha256").update(normaliseForHash(text), "utf8").digest("hex");

export function renderArtifacts() {
  const json = renderJson(buildOpenApi());
  const types = buildTypeScript();
  const checksums = {
    contractVersion: CONTRACT_VERSION,
    algorithm: "sha256 over LF-normalised UTF-8",
    note:
      "Newline-normalised on purpose: this repository has core.autocrlf=true, so a raw-byte hash " +
      "would differ between a Windows and a POSIX checkout of identical content. Mobile repos " +
      "must normalise CRLF to LF before hashing their copy.",
    files: {
      "mobile-api.v1.json": sha256(json),
      "mobile-api.v1.d.ts": sha256(types),
    },
  };
  return {
    "mobile-api.v1.json": json,
    "mobile-api.v1.d.ts": types,
    "CHECKSUMS.json": JSON.stringify(checksums, null, 2) + "\n",
  };
}

const artifacts = renderArtifacts();

if (check) {
  let stale = 0;
  for (const [name, expected] of Object.entries(artifacts)) {
    const file = path.join(OUT_DIR, name);
    if (!fs.existsSync(file)) {
      console.log(`FAIL  contract/${name} is missing`);
      stale++;
      continue;
    }
    const actual = fs.readFileSync(file, "utf8");
    if (normaliseForHash(actual) !== normaliseForHash(expected)) {
      console.log(`FAIL  contract/${name} is STALE — the source changed and was not regenerated`);
      stale++;
    } else {
      console.log(`PASS  contract/${name} matches source`);
    }
  }
  if (stale) {
    console.log(`\n${stale} file(s) stale. Run: node scripts/generateMobileContract.mjs`);
    process.exit(1);
  }
  console.log("\nContract is current.");
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(artifacts)) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, "utf8");
  console.log(`wrote contract/${name}  (${content.length} bytes)`);
}
console.log(`\nContract version ${CONTRACT_VERSION}.`);
