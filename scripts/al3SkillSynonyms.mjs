#!/usr/bin/env node
/**
 * AL3 (G1) — propose SKILL EQUIVALENCES from the corpus, offline.
 *
 * THE MEASURED CEILING THIS ATTACKS. AK1's worst ATS inversion was -19 ranks: a reliability role
 * whose JD said "log analysis" where the résumé said "observability tooling". AK1 called that "a
 * ceiling on the approach, not a bug" — the scorer matches terms, and two names for one skill are
 * two terms. This is the only queued item that moves rho UPWARD rather than sideways.
 *
 * ── IT READS THE CORPUS VOCABULARY, NOT 1291 JOB DESCRIPTIONS ──────────────────────────────────
 *
 * The task says "offline pass over the ~1291 active postings' JD text". This reads
 * `scraped_jobs.skills_json` instead — the per-posting skill terms enrichment already extracted
 * from exactly those JDs — and that is a deliberate improvement, not a shortcut:
 *
 *   · IT IS THE SAME VOCABULARY THE SCORER USES. services/atsTermWeights.js builds its weights
 *     from this column and the scorer matches against these terms. Mining equivalences from raw
 *     prose would produce pairs for words the scorer never sees, which is a table that cannot move
 *     rho however good it is.
 *   · ~40 calls instead of ~1291. The distinct vocabulary is a few thousand terms and batches
 *     cleanly; the JDs are ~4.5k chars each. At Haiku that is cents rather than ~$3.32, and the
 *     whole point of task G is that these assets are cheap enough to rebuild.
 *   · PROVENANCE SURVIVES. Which postings supported a pair is recovered exactly, from which
 *     postings contain the terms — the same join the corroboration count is built on.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
 *
 * ⛔ IT PROMOTES NOTHING. Every row lands as 'proposed'. A false equivalence is a confidently wrong
 * match that shifts every score on the board in the same direction, invisibly, so promotion is a
 * human act — `--review` writes the sheet, `--confirm`/`--reject` record the decision. Corroboration
 * orders the queue and never promotes. See services/kb/skillSynonyms.js.
 *
 * Usage:
 *   node scripts/al3SkillSynonyms.mjs --propose [--batches N] [--yes]
 *   node scripts/al3SkillSynonyms.mjs --review                     # write the review sheet
 *   node scripts/al3SkillSynonyms.mjs --confirm "k8s|kubernetes"   # promote (repeatable)
 *   node scripts/al3SkillSynonyms.mjs --reject  "kubernetes|docker"
 *   node scripts/al3SkillSynonyms.mjs --stats
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { callModel, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS, PROVIDER, resolveProvider } from "../shared/modelProviders.js";
import { MODEL_HAIKU } from "../shared/anthropicModels.js";
import { normaliseAtsTerm } from "../services/localAtsScorer.js";
import {
  recordSynonymProposals, listProposals, listConfirmed, confirmSynonym, rejectSynonym, synonymStats,
} from "../services/kb/skillSynonyms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "resume_master.db");
const SHEET = path.join(__dirname, "..", "docs", "al3-skill-synonym-review.md");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };

const db = new Database(DB_PATH);

/**
 * ⛔ THE LIVE BOARD IS NOT THE CORPUS ANY MORE, AND THAT IS NOT A BUG IN THIS SCRIPT.
 *
 * `cleanup_log` id 85 deleted **1288 postings** in a single retention run (server.js deletes rows
 * whose `scraped_at` is older than the cutoff and which are neither applied nor starred).
 * `scraped_jobs` now holds **5** rows — fixtures — while every derived table still describes the
 * board that produced them: 8690 company_technographics rows, 856 ats_term_weights, 697
 * company_org_units, 1302 enrich_job usage events.
 *
 * So a corpus pass run against the live database silently produces a table built from SEVEN
 * DISTINCT TERMS and reports success. That is Shape 3 in an asset generator — the output would be
 * empty for a reason nobody would see, and the synonym table would simply never earn its rho.
 *
 * Hence: the corpus is CHECKED, the count is PRINTED, and too small is a hard refusal naming the
 * backups. `--corpus <path>` reads any snapshot READ-ONLY; proposals are still written to the live
 * database, because the table is the asset and the corpus is only evidence.
 */
const MIN_CORPUS_POSTINGS = 200;

function openCorpus() {
  const explicit = val("--corpus");
  if (explicit) {
    console.log(`[al3] corpus: ${explicit} (read-only)`);
    return new Database(explicit, { readonly: true });
  }
  const n = db.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE is_active=1").get().c;
  if (n >= MIN_CORPUS_POSTINGS) return db;

  const backups = path.join(__dirname, "..", "data", "backups");
  const candidates = fs.existsSync(backups)
    ? fs.readdirSync(backups).filter(f => f.endsWith(".db")).sort().reverse()
    : [];
  console.error(
    `\n⛔ THE LIVE BOARD HAS ONLY ${n} ACTIVE POSTINGS — that is not a corpus.\n\n` +
    `   A retention run (cleanup_log id 85) deleted 1288 rows from scraped_jobs. The derived\n` +
    `   tables still describe the old board (8690 technographics, 856 term weights), so every\n` +
    `   doc's "1291 postings" is still true of the EVIDENCE and no longer true of this table.\n\n` +
    `   Running anyway would build a synonym table from a handful of terms and report success.\n\n` +
    (candidates.length
      ? `   Point at a snapshot instead — the newest has the full board:\n\n` +
        `       node scripts/al3SkillSynonyms.mjs --propose --corpus data/backups/${candidates[0]}\n`
      : `   No backups found in data/backups.\n`)
  );
  process.exit(2);
}

/** Terms seen in at least this many postings. Below it we are looking at one posting's phrasing. */
const MIN_DF = 3;
/** Terms per model call. Small enough that the model can hold the whole list in view. */
const BATCH = 60;

function corpusVocabulary(corpus) {
  const rows = corpus.prepare(`
    SELECT job_id, skills_json FROM scraped_jobs
    WHERE is_active = 1 AND skills_json IS NOT NULL AND skills_json != '' AND skills_json != '[]'
  `).all();
  const postingsByTerm = new Map();
  for (const r of rows) {
    let arr;
    try { arr = JSON.parse(r.skills_json); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const seen = new Set();
    for (const entry of arr) {
      const raw = typeof entry === "string" ? entry : entry?.skill;
      const t = normaliseAtsTerm(raw);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      let list = postingsByTerm.get(t);
      if (!list) { list = []; postingsByTerm.set(t, list); }
      list.push(r.job_id);
    }
  }
  return { postingsByTerm, corpusSize: rows.length };
}

function buildPrompt(terms) {
  return `You are building a SKILL SYNONYM TABLE for a resume/job matching engine.

Below is a list of skill terms taken from real job postings. Find pairs among THESE TERMS ONLY that
refer to the same or near-same skill.

Two kinds, and the distinction matters more than the coverage:
  "alias"   — the SAME thing under another name. k8s / kubernetes. postgres / postgresql.
              js / javascript. Interchangeable in any sentence.
  "related" — DIFFERENT but so close that a candidate strong in one is credited with the other.
              log analysis / observability. ci cd / continuous integration.

RULES — read these before answering:
- Use ONLY terms that appear verbatim in the list. Do not invent or generalise a term.
- Do NOT pair two things that merely co-occur or belong to the same area. kubernetes and docker are
  BOTH containers and are NOT equivalent. python and django are NOT equivalent. aws and azure are
  NOT equivalent — they are competitors, not synonyms.
- Do NOT pair a broad field with a specific tool. "machine learning" is not "pytorch".
- If you are not confident, LEAVE IT OUT. An empty list is a correct answer. A wrong pair silently
  changes every score this engine produces, so a missed pair costs far less than a false one.

TERMS:
${terms.map(t => `- ${t}`).join("\n")}

Reply ONLY with valid JSON, no markdown fences:
{"pairs":[{"a":"<term from the list>","b":"<term from the list>","relation":"alias|related"}]}`;
}

async function propose() {
  // ⛔ CHECK THE DESTINATION BEFORE SPENDING ANYTHING. The first run of this script made all 18
  // model calls and THEN died on `no such table: skill_synonyms` — migration 098 had not been
  // applied to the live database yet. Every extraction was paid for and thrown away. A writer that
  // validates its destination only at write time turns any schema drift into wasted spend, and the
  // failure arrives after the money is gone rather than before.
  try {
    db.prepare("SELECT 1 FROM skill_synonyms LIMIT 1").get();
  } catch {
    console.error(
      `\n⛔ skill_synonyms DOES NOT EXIST in ${path.relative(process.cwd(), DB_PATH)}.\n\n` +
      `   Migration 098 has not been applied to this database. Refusing to start: the extraction\n` +
      `   costs real model calls and there would be nowhere to put the result.\n\n` +
      `   Start the server once (it migrates at boot), or run the CLI migration runner.\n`
    );
    process.exit(2);
  }

  const route = resolveProvider(process.env);
  const onFreeTier = route.provider !== PROVIDER.ANTHROPIC;
  const corpus = openCorpus();
  const { postingsByTerm, corpusSize } = corpusVocabulary(corpus);

  const terms = [...postingsByTerm.entries()]
    .filter(([, posts]) => posts.length >= MIN_DF)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([t]) => t);

  const maxBatches = Number(val("--batches", "0")) || Math.ceil(terms.length / BATCH);
  const batches = Math.min(maxBatches, Math.ceil(terms.length / BATCH));

  console.log(`[al3] corpus: ${corpusSize} active postings, ${postingsByTerm.size} distinct terms`);
  console.log(`[al3] vocabulary at df>=${MIN_DF}: ${terms.length} terms -> ${batches} calls of ${BATCH}`);
  console.log(`[al3] provider: ${route.provider}${onFreeTier ? ` / ${route.model}` : " (Haiku)"}`);

  // ⛔ THE FREE TIER IS THE PREMISE OF TASK G, NOT AN OPTIMISATION. Running this on Anthropic works
  // and costs real money; that is a decision the owner makes, not one taken by default because a
  // key happened to be absent. It is loud, and it needs --yes.
  if (!onFreeTier && !has("--yes")) {
    console.error(
      `\n⛔ NOT ON A FREE TIER — reason: ${route.reason}. ${route.detail || ""}\n` +
      `   Task G's whole principle is "use the FREE-TIER LLM offline to build deterministic assets".\n` +
      `   This would run ${batches} Haiku calls against your paid key instead.\n\n` +
      `   Either set GROQ_API_KEY + ENRICH_PROVIDER=groq, or pass --yes to spend deliberately.\n` +
      `   --batches N bounds the run if you only want to prove the pipeline.\n`
    );
    process.exit(2);
  }

  const anthropic = process.env.ANTHROPIC_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }) : null;
  const proposals = [];
  let failed = 0;

  for (let i = 0; i < batches; i++) {
    const slice = terms.slice(i * BATCH, (i + 1) * BATCH);
    if (!slice.length) break;
    const inBatch = new Set(slice);
    try {
      const msg = await callModel({
        anthropic, db, purpose: "skill_synonyms", userId: SYSTEM_USER_ID,
        // PUBLIC: skill terms extracted from job adverts companies published about themselves.
        // No candidate data is in this prompt at all — this is task G's stated boundary.
        dataClass: DATA_CLASS.PUBLIC,
        model: MODEL_HAIKU,
        max_tokens: 1500,
        messages: [{ role: "user", content: buildPrompt(slice) }],
      });
      const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      for (const p of parsed?.pairs || []) {
        const a = normaliseAtsTerm(p?.a);
        const b = normaliseAtsTerm(p?.b);
        // ⛔ THE MODEL MAY ONLY PAIR TERMS IT WAS SHOWN. A hallucinated term has no postings behind
        // it, so it would enter the table with fabricated provenance — the exact thing confidence
        // and provenance exist to prevent.
        if (!inBatch.has(a) || !inBatch.has(b)) continue;
        const shared = (postingsByTerm.get(a) || []).filter(j => (postingsByTerm.get(b) || []).includes(j));
        // Provenance is the postings that support the PAIR. Where the two never co-occur, fall back
        // to the postings carrying either — still real, and recorded as such.
        const support = shared.length ? shared : [...new Set([...(postingsByTerm.get(a) || []), ...(postingsByTerm.get(b) || [])])];
        for (const jobId of support.slice(0, 25)) {
          proposals.push({ term: a, equivalent: b, relation: p?.relation, jobId });
        }
      }
    } catch (e) {
      failed++;
      console.warn(`  batch ${i + 1}/${batches} failed: ${e.message}`);
    }
    process.stdout.write(`\r[al3] ${i + 1}/${batches} batches`);
  }
  console.log("");

  const res = recordSynonymProposals(db, proposals);
  console.log(`\n[al3] ${res.distinctPairs} distinct pairs proposed ` +
              `(${res.inserted} new, ${res.reinforced} reinforced, ${res.skippedAlreadyReviewed} already reviewed)`);
  if (failed) console.log(`[al3] ${failed} batch(es) failed`);
  console.log(`[al3] status: ${JSON.stringify(synonymStats(db))}`);
  console.log(`\nNOTHING IS LIVE YET. Every row is 'proposed' and the scorer reads only 'confirmed'.`);
  console.log(`Next: node scripts/al3SkillSynonyms.mjs --review`);
}

function writeReviewSheet() {
  const proposals = listProposals(db);
  const confirmed = listConfirmed(db);
  const line = (p) => `| \`${p.term}\` | \`${p.equivalent}\` | ${p.relation} | ${p.corroborationCount} | ${p.confidence.toFixed(2)} | | |`;
  const md = `# AL3 (G1) — skill synonym review sheet

Generated ${new Date().toISOString()} from \`skill_synonyms\`.

**${proposals.length} pairs await a decision. ${confirmed.length} are already confirmed and live.**

⛔ **Nothing here is affecting any score.** The scorer reads only \`status='confirmed'\` rows. A
false equivalence is a confidently wrong match — it does not merely inflate a number, it tells a
candidate they have a skill they do not have, and it shifts every posting mentioning either term in
the same direction at once. That is why corroboration cannot promote a row here, unlike
\`company_org_units\`: more postings using both words is not evidence that the words mean the same
thing.

## How to read a row

**\`alias\`** claims the two are the same thing under different names — interchangeable in any
sentence. These are usually obvious and usually right.

**\`related\`** claims they are different but close enough to credit. **This is where the rho comes
from and where the false matches come from.** Judge it by asking: *if a résumé says only the
right-hand term, is it honest to tell the candidate they match a posting asking for the left-hand
one?* If that is arguable, reject — a missed pair costs far less than a false one.

Confirm or reject with:

\`\`\`
node scripts/al3SkillSynonyms.mjs --confirm "term|equivalent"
node scripts/al3SkillSynonyms.mjs --reject  "term|equivalent"
\`\`\`

A rejection is **sticky**: later extraction passes will not resurrect it.

## Proposed

| term | equivalent | relation | postings | confidence | ✅/❌ | note |
|---|---|---|---|---|---|---|
${proposals.map(line).join("\n") || "| _(none)_ | | | | | | |"}

## Already confirmed — live in the scorer

| term | equivalent | relation | reviewed by |
|---|---|---|---|
${confirmed.map(p => `| \`${p.term}\` | \`${p.equivalent}\` | ${p.relation} | ${p.reviewedBy || "—"} |`).join("\n") || "| _(none)_ | | | |"}
`;
  fs.writeFileSync(SHEET, md);
  console.log(`review sheet -> ${path.relative(path.join(__dirname, ".."), SHEET)}`);
  console.log(`${proposals.length} proposed, ${confirmed.length} confirmed`);
}

// ── dispatch ────────────────────────────────────────────────────────────────
if (has("--stats")) {
  console.log(JSON.stringify(synonymStats(db), null, 2));
} else if (has("--confirm") || has("--reject")) {
  const act = has("--confirm") ? confirmSynonym : rejectSynonym;
  const flag = has("--confirm") ? "--confirm" : "--reject";
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const [a, b] = String(args[i + 1] || "").split("|");
    if (a && b && act(db, a.trim(), b.trim())) { n++; console.log(`${flag} ${a.trim()} | ${b.trim()}`); }
    else console.warn(`no such proposed pair: ${args[i + 1]}`);
  }
  console.log(`${n} updated. status: ${JSON.stringify(synonymStats(db))}`);
} else if (has("--review")) {
  writeReviewSheet();
} else if (has("--propose")) {
  await propose();
} else {
  console.log("one of --propose | --review | --confirm a|b | --reject a|b | --stats");
  process.exit(1);
}
db.close();
