#!/usr/bin/env node
/**
 * AL4 (G2) — resolve the LCA companies the matcher declined to match.
 *
 * ── WHAT IS ACTUALLY UNRESOLVED, and it is not what the task assumed ───────────────────────────
 *
 * The task described the gap as "legal-entity vs brand mismatches — META PLATFORMS, INC. vs Meta,
 * subsidiaries, DBAs". Measured, that is not it: tier A already strips legal suffixes and tier B
 * already reads d/b/a fields, so those cases match today. The six unresolved rows split cleanly:
 *
 *   3 UNMATCHED  Bolt Farm Treehouse · Epia Neuro · Physical Superintelligence
 *                ZERO candidate employers out of 144,584. There is nothing to resolve TO. A model
 *                asked to resolve these can only invent one, and an invented match here is a
 *                sponsorship claim about a company that has never filed.
 *   3 AMBIGUOUS  Linear · Mercury · Ramp
 *                Real candidates the matcher refuses to choose between. This is the ONLY place
 *                outside knowledge can help, so it is the only place this script asks.
 *
 * ⛔ SO IT DOES NOT ASK ABOUT UNMATCHED COMPANIES AT ALL. Not a cost saving — a correctness one.
 *
 * ── "NONE OF THESE" IS A FIRST-CLASS ANSWER ────────────────────────────────────────────────────
 *
 * Linear is the case that shaped this. The corpus contains "Linear Labs LLC", an electric-motor
 * company, and lcaMatch.js's header records that an earlier candidate-set check attributed it to
 * Linear.app — which has never filed an LCA. The prompt therefore offers "none" explicitly and says
 * it is the expected answer when nothing fits, because a model asked to pick from a list will pick
 * from the list.
 *
 * Nothing proposed here reaches the matcher. `--confirm` does, and only after a person reads it.
 *
 * Usage:
 *   node scripts/al4LcaResolution.mjs --propose [--yes]
 *   node scripts/al4LcaResolution.mjs --review
 *   node scripts/al4LcaResolution.mjs --confirm "Ramp"      (repeatable)
 *   node scripts/al4LcaResolution.mjs --reject  "Linear"
 *   node scripts/al4LcaResolution.mjs --rate                # the match rate, before/after
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { callModel, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS, PROVIDER, resolveProvider } from "../shared/modelProviders.js";
import { MODEL_HAIKU } from "../shared/anthropicModels.js";
import {
  recordResolutionProposal, listResolutionProposals, confirmResolution, rejectResolution,
  resolutionStats, RESOLUTION_CONFIDENCE,
} from "../services/kb/lcaResolution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "resume_master.db");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const db = new Database(DB_PATH);

function unresolved() {
  return db.prepare(`
    SELECT company, match_status, match_reason, matched_entities_json, candidate_count
    FROM company_lca_sponsorship WHERE match_status != 'matched' ORDER BY company
  `).all();
}

/** Every LCA employer whose name shares the brand's first token — the real candidate set. */
function candidatesFor(company) {
  const token = String(company).toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
  if (!token) return [];
  return db.prepare(`
    SELECT employer_name, SUM(certified) certified, COUNT(DISTINCT fiscal_period) periods
    FROM lca_employer_periods
    WHERE LOWER(employer_name) LIKE ?
    GROUP BY employer_name ORDER BY certified DESC LIMIT 25
  `).all(`${token}%`);
}

function buildPrompt(company, candidates) {
  return `A job board lists a company called "${company}". US Department of Labor H-1B (LCA) filings
are recorded against LEGAL ENTITY names. Below are every LCA employer whose name begins with the
same word.

Which ONE of these, if any, is the legal entity of the company "${company}"?

CANDIDATES:
${candidates.map((c, i) => `${i + 1}. ${c.employer_name}  (${c.certified} certified across ${c.periods} quarters)`).join("\n")}

⛔ READ BEFORE ANSWERING:
- "none" is a REAL and often CORRECT answer. Many well-known companies have never filed an LCA at
  all, and a similarly-named company appearing in this list is not evidence that they have.
- Companies that merely share a word are DIFFERENT COMPANIES. "Linear Labs LLC" makes electric
  motors and is not the software company Linear. "Mercury Insurance Services" is not the fintech
  Mercury. Answering with one of those would tell a job seeker that a company sponsors visas when
  it does not — a false statement about a third party who cannot correct it.
- Answer "none" unless you specifically know this legal entity IS this company.

Reply ONLY with valid JSON, no markdown fences:
{"employer_name": "<exact name from the list, or null>", "confidence": <0.0-1.0>, "reason": "<one sentence>"}`;
}

async function propose() {
  const rows = unresolved();
  // ⛔ AMBIGUOUS ONLY. See the header: an unmatched company has no candidates, so there is nothing
  // to resolve and the only possible answer is an invented one.
  const askable = rows.filter(r => r.match_status === "ambiguous");
  const skipped = rows.filter(r => r.match_status !== "ambiguous");

  console.log(`[al4] unresolved: ${rows.length}  (${askable.length} ambiguous, ${skipped.length} unmatched)`);
  for (const s of skipped) {
    console.log(`      skipping ${s.company} — ${s.match_status}: no candidate entities exist, so there is nothing to resolve`);
  }
  if (!askable.length) { console.log("nothing to ask about."); return; }

  const route = resolveProvider(process.env);
  if (route.provider === PROVIDER.ANTHROPIC && !has("--yes")) {
    console.error(`\n⛔ NOT ON A FREE TIER (${route.reason}). ${askable.length} Haiku calls against the paid key. Pass --yes.\n`);
    process.exit(2);
  }
  const anthropic = process.env.ANTHROPIC_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }) : null;

  for (const row of askable) {
    const candidates = candidatesFor(row.company);
    if (!candidates.length) { console.log(`  ${row.company}: no candidates found`); continue; }
    try {
      const msg = await callModel({
        anthropic, db, purpose: "lca_company_resolution", userId: SYSTEM_USER_ID,
        // PUBLIC: company legal names from a US government disclosure dataset, and a brand name
        // from a job posting. No candidate data whatsoever.
        dataClass: DATA_CLASS.PUBLIC,
        model: MODEL_HAIKU, max_tokens: 400,
        messages: [{ role: "user", content: buildPrompt(row.company, candidates) }],
      });
      const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      const name = parsed?.employer_name || null;
      // The model may only choose from what it was shown. A name it invented has no filings behind
      // it, and would become a sponsorship claim backed by nothing.
      const valid = name && candidates.some(c => c.employer_name === name);
      recordResolutionProposal(db, {
        company: row.company,
        resolvedEmployerName: valid ? name : null,
        candidates: candidates.map(c => ({ name: c.employer_name, certified: c.certified })),
        modelConfidence: Number(parsed?.confidence) || null,
        modelReason: (valid || !name)
          ? String(parsed?.reason || "").slice(0, 400)
          : `model named "${name}", which is not in the candidate list — recorded as none`,
      });
      console.log(`  ${row.company.padEnd(12)} -> ${valid ? name : "none"}  (model confidence ${parsed?.confidence ?? "?"})`);
    } catch (e) {
      console.warn(`  ${row.company}: failed — ${e.message}`);
    }
  }
  console.log(`\nstatus: ${JSON.stringify(resolutionStats(db))}`);
  console.log("NOTHING IS LIVE. Confirm with --confirm \"<Company>\" after reading --review.");
}

function review() {
  const props = listResolutionProposals(db);
  if (!props.length) { console.log("no proposals awaiting review."); return; }
  console.log(`${props.length} awaiting review. A wrong confirmation is a false sponsorship claim`);
  console.log(`about a third party, so confirm only what you can verify independently.\n`);
  for (const p of props) {
    const cands = JSON.parse(p.candidates_json || "[]");
    console.log(`── ${p.company}`);
    console.log(`   proposed : ${p.resolved_employer_name || "NONE OF THESE"}`);
    console.log(`   model    : confidence ${p.model_confidence ?? "?"} — ${p.model_reason || ""}`);
    console.log(`   chose from ${cands.length}: ${cands.slice(0, 6).map(c => `${c.name} (${c.certified})`).join(" | ")}`);
    console.log(`   confirm  : node scripts/al4LcaResolution.mjs --confirm "${p.company}"`);
    console.log("");
  }
  console.log(`A confirmed resolution enters the matcher as TIER R at confidence ${RESOLUTION_CONFIDENCE} —`);
  console.log(`above the presentable floor (0.60) so it can be shown, below the high-confidence line`);
  console.log(`(0.80) so the surface NAMES the matched legal entity instead of asserting a bare count.`);
}

function rate() {
  const rows = db.prepare("SELECT match_status, match_tier, COUNT(*) n FROM company_lca_sponsorship GROUP BY match_status, match_tier").all();
  const total = db.prepare("SELECT COUNT(*) n FROM company_lca_sponsorship").get().n;
  const matched = rows.filter(r => r.match_status === "matched").reduce((a, r) => a + r.n, 0);
  console.log(`match rate: ${matched}/${total} = ${((matched / total) * 100).toFixed(1)}%`);
  for (const r of rows) console.log(`  ${r.match_status.padEnd(10)} ${(r.match_tier || "-").padEnd(3)} ${r.n}`);
  const unmatchedNoCandidates = db.prepare(`
    SELECT COUNT(*) n FROM company_lca_sponsorship WHERE match_status='unmatched'
  `).get().n;
  console.log(`\nOf the unmatched, ${unmatchedNoCandidates} have ZERO candidate employers in the corpus.`);
  console.log(`Those are not resolution failures — they are companies with no LCA filings, and`);
  console.log(`"no evidence of sponsorship" is the correct answer for them.`);
}

if (has("--propose")) await propose();
else if (has("--review")) review();
else if (has("--rate")) rate();
else if (has("--confirm") || has("--reject")) {
  const act = has("--confirm") ? confirmResolution : rejectResolution;
  const flag = has("--confirm") ? "--confirm" : "--reject";
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const c = args[i + 1];
    console.log(c && act(db, c) ? `${flag} ${c}` : `no proposal for "${c}"`);
  }
  console.log(`status: ${JSON.stringify(resolutionStats(db))}`);
  console.log("Re-run the LCA rollup for a confirmation to take effect in company_lca_sponsorship.");
} else {
  console.log("one of --propose | --review | --confirm <Company> | --reject <Company> | --rate");
  process.exit(1);
}
db.close();
