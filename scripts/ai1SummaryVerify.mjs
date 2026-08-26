#!/usr/bin/env node
/**
 * AI1 REAL-RUN verification — the summary is opt-in, and turning it off does not turn AF2 off.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT A UNIT TEST
 * test/summaryOptIn.test.js proves the RULES leave the prompt and that the guard reports what it
 * inspected. Neither proves the MODEL stops writing a summary when it is not asked for one, and
 * neither renders a page. Those are the two things that actually reach an employer: what the model
 * produced, and what the PDF looks like. So this makes two real Sonnet calls — one with the
 * section off, one with it on — renders both to PDF through the same htmlToPdf path the product
 * uses, and screenshots page one of each.
 *
 * It does not run under verify:harness: it spends tokens and needs a live API key.
 *
 * --render-only DOES NOT CALL A MODEL, AND PROVES LESS. It takes a REAL previously-generated
 * artifact out of resume_versions and renders it both ways — with its summary, and with the
 * summary section removed from the parsed STRUCTURE before rendering. That is a genuine test of
 * the renderer, the PDF and the page layout on real content, and it is NOT a test of whether the
 * model obeys the prompt. The two halves are reported separately and the summary line says which
 * ran, because a run that quietly skipped the model half would be the more dangerous of the two to
 * mistake for a full pass.
 *
 * Usage: node scripts/ai1SummaryVerify.mjs [--render-only]
 * Output: docs/ai1-summary/{off,on}.{html,pdf,png}
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_SONNET } from "../shared/anthropicModels.js";
import { callModel } from "../services/modelCall.js";
import { assemblePrompt, loadAllPrompts } from "../services/promptAssembler.js";
import {
  assertResumeClaims, ResumeClaimError, ResumeClaimNotInspectedError,
  htmlToText, extractSummaryText,
} from "../services/resumeClaimGuard.js";
import {
  normalizeResumeHtml, buildStructuredResume, renderStructuredResume,
} from "../services/resumeFormatter.js";
import { launchBrowser } from "../services/browserLauncher.js";

const DB_PATH = process.env.RESUME_MASTER_DB || "data/resume_master.db";
const OUT = "docs/ai1-summary";
const RENDER_ONLY = process.argv.includes("--render-only");

/**
 * --from-file: verify artifacts produced SOMEWHERE ELSE, through this exact pipeline.
 *
 * WHY IT EXISTS
 * The two model calls cost about seven cents, which is not the problem — the problem is a billed
 * key that may be empty when you need the answer. This mode lets the two documents be produced by
 * any model, through any surface (including a Claude Code session on a subscription), and then run
 * through the IDENTICAL guard, renderer, PDF and section assertions. Nothing about the verification
 * is weakened; only the provenance of the HTML changes.
 *
 * WHAT IT DOES NOT PROVE, AND THE RUN SAYS SO
 * If the person supplying the artifacts knows what is being tested, "the model omitted the summary"
 * is not evidence about models — it is evidence about that author. This mode is honest about the
 * pipeline and silent about model obedience, and the closing summary spells out which is which.
 *
 * Usage: AI1_OFF_HTML=<path> AI1_ON_HTML=<path> node scripts/ai1SummaryVerify.mjs --from-file
 */
const FROM_FILE = process.argv.includes("--from-file");
const FROM_FILE_PATHS = { off: process.env.AI1_OFF_HTML, on: process.env.AI1_ON_HTML };
if (FROM_FILE) {
  if (RENDER_ONLY) { console.error("--from-file and --render-only are different sources; pick one"); process.exit(2); }
  for (const [label, p] of Object.entries(FROM_FILE_PATHS)) {
    if (!p || !fs.existsSync(p)) {
      console.error(`--from-file needs AI1_${label.toUpperCase()}_HTML to point at an existing file (got ${p || "unset"})`);
      process.exit(2);
    }
  }
}

const NO_MODEL = RENDER_ONLY || FROM_FILE;
const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
if (!key && !NO_MODEL) { console.error("no ANTHROPIC_KEY — cannot do a REAL run"); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── The real candidate ────────────────────────────────────────────────────────
// NOT readonly: callModel records what this script spends, and an untracked model call is
// exactly the defect test/modelCallGuard.test.js exists to prevent.
const db = new Database(DB_PATH);
const profile = db.prepare(`
  SELECT * FROM user_profile WHERE years_of_experience IS NOT NULL AND full_name IS NOT NULL
  ORDER BY user_id DESC LIMIT 1
`).get();
if (!profile) { console.error("no profile with years_of_experience in the DB"); process.exit(2); }
const dp = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1").get(profile.user_id);
const base = db.prepare("SELECT content FROM profile_base_resumes WHERE user_id=? ORDER BY profile_id DESC LIMIT 1")
  .get(profile.user_id);
if (!base?.content) { console.error("no base resume for that profile"); process.exit(2); }

const PROFILE_YEARS = Number(profile.years_of_experience);
console.log(`\nAI1 real-run verification`);
console.log(`  candidate      : ${profile.full_name} (${PROFILE_YEARS} years)`);
console.log(`  domain profile : ${dp?.profile_name ?? "none"} (include_summary=${dp?.include_summary ?? "n/a"})`);

// A JD that demands more years than the candidate has, so AF2's inflation vector is live in BOTH
// runs. Verifying the summary-off path against a JD that asks for nothing would prove nothing
// about whether the guard still has teeth.
const JOB = {
  title: "Senior Backend Engineer",
  company: "Northwind Systems",
  category: "Technology",
  stack: "Go, Kubernetes, PostgreSQL, Kafka",
  description: `We are hiring a Senior Backend Engineer.

Requirements:
- 8+ years of professional software engineering experience (this is a hard requirement)
- Deep experience with Go and distributed systems
- Production Kubernetes, PostgreSQL and Kafka
- Track record owning services end to end at senior level`,
};

const domainProfileBlock = dp ? `
**User domain profile:** ${dp.profile_name}
**Seniority the candidate states they are (their own declaration — you may use it, and may not exceed it):** ${dp.seniority}
**Profile keywords:** ${JSON.parse(dp.selected_keywords || "[]").join(", ") || "—"}
**Profile tools:** ${JSON.parse(dp.selected_tools || "[]").join(", ") || "—"}
**Profile action verbs:** ${JSON.parse(dp.selected_verbs || "[]").join(", ") || "—"}
` : "";

const runtimeInputs = `## RUNTIME INPUTS

**Mode:** Generate
**Candidate full name:** ${profile.full_name}
**Phone:** ${profile.phone || ""}
**Email:** ${profile.email || ""}
**LinkedIn URL:** ${profile.linkedin_url || ""}
**GitHub URL:** ${profile.github_url || ""}
**User location (City, State):** ${profile.location || ""}
**Candidate years of experience (AUTHORITATIVE — the JD may not change this):** ${PROFILE_YEARS}
${domainProfileBlock}
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
const anthropic = key ? new Anthropic({ apiKey: key }) : null;
fs.mkdirSync(OUT, { recursive: true });

// Whose facts the claim guard judges the artifact against. The live candidate for a real
// generation; the fixture's own owner under --render-only (see fixtureArtifact).
let guardProfile = profile;
let guardBaseText = base.content;
let guardDomainProfile = dp;

// ── The prompt half, which costs nothing and is where requirement 3 actually lives ────────────
//
// Run in BOTH modes. A stripping implementation would produce identical prompts here and differ
// only downstream, so this is the assertion that tells the two designs apart — and it does not
// need a model to make it.
function verifyPrompt(includeSummary) {
  const { systemBlocks } = assemblePrompt("general", "TAILORED", runtimeInputs, { SUMMARY: includeSummary });
  const promptText = systemBlocks.map(b => b.text || "").join("\n");
  const label = includeSummary ? "ON" : "OFF";
  if (includeSummary) {
    check(`${label}: the sent prompt carries the SUMMARY rules`, /## SUMMARY/.test(promptText));
    check(`${label}: the sent prompt carries AF2's source rule`,
      /The years figure comes from `Candidate years of experience`/.test(promptText));
    check(`${label}: layer 2's summary framing is present`, /SUMMARY FRAMING GUIDANCE/.test(promptText));
  } else {
    check(`${label}: the sent prompt carries NO SUMMARY rules`, !/## SUMMARY/.test(promptText));
    check(`${label}: the sent prompt carries no layer-2 summary framing`,
      !/SUMMARY FRAMING GUIDANCE/.test(promptText));
    check(`${label}: the sent prompt forbids the section positively`, /## NO SUMMARY SECTION/.test(promptText));
    check(`${label}: the sent prompt reorders the sections`, /Order: TECHNICAL SKILLS -> EXPERIENCE/.test(promptText));
  }
  check(`${label}: no conditional marker leaked into the sent prompt`,
    !/<!--\s*(IF|IFNOT|ENDIF)/.test(promptText));
  return systemBlocks;
}

// ── One generation, run exactly as the product runs it ────────────────────────
async function generate(label, includeSummary) {
  console.log(`\n── ${label}: SUMMARY ${includeSummary ? "ON" : "OFF"} ──`);
  const systemBlocks = verifyPrompt(includeSummary);

  let html;
  if (FROM_FILE) {
    const src = FROM_FILE_PATHS[label];
    const raw = fs.readFileSync(src, "utf8");
    // normalizeResumeHtml, exactly as the live path applies it to a model's raw output — so the
    // renderer, the section ordering and the empty-section drop are all genuinely exercised.
    html = normalizeResumeHtml(raw);
    console.log(`  --from-file: ${src} (${raw.length} chars, normalised to ${html.length})`);
  } else if (RENDER_ONLY) {
    html = fixtureArtifact(includeSummary);
    console.log(`  --render-only: rendered a REAL prior artifact ${includeSummary ? "as generated" : "with its summary section removed from the structure"} (${html.length} chars)`);
  } else {
    console.log(`  calling ${MODEL_SONNET} ...`);
    const msg = await callModel({
      anthropic, db, purpose: "ai1_summary_verify", userId: profile.user_id,
      model: MODEL_SONNET,
      thinking: { type: "disabled" },
      max_tokens: 8192,
      system: systemBlocks,
      messages: [{ role: "user", content: runtimeInputs }],
    });
    const raw = msg.content.map(b => b.text || "").join("").replace(/```html|```/g, "").trim();
    html = normalizeResumeHtml(raw);
    console.log(`  got ${raw.length} chars, normalised to ${html.length}`);
  }

  // ── AF2's assertion, on the same call site the product uses ─────────────────
  let claim = null, claimError = null;
  try { claim = assertResumeClaims({ html, profile: guardProfile, baseResumeText: guardBaseText, domainProfile: guardDomainProfile }); }
  catch (e) {
    claimError = e;
    if (e instanceof ResumeClaimNotInspectedError) {
      check("the claim guard had something to inspect", false, "it read nothing at all");
    } else if (e instanceof ResumeClaimError) {
      console.log(`  guard REFUSED: ${e.violations.map(v => v.message).join(" | ")}`);
    } else throw e;
  }

  // THE POINT OF REQUIREMENT 4. Not "no violation" — "it looked". A refusal counts as having
  // looked, so the inspection record is read off either outcome.
  const inspected = (claim || claimError)?.checked?.inspected;
  check(`${label}: the guard INSPECTED the document`,
    !!inspected && inspected.documentChars > 200,
    `documentChars=${inspected?.documentChars}`);
  check(`${label}: the guard inspected a named headline region`,
    !!inspected && inspected.headlineRegion !== "none" && inspected.headlineChars > 0,
    `region=${inspected?.headlineRegion} chars=${inspected?.headlineChars}`);
  check(`${label}: the seniority ceiling was known`, inspected?.seniorityCeilingKnown === true);
  console.log(`  inspected: ${inspected?.documentChars} chars, headline region "${inspected?.headlineRegion}" (${inspected?.headlineChars} chars)`);

  check(`${label}: the guard did not refuse this generation`, !claimError,
    claimError?.message);

  // ── What the model actually produced ────────────────────────────────────────
  const text = htmlToText(html);
  const headings = [...html.matchAll(/<div class="section-title">([^<]*)<\/div>/g)].map(m => m[1].trim());
  console.log(`  sections: ${headings.join(" -> ")}`);
  const summaryText = extractSummaryText(html);

  if (includeSummary) {
    check("ON: a SUMMARY section is present", headings.includes("SUMMARY"));
    check("ON: it is the first section", headings[0] === "SUMMARY");
    check("ON: it has prose in it", summaryText.length > 100, `${summaryText.length} chars`);
  } else {
    check("OFF: no SUMMARY section, under any of its names", !headings.some(h =>
      /^(SUMMARY|PROFESSIONAL SUMMARY|PROFILE|OBJECTIVE|ABOUT)$/i.test(h)));
    check("OFF: no empty heading was left behind", !headings.includes("SUMMARY"));
    check("OFF: TECHNICAL SKILLS is the first section, so the page reflows up",
      headings[0] === "TECHNICAL SKILLS", `first section is ${headings[0]}`);
    check("OFF: extractSummaryText finds nothing", summaryText === "", summaryText.slice(0, 80));
    // The obvious way to comply with the letter and not the rule.
    const firstBody = html.slice(html.indexOf("</div>", html.indexOf("class=\"contact\"")), html.indexOf("section-title"));
    check("OFF: no unlabelled summary paragraph sits above the first section",
      htmlToText(firstBody).length < 60, htmlToText(firstBody).slice(0, 120));
  }

  // AF2's own subject matter: the JD demands 8 years and the candidate has fewer. Skipped only
  // under --render-only, where the artifact was written against a DIFFERENT JD and asserting this
  // would be checking the fixture rather than the change. It runs under --from-file, because those
  // artifacts were produced against this JD and the inflation question is live for them.
  if (!RENDER_ONLY) {
    const eight = /\b(8|eight)\s*\+?\s*(years?|yrs?)\b/i.exec(text);
    check(`${label}: no "8 years" anywhere in the document`, !eight, eight?.[0]);
  }

  // ── The PDF, which is what reaches an employer ──────────────────────────────
  const pdf = await htmlToPdf(html);
  fs.writeFileSync(path.join(OUT, `${label}.html`), html);
  fs.writeFileSync(path.join(OUT, `${label}.pdf`), pdf);
  check(`${label}: the PDF is non-empty`, pdf.length > 5000, `${pdf.length} bytes`);

  const shot = await screenshotPageOne(html);
  fs.writeFileSync(path.join(OUT, `${label}.png`), shot);
  console.log(`  wrote ${OUT}/${label}.{html,pdf,png} (pdf ${pdf.length} bytes, png ${shot.length} bytes)`);

  return { html, headings, text, pdf };
}

/**
 * The --render-only fixture: a REAL artifact, rendered both ways.
 *
 * The artifact came out of a real generation and is in resume_versions. The OFF variant drops the
 * summary from the PARSED STRUCTURE and re-renders — the same code path renderStructuredResume
 * takes when the model never wrote one, and deliberately NOT a string edit of the finished HTML,
 * which would test a stripping implementation that this change does not have.
 */
let _fixtureRow = null;
function fixtureArtifact(includeSummary) {
  if (!_fixtureRow) {
    _fixtureRow = db.prepare("SELECT user_id, html FROM resume_versions WHERE html LIKE '%SUMMARY%' ORDER BY id DESC LIMIT 1").get();
    if (!_fixtureRow) { console.error("--render-only needs a real artifact in resume_versions"); process.exit(2); }
    // The guard must judge the artifact against the profile it was WRITTEN for. Judging one
    // candidate's resume against another's years would manufacture a violation and teach nothing.
    guardProfile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(_fixtureRow.user_id) || profile;
    guardBaseText = db.prepare("SELECT content FROM profile_base_resumes WHERE user_id=? LIMIT 1")
      .get(_fixtureRow.user_id)?.content || "";
    guardDomainProfile = db.prepare("SELECT * FROM domain_profiles WHERE user_id=? AND is_active=1")
      .get(_fixtureRow.user_id) || null;
    console.log(`  --render-only fixture: artifact from user ${_fixtureRow.user_id}, guard uses that user's profile (${guardProfile?.years_of_experience ?? "no"} years)`);
  }
  const structure = buildStructuredResume(_fixtureRow.html);
  if (includeSummary) return renderStructuredResume(structure);
  return renderStructuredResume({
    ...structure,
    sections: structure.sections.filter(s => s.title !== "SUMMARY"),
  });
}

// The product's own renderer, copied rather than imported because it lives inside server.js and
// importing server.js would boot the app. Any drift between the two is a defect in this harness,
// so the settings are kept identical to server.js htmlToPdf().
async function htmlToPdf(html) {
  const doc = html.trimStart().toLowerCase().startsWith("<!doctype") ? html : "<!DOCTYPE html>" + html;
  const browser = await launchBrowser({ headless: true, viewport: { width: 1240, height: 1754 } });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });
    await page.setContent(doc, { waitUntil: "networkidle0", timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    const pdf = await page.pdf({
      format: "Letter", printBackground: true, preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    if (!pdf || pdf.length === 0) throw new Error("PDF generation produced empty output");
    return Buffer.from(pdf);
  } finally { await browser.close(); }
}

// Letter at 150dpi, print media — the page as the PDF lays it out, not as a screen would.
async function screenshotPageOne(html) {
  const doc = html.trimStart().toLowerCase().startsWith("<!doctype") ? html : "<!DOCTYPE html>" + html;
  const browser = await launchBrowser({ headless: true, viewport: { width: 1275, height: 1650 } });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1275, height: 1650, deviceScaleFactor: 1 });
    await page.emulateMediaType("print");
    await page.setContent(doc, { waitUntil: "networkidle0", timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200));
    return Buffer.from(await page.screenshot({ clip: { x: 0, y: 0, width: 1275, height: 1650 } }));
  } finally { await browser.close(); }
}

const off = await generate("off", false);
const on  = await generate("on",  true);

// ── The comparison ────────────────────────────────────────────────────────────
console.log("\n── off vs on ──");
console.log(`  off sections: ${off.headings.join(" -> ")}`);
console.log(`  on  sections: ${on.headings.join(" -> ")}`);
check("ON has a summary and OFF does not — the setting is what differs",
  on.headings.includes("SUMMARY") && !off.headings.includes("SUMMARY"));
check("both runs produced the same non-summary sections",
  JSON.stringify(off.headings) === JSON.stringify(on.headings.filter(h => h !== "SUMMARY")),
  `off=${off.headings} on=${on.headings}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`\n  verified: the prompt (requirement 3), the renderer and PDF (requirement 2), and`);
console.log(`            the claim guard's inspection record (requirement 4).`);
if (RENDER_ONLY) {
  console.log(`  NOT verified: whether the MODEL obeys the prompt. --render-only made no model call,`);
  console.log(`            so the OFF document has no summary because the fixture was built without one,`);
  console.log(`            not because a model declined to write one. Re-run without --render-only.`);
} else if (FROM_FILE) {
  console.log(`  PARTLY verified: the documents were written by a model against the real prompt, and`);
  console.log(`            everything above is a real result on real model output. But they were supplied`);
  console.log(`            by --from-file, so this run cannot know whether their author was blind to what`);
  console.log(`            is being tested. An author who knew would comply, and "the summary is absent"`);
  console.log(`            would then be evidence about the author rather than about the prompt.`);
  console.log(`            For evidence about MODEL OBEDIENCE, re-run with no flag: two blind Sonnet calls.`);
} else {
  console.log(`            Both documents came from real ${MODEL_SONNET} calls.`);
}
db.close();
process.exit(fail ? 1 : 0);
