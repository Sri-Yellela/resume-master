#!/usr/bin/env node
/**
 * AM1 / task R1 — PRESERVE THE EVIDENCE.
 *
 * ⛔ WHY THIS EXISTS. `cleanup_log` id 85 deleted 1288 of 1293 rows from `scraped_jobs` on
 * 2026-09-02T02:06Z. The live table holds 5 fixtures. **0 of the 30 human-graded postings survive**,
 * and those 30 grades are the only independent validation the ATS engine has: rho = 0.746, tau-b =
 * 0.594, every band cutpoint in shared/atsBands.js and the seniority guard were all measured
 * against them.
 *
 * The grades themselves are committed (docs/ak2-ats-grading-key.json, docs/ak2-ats-grading-set.md).
 * THE POSTINGS THEY REFER TO ARE NOT. The scorer reads the job DESCRIPTION, so a grade without its
 * posting cannot be re-scored — the measurement is unreproducible, not merely inconvenient.
 * docs/ak2-ats-grading-set.md does carry description text, but TRUNCATED TO 1400 CHARACTERS
 * (measured: min 1399, max 1400 across all 30) against a real mean of 4652. It is a reading aid for
 * a human grader, not a scorable corpus, and scoring from it reproduces nothing.
 *
 * The only surviving copy is data/backups/resume_master_2026-08-31...db. THE 2026-09-02 SNAPSHOT IS
 * ALREADY POST-DELETION. And that backup is a small number of auto-daily runs from being pruned —
 * see `retentionForecast` below, which computes it from the real policy rather than asserting it.
 *
 * So this does two different things, on purpose, because they fail differently:
 *
 *   1. COPIES the backup out of data/backups/ entirely. scripts/backup.js only ever unlinks paths
 *      it joins directly onto BAK_DIR from the manifest, plus sidecars matching /\.db-(shm|wal)$/,
 *      so a sibling directory is unreachable from it. This preserves the WHOLE corpus — 1291
 *      postings, term weights, org units — but it is an untracked 116 MB file on one disk. A
 *      backup is not evidence; it is a copy that happens to still exist.
 *
 *   2. EXPORTS the 30 graded postings as a COMMITTED JSON fixture. ~200 KB, in git, survives any
 *      future purge, any disk, any clone. This is the durable artefact. It carries every column
 *      services/localAtsScorer.js actually reads (title, company, category, description) plus the
 *      published engine score and the human FIT, and scripts/am1GradedCorpusVerify.mjs re-scores
 *      FROM IT and checks rho reproduces.
 *
 * Read-only against the backup. Writes only to data/evidence/ and docs/.
 *
 * Usage: node scripts/am1PreserveGradedCorpus.mjs [--no-copy]
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectRetained } from "./backup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BAK_DIR = path.join(ROOT, "data", "backups");
const EVIDENCE_DIR = path.join(ROOT, "data", "evidence");
const FIXTURE = path.join(ROOT, "docs", "am1-ats-graded-corpus.json");
const args = process.argv.slice(2);

/** The published figures this corpus is the evidence for. shared/atsBands.js. */
const PUBLISHED = { rho: 0.746, tau: 0.594, misordered: 0.122 };

function sha256(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/**
 * HOW LONG THE BACKUP HAS LEFT, computed from the real retention rule rather than guessed.
 *
 * selectRetained is imported from the script that actually prunes, so this cannot drift away from
 * the policy the way a restated rule would. Each simulated step prepends one auto-daily entry the
 * size of the current DB, exactly as createBackup does.
 */
function retentionForecast(filename, { steps = 10 } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(BAK_DIR, "manifest.json"), "utf8")); }
  catch { return { known: false }; }
  const livePath = path.join(ROOT, "data", "resume_master.db");
  const liveSize = fs.existsSync(livePath) ? fs.statSync(livePath).size : manifest[0]?.size ?? 0;

  if (!manifest.some(e => e.filename === filename)) return { known: true, survives: 0, absent: true };
  let sim = manifest;
  for (let i = 1; i <= steps; i++) {
    sim = [{ filename: "simulated-" + i + ".db", label: "auto-daily", created: new Date().toISOString(), size: liveSize }, ...sim];
    sim = selectRetained(sim).keep;
    if (!sim.some(e => e.filename === filename)) return { known: true, survives: i - 1, liveSize };
  }
  return { known: true, survives: ">" + steps, liveSize };
}

// ── locate the corpus ───────────────────────────────────────────────────────
const backupName = fs.readdirSync(BAK_DIR).find(f => f.includes("2026-08-31") && f.endsWith(".db"));
if (!backupName) {
  console.error("⛔ The 2026-08-31 backup is GONE. If data/evidence/ has no copy either, the graded");
  console.error("   corpus is unrecoverable and rho = 0.746 can never be reproduced.");
  process.exit(2);
}
const backupPath = path.join(BAK_DIR, backupName);

console.log("─".repeat(90));
console.log("R1 — PRESERVE THE EVIDENCE");
console.log("─".repeat(90));

const forecast = retentionForecast(backupName);
console.log("source          " + path.relative(ROOT, backupPath));
console.log("size            " + (fs.statSync(backupPath).size / 1048576).toFixed(1) + " MB");
if (forecast.known && typeof forecast.survives === "number") {
  console.log("retention       survives " + forecast.survives + " more auto-daily backup(s) " +
              "before selectRetained() drops it");
}

// ── 1. copy out of the rotation ─────────────────────────────────────────────
const sourceHash = sha256(backupPath);
console.log("sha256(source)  " + sourceHash);

let copyPath = null;
if (!args.includes("--no-copy")) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  copyPath = path.join(EVIDENCE_DIR, backupName);
  // Copy first, hash the COPY independently, and compare. Trusting copyFileSync and reporting the
  // source hash for the destination would certify a file nobody read.
  fs.copyFileSync(backupPath, copyPath);
  const copyHash = sha256(copyPath);
  if (copyHash !== sourceHash) {
    console.error("⛔ COPY MISMATCH — " + copyHash + " != " + sourceHash + ". The copy is NOT the evidence.");
    process.exit(3);
  }
  console.log("pinned copy     " + path.relative(ROOT, copyPath));
  console.log("sha256(copy)    " + copyHash + "  ✓ matches source");

  fs.writeFileSync(path.join(EVIDENCE_DIR, backupName + ".sha256"), sourceHash + "  " + backupName + "\n");
  fs.writeFileSync(path.join(EVIDENCE_DIR, "README.md"), [
    "# data/evidence — pinned, out of the backup rotation",
    "",
    "`scripts/backup.js` prunes `data/backups/` against a 512 MB budget. It only ever unlinks paths",
    "it joins directly onto that directory from `manifest.json`, plus sidecars matching `.db-shm` /",
    "`.db-wal`. This directory is unreachable from it, and nothing here is in the manifest.",
    "",
    "| file | sha256 |",
    "|---|---|",
    "| `" + backupName + "` | `" + sourceHash + "` |",
    "",
    "That is the last snapshot before `cleanup_log` id 85 deleted 1288 postings on 2026-09-02. It",
    "holds 1291 postings including all 30 human-graded ones, 856 term weights, profile 6 and its",
    "4912-char résumé. The 2026-09-02 snapshot is ALREADY post-deletion.",
    "",
    "**This file is untracked and lives on one disk.** The durable artefact is",
    "`docs/am1-ats-graded-corpus.json` — the 30 graded postings, committed. Verify with",
    "`node scripts/am1GradedCorpusVerify.mjs`.",
    "",
  ].join("\n"));
}

// ── 2. export the graded 30 as a committed fixture ──────────────────────────
const key = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "ak2-ats-grading-key.json"), "utf8"));
const md = fs.readFileSync(path.join(ROOT, "docs", "ak2-ats-grading-set.md"), "utf8");
const fits = new Map();
for (const m of md.matchAll(/^\|\s*(\d+)\s*\|\s*([1-5])\s*\|/gm)) fits.set(Number(m[1]), Number(m[2]));

const db = new Database(backupPath, { readonly: true });
const row = db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?");

const postings = [];
const missing = [];
for (const p of key.postings) {
  const j = row.get(p.job_id);
  if (!j) { missing.push(p); continue; }
  postings.push({
    n: p.n,
    job_id: p.job_id,
    // ── what services/localAtsScorer.js actually reads off a job row ──
    company: j.company,
    title: j.title,
    category: j.category,
    description: j.description,
    // ── context a reader needs, and the join keys for a future re-derivation ──
    location: j.location,
    url: j.url,
    source: j.source,
    source_platform: j.source_platform,
    skills_json: j.skills_json,
    normalized_title: j.normalized_title,
    experience_level: j.experience_level,
    workplace_type: j.workplace_type,
    scraped_at: j.scraped_at,
    // ── the two numbers the whole fixture exists to keep joinable ──
    engine_score: p.engine_score,
    human_fit: fits.get(p.n) ?? null,
  });
}
db.close();

const ungraded = postings.filter(p => !Number.isFinite(p.human_fit));
const noText = postings.filter(p => !p.description || !p.description.trim());

const fixture = {
  // Everything a future reader needs in order to decide whether to trust this file, stated IN it
  // rather than in a doc that can drift away from it.
  schema: "am1-ats-graded-corpus/v1",
  generated_at: new Date().toISOString(),
  purpose:
    "The 30 human-graded postings behind rho = 0.746. Exported because cleanup_log id 85 deleted " +
    "1288 of 1293 scraped_jobs rows on 2026-09-02 and none of these 30 survive on the live board. " +
    "The human grades were already committed; the postings they grade were not, and the scorer " +
    "reads the description, so the grades alone could not re-score anything.",
  provenance: {
    corpus: "data/backups/" + backupName,
    corpus_sha256: sourceHash,
    pinned_copy: copyPath ? path.relative(ROOT, copyPath).replace(/\\/g, "/") : null,
    grades_from: "docs/ak2-ats-grading-set.md (FIT column)",
    ids_from: "docs/ak2-ats-grading-key.json",
    scorer: key.scorer,
    profile_id: key.profile_id,
    resume_chars: key.resume_chars,
    board_size_when_graded: key.board_size,
  },
  published: PUBLISHED,
  // ⛔ NOT SELF-SUFFICIENT, and saying so is the point. Re-scoring also needs profile 6, its base
  // résumé and ats_term_weights. Those are still in the LIVE database (856 weights, profile 6 and
  // its résumé all survived, because they are not scraped_jobs rows). If a future purge takes them
  // too, this fixture stops being scorable — that is the next thing to export, not a surprise.
  also_required_to_rescore: [
    "domain_profiles id 6",
    "profile_base_resumes profile_id 6",
    "ats_term_weights (856 rows, role-family scoped)",
  ],
  counts: {
    postings: postings.length,
    expected: key.postings.length,
    with_human_fit: postings.length - ungraded.length,
    description_chars: postings.reduce((n, p) => n + (p.description?.length ?? 0), 0),
  },
  postings,
};

fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");

console.log("─".repeat(90));
console.log("fixture         " + path.relative(ROOT, FIXTURE));
console.log("                " + postings.length + "/" + key.postings.length + " postings, " +
            fixture.counts.with_human_fit + " with a human FIT, " +
            (fixture.counts.description_chars / 1024).toFixed(0) + " KB of description text");
console.log("sha256(fixture) " + sha256(FIXTURE));

let bad = 0;
if (missing.length) {
  bad++;
  console.log("⛔ " + missing.length + " graded posting(s) NOT IN THE BACKUP: " + missing.map(m => m.n).join(", "));
}
if (ungraded.length) {
  bad++;
  console.log("⛔ " + ungraded.length + " posting(s) exported with NO human FIT: " + ungraded.map(m => m.n).join(", "));
}
if (noText.length) {
  bad++;
  console.log("⛔ " + noText.length + " posting(s) have an EMPTY description, so are not scorable: " +
              noText.map(m => m.n).join(", "));
}
if (!bad) console.log("✓ all 30 present, all graded, all carrying description text");

console.log("─".repeat(90));
console.log("Next: node scripts/am1GradedCorpusVerify.mjs   (re-scores FROM the fixture, checks rho)");
process.exit(bad ? 1 : 0);
