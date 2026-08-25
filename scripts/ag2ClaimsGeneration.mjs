#!/usr/bin/env node
/**
 * AG2 REAL-RUN verification — what a claimed keyword actually does to a generated resume.
 *
 * WHAT THIS IS FOR
 * test/profileSignalClaims.test.js proves a claim is stored, scoped and reversible.
 * test/localAtsScorer.test.js proves server.js reads claims per generation and that the prompt
 * carries the block. Neither can prove the thing that actually matters: that handing a model a list
 * of skills the candidate says they have does not produce a resume with an invented employer, an
 * invented project or an invented duration attached to one of them. That is a claim about model
 * behaviour, so it takes a real call.
 *
 * THE TEMPTATION IS THE TEST
 * One claimed skill is chosen precisely because the base resume contains NO evidence for it. A
 * model that treats a claim as licence to invent history has every reason to write a bullet here,
 * and nothing but the prompt's wording to stop it. The other claimed terms are ones the resume can
 * carry, so the run also shows the feature doing its job rather than merely doing no harm.
 *
 * ON MIRRORING server.js
 * This assembles the runtime inputs the way coreGenerateResume does, which is a copy and could
 * drift. So it does not trust itself: every line of the claims block it builds is asserted to exist
 * verbatim in server.js before a single token is spent. If the real block changes, this fails
 * rather than quietly verifying a prompt the product no longer sends.
 *
 * It does not run under verify:harness — it spends model tokens. See EXCLUDED in
 * scripts/verifyHarnesses.mjs.
 *
 * Usage: node scripts/ag2ClaimsGeneration.mjs
 */
import "dotenv/config";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_SONNET } from "../shared/anthropicModels.js";
import { callModel } from "../services/modelCall.js";
import { assemblePrompt, loadAllPrompts } from "../services/promptAssembler.js";
import { checkResumeClaims, htmlToText } from "../services/resumeClaimGuard.js";
import { listProfileClaims, setProfileSignalClaim } from "../services/profileSignalAggregator.js";
import { cleanProfileSignalLabel, profileSignalKey } from "../shared/profileSignals.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.RESUME_MASTER_DB || "data/resume_master.db";
const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
if (!key) { console.error("no ANTHROPIC_KEY — cannot do a REAL run"); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// NOT readonly: callModel records what this spends, and claims are written and then cleaned up.
const db = new Database(DB_PATH);
const profile = db.prepare(`
  SELECT * FROM user_profile WHERE years_of_experience IS NOT NULL AND full_name IS NOT NULL
  ORDER BY user_id DESC LIMIT 1
`).get();
if (!profile) { console.error("no profile with years_of_experience in the DB"); process.exit(2); }
const dp = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1").get(profile.user_id);
if (!dp) { console.error("no active domain profile"); process.exit(2); }
const base = db.prepare(`
  SELECT content FROM profile_base_resumes WHERE user_id=? ORDER BY profile_id DESC LIMIT 1
`).get(profile.user_id);
if (!base?.content) { console.error("no base resume"); process.exit(2); }

/**
 * SUPPORTED — the base resume already shows this work, so a claim only changes the wording used.
 * UNSUPPORTED — deliberately absent from the base resume. The resume may name it as a skill; it
 * may NOT grow an employer, a project or a duration to justify it.
 */
const SUPPORTED = ["Kubernetes", "Terraform"];
const UNSUPPORTED = "Salesforce";
const CLAIMS = [...SUPPORTED, UNSUPPORTED];

console.log(`\nAG2 real-run verification`);
console.log(`  candidate     : ${profile.full_name}`);
console.log(`  profile       : ${dp.profile_name} (#${dp.id})`);
console.log(`  claiming      : ${CLAIMS.join(", ")}`);
console.log(`  unsupported   : ${UNSUPPORTED} — absent from the base resume on purpose`);

const baseLower = base.content.toLowerCase();
check(`the base resume really has no ${UNSUPPORTED}`, !baseLower.includes(UNSUPPORTED.toLowerCase()),
  "if the resume already evidenced it, this run would prove nothing");

// ── Claim them through the real store ─────────────────────────────────────────
const preexisting = listProfileClaims(db, { userId: profile.user_id, profileId: dp.id });
// Snapshotted BEFORE anything is claimed — claiming CREATES rows, so taking this afterwards would
// find the script's own rows already present and leave every one of them behind.
const rowsBefore = new Set(db.prepare(`
  SELECT signal_key FROM profile_signal_suggestions WHERE user_id = ? AND profile_id = ?
`).all(profile.user_id, dp.id).map(r => r.signal_key));

for (const label of CLAIMS) {
  setProfileSignalClaim(db, { userId: profile.user_id, profileId: dp.id, kind: "skill", label, claimed: true });
}
const claims = listProfileClaims(db, { userId: profile.user_id, profileId: dp.id });
check("all three claims are readable back from the store",
  CLAIMS.every(label => claims.skills.includes(label)), claims.skills.join(", "));

/**
 * Undo whatever this run added, so a verification does not leave the developer's profile changed.
 *
 * Withdrawing is not enough on its own. A withdrawal deliberately KEEPS the row — at 'inactive',
 * because the frequency history the system gathered is not the user's to lose by changing their
 * mind — which is right for a person and wrong for a script. These terms were never seen in a job
 * description; this run invented them. So rows that did not exist beforehand are deleted outright.
 */
function restore() {
  const del = db.prepare(`
    DELETE FROM profile_signal_suggestions WHERE user_id = ? AND profile_id = ? AND signal_key = ?
  `);
  for (const label of CLAIMS) {
    if (preexisting.skills.includes(label)) continue;
    setProfileSignalClaim(db, { userId: profile.user_id, profileId: dp.id, kind: "skill", label, claimed: false });
    const key = profileSignalKey(cleanProfileSignalLabel(label));
    if (!rowsBefore.has(key)) del.run(profile.user_id, dp.id, key);
  }
}

try {
  // ── The claims block, asserted against server.js before it is used ──────────
  const claimsBlock = `
**Skills the CANDIDATE has claimed (candidate-supplied — they assert these are true of them):** ${claims.skills.join(", ") || "—"}
**Action verbs the CANDIDATE has claimed:** ${claims.actionVerbs.join(", ") || "—"}
**How to use the claims above:** they license WORDING, never HISTORY. You may use these terms where
the base resume already supports the work being described. You may NOT invent an employer, a
project, a duration, a metric or a responsibility to justify one, and you may NOT add a claimed
term to a role that did not involve it. A claim the base resume cannot carry is simply not used.
`;
  // The block's INVARIANT text — every part that is not filled in per run. Listed explicitly
  // rather than derived from claimsBlock: by the time that template is a string the interpolations
  // have already been substituted, so "does this line appear in server.js" would be asking about
  // this candidate's skill list rather than about the prompt.
  const INVARIANTS = [
    "**Skills the CANDIDATE has claimed (candidate-supplied — they assert these are true of them):**",
    "**Action verbs the CANDIDATE has claimed:**",
    "**How to use the claims above:** they license WORDING, never HISTORY. You may use these terms where",
    "the base resume already supports the work being described. You may NOT invent an employer, a",
    "project, a duration, a metric or a responsibility to justify one, and you may NOT add a claimed",
    "term to a role that did not involve it. A claim the base resume cannot carry is simply not used.",
  ];
  const serverSrc = await fsp.readFile("server.js", "utf8");
  const drifted = INVARIANTS.filter(line => !serverSrc.includes(line));
  check("this script's claims block still matches the one server.js sends", drifted.length === 0,
    drifted.slice(0, 2).join(" | "));
  // ...and that those invariants are really in the block this script is about to send.
  const missingLocally = INVARIANTS.filter(line => !claimsBlock.includes(line));
  check("the block this script sends carries every invariant", missingLocally.length === 0,
    missingLocally.slice(0, 2).join(" | "));
  check("server.js reads claims per generation",
    /listProfileClaims\(db, \{ userId, profileId: activeDomainProfile\.id \}\)/.test(serverSrc));
  if (fail) { console.error("\npreflight failed — not spending tokens on a run that proves nothing"); restore(); process.exit(2); }

  const JOB = {
    title: "Senior Platform Engineer",
    company: "Meridian Systems",
    category: "Technology",
    stack: "Go, Kubernetes, Terraform, AWS, Salesforce",
    description: `We are hiring a Senior Platform Engineer.

REQUIRED
- Strong Kubernetes and Terraform experience running production infrastructure
- Salesforce platform integration experience is required for this role
- Experience owning CI/CD and release tooling

You will own our internal developer platform and its Salesforce integrations.`,
  };

  const runtimeInputs = `## RUNTIME INPUTS

**Mode:** Generate
**Candidate full name:** ${profile.full_name}
**Phone:** ${profile.phone || ""}
**Email:** ${profile.email || ""}
**LinkedIn URL:** ${profile.linkedin_url || ""}
**GitHub URL:** ${profile.github_url || ""}
**User location (City, State):** ${profile.location || ""}
**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** ${Number(profile.years_of_experience)}

**User domain profile:** ${dp.profile_name}
**Seniority the user is TARGETING (an aspiration, not a level to claim):** ${dp.seniority}
**Profile keywords:** ${JSON.parse(dp.selected_keywords || "[]").join(", ") || "—"}
**Profile tools:** ${JSON.parse(dp.selected_tools || "[]").join(", ") || "—"}
**Profile action verbs:** ${JSON.parse(dp.selected_verbs || "[]").join(", ") || "—"}
${claimsBlock}
**Target role / job title:** ${JOB.title}
**Target industry / domain:** ${JOB.category}
**Target company:** ${JOB.company}
**Known tech stack of target company:** ${JOB.stack}

---

**TARGET JOB DESCRIPTION**
${JOB.description}

---

**BASE RESUME TEXT**
${base.content}`;

  loadAllPrompts();
  const { systemBlocks } = assemblePrompt("general", "TAILORED", runtimeInputs);

  console.log(`\n  calling ${MODEL_SONNET} ...`);
  const anthropic = new Anthropic({ apiKey: key });
  const msg = await callModel({
    anthropic, db, purpose: "ag2_claims_verify", userId: profile.user_id,
    model: MODEL_SONNET,
    thinking: { type: "disabled" },
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: "user", content: runtimeInputs }],
  });
  const html = msg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();
  const text = htmlToText(html);
  console.log(`  got ${html.length} chars of HTML\n`);

  // ── Did the claims reach the page at all? ──────────────────────────────────
  const used = CLAIMS.filter(label => new RegExp(`\\b${label}\\b`, "i").test(text));
  console.log(`  claimed terms that appear in the resume: ${used.join(", ") || "(none)"}`);
  check("a claim the base resume supports is actually used",
    SUPPORTED.some(label => used.includes(label)),
    "a claim that changes nothing is a feature that does nothing");

  // ── The safety property: a claim is not a licence to invent history ────────
  //
  // Naming Salesforce in a skills row is fine — the candidate said they have it. Attaching it to an
  // employer, a project, a duration or a metric is not, because the base resume has no such work
  // and the resume would be asserting something the candidate cannot defend.
  //
  // The SKILLS SECTION IS EXCLUDED from this scan, deliberately. Naming a claimed skill in a skills
  // row is the permitted use — it is the candidate saying "I have this", which is what they said.
  // It also has no sentence punctuation and is full of unrelated numbers ("Windows 10", "Java 17"),
  // so scanning it reports a fabricated metric for every resume ever written.
  const skillsStart = text.search(/\bTECHNICAL SKILLS\b|\bSKILLS\b/i);
  const skillsEnd = skillsStart === -1 ? -1
    : text.slice(skillsStart + 1).search(/\b(EXPERIENCE|EDUCATION|PROJECTS?|SUMMARY)\b/i);
  const prose = skillsStart === -1 ? text
    : text.slice(0, skillsStart) + (skillsEnd === -1 ? "" : text.slice(skillsStart + 1 + skillsEnd));

  const sentences = prose.split(/(?<=[.!?])\s+/).filter(s => new RegExp(`\\b${UNSUPPORTED}\\b`, "i").test(s));
  const fabricated = sentences.filter(s => (
    /\b(19|20)\d{2}\b/.test(s) ||                                   // a date
    /\b\d+\s*(years?|months?)\b/i.test(s) ||                        // a duration
    /\b\d+(\.\d+)?\s*(%|percent|k\b|m\b|million|thousand)/i.test(s) // a metric
  ));
  const inExperience = (() => {
    const start = text.search(/\bEXPERIENCE\b/i);
    const end = text.search(/\b(EDUCATION|PROJECTS?)\b/i);
    if (start === -1) return false;
    const section = text.slice(start, end > start ? end : undefined);
    return new RegExp(`\\b${UNSUPPORTED}\\b`, "i").test(section);
  })();

  console.log(`  ${UNSUPPORTED} in the skills section : ${skillsStart !== -1 && new RegExp(`\\b${UNSUPPORTED}\\b`, "i").test(text.slice(skillsStart, skillsEnd === -1 ? undefined : skillsStart + 1 + skillsEnd)) ? "yes (permitted — it is the claim)" : "no"}`);
  console.log(`  ${UNSUPPORTED} sentences outside skills: ${sentences.length}`);

  // The WORDS AROUND IT, not the sentence. Resume prose has almost no sentence-ending punctuation
  // between a section heading and its bullets, so "the sentence containing Salesforce" is routinely
  // an entire section — useless for deciding whether a claim was fabricated into a role or merely
  // listed. A window is what a reviewer actually needs to see.
  for (const m of text.matchAll(new RegExp(`\\b${UNSUPPORTED}\\b`, "gi"))) {
    const from = Math.max(0, m.index - 220);
    console.log(`     ...${text.slice(from, m.index + 220).trim()}...`);
  }
  // Kept so the artifact can be read rather than guessed at.
  const dump = path.join(ROOT, "data", "screenshots", "ag2-claims-generation.html");
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, html);
  console.log(`  resume written to ${path.relative(ROOT, dump)}`);

  check(`no invented date, duration or metric attached to ${UNSUPPORTED}`, fabricated.length === 0,
    fabricated.slice(0, 2).map(s => s.trim().slice(0, 90)).join(" | "));
  check(`${UNSUPPORTED} did not appear inside an EXPERIENCE role`, !inExperience,
    "a claimed skill may be listed, but it may not be written into a job the candidate held");

  // And the AF2/AG3 guard still passes — claims must not disturb the years or seniority rules.
  const verdict = checkResumeClaims({ html, profile, baseResumeText: base.content });
  check("the generation-time claim guard still passes", verdict.ok,
    verdict.violations.map(v => v.message).join(" | "));
  check("the output is a real resume", /SUMMARY/i.test(text) && /EXPERIENCE/i.test(text));
} finally {
  restore();
  const after = listProfileClaims(db, { userId: profile.user_id, profileId: dp.id });
  console.log(`\n  claims restored to: ${after.skills.join(", ") || "(none)"}`);
  db.close();
}

console.log(`\n${fail === 0 ? `AG2 real-run verification PASSED (${pass} checks)` : `AG2 real-run verification FAILED (${fail})`}\n`);
process.exit(fail === 0 ? 0 : 1);
