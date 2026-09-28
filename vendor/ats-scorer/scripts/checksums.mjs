#!/usr/bin/env node
/**
 * CHECKSUMS.json — how a second repository consumes this package without a registry.
 *
 * DISTRIBUTION, decided in A1: the package's source of truth is draft/packages/ats-scorer. draft
 * consumes it as a `file:` dependency. Any other repository VENDORS a byte-for-byte copy of this
 * directory and runs the package's own tests, one of which re-hashes every file against this
 * manifest — the same copied-with-checksum pattern contract/mobile-api.v1.json already uses.
 * A hand-edit to a vendored copy therefore fails that repository's suite, and so does an edit here
 * that was not followed by `npm run checksums`.
 *
 * ⛔ LF-NORMALISED. draft materialises CRLF on Windows (core.autocrlf) and other checkouts do not,
 * so a raw-byte hash would differ between two identical trees and the verify would cry wolf until
 * someone deleted it.
 *
 * Usage: node scripts/checksums.mjs            verify, exit 1 on any mismatch
 *        node scripts/checksums.mjs --write    regenerate
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST = path.join(PACKAGE_ROOT, "CHECKSUMS.json");
const SKIP = new Set(["CHECKSUMS.json", "node_modules"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(path.relative(PACKAGE_ROOT, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

export function hashFile(rel) {
  const text = fs.readFileSync(path.join(PACKAGE_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  const files = {};
  for (const rel of walk(PACKAGE_ROOT)) files[rel] = hashFile(rel);
  return { name: pkg.name, version: pkg.version, normalisation: "LF", algorithm: "sha256", files };
}

/** Returns a list of human-readable problems; empty means the tree matches the manifest. */
export function verifyManifest() {
  if (!fs.existsSync(MANIFEST)) return ["CHECKSUMS.json is missing — run `npm run checksums`"];
  const recorded = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const actual = computeManifest();
  const problems = [];
  if (recorded.version !== actual.version) problems.push(`version ${recorded.version} recorded, package.json says ${actual.version}`);
  for (const [rel, sum] of Object.entries(recorded.files)) {
    if (!(rel in actual.files)) problems.push(`${rel} is in the manifest but missing from the package`);
    else if (actual.files[rel] !== sum) problems.push(`${rel} differs from the manifest`);
  }
  for (const rel of Object.keys(actual.files)) {
    if (!(rel in recorded.files)) problems.push(`${rel} is in the package but not in the manifest`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    fs.writeFileSync(MANIFEST, JSON.stringify(computeManifest(), null, 2) + "\n");
    console.log("wrote " + path.relative(process.cwd(), MANIFEST));
  } else {
    const problems = verifyManifest();
    for (const p of problems) console.error("⛔ " + p);
    if (!problems.length) console.log("✓ package matches CHECKSUMS.json");
    process.exit(problems.length ? 1 : 0);
  }
}
