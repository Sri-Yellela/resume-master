#!/usr/bin/env node
/**
 * AL5 (task F) — the tokenized generation round trip, on a REAL model call.
 *
 * The VERIFY block: generate through the tokenized path, diff against an untokenized generation of
 * the same job, and assert that no token leaked into the final artifact.
 *
 * ── WHAT A UNIT TEST CANNOT ESTABLISH ──────────────────────────────────────────────────────────
 *
 * test/piiTokenization.test.js proves the round-trip CHECK is correct against fixtures — it fails on
 * a dropped token and on an invented one. What it cannot show is whether a real model, handed
 * COMPANY_A instead of "Stripe", actually carries the placeholders through into its output. That is
 * the assumption the entire design rests on, and it is a fact about the model, not about the code.
 * If a model silently rewrites COMPANY_A as "a leading payments company", every generation fails
 * the round trip and the feature is unusable — which is worth knowing before volume, not after.
 *
 * ⚠ SPENDS REAL MONEY: two Sonnet generations, ~$0.08. Excluded from verify:harness; run by hand.
 *
 * ⚠ THE PROVIDER IS NOT THE POINT HERE. With no GROQ_API_KEY the tokenized call also routes to
 * Anthropic. That does not weaken the test: what is being verified is the round trip and the
 * whitelist, both of which run identically whoever serves the call. The provider split is task A's
 * property and is tested there.
 *
 * Usage: node scripts/al5TokenizedGeneration.mjs [--profile 6] [--job <job_id>]
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { callModel, SYSTEM_USER_ID } from "../services/modelCall.js";
import { DATA_CLASS } from "../shared/modelProviders.js";
import { MODEL_SONNET } from "../shared/anthropicModels.js";
import { assertOutboundFields } from "../shared/piiPolicy.js";
import { buildTokenMap, tokenizeText, tokensPresentIn, reverseOrThrow, ANY_TOKEN_RE }
  from "../services/pii/tokenizer.js";
// The parser the failsafe already uses to read company claims — not a second one.
import { buildStructuredResume } from "../services/resumeFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const db = new Database(path.join(__dirname, "..", "data", "resume_master.db"));
const profileId = Number(val("--profile", "6"));

const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(profileId);
const resume = db.prepare("SELECT content FROM profile_base_resumes WHERE profile_id=?").get(profileId)?.content;
const job = val("--job")
  ? db.prepare("SELECT * FROM scraped_jobs WHERE job_id=?").get(val("--job"))
  : db.prepare("SELECT * FROM scraped_jobs WHERE description IS NOT NULL LIMIT 1").get();

if (!profile || !resume || !job) {
  console.error("need a profile with a base resume and at least one job with a description");
  process.exit(2);
}
if (!process.env.ANTHROPIC_KEY) { console.error("ANTHROPIC_KEY absent"); process.exit(2); }
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

/**
 * Employers, from the résumé parser this codebase ALREADY has.
 *
 * ⛔ THE FIRST TWO VERSIONS OF THIS WERE A REGEX, AND BOTH WERE WRONG IN A WAY THAT MATTERED. Pass
 * one tokenized "Aug 2022" and "Jan 2021" as employers; pass two tokenized "Java" and "Distributed
 * Key" — fragments of a skills line. Tokens were then substituted into places no model would
 * reproduce them, the round trip failed, and the failure looked like a defect in the DESIGN when it
 * was a defect in the INPUT.
 *
 * buildStructuredResume is the same parser services/kb/failsafe.js uses to extract company claims,
 * so this harness now asks the question the product asks. A bespoke extractor here would be a
 * second source of truth about what an employer is — the exact shape this repo keeps finding.
 */
function employersFrom(text) {
  const structured = buildStructuredResume(text);
  const experience = (structured.sections || []).find(s => /experience/i.test(s.title || ""));
  const names = (experience?.entries || [])
    // "Stripe — Software Development Engineer": the employer is what precedes the separator.
    .map(e => String(e.company || "").split(/\s+[—–|]\s+|\s+-\s+/)[0].trim())
    .filter(Boolean);
  return [...new Set(names)];
}

const employers = employersFrom(resume);
console.log(`profile ${profileId} · job "${job.title}" @ ${job.company}`);
console.log(`employers detected: ${employers.join(", ") || "(none)"}\n`);
if (!employers.length) {
  console.log("no employers detected in the base resume — the round trip would be vacuous.");
  console.log("A run with nothing to tokenize proves nothing, so this refuses rather than passing.");
  process.exit(2);
}

const map = buildTokenMap({ employers });
const tokenizedResume = tokenizeText(resume, map);
const sentTokens = tokensPresentIn(tokenizedResume);

// ── The WHITELIST-CONSTRUCTED payload. Built from the allow-list, never filtered down from a
// fuller one. Note what is absent by construction: name, email, phone, LinkedIn, GitHub — all of
// which the CURRENT untokenized prompt sends.
const piiFields = {
  mode: "GENERATE",
  job_title: job.title,
  job_company: job.company,
  job_description: String(job.description || "").slice(0, 4000),
  years_of_experience: profile.years_of_experience ?? null,
  seniority: profile.seniority ?? null,
  employer_tokens: [...sentTokens],
  resume_body: tokenizedResume,
};
assertOutboundFields(piiFields, { where: "al5 harness" });

const prompt = `Write a tailored one-page resume in clean HTML for the role below.

The candidate's employers appear as PLACEHOLDER TOKENS (${[...sentTokens].join(", ")}).
⛔ Reproduce every token EXACTLY as written, once per role, and invent no others. They are
substituted for real company names after you reply — a token you drop erases a job, and a token you
invent puts an employer on this resume that the candidate never worked for.

TARGET ROLE: ${piiFields.job_title} at ${piiFields.job_company}
${piiFields.job_description}

CANDIDATE RESUME (tokenized):
${piiFields.resume_body}

Reply with HTML only.`;

console.log("=== 1. tokenized generation ===");
let restored = null;
try {
  const msg = await callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.TOKENIZED,
    piiFields,
    model: MODEL_SONNET, max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = msg.content.map(b => b.text || "").join("");

  // ⛔ THE OUTBOUND PAYLOAD MUST CONTAIN NO REAL EMPLOYER. Checked against what was actually sent,
  // not against what we intended to send.
  // ⚠ THE TARGET COMPANY IS EXEMPT, AND THAT IS A RESIDUAL DISCLOSURE WORTH NAMING.
  //
  // job_company is on the allow-list because the company published the posting — it is public, and
  // the prompt cannot tailor without it. But if the candidate has ALSO worked there, their employer
  // name is in the payload as the target, and an observer can infer COMPANY_x = that company for
  // free. Tokenization cannot fix that without removing the target company, which would break the
  // tailoring the feature exists to do.
  //
  // So the check distinguishes the two: an employer leaking is a DEFECT; an employer coinciding
  // with the target is a known, unavoidable limit that gets REPORTED rather than hidden behind a
  // green tick or, worse, silently exempted.
  const targetKey = String(job.company || "").trim().toLowerCase();
  const coincides = employers.filter(e => e.trim().toLowerCase() === targetKey);
  const leakedOut = employers
    .filter(e => e.trim().toLowerCase() !== targetKey)
    .filter(e => new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(prompt));
  check("no candidate employer leaked into the OUTBOUND prompt", leakedOut.length === 0, leakedOut.join(", "));
  if (coincides.length) {
    console.log(`      ⚠ RESIDUAL DISCLOSURE: "${coincides.join(", ")}" is BOTH an employer and the`);
    console.log(`        TARGET company. The target is public and must be sent, so that token is`);
    console.log(`        inferable. Not a tokenizer defect — a limit of tokenizing against a named`);
    console.log(`        target, and the one case where this design leaks by construction.`);
  }
  check("the prompt carries tokens instead", sentTokens.size > 0, `${sentTokens.size} tokens`);

  restored = reverseOrThrow({ sentTokens, output: raw, map });
  check("the round trip passed — every token came back, none invented", true);
  check("no token leaked into the final artifact", !ANY_TOKEN_RE.test(restored));
  check("the real employers are back in the artifact",
    employers.every(e => restored.toLowerCase().includes(e.toLowerCase())),
    employers.filter(e => !restored.toLowerCase().includes(e.toLowerCase())).join(", ") || "all present");
} catch (e) {
  check(`the tokenized generation completed (${e.code || e.message})`, false, e.message.slice(0, 200));
}

console.log("\n=== 2. untokenized control, same job ===");
let control = null;
try {
  const msg = await callModel({
    anthropic, db, purpose: "resume_generate", userId: SYSTEM_USER_ID,
    dataClass: DATA_CLASS.CANDIDATE,
    model: MODEL_SONNET, max_tokens: 4000,
    messages: [{ role: "user", content: prompt.replace(piiFields.resume_body, resume)
      .replace(/The candidate's employers appear[\s\S]*?never worked for\.\n\n/, "") }],
  });
  control = msg.content.map(b => b.text || "").join("");
  check("the control generation completed", !!control);
} catch (e) {
  check("the control generation completed", false, e.message.slice(0, 200));
}

if (restored && control) {
  console.log("\n=== 3. content equivalence ===");
  const words = (s) => new Set(String(s).replace(/<[^>]+>/g, " ").toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) || []);
  const a = words(restored), b = words(control);
  const inter = [...a].filter(w => b.has(w)).length;
  const jaccard = inter / (a.size + b.size - inter);
  console.log(`  vocabulary overlap (Jaccard): ${(jaccard * 100).toFixed(1)}%  (${a.size} vs ${b.size} distinct terms)`);
  // NOT an equality check. Two Sonnet generations of the same prompt differ from each other anyway,
  // so a strict diff would fail for reasons that have nothing to do with tokenization. What matters
  // is that the tokenized one is not obviously degraded or truncated.
  check("the tokenized artifact is comparable in size", Math.abs(a.size - b.size) / Math.max(a.size, b.size) < 0.5,
    `${a.size} vs ${b.size}`);
  check("substantial vocabulary overlap with the control", jaccard > 0.3, `${(jaccard * 100).toFixed(1)}%`);
  console.log("\n  ⚠ Equivalence is measured as OVERLAP, not equality. Two generations of the same");
  console.log("    prompt differ anyway, so a strict diff would fail for reasons unrelated to");
  console.log("    tokenization. This says the tokenized output is not degraded; it cannot say the");
  console.log("    two are the same document, and no run of two samples could.");
}

db.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
