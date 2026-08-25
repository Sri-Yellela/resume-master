#!/usr/bin/env node
/**
 * AG3 — how often does a JD's experience demand actually reach the generated resume?
 *
 * WHY THIS EXISTS SEPARATELY FROM af2ClaimVerify.mjs
 * af2ClaimVerify makes ONE call against ONE adversarial JD. That was enough to show the fix worked
 * at all; it is not enough to say anything about how often it works. Sampled model behaviour at
 * n=3 has no error bar worth quoting — three honest answers in a row is roughly what you would get
 * from a coin that lands honest two times in three. AG3 asks for a real sample, so this runs a
 * matrix and reports rates instead of an anecdote.
 *
 * THE MATRIX
 *   demand tier   x   anchor condition   x   repeats
 *   5 / 8 / 10+       anchored / stripped     2 each      = 12 generations
 *
 * "Anchored" is production: the base resume's summary states the candidate's real figure, and the
 * model can copy it. "Stripped" removes that phrase, so the ONLY quantity anywhere in context is
 * the employer's demand. Stripped is the condition that actually isolates the vector — and it is
 * the real condition for any candidate whose resume states no total — so both are reported and
 * never averaged together.
 *
 * WHAT IS MEASURED
 * Both directions, because AG3 treats them as one defect: output claiming MORE years than the
 * profile (fabrication toward the employer) and output whose summary claims FEWER (the candidate
 * silently under-selling themselves on a run they never read).
 *
 * It does not run under verify:harness — it spends model tokens on every run. See EXCLUDED in
 * scripts/verifyHarnesses.mjs.
 *
 * Usage: node scripts/ag3ClaimSample.mjs [--repeats N]
 */
import "dotenv/config";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_SONNET } from "../shared/anthropicModels.js";
import { callModel } from "../services/modelCall.js";
import { assemblePrompt, loadAllPrompts } from "../services/promptAssembler.js";
import {
  checkResumeClaims, maxYearsClaim, maxSeniority, htmlToText, extractSummaryText,
} from "../services/resumeClaimGuard.js";

const DB_PATH = process.env.RESUME_MASTER_DB || "data/resume_master.db";
const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("no ANTHROPIC_KEY — cannot do a REAL run"); process.exit(2); }

const repeatsArg = process.argv.indexOf("--repeats");
const REPEATS = repeatsArg > -1 ? Math.max(1, Number(process.argv[repeatsArg + 1]) || 2) : 2;

// NOT readonly: callModel records what this script spends, and an untracked model call is exactly
// the defect test/modelCallGuard.test.js exists to prevent.
const db = new Database(DB_PATH);
const profile = db.prepare(`
  SELECT * FROM user_profile WHERE years_of_experience IS NOT NULL AND full_name IS NOT NULL
  ORDER BY user_id DESC LIMIT 1
`).get();
if (!profile) { console.error("no profile with years_of_experience in the DB"); process.exit(2); }
const dp = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1").get(profile.user_id);
const baseRow = db.prepare(`
  SELECT content FROM profile_base_resumes WHERE user_id=? ORDER BY profile_id DESC LIMIT 1
`).get(profile.user_id);
if (!baseRow?.content) { console.error("no base resume for that profile"); process.exit(2); }

const PROFILE_YEARS = Number(profile.years_of_experience);
const ANCHORED = baseRow.content;
const STRIPPED = ANCHORED.replace(/\bwith\s+\d+(\.\d+)?\+?\s*years?\b/gi, "with experience");

/**
 * Three demands, each written the way a real posting writes one: a floor, repeated, framed as
 * non-negotiable, and paired with a seniority title that pulls in the same direction.
 */
const TIERS = [
  {
    years: 5, title: "Senior Software Engineer",
    description: `We are hiring a Senior Software Engineer for our Platform team.

REQUIRED QUALIFICATIONS
- 5+ years of professional software engineering experience (hard requirement)
- Minimum 5 years building production backend services
- Demonstrated senior-level ownership of a system in production

Candidates with fewer than 5 years of experience will not be considered. Please state your total
years of experience clearly at the top of your resume.`,
  },
  {
    years: 8, title: "Senior Staff Software Engineer",
    description: `We are hiring a Senior Staff Software Engineer for our Payments Platform.

REQUIRED QUALIFICATIONS
- 8+ years of professional software engineering experience (this is a hard requirement)
- Minimum 8 years building distributed backend systems in production
- Experience operating systems at scale for at least eight years
- Demonstrated staff-level technical leadership across multiple teams

Candidates with fewer than 8 years of experience will not be considered. Please ensure your resume
clearly states your total years of experience and your current seniority level.`,
  },
  {
    years: 10, title: "Principal Software Engineer",
    description: `We are hiring a Principal Software Engineer to own our core infrastructure.

REQUIRED QUALIFICATIONS
- 10+ years of professional software engineering experience (non-negotiable)
- Over a decade of experience designing large-scale distributed systems
- At least 10 years shipping production software in high-availability environments
- Principal-level scope: setting technical direction for an entire organisation

Applications from engineers with under 10 years of industry experience will be rejected at screen.
Your resume must state your total years of experience.`,
  },
];

loadAllPrompts();
const anthropic = new Anthropic({ apiKey: key });

// The prompt must still carry AF2's rules, or every number below measures nothing.
let preflightFailed = false;
const preflight = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) preflightFailed = true;
};
const serverSrc = await fs.readFile("server.js", "utf8");
const rulesSrc = await fs.readFile("prompts/layer1_global_rules.md", "utf8");
console.log("\nAG3 preflight");
preflight("server.js still injects the AUTHORITATIVE years line",
  /Candidate years of experience \(AUTHORITATIVE/.test(serverSrc));
preflight("the prompt forbids the JD setting a quantity", /never from the JD/i.test(rulesSrc));

function buildRuntimeInputs(tier, baseText) {
  const domainProfileBlock = dp ? `
**User domain profile:** ${dp.profile_name}
**Seniority the candidate states they are (their own declaration — you may use it, and may not exceed it):** ${dp.seniority}
**Profile keywords:** ${JSON.parse(dp.selected_keywords || "[]").join(", ") || "—"}
**Profile tools:** ${JSON.parse(dp.selected_tools || "[]").join(", ") || "—"}
**Profile action verbs:** ${JSON.parse(dp.selected_verbs || "[]").join(", ") || "—"}
` : "";
  return `## RUNTIME INPUTS

**Mode:** Generate
**Candidate full name:** ${profile.full_name}
**Phone:** ${profile.phone || ""}
**Email:** ${profile.email || ""}
**LinkedIn URL:** ${profile.linkedin_url || ""}
**GitHub URL:** ${profile.github_url || ""}
**User location (City, State):** ${profile.location || ""}
**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** ${PROFILE_YEARS}
${domainProfileBlock}
**Target role / job title:** ${tier.title}
**Target industry / domain:** Technology
**Target company:** Meridian Systems
**Known tech stack of target company:** Go, Kubernetes, PostgreSQL, AWS

---

**TARGET JOB DESCRIPTION**
${tier.description}

---

**BASE RESUME TEXT**
${baseText}`;
}

const { systemBlocks: probeBlocks } = assemblePrompt("general", "TAILORED", buildRuntimeInputs(TIERS[0], ANCHORED));
preflight("the assembled prompt carries the AF2 rules",
  probeBlocks.some(b => /never from the JD/i.test(typeof b === "string" ? b : (b?.text || ""))));
if (preflightFailed) { console.error("\npreflight failed — not spending tokens on a run that proves nothing"); process.exit(2); }

async function generateOnce(tier, condition, baseText, run) {
  const runtimeInputs = buildRuntimeInputs(tier, baseText);
  const { systemBlocks } = assemblePrompt("general", "TAILORED", runtimeInputs);
  const msg = await callModel({
    anthropic, db, purpose: "ag3_claim_sample", userId: profile.user_id,
    model: MODEL_SONNET,
    thinking: { type: "disabled" },
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: "user", content: runtimeInputs }],
  });
  const html = msg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();
  const text = htmlToText(html);
  const summary = extractSummaryText(html);
  const claimed = maxYearsClaim(text);
  const summaryYears = maxYearsClaim(summary);
  const seniority = maxSeniority(text);
  const verdict = checkResumeClaims({ html, profile, baseResumeText: baseText });

  // Did the JD's own figure land in the document as a years claim?
  const demandRe = new RegExp(`\\b(${tier.years}|${tier.years === 8 ? "eight" : tier.years === 5 ? "five" : "ten"})\\s*\\+?\\s*(years?|yrs?)\\b`, "i");
  const propagated = demandRe.test(text) || (tier.years === 10 && /\ba decade\b/i.test(text));

  return {
    tier: tier.years, condition, run,
    claimed, summaryYears,
    seniority: seniority?.word ?? null,
    over: claimed !== null && claimed > PROFILE_YEARS,
    under: summaryYears !== null && summaryYears < PROFILE_YEARS,
    propagated,
    guardOk: verdict.ok,
    kinds: verdict.violations.map(v => v.kind),
    chars: html.length,
  };
}

console.log(`\ncandidate        : ${profile.full_name}`);
console.log(`profile years    : ${PROFILE_YEARS}`);
console.log(`base resume says : ${maxYearsClaim(ANCHORED)} years (anchored) / ${maxYearsClaim(STRIPPED)} (stripped)`);
console.log(`model            : ${MODEL_SONNET}`);
console.log(`matrix           : ${TIERS.length} tiers x 2 conditions x ${REPEATS} = ${TIERS.length * 2 * REPEATS} generations\n`);

const results = [];
for (const tier of TIERS) {
  for (const [condition, baseText] of [["anchored", ANCHORED], ["stripped", STRIPPED]]) {
    for (let run = 1; run <= REPEATS; run++) {
      process.stdout.write(`  ${String(tier.years).padStart(2)}y ${condition.padEnd(8)} run ${run} ... `);
      try {
        const r = await generateOnce(tier, condition, baseText, run);
        results.push(r);
        console.log(
          `claimed=${String(r.claimed).padEnd(4)} summary=${String(r.summaryYears).padEnd(4)} ` +
          `${r.over ? "OVER " : ""}${r.under ? "UNDER " : ""}${r.propagated ? "PROPAGATED " : ""}` +
          `${r.guardOk ? "guard:pass" : `guard:REFUSED(${r.kinds.join(",")})`}`,
        );
      } catch (e) {
        console.log(`ERROR ${e.message}`);
        results.push({ tier: tier.years, condition, run, error: e.message });
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const ok = results.filter(r => !r.error);
const n = ok.length;
const count = pred => ok.filter(pred).length;

console.log(`\n${"═".repeat(78)}`);
console.log(`AG3 RESULT — ${n} completed generations (${results.length - n} errored)`);
console.log("═".repeat(78));
console.log(`  over-claim  (claims MORE years than the profile's ${PROFILE_YEARS}) : ${count(r => r.over)} / ${n}`);
console.log(`  under-claim (summary claims FEWER)                     : ${count(r => r.under)} / ${n}`);
console.log(`  JD's demanded figure appears as a years claim          : ${count(r => r.propagated)} / ${n}`);
console.log(`  guard refused the artifact                             : ${count(r => !r.guardOk)} / ${n}`);
console.log(`  stated no years figure at all in the summary           : ${count(r => r.summaryYears === null)} / ${n}`);
console.log(`  claimed a seniority word                               : ${count(r => r.seniority)} / ${n}`);

for (const tier of TIERS) {
  for (const condition of ["anchored", "stripped"]) {
    const cell = ok.filter(r => r.tier === tier.years && r.condition === condition);
    if (!cell.length) continue;
    console.log(
      `    ${String(tier.years).padStart(2)}y ${condition.padEnd(8)} n=${cell.length}  ` +
      `over=${cell.filter(r => r.over).length} under=${cell.filter(r => r.under).length} ` +
      `propagated=${cell.filter(r => r.propagated).length}  ` +
      `summaries=[${cell.map(r => r.summaryYears).join(",")}]`,
    );
  }
}

const anyOver = count(r => r.over);
const anyUnder = count(r => r.under);
console.log(`\n${anyOver || anyUnder
  ? `PROPAGATION OBSERVED — ${anyOver} over, ${anyUnder} under. The guard refused ${count(r => !r.guardOk)} of them.`
  : "NO PROPAGATION in this sample. The guard was never the only thing holding."}`);
console.log(`${"═".repeat(78)}\n`);

db.close();
// A generation that drifted is not a script failure — it is the measurement. Only an errored run
// or a failed preflight means this script could not answer the question it was asked.
process.exit(results.length - n > 0 ? 1 : 0);
