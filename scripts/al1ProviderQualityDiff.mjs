#!/usr/bin/env node
/**
 * AL1 — does the free-tier model extract as well as Haiku?
 *
 * Requirement 8 of task A: quality is NOT assumed. The saving is ~$3.32 a pass and it is not worth
 * degrading skills_json, which feeds company_technographics (8507 rows, and the STACK block every
 * company card renders) and the ATS scorer's term matching. An 8B model may simply be worse.
 *
 * WHAT THIS MEASURES: per-column agreement between two providers extracting from the SAME postings
 * with the SAME prompt. Not "is the output well-formed" — that is a much weaker question that a
 * broken extractor passes. Agreement is reported per column because the columns are not equally
 * important and they do not fail together: a model can nail experience_level and hallucinate
 * salaries.
 *
 * ⚠ THIS SPENDS REAL MONEY on the Anthropic arm — one Haiku call per row, ~$0.0026 for 50 rows.
 * It is excluded from `npm run verify:harness` for that reason. Run it by hand.
 *
 *   ENRICH_PROVIDER=groq GROQ_API_KEY=gsk_... node scripts/al1ProviderQualityDiff.mjs --rows 50
 *
 * Flags:
 *   --rows N        how many postings to compare (default 50)
 *   --free-only     skip the Anthropic arm; proves the free path runs, measures no agreement
 *   --json PATH     also write the raw per-row extractions for inspection
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

import { callModel, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS, PROVIDER, resolveProvider, PROVIDERS } from "../shared/modelProviders.js";
import { MODEL_HAIKU } from "../shared/anthropicModels.js";
// THE PIPELINE'S OWN PROMPT, imported rather than copied. A copy would drift and this harness would
// then report agreement on a prompt enrichment does not use.
import { buildPrompt } from "../services/jobs/enrichJob.js";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "resume_master.db");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const ROWS = Number(flag("--rows", "50"));
const FREE_ONLY = args.includes("--free-only");
const JSON_OUT = flag("--json");

const COLUMNS = [
  "normalizedTitle", "experienceLevel", "workplaceType",
  "salaryMinUsd", "salaryMaxUsd", "salaryPeriod",
  "isH1bSponsor", "requiresWorkAuth", "isClearanceRequired", "orgUnit",
];

function parse(msg) {
  const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  try { return JSON.parse(raw); } catch { return null; }
}

/** Two nulls AGREE. A model correctly declining on a silent posting is the common correct case. */
function agrees(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

/** Jaccard over the skill sets — skills are a SET, so exact-match agreement would read as 0%. */
function skillOverlap(a, b) {
  const norm = (x) => new Set((Array.isArray(x) ? x : []).map(s => String(s).trim().toLowerCase()).filter(Boolean));
  const A = norm(a), B = norm(b);
  if (!A.size && !B.size) return 1;
  const inter = [...A].filter(s => B.has(s)).length;
  return inter / (A.size + B.size - inter);
}

async function main() {
  const route = resolveProvider(process.env);
  if (route.provider === PROVIDER.ANTHROPIC) {
    console.error(
      `\n⛔ NOT CONFIGURED FOR A FREE TIER — reason: ${route.reason}. ${route.detail || ""}\n` +
      `   This harness would otherwise compare Haiku against Haiku and report 100% agreement,\n` +
      `   which is exactly the false green requirement 8 exists to prevent.\n\n` +
      `   Set ENRICH_PROVIDER=groq and GROQ_API_KEY, then re-run.\n`
    );
    process.exit(2);
  }
  const spec = PROVIDERS[route.provider];
  console.log(`[al1] free tier: ${spec.label} / ${route.model}   (${spec.requestsPerMinute} req/min)`);

  const db = new Database(DB_PATH, { readonly: false });
  const anthropic = process.env.ANTHROPIC_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }) : null;
  if (!FREE_ONLY && !anthropic) {
    console.error("⛔ ANTHROPIC_KEY absent — the comparison arm cannot run. Use --free-only to measure nothing, deliberately.");
    process.exit(2);
  }

  // Real postings, and the SAME ones enrichment would pick: long enough to carry signal.
  const jobs = db.prepare(`
    SELECT job_id, title, company, description FROM scraped_jobs
    WHERE is_active = 1 AND description IS NOT NULL AND LENGTH(description) > 500
    ORDER BY job_id LIMIT ?
  `).all(ROWS);
  if (!jobs.length) {
    console.error("⛔ no postings in scraped_jobs — nothing to compare.");
    process.exit(2);
  }
  console.log(`[al1] comparing ${jobs.length} postings\n`);

  const rows = [];
  let freeFailures = 0, paidFailures = 0;

  for (const [i, job] of jobs.entries()) {
    const params = {
      max_tokens: 500,
      messages: [{ role: "user", content: buildPrompt(job.title, job.company, job.description) }],
    };

    let free = null, paid = null;
    try {
      free = parse(await callModel({
        anthropic, db, purpose: "enrich_job", userId: SYSTEM_USER_ID, jobId: job.job_id,
        dataClass: DATA_CLASS.PUBLIC, model: MODEL_HAIKU, ...params,
      }));
    } catch (e) { freeFailures++; console.warn(`  [${i + 1}] free arm failed: ${e.message}`); }

    if (!FREE_ONLY) {
      try {
        paid = parse(await callModel({
          anthropic, db, purpose: "enrich_job", userId: SYSTEM_USER_ID, jobId: job.job_id,
          // CANDIDATE forces the Anthropic route without a second code path. The payload is still
          // public job text — this is the harness borrowing the router's own switch, and it is the
          // reason the class is a parameter rather than a lookup on `purpose`.
          dataClass: DATA_CLASS.CANDIDATE, model: MODEL_HAIKU, ...params,
        }));
      } catch (e) { paidFailures++; console.warn(`  [${i + 1}] anthropic arm failed: ${e.message}`); }
    }

    rows.push({ job_id: job.job_id, title: job.title, free, paid });
    process.stdout.write(`\r[al1] ${i + 1}/${jobs.length}`);
  }
  console.log("\n");

  // ── REPORT ────────────────────────────────────────────────────────────────────────────────────
  const usable = rows.filter(r => r.free && (FREE_ONLY || r.paid));
  console.log(`parsed OK: free ${rows.filter(r => r.free).length}/${rows.length}` +
              (FREE_ONLY ? "" : `   anthropic ${rows.filter(r => r.paid).length}/${rows.length}`));
  console.log(`failures:  free ${freeFailures}   anthropic ${paidFailures}\n`);

  if (FREE_ONLY) {
    console.log("--free-only: the free path RAN. No agreement was measured, so this says NOTHING");
    console.log("about extraction quality. Do not read it as a green light for switching the default.");
  } else if (!usable.length) {
    console.log("⛔ no row produced BOTH extractions — nothing can be compared.");
  } else {
    console.log(`PER-COLUMN AGREEMENT over ${usable.length} postings\n`);
    console.log("  column                  agree    disagree");
    for (const col of COLUMNS) {
      const agree = usable.filter(r => agrees(r.free[col], r.paid[col])).length;
      const pct = ((agree / usable.length) * 100).toFixed(1);
      console.log(`  ${col.padEnd(22)}  ${String(pct).padStart(5)}%   ${usable.length - agree}`);
    }
    const hard = usable.map(r => skillOverlap(r.free.skillsHard, r.paid.skillsHard));
    const soft = usable.map(r => skillOverlap(r.free.skillsSoft, r.paid.skillsSoft));
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`\n  skillsHard (Jaccard)    ${(mean(hard) * 100).toFixed(1)}%   <- feeds company_technographics AND the ATS scorer`);
    console.log(`  skillsSoft (Jaccard)    ${(mean(soft) * 100).toFixed(1)}%`);
    console.log(
      `\nREAD THIS BEFORE SWITCHING THE DEFAULT. Agreement is not accuracy — it says the two models\n` +
      `say the same thing, not that either is right. A column where they disagree needs a human to\n` +
      `look at which one is correct. The saving at stake is ~$3.32 per full pass.`
    );
  }

  const events = db.prepare(`
    SELECT COALESCE(provider,'anthropic') AS provider, COUNT(*) AS calls,
           COALESCE(SUM(cost_usd),0) AS cost
    FROM usage_events WHERE purpose = 'enrich_job'
      AND created_at >= ? GROUP BY 1 ORDER BY calls DESC
  `).all(Math.floor(Date.now() / 1000) - 3600);
  console.log("\nusage_events written in the last hour (enrich_job):");
  for (const e of events) console.log(`  ${e.provider.padEnd(12)} ${String(e.calls).padStart(5)} calls   $${e.cost.toFixed(4)}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
    console.log(`\nraw extractions -> ${JSON_OUT}`);
  }
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
