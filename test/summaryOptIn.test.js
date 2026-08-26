// AI1 — the summary section is opt-in, and turning it off must not turn the AF2 guard off with it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import {
  applyPromptConditionals, assemblePrompt, loadAllPrompts,
} from "../services/promptAssembler.js";
import {
  checkResumeClaims, assertResumeClaims, ResumeClaimError, ResumeClaimNotInspectedError,
  extractHeadlineRegion,
} from "../services/resumeClaimGuard.js";
import { normalizeResumeHtml, renderStructuredResume } from "../services/resumeFormatter.js";
import { scoreAtsLocally } from "../services/localAtsScorer.js";

loadAllPrompts();

// ── The conditional mechanism ───────────────────────────────────────────────────────────────────

test("a conditional span is kept when its flag is on and removed when it is off", () => {
  const text = "keep<!--IF:SUMMARY-->A<!--ENDIF--><!--IFNOT:SUMMARY-->B<!--ENDIF-->keep";
  assert.equal(applyPromptConditionals(text, { SUMMARY: true }),  "keepAkeep");
  assert.equal(applyPromptConditionals(text, { SUMMARY: false }), "keepBkeep");
});

test("an unknown or missing flag resolves OFF, so a typo cannot silently keep a rule", () => {
  const text = "<!--IF:SUMMRY-->typo<!--ENDIF--><!--IFNOT:SUMMRY-->fallback<!--ENDIF-->";
  assert.equal(applyPromptConditionals(text, {}), "fallback");
  // Only an explicit true counts — a truthy string or 1 is not a flag being set.
  assert.equal(applyPromptConditionals("<!--IF:SUMMARY-->on<!--ENDIF-->", { SUMMARY: "yes" }), "");
  assert.equal(applyPromptConditionals("<!--IF:SUMMARY-->on<!--ENDIF-->", { SUMMARY: 1 }), "");
});

test("a multi-line span is removed whole, and does not leave a hole in the prose", () => {
  const text = "before\n\n<!--IFNOT:SUMMARY-->## GONE\n\nbody\n<!--ENDIF-->\n\nafter";
  const off = applyPromptConditionals(text, { SUMMARY: true });
  assert.doesNotMatch(off, /GONE|body/);
  assert.doesNotMatch(off, /\n{3,}/, "a removed block must not leave three blank lines behind");
});

// ── THE RULE COMES OUT OF THE PROMPT (requirement 3) ────────────────────────────────────────────
//
// Not "the summary is removed after generation". The assertion is on the assembled system blocks,
// because that is the only place the difference between the two designs is visible: a stripping
// implementation would produce IDENTICAL prompts here and differ only downstream.

test("with the summary OFF the model is never told to write one", () => {
  const off = assemblePrompt("engineering", "GENERATE", "inputs", { SUMMARY: false });
  const text = off.systemBlocks.map(b => b.text).join("\n");

  assert.doesNotMatch(text, /## SUMMARY/, "the SUMMARY rules block must be absent");
  assert.doesNotMatch(text, /SUMMARY appears immediately after header/);
  assert.doesNotMatch(text, /430-480 rendered characters/, "the length rule is the summary's");
  assert.doesNotMatch(text, /### E\. SUMMARY FRAMING GUIDANCE/,
    "layer 2 restates the rule in every domain module; that copy must go too");
  assert.doesNotMatch(text, /Open as Layer 1 requires/);
  assert.doesNotMatch(text, /Summary \/ Professional Summary \/ Profile \/ About/,
    "the label-normalisation line would reintroduce the section by another name");
  assert.doesNotMatch(text, /Order: SUMMARY ->/);
  assert.doesNotMatch(text, /summary length/, "the final silent check must not ask for one either");

  // And it is told, positively, not to produce one — silence is not an instruction.
  assert.match(text, /## NO SUMMARY SECTION/);
  assert.match(text, /Do not emit a SUMMARY, PROFESSIONAL SUMMARY, PROFILE, OBJECTIVE or ABOUT section/);
  assert.match(text, /a summary without its heading is still a summary/,
    "an unlabelled opening paragraph is the obvious way to comply with the letter and not the rule");
  assert.match(text, /Order: TECHNICAL SKILLS -> EXPERIENCE/);
});

test("with the summary ON the prompt is what it was before AI1", () => {
  const on  = assemblePrompt("engineering", "GENERATE", "inputs", { SUMMARY: true });
  const text = on.systemBlocks.map(b => b.text).join("\n");
  assert.match(text, /## SUMMARY/);
  assert.match(text, /SUMMARY appears immediately after header/);
  assert.match(text, /430-480 rendered characters/);
  assert.match(text, /### E\. SUMMARY FRAMING GUIDANCE/);
  assert.match(text, /Order: SUMMARY -> TECHNICAL SKILLS/);
  assert.doesNotMatch(text, /## NO SUMMARY SECTION/);
  // AF2's rules are inside the block that is now conditional — confirm they survived the move.
  assert.match(text, /The years figure comes from `Candidate years of experience`/);
  assert.match(text, /Never from the JD\./);
});

test("no marker syntax ever reaches the model, under either setting", () => {
  for (const SUMMARY of [true, false]) {
    for (const mode of ["GENERATE", "A_PLUS"]) {
      for (const domain of fs.readdirSync("prompts/layer2_domains").map(f => f.replace(/\.md$/, ""))) {
        const text = assemblePrompt(domain, mode, "inputs", { SUMMARY }).systemBlocks.map(b => b.text).join("\n");
        assert.doesNotMatch(text, /<!--\s*(IF|IFNOT|ENDIF)/,
          `${domain}/${mode}/SUMMARY=${SUMMARY} leaked a conditional marker`);
      }
    }
  }
});

test("the default is OFF when no flag is passed at all", () => {
  const text = assemblePrompt("general", "GENERATE", "inputs").systemBlocks.map(b => b.text).join("\n");
  assert.match(text, /## NO SUMMARY SECTION/,
    "a caller that forgets the flag must get the product default, not yesterday's behaviour");
});

test("both variants are still cacheable — every block carries cache_control", () => {
  for (const SUMMARY of [true, false]) {
    const blocks = assemblePrompt("general", "GENERATE", "inputs", { SUMMARY }).systemBlocks;
    for (const b of blocks) {
      if (!b.text) continue;
      assert.deepEqual(b.cache_control, { type: "ephemeral" });
    }
  }
});

test("resolving does not mutate the cache — the two settings stay independent across calls", () => {
  const a = assemblePrompt("general", "GENERATE", "x", { SUMMARY: false }).systemBlocks[0].text;
  const b = assemblePrompt("general", "GENERATE", "x", { SUMMARY: true  }).systemBlocks[0].text;
  const c = assemblePrompt("general", "GENERATE", "x", { SUMMARY: false }).systemBlocks[0].text;
  assert.notEqual(a, b);
  assert.equal(a, c, "the OFF variant must be identical before and after an ON call");
});

// ── OFF MEANS ABSENT, NOT EMPTY (requirement 2) ─────────────────────────────────────────────────

test("a resume with no summary renders no heading and no rule line for one", () => {
  const html = normalizeResumeHtml(`<html><body>
    <div class="header"><div class="name">Ada Byron</div><div class="tagline">Software Engineer</div></div>
    <div class="section-title">TECHNICAL SKILLS</div><ul><li><strong>Languages</strong> Python, Go</li></ul>
    <div class="section-title">EXPERIENCE</div>
    <div class="entry"><div class="entry-org">Acme</div><ul class="bullets"><li>Built things.</li></ul></div>
  </body></html>`);
  assert.doesNotMatch(html, />SUMMARY</);
  // The section beneath is the FIRST one, immediately after the header — nothing is reserved and
  // nothing reflows around a gap. Asserted on the first section heading in the document rather
  // than on the absence of the word, so a blank heading of any name would fail here too.
  const headings = [...html.matchAll(/<div class="section-title">([^<]*)<\/div>/g)].map(m => m[1].trim());
  assert.deepEqual(headings, ["TECHNICAL SKILLS", "EXPERIENCE"]);
  assert.ok(html.indexOf("Ada Byron") < html.indexOf("TECHNICAL SKILLS"),
    "TECHNICAL SKILLS must follow the header");
});

test("an EMPTY summary is dropped rather than rendered as a heading over nothing", () => {
  const out = renderStructuredResume({
    header: { name: "Ada Byron", tagline: "Software Engineer", contact: "ada@example.com" },
    sections: [
      { type: "summary", title: "SUMMARY", text: "   " },
      { type: "skills", title: "TECHNICAL SKILLS", rows: [{ label: "Languages", values: "Python" }] },
    ],
  });
  assert.doesNotMatch(out, />SUMMARY</, "a heading with no body is worse than no section");
  assert.match(out, />TECHNICAL SKILLS</);
});

test("a summary WITH text still renders, so the drop is of empties and not of summaries", () => {
  const out = renderStructuredResume({
    header: { name: "Ada Byron", tagline: "Software Engineer", contact: "ada@example.com" },
    sections: [
      { type: "summary", title: "SUMMARY", text: "Software Engineer with 4 years of experience." },
      { type: "skills", title: "TECHNICAL SKILLS", rows: [{ label: "Languages", values: "Python" }] },
    ],
  });
  assert.match(out, />SUMMARY</);
  assert.match(out, /4 years of experience/);
});

// ── AF2'S ASSERTION MUST SURVIVE (requirement 4) ────────────────────────────────────────────────

const PROFILE = { years_of_experience: 4 };
const BASE = "Sri Balaji Yellela\nSoftware Engineer\nBuilt services at Acme.";

const noSummaryResume = (bullet, tagline = "Software Engineer") => `<html><body>
<div class="header"><div class="name">SRI BALAJI YELLELA</div><div class="tagline">${tagline}</div>
<div class="contact">sri@example.com</div></div>
<div class="section-title">TECHNICAL SKILLS</div><ul class="bullets"><li>Python, Go</li></ul>
<div class="section-title">EXPERIENCE</div>
<div class="entry"><div class="entry-org">Acme</div><ul class="bullets"><li>${bullet}</li></ul></div>
</body></html>`;

test("the INFLATION check still fires on a document with no summary", () => {
  // This is the check AF2 exists for, and it reads the whole document — the summary was only ever
  // where the figure usually sat, never the limit of what was inspected.
  const html = noSummaryResume("Delivered platform work over 9 years of professional engineering.");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "years_exceed_profile");
  assert.throws(() => assertResumeClaims({ html, profile: PROFILE, baseResumeText: BASE }),
    e => e instanceof ResumeClaimError);
});

test("the inflation check reports that it INSPECTED something, not merely that it found nothing", () => {
  // A pass with documentChars 0 would read exactly like an honest resume. This is the assertion
  // that tells the two apart.
  const html = noSummaryResume("Built and shipped internal services.");
  const r = assertResumeClaims({ html, profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.ok, true, r.violations.map(v => v.message).join(" | "));
  assert.ok(r.checked.inspected.documentChars > 100,
    `the guard read only ${r.checked.inspected.documentChars} characters`);
  assert.ok(r.checked.inspected.headlineChars > 0, "the headline region must not be empty");
  assert.equal(r.checked.inspected.seniorityCeilingKnown, true);
});

test("the guard REFUSES a document it cannot read, rather than passing it", () => {
  assert.throws(() => assertResumeClaims({ html: "", profile: PROFILE, baseResumeText: BASE }),
    e => e instanceof ResumeClaimNotInspectedError && e.code === "resume_claim_not_inspected");
  assert.throws(() => assertResumeClaims({ html: "<html><body></body></html>", profile: PROFILE }),
    e => e instanceof ResumeClaimNotInspectedError);
});

test("with no summary the headline region is the HEADER, and it is named", () => {
  const r = checkResumeClaims({ html: noSummaryResume("Built services."), profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.checked.inspected.headlineRegion, "header");
  assert.equal(r.checked.summaryYears, null, "there is no summary, so no summary figure");
});

test("with a summary the headline region is still the SUMMARY — unchanged behaviour", () => {
  const html = `<html><body><div class="header"><div class="name">A B</div></div>
<div class="section-title">SUMMARY</div><p>Software Engineer with 4 years of experience.</p>
<div class="section-title">EXPERIENCE</div><p>Acme</p></body></html>`;
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.checked.inspected.headlineRegion, "summary");
  assert.equal(r.checked.summaryYears, 4);
  assert.equal(r.checked.headlineYears, 4);
});

test("the UNDER-claim check follows the figure into the header when there is no summary", () => {
  // The AG3 drift, on a document shaped by AI1. Before the headline region existed this returned
  // ok with nothing read — the exact silent pass requirement 4 calls a regression.
  const html = noSummaryResume("Built services.", "Software Engineer | 2 Years Experience");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "years_below_profile");
  assert.match(r.violations[0].message, /header claims 2 years/);
});

test("a scoped figure in a bullet is still not read as the document's total", () => {
  const html = noSummaryResume("Maintained a Python service (3 years of Python across two teams).");
  const r = checkResumeClaims({ html, profile: PROFILE, baseResumeText: BASE });
  assert.equal(r.ok, true, r.violations.map(v => v.message).join(" | "));
});

test("extractHeadlineRegion stops at the first section heading", () => {
  const { text, region } = extractHeadlineRegion(noSummaryResume("Built services."));
  assert.equal(region, "header");
  assert.match(text, /SRI BALAJI YELLELA/);
  assert.doesNotMatch(text, /Built services/, "the header stops where the first section starts");
  assert.deepEqual(extractHeadlineRegion(""), { text: "", region: "none" });
});

// ── The ATS scorer ──────────────────────────────────────────────────────────────────────────────

test("the ATS scorer has no structural dependency on a summary section", () => {
  // The question requirement 4's regression list asks: does a document score worse simply for not
  // having a summary? It does not — the scorer never looks for the section. It reads keyword
  // coverage over the whole document, so a resume with no summary is scored on the same terms as
  // one with a summary, and identical text scores identically whichever section carries it.
  const scorer = fs.readFileSync("services/localAtsScorer.js", "utf8");
  assert.doesNotMatch(scorer, /SUMMARY|section_title|hasSummary/,
    "the scorer must not read, require or reward a summary section");

  const job = {
    title: "Backend Engineer", company: "Northwind",
    description: "Backend engineer. Java, distributed systems, Kubernetes.",
  };
  const basis = t => ({ resumeText: t, skills: [], titles: [], actionVerbs: [] });
  const terms = "Java distributed systems Kubernetes";
  const inSummary = `SUMMARY Engineer skilled in ${terms}. EXPERIENCE Acme. Built services.`;
  const inBullets = `TECHNICAL SKILLS ${terms} EXPERIENCE Acme. Built services.`;
  assert.equal(scoreAtsLocally({ job, runtimeBasis: basis(inSummary) }).score,
               scoreAtsLocally({ job, runtimeBasis: basis(inBullets) }).score,
    "the same terms must score the same wherever in the document they sit");
});

test("a term the summary was the ONLY carrier of is lost with it — which is why the prompt says so", () => {
  // Measured on the real artifact in docs/ai1-summary: dropping its summary cost 12 points,
  // because "distributed systems" appeared in the summary and nowhere else. That is not the
  // scorer penalising an absent section — it is a keyword that had one home. The no-summary prompt
  // rule exists precisely for this, so the assertion is on the rule.
  const rules = fs.readFileSync("prompts/layer1_global_rules.md", "utf8");
  const noSummaryBlock = rules.slice(rules.indexOf("## NO SUMMARY SECTION"), rules.indexOf("<!--ENDIF--><!--IF:SUMMARY-->"));
  assert.match(noSummaryBlock, /Every honestly claimable Tier 1 term still appears verbatim in TECHNICAL SKILLS or in a bullet/,
    "with no summary, the terms it used to carry must be required somewhere that remains");

  const job = { title: "Backend Engineer", company: "N", description: "Java, distributed systems." };
  const basis = t => ({ resumeText: t, skills: [], titles: [], actionVerbs: [] });
  const carried = scoreAtsLocally({ job, runtimeBasis: basis("TECHNICAL SKILLS Java, distributed systems EXPERIENCE Acme") }).score;
  const dropped = scoreAtsLocally({ job, runtimeBasis: basis("TECHNICAL SKILLS Java EXPERIENCE Acme") }).score;
  assert.ok(carried > dropped,
    "the cost is the missing TERM, not the missing section — this is what the rule prevents");
});

// ── The wiring (requirements 1, 5, 6) ───────────────────────────────────────────────────────────

test("the migration is byte-identical in both runners, and defaults to OFF", () => {
  const slice = (file) => {
    const t = fs.readFileSync(file, "utf8");
    const i = t.indexOf("      // AI1. The summary section");
    const j = t.indexOf("},", t.indexOf("092_profile_summary_opt_in")) + 3;
    assert.ok(i > 0 && j > i, `${file} is missing migration 092`);
    return t.slice(i, j);
  };
  const a = slice("server.js"), b = slice("scripts/migrations.js");
  assert.equal(a, b, "the two migration lists must not drift");
  assert.match(a, /ALTER TABLE domain_profiles ADD COLUMN include_summary INTEGER NOT NULL DEFAULT 0;/);
  // Additive only — a migration that rewrites the table would take the existing rows with it.
  assert.doesNotMatch(a, /DROP|DELETE FROM|UPDATE domain_profiles/);
});

test("coreGenerateResume reads the per-profile preference and passes it to the PROMPT", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const body = server.slice(server.indexOf("async function coreGenerateResume"),
                            server.indexOf("async function generateResumeForApply"));
  assert.ok(body.length > 500, "coreGenerateResume was not located");
  assert.match(body, /const includeSummary = activeDomainProfile\?\.include_summary === 1;/);
  assert.match(body, /assemblePrompt\(domainModuleKey, promptMode, runtimeInputs, \{ SUMMARY: includeSummary \}\)/);
  // The assertion still runs, and what it inspected is recorded next to it.
  assert.match(body, /const claimCheck = assertResumeClaims\(\{/);
  assert.match(body, /claimCheck\.checked\.inspected\.documentChars/);
  // Requirement 3, asserted structurally: nothing removes a summary after the fact.
  assert.doesNotMatch(body, /stripSummary|removeSummary/);
});

test("--from-file verifies externally-produced artifacts, and says what it cannot know", () => {
  // The mode exists so the two documents can be produced without spending on a billed key — but a
  // verification path that quietly reports a weaker result as a full pass is worse than no path.
  // What is asserted here is the honesty, not the plumbing.
  const h = fs.readFileSync("scripts/ai1SummaryVerify.mjs", "utf8");
  assert.match(h, /const FROM_FILE = process\.argv\.includes\("--from-file"\);/);
  // It goes through the SAME normaliser, guard and PDF as a real run — only the HTML's origin differs.
  assert.match(h, /html = normalizeResumeHtml\(raw\);\n    console\.log\(`  --from-file:/);
  // The two sources are mutually exclusive; silently preferring one would misreport provenance.
  assert.match(h, /--from-file and --render-only are different sources; pick one/);
  // A missing or wrong path fails loudly rather than falling back to a model call.
  assert.match(h, /--from-file needs AI1_\$\{label\.toUpperCase\(\)\}_HTML to point at an existing file/);
  // And the closing report refuses to claim model obedience.
  assert.match(h, /PARTLY verified/);
  assert.match(h, /cannot know whether their author was blind to what/);
  assert.match(h, /For evidence about MODEL OBEDIENCE, re-run with no flag/);
  // The AF2 inflation check must RUN in this mode — those artifacts face the 8-year JD.
  assert.match(h, /It runs under --from-file, because those\n  \/\/ artifacts were produced against this JD/);
});

test("the standalone path honours it, with the same default", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const body = server.slice(server.indexOf('app.post("/api/standalone/generate"'),
                            server.indexOf('app.post("/api/standalone/apply"'));
  assert.ok(body.length > 500, "the standalone generate route was not located");
  assert.match(body, /req\.body\?\.include_summary === true/);
  assert.match(body, /assemblePrompt\(domainModuleKey, "GENERATE", runtimeInputs, \{ SUMMARY: includeSummary \}\)/);
});

test("the API accepts the field, coerces it, and returns it as a boolean", () => {
  const routes = fs.readFileSync("routes/domainProfiles.js", "utf8");
  assert.match(routes, /include_summary: row\.include_summary === 1,/);
  assert.match(routes, /"include_summary"\]/, "PUT must allow the field");
  assert.match(routes, /updates\.include_summary === true \|\| updates\.include_summary === 1 \|\| updates\.include_summary === "true"\) \? 1 : 0/);
});

test("the toggle sits with the per-profile resume settings and says what it does", () => {
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");
  assert.match(panel, /Include a summary section/);
  // Beside the base resume block, not in a general settings page.
  assert.ok(panel.indexOf("Base Resume") < panel.indexOf("Include a summary section"),
    "the toggle belongs in the profile's resume settings");
  assert.match(panel, /resumes generated before this setting existed did/,
    "the default changed under existing users; the UI has to say so");
  assert.match(panel, /include_summary: next/);
  // The copy states the effect, not a pitch for the section.
  assert.doesNotMatch(panel, /recruiters (love|prefer)|stand out|boost your/i);
});
