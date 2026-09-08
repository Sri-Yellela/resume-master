#!/usr/bin/env node
/**
 * AM4 / task U1.1 — MEASURE THE ENRICHMENT BACKLOG BEFORE BUILDING ANYTHING.
 *
 * Task U's first requirement is a measurement, not a feature: "report how many are worth enriching
 * AT ALL. If most are stale, the answer to 'clear the backlog' may be 'do not' — say so rather than
 * enriching them dutifully."
 *
 * READ-ONLY. Locally it opens the database with `readonly: true`; against production it issues
 * authenticated GETs to /api/admin/db/raw-query, which rejects anything but SELECT. Nothing here
 * calls a model, so it cannot spend a token.
 *
 * TWO DATABASES, AND THE 837 IS PRODUCTION'S. NEXT_WORK.md's "837 of ~1248 active rows are
 * unenriched" is a measurement of the DEPLOYED board. The local board was restored by task S from
 * an evidence snapshot of already-enriched rows, so its backlog is a different number entirely.
 * Reporting one as the other is the mistake this file exists to avoid, so it labels every figure.
 *
 * AND THE CHEAP SQL PRE-FILTER IS NOT A COST BASIS. enrichJob.js selects on
 * `enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at` and then re-filters in
 * JS on the exact content hash. On the restored local board the pre-filter matches 1252 rows and
 * the hash check leaves 5 — a 250x over-count, because the restore stamped one bulk `updated_at`
 * onto 1247 rows whose text never changed. Any dry run that priced the pre-filter would quote
 * ~$2 to send nothing. This script reports BOTH numbers and the gap between them.
 *
 * Usage:
 *   node scripts/am4EnrichBacklogAudit.mjs              # local only
 *   node scripts/am4EnrichBacklogAudit.mjs --prod       # local + production
 *   node scripts/am4EnrichBacklogAudit.mjs --url URL    # local + an explicit target
 */

import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "data", "resume_master.db");

// .env is not loaded in a bare script and the admin credentials live there.
for (const line of (fs.existsSync(path.join(ROOT, ".env"))
  ? fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/) : [])) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const WANT_PROD = args.includes("--prod") || urlArg >= 0;
const BASE = (urlArg >= 0 ? args[urlArg + 1] : process.env.APP_BASE_URL || "https://resumemaster.one")
  .replace(/\/$/, "");

const bar = (c) => (c || "-").repeat(88);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "-");

// Haiku 4.5 list price. The estimate is a CEILING: real input, max_tokens output.
const USD_PER_INPUT_MTOK = 1.0;
const USD_PER_OUTPUT_MTOK = 5.0;
const MAX_TOKENS = 500;

// The enrichment columns, in the order the task asks them to be reported.
const ENRICH_COLUMNS = [
  "skills_json", "summary", "normalized_title", "experience_level", "workplace_type",
  "salary_min_usd", "salary_max_usd", "salary_period",
  "is_h1b_sponsor", "requires_work_auth", "is_clearance_required", "org_unit_raw",
];

// Age buckets, in days. The restored board expires as one cohort ~7 days from 2026-09-07, so the
// boundaries deliberately sit either side of that rather than on it.
const BUCKETS = [
  ["0-1d", 0, 1], ["1-3d", 1, 3], ["3-7d", 3, 7],
  ["7-14d", 7, 14], ["14-30d", 14, 30], ["30-60d", 30, 60], ["60d+", 60, Infinity],
];

function bucketOf(epoch, now) {
  if (epoch == null) return "no date";
  const days = (now - epoch) / 86400;
  for (const [label, lo, hi] of BUCKETS) if (days >= lo && days < hi) return label;
  return "60d+";
}

// The queries, written once and run against either database. Every one is an aggregate, so the
// raw-query endpoint's 200-row cap cannot truncate an answer.
const SQL = {
  totals: `SELECT COUNT(*) total, SUM(is_active = 1) active,
                  SUM(is_active = 1 AND (description IS NULL OR TRIM(description) = '')) active_no_desc
           FROM scraped_jobs`,
  // The three pre-filter limbs, counted SEPARATELY. Reporting only their union is what let a
  // 250x over-count look like a backlog: the limbs answer different questions and only one of
  // them ("never enriched") is unambiguous without hashing the text.
  limbs: `SELECT
            SUM(is_active = 1 AND enriched_at IS NULL) never_enriched,
            SUM(is_active = 1 AND content_hash IS NULL) no_hash,
            SUM(is_active = 1 AND updated_at > enriched_at) touched_since,
            SUM(is_active = 1 AND enriched_at IS NOT NULL) enriched
          FROM scraped_jobs`,
  prefilter: `SELECT COUNT(*) n FROM scraped_jobs
              WHERE is_active = 1 AND description IS NOT NULL AND TRIM(description) != ''
                AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)`,
  // Age + description size of the rows that have NEVER been enriched — the unambiguous backlog.
  // discovered_at is the provenance date; task S left it untouched while rebasing scraped_at.
  backlogAges: `SELECT discovered_at, posted_at, valid_through, source,
                       LENGTH(COALESCE(description, '')) desc_len
                FROM scraped_jobs
                WHERE is_active = 1 AND enriched_at IS NULL
                  AND description IS NOT NULL AND TRIM(description) != ''`,
  coverage: `SELECT COUNT(*) n, ${ENRICH_COLUMNS.map(c => `SUM(${c} IS NOT NULL) ${c}`).join(", ")}
             FROM scraped_jobs WHERE is_active = 1`,
};

// Bucketing done in SQL, for the remote path. The 200-row cap means the per-row age list cannot be
// fetched over HTTP, and a truncated 200-row sample of an 837-row backlog would look like a
// measurement without being one.
const REMOTE_AGE_BUCKETS = `
  SELECT CASE
    WHEN discovered_at IS NULL THEN 'no date'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 <  1 THEN '0-1d'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 <  3 THEN '1-3d'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 <  7 THEN '3-7d'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 < 14 THEN '7-14d'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 < 30 THEN '14-30d'
    WHEN (strftime('%s','now') - discovered_at) / 86400.0 < 60 THEN '30-60d'
    ELSE '60d+' END bucket,
    COUNT(*) n, SUM(LENGTH(COALESCE(description,''))) chars,
    MIN(discovered_at) min_disc, MAX(discovered_at) max_disc,
    SUM(posted_at IS NULL) posted_null,
    SUM(valid_through IS NOT NULL AND valid_through < strftime('%s','now')) past_valid_through
  FROM scraped_jobs
  WHERE is_active = 1 AND enriched_at IS NULL
    AND description IS NOT NULL AND TRIM(description) != ''
  GROUP BY bucket`;

async function measureRemote(base) {
  const USER = process.env.ADMIN_USER, PASS = process.env.ADMIN_PASSWORD;
  if (!USER || !PASS) throw new Error("ADMIN_USER / ADMIN_PASSWORD are not set");
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`login: HTTP ${login.status} ${(await login.text()).slice(0, 160)}`);
  const { authContext: token } = await login.json();
  if (!token) throw new Error("login returned no authContext token");

  const q = async (sql) => {
    const r = await fetch(`${base}/api/admin/db/raw-query?sql=${encodeURIComponent(sql)}`,
      { headers: { "x-rm-auth-context": token } });
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(`raw-query: ${body.error || r.status}`);
    return body.rows;
  };
  return {
    totals: (await q(SQL.totals))[0],
    limbs: (await q(SQL.limbs))[0],
    prefilter: (await q(SQL.prefilter))[0].n,
    coverage: (await q(SQL.coverage))[0],
    ageBuckets: await q(REMOTE_AGE_BUCKETS),
    // The hash-mismatch count cannot be computed remotely (it needs every row's full text), so it
    // is reported as unknown rather than guessed. Said out loud in report().
    trueCandidates: null,
  };
}

function measureLocal() {
  const db = new Database(LIVE, { readonly: true });
  const hash = (t, d) => crypto.createHash("sha1").update(`${t || ""}|${d || ""}`).digest("hex");
  const now = Math.floor(Date.now() / 1000);

  // The exact candidate set enrichJob.js would act on: pre-filter, then the hash check.
  const preRows = db.prepare(`
    SELECT job_id, title, description, content_hash, enriched_at, discovered_at, posted_at,
           valid_through, source
    FROM scraped_jobs
    WHERE is_active = 1 AND description IS NOT NULL AND TRIM(description) != ''
      AND (enriched_at IS NULL OR content_hash IS NULL OR updated_at > enriched_at)`).all();
  const cands = preRows.filter(r => hash(r.title, r.description) !== r.content_hash);

  const backlog = db.prepare(SQL.backlogAges).all();
  const buckets = new Map();
  for (const r of backlog) {
    const b = bucketOf(r.discovered_at, now);
    const e = buckets.get(b) || { bucket: b, n: 0, chars: 0, posted_null: 0, past_valid_through: 0,
                                  min_disc: Infinity, max_disc: -Infinity };
    e.n++; e.chars += r.desc_len; if (r.posted_at == null) e.posted_null++;
    if (r.valid_through != null && r.valid_through < now) e.past_valid_through++;
    if (r.discovered_at != null) {
      e.min_disc = Math.min(e.min_disc, r.discovered_at);
      e.max_disc = Math.max(e.max_disc, r.discovered_at);
    }
    buckets.set(b, e);
  }
  const out = {
    totals: db.prepare(SQL.totals).get(),
    limbs: db.prepare(SQL.limbs).get(),
    prefilter: preRows.length,
    coverage: db.prepare(SQL.coverage).get(),
    ageBuckets: [...buckets.values()],
    trueCandidates: cands.length,
    candidateChars: cands.reduce((s, r) => s + (r.description?.length || 0), 0),
    candidateIds: cands.map(r => r.job_id),
    candidateSources: cands.reduce((m, r) => (m[r.source || "?"] = (m[r.source || "?"] || 0) + 1, m), {}),
  };
  db.close();
  return out;
}

function estimate(chars, rows) {
  const estIn = chars / 4;             // ~4 chars/token, and buildPrompt slices to 4000 chars
  const estOut = rows * MAX_TOKENS;    // the cap, so a ceiling
  return (estIn / 1e6) * USD_PER_INPUT_MTOK + (estOut / 1e6) * USD_PER_OUTPUT_MTOK;
}

function report(label, m) {
  console.log("\n" + bar("="));
  console.log(label);
  console.log(bar("="));
  const t = m.totals, l = m.limbs;
  console.log(`scraped_jobs: ${t.total} rows, ${t.active} active, ` +
              `${t.active_no_desc} active with no description (can never be enriched)`);
  console.log(`  enriched_at set:  ${l.enriched} / ${t.active}  (${pct(l.enriched, t.active)})`);
  console.log(`  NEVER enriched:   ${l.never_enriched}   <- the unambiguous backlog`);
  console.log("");
  console.log("the three pre-filter limbs, separately:");
  console.log(`  enriched_at IS NULL      ${String(l.never_enriched).padStart(6)}`);
  console.log(`  content_hash IS NULL     ${String(l.no_hash).padStart(6)}`);
  console.log(`  updated_at > enriched_at ${String(l.touched_since).padStart(6)}   <- needs the hash to resolve`);
  console.log(`  -- union (pre-filter)    ${String(m.prefilter).padStart(6)}`);
  if (m.trueCandidates == null) {
    console.log(`  -- after the hash check       ?   NOT MEASURABLE REMOTELY (needs every row's full text)`);
  } else {
    const over = m.trueCandidates ? (m.prefilter / m.trueCandidates).toFixed(0) + "x" : "infinite";
    console.log(`  -- after the hash check ${String(m.trueCandidates).padStart(6)}   <- pre-filter over-counts ${over}`);
  }

  console.log("\nnever-enriched rows by discovered_at age:");
  const order = [...BUCKETS.map(b => b[0]), "no date"];
  const sorted = [...m.ageBuckets].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
  const totalBacklog = sorted.reduce((s, b) => s + b.n, 0);
  console.log("  bucket    rows   est. $   posted_at null   past valid_through");
  for (const b of sorted) {
    console.log(`  ${b.bucket.padEnd(8)} ${String(b.n).padStart(5)}   ` +
                `${("$" + estimate(b.chars, b.n).toFixed(3)).padStart(7)}   ` +
                `${String(b.posted_null).padStart(14)}   ${String(b.past_valid_through).padStart(18)}`);
  }
  const allChars = sorted.reduce((s, b) => s + b.chars, 0);
  console.log(`  ${"TOTAL".padEnd(8)} ${String(totalBacklog).padStart(5)}   ` +
              `${("$" + estimate(allChars, totalBacklog).toFixed(3)).padStart(7)}   (ceiling, Haiku 4.5 list)`);

  console.log("\nper-column fill rates over active rows (this is what coverage means):");
  const c = m.coverage;
  for (const col of ENRICH_COLUMNS) {
    console.log(`  ${col.padEnd(22)} ${String(c[col]).padStart(5)} / ${c.n}  ${pct(c[col], c.n)}`);
  }
}

const local = measureLocal();
report("LOCAL - data/resume_master.db (restored by task S)", local);

if (local.trueCandidates && local.trueCandidates <= 20) {
  console.log(`\nthe ${local.trueCandidates} true local candidates:`);
  console.log(`  sources: ${JSON.stringify(local.candidateSources)}`);
  for (const id of local.candidateIds) console.log(`  ${id}`);
  console.log(`  estimated cost to enrich all ${local.trueCandidates}: ` +
              `$${estimate(local.candidateChars, local.trueCandidates).toFixed(4)}`);
}

if (WANT_PROD) {
  try {
    const prod = await measureRemote(BASE);
    report(`PRODUCTION - ${BASE} (read-only, SELECT only)`, prod);
  } catch (e) {
    console.log("\n" + bar("="));
    console.log(`PRODUCTION - ${BASE}: COULD NOT MEASURE`);
    console.log(bar("="));
    console.log("  " + e.message);
    console.log("  Local figures above stand on their own; the production backlog is UNMEASURED.");
    process.exitCode = 1;
  }
} else {
  console.log("\n(no --prod: production's backlog - the 837 - is NOT measured by this run)");
}
