// @draft/ats-scorer's own suite. It travels with every vendored copy, so each assertion here is a
// property the PACKAGE promises, independent of which product imported it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  scoreAtsLocally, buildRuntimeAtsBasis, resolveTermWeights, resolveSynonyms,
  skillVocabularyTerms, actionVerbVocabularyTerms, isJuniorPosting, seniorityCapFor,
  REGISTRY_FILES, LOCAL_ATS_SOURCE,
} from "../src/index.js";
import { verifyManifest, PACKAGE_ROOT } from "../scripts/checksums.mjs";

const SRC = path.join(PACKAGE_ROOT, "src");
const sources = () => fs.readdirSync(SRC).map(f => [f, fs.readFileSync(path.join(SRC, f), "utf8")]);

const JOB = {
  title: "Backend Engineer", company: "Acme",
  description: "Build services in Python and Kubernetes with Kafka and Terraform on AWS.",
  skills_json: JSON.stringify(["Python", "Kubernetes", "Kafka", "Terraform", "AWS"].map(skill => ({ skill, type: "hard" }))),
};
const basis = (resumeText) => buildRuntimeAtsBasis({ resumeText, signalProfile: {}, domainProfile: {} });

// ── distribution ────────────────────────────────────────────────────────────────────────────────

test("every file matches CHECKSUMS.json (LF-normalised) — a vendored copy has not been hand-edited", () => {
  assert.deepEqual(verifyManifest(), [],
    "the package differs from its manifest. In draft: run `npm run checksums` in packages/ats-scorer " +
    "after an intended change. In a vendored copy: re-copy from draft instead of editing here.");
});

// ── free, local, deterministic ──────────────────────────────────────────────────────────────────

test("the package makes no model call, no network call and opens no database", () => {
  for (const [file, src] of sources()) {
    assert.doesNotMatch(src, /messages\.(create|batches)|@anthropic-ai|callModel\s*\(/, `${file} reaches for a model`);
    assert.doesNotMatch(src, /\bfetch\s*\(|node:https?\b|["']https?["']/, `${file} reaches for the network`);
    assert.doesNotMatch(src, /better-sqlite3|\.prepare\s*\(|ats_term_weights\s+WHERE|FROM\s+ats_term_weights/i,
      `${file} reads a database — weights are an ARGUMENT; each product loads its own`);
  }
});

test("the package imports nothing but node built-ins and its own files", () => {
  for (const [file, src] of sources()) {
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(m[1].startsWith("node:") || m[1].startsWith("./"),
        `${file} imports "${m[1]}" — the package must not reach back into either product`);
    }
  }
});

// ── the registries come WITH the scorer ─────────────────────────────────────────────────────────

test("the term registries ship inside the package and are not empty", () => {
  for (const f of REGISTRY_FILES) assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, "data", f)), `data/${f} is missing`);
  assert.ok(skillVocabularyTerms().length > 500, `skill vocabulary has ${skillVocabularyTerms().length} terms`);
  assert.ok(actionVerbVocabularyTerms().length > 100, `verb vocabulary has ${actionVerbVocabularyTerms().length} terms`);
});

test("⛔ a copy WITHOUT its registries throws — it does not quietly score against nothing", async () => {
  // Injected, not assumed: copy src/ alone to a temp dir and import it from there. An empty
  // vocabulary moves 27 of 30 graded scores and RAISES rho, so a silent fallback would never be seen.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ats-scorer-nodata-"));
  try {
    fs.cpSync(SRC, path.join(tmp, "src"), { recursive: true });
    const cwd = process.cwd();
    // a data/ in the working directory must not rescue it either
    fs.mkdirSync(path.join(tmp, "cwd", "data"), { recursive: true });
    for (const f of REGISTRY_FILES) fs.copyFileSync(path.join(PACKAGE_ROOT, "data", f), path.join(tmp, "cwd", "data", f));
    process.chdir(path.join(tmp, "cwd"));
    try {
      const mod = await import(pathToFileURL(path.join(tmp, "src", "index.js")).href);
      assert.throws(() => mod.skillVocabularyTerms(), /registry DOMAIN_METADATA_REGISTRY\.json is missing/);
      assert.throws(() => mod.scoreAtsLocally({ job: JOB, runtimeBasis: basis("Python") }), /is missing/);
    } finally { process.chdir(cwd); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── ⛔ THE SIGNATURE: the wrong shape cannot be passed quietly ──────────────────────────────────

test("termWeights: null, a Map, or the envelope — and the envelope's staleness is refused", () => {
  const map = new Map([["python", 2.5]]);
  assert.equal(resolveTermWeights(null), null);
  assert.equal(resolveTermWeights(undefined), null);
  assert.equal(resolveTermWeights(map), map);
  assert.equal(resolveTermWeights(new Map()), null, "an empty Map is a deliberate 'unweighted'");
  assert.equal(resolveTermWeights({ weights: map, stale: false, computedAt: 1 }), map);
  assert.equal(resolveTermWeights({ weights: map, stale: true }), null, "a stale table is refused, as server.js does");
});

test("⛔ termWeights of any OTHER shape is a TypeError, not a silent unweighted score", () => {
  for (const bad of [{ python: 2.5 }, { weights: { python: 2.5 }, stale: false }, [["python", 2.5]], "python", 3, {}]) {
    assert.throws(() => resolveTermWeights(bad), TypeError, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => scoreAtsLocally({ job: JOB, runtimeBasis: basis("Python"), termWeights: bad }), TypeError);
  }
  // …including a wrong shape riding in on the basis rather than the argument.
  const b = buildRuntimeAtsBasis({ resumeText: "Python", termWeights: { python: 2 } });
  assert.throws(() => scoreAtsLocally({ job: JOB, runtimeBasis: b }), TypeError);
});

test("⛔ synonyms of any shape but a Map is a TypeError", () => {
  assert.equal(resolveSynonyms(null), null);
  const m = new Map([["k8s", ["kubernetes"]]]);
  assert.equal(resolveSynonyms(m), m);
  for (const bad of [{ k8s: ["kubernetes"] }, [["k8s", ["kubernetes"]]], "k8s"]) {
    assert.throws(() => scoreAtsLocally({ job: JOB, runtimeBasis: basis("Python"), synonyms: bad }), TypeError);
  }
});

test("a weighted score differs from an unweighted one — the weights actually reach the scorer", () => {
  const b = basis("Python Kubernetes engineer");
  const weights = new Map([["python", 0.2], ["kubernetes", 0.2], ["kafka", 3], ["terraform", 3], ["aws", 3]]);
  const weighted = scoreAtsLocally({ job: JOB, runtimeBasis: b, termWeights: weights });
  const viaEnvelope = scoreAtsLocally({ job: JOB, runtimeBasis: b, termWeights: { weights, stale: false } });
  const unweighted = scoreAtsLocally({ job: JOB, runtimeBasis: b, termWeights: null });
  assert.equal(weighted.weighting.applied, true);
  assert.equal(viaEnvelope.score, weighted.score);
  assert.notEqual(weighted.score, unweighted.score, "weighting moved nothing — the argument is not being read");
});

// ── synonyms: the invariants that are the SCORER's to hold ──────────────────────────────────────
// (corroboration-never-promotes, sticky rejection, (a,b)≡(b,a) and absent-table are properties of
// the product's loader, which reads the table. They are tested where that loader lives.)

test("synonyms apply ONE hop, never transitively", () => {
  const job = { ...JOB, skills_json: JSON.stringify([{ skill: "Terraform", type: "hard" }]) };
  const b = basis("Experienced with Pulumi only.");
  // terraform~opentofu and opentofu~pulumi must NOT make terraform~pulumi.
  const chain = new Map([["terraform", ["opentofu"]], ["opentofu", ["pulumi"]]]);
  const r = scoreAtsLocally({ job, runtimeBasis: b, synonyms: chain });
  assert.ok(!r.tier1_matched.map(t => t.toLowerCase()).includes("terraform"), "a two-hop chain matched");
  const direct = new Map([["terraform", ["pulumi"]]]);
  const r2 = scoreAtsLocally({ job, runtimeBasis: b, synonyms: direct });
  assert.ok(r2.tier1_matched.map(t => t.toLowerCase()).includes("terraform"), "a direct equivalence did not match");
});

test("no synonyms and an empty synonym Map score identically", () => {
  const b = basis("Python Kubernetes");
  assert.deepEqual(scoreAtsLocally({ job: JOB, runtimeBasis: b, synonyms: null }),
                   scoreAtsLocally({ job: JOB, runtimeBasis: b, synonyms: new Map() }));
});

// ── what came and what did not ──────────────────────────────────────────────────────────────────

test("the score travels, the bands do not — no band logic and no resume_depth in the package", () => {
  for (const [file, src] of sources()) {
    assert.doesNotMatch(src, /^\s*import[^\n]*atsBands/m, `${file} imports band logic`);
    assert.doesNotMatch(src, /ATS_BAND_CUTPOINTS|atsBandFor\s*\(|THIN_RESUME\./, `${file} carries band presentation`);
  }
  const r = scoreAtsLocally({ job: JOB, runtimeBasis: basis("Python") });
  assert.equal("resume_depth" in r, false, "resume_depth is draft's presentation; the product attaches it");
  assert.equal(r.source, LOCAL_ATS_SOURCE);
});

test("the seniority guard is SCORING and travels with the scorer", () => {
  assert.equal(isJuniorPosting("Software Engineer Intern (Winter 2027)"), true);
  assert.equal(isJuniorPosting("Internal Tools Engineer"), false);
  assert.equal(seniorityCapFor("Software Engineer Intern", "mid")?.cap, 20);
  assert.equal(seniorityCapFor("Software Engineer Intern", "intern"), null);
  const b = buildRuntimeAtsBasis({ resumeText: "Python Kubernetes Kafka Terraform AWS", signalProfile: {}, domainProfile: { seniority: "senior" } });
  const r = scoreAtsLocally({ job: { ...JOB, title: "Backend Engineer Intern" }, runtimeBasis: b });
  assert.equal(r.seniority_cap.applied, true);
  assert.ok(r.score <= 20);
});

test("scoring is deterministic", () => {
  const b = basis("Python Kubernetes Kafka");
  assert.deepEqual(scoreAtsLocally({ job: JOB, runtimeBasis: b }), scoreAtsLocally({ job: JOB, runtimeBasis: b }));
});
