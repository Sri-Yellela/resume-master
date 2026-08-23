#!/usr/bin/env node
/**
 * mode:'full' AGAINST THE LIVE POSTING'S MEASURED SHAPE.
 * ============================================================================================
 * THE GAP THIS CLOSES
 * AE1/AE2 came out of a live Ashby run, and the diagnosis found that everything had only ever been
 * verified against `/ashby` — a static replica with native controls. The submit path in particular
 * (`classifySubmitLabel`, the cross-frame candidate scoring, the post-click evidence check) had never
 * fired against the shape a real Ashby form actually has: React-rendered in chunks, required controls
 * with no `name` and no `<label>`, UUID field names, checkboxes named with their own question text.
 *
 * `/ashby-spa` is that shape, transcribed from `scripts/ae1Diagnose.mjs`'s reading of the real
 * posting — 15 fields, every label, name, type and required flag identical. This drives `mode:'full'`
 * against it, which is the submitting path, with nothing outbound and nothing unrecallable.
 *
 * FOUR CASES, because "it submits" is not the only thing worth knowing:
 *   A  the form AS MEASURED           -> must HOLD. The date field is required and its only identity
 *                                        is the placeholder "Pick date...", so nothing can answer it.
 *                                        This is the live outcome, reproduced locally.
 *   B  ?answerable=1                  -> must SUBMIT, and the ATS must RECORD it. The one difference
 *                                        from A is that one control says what it wants.
 *   C  ?answerable=1&deadsubmit=1     -> must report clicked_no_evidence and record NOTHING. A1
 *                                        finding N1: a submit-shaped button that changes nothing was
 *                                        once reported as `submitted`, which is self-concealing.
 *   D  ?answerable=1&autofilltrap=1   -> must HOLD on "Resume". The resume IS uploaded, into the
 *                                        wrong file input, because that input carries the real page's
 *                                        own "Upload your resume here to autofill" copy.
 *
 * ASSERT ON WHAT THE ATS RECORDS, never on status. A status is the pipeline's opinion of itself.
 *
 * Requires: node scripts/fakeAts.js
 * Usage:    node scripts/ae7SubmitOnRealShape.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoApply } from "../services/applyAutomation.js";

const ATS = process.env.ATS_URL || "http://localhost:4599";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(ATS)) {
  console.error(`REFUSING: ATS_URL must be localhost. Got ${ATS}\n` +
    `This script runs mode:'full', which CLICKS SUBMIT. It may only ever point at the fixture.`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// A real file, so the multipart recorder has something real to record. Content is irrelevant; the
// assertion is on size and content type, which is how "a resume arrived" is distinguished from "the
// field was skipped".
const RESUME = path.join(os.tmpdir(), "ae7-resume.pdf");
fs.writeFileSync(RESUME, Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n", "utf8"));
const RESUME_SIZE = fs.statSync(RESUME).size;

// The candidate. `custom_answers` is keyed on the QUESTION TEXT, which is the mechanism a real
// candidate uses for a field no map can resolve — and in case B it is the only thing that can answer
// the date. Nothing here is a guess by the resolver.
const PAYLOAD = {
  field_map: {
    first_name: "John", last_name: "Doe", full_name: "John Doe",
    email: "johndoe.a5test@gmail.com", phone: "+1 617 555 0142",
    location: "San Francisco, CA",
  },
  handler_map: {},
  custom_answers: { "Earliest start date": "2026-09-15" },
};

const reset = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const recorded = () => fetch(`${ATS}/_submissions`).then(r => r.json());

// `platform: 'ashby'` is passed explicitly. detectPlatformFromUrl sees `localhost` and answers
// 'generic', which would silently exercise the WRONG label map — the fixture reproduces Ashby's
// markup, so it has to be resolved with Ashby's map or the run is not the run under test.
const run = (query, jobId, opts = {}) => autoApply(
  `${ATS}/ashby-spa${query}`, PAYLOAD,
  { mode: "full", jobId, platform: "ashby", resumePath: RESUME, ...opts });

const summarise = (r) => `status=${r.status} reason=${r.reasonCode ?? "-"} ` +
  `filled=${r.fieldsFilled} verified=${r.submitVerified} evidence=${r.submitEvidence ?? "-"}`;

console.log("=".repeat(94));
console.log("mode:'full' against /ashby-spa — the live posting's measured shape, locally");
console.log("=".repeat(94));
try {
  await reset();
} catch {
  console.error(`Cannot reach ${ATS} — is scripts/fakeAts.js running?`);
  process.exit(1);
}

// ── CASE A: the form exactly as measured ─────────────────────────────────────
console.log("\n── A. the form AS MEASURED — a required control that says only \"Pick date...\" ──");
const a = await run("", "ae7-a");
console.log(`   ${summarise(a)}`);
console.log(`   missingRequired: ${JSON.stringify(a.missingRequired ?? null)}`);
check("A  the run HOLDS rather than submitting an incomplete application",
  a.status === "held_review" && a.reasonCode === "incomplete_form", summarise(a));
check("A  and it names the field it cannot answer",
  (a.missingRequired || []).includes("Pick date..."), JSON.stringify(a.missingRequired));
check("A  nothing was recorded by the ATS",
  (await recorded()).count === 0, `${(await recorded()).count} submission(s)`);
// The point of the case: the fill worked, the FORM is the problem.
check("A  the fields that CAN be identified were all filled",
  a.fieldsFilled >= 4, `fieldsFilled=${a.fieldsFilled}`);
check("A  this is the same outcome the live posting produced",
  a.reasonCode === "incomplete_form", "live: held_review/incomplete_form, missingRequired [Resume, Pick date...]");

// ── CASE B: one control says what it wants ───────────────────────────────────
console.log("\n── B. ?answerable=1 — the SAME form with the date field labelled ──");
await reset();
const b = await run("?answerable=1", "ae7-b");
console.log(`   ${summarise(b)}`);
const subs = await recorded();
const rec = subs.submissions[0];
check("B  the run SUBMITS", b.status === "submitted", summarise(b));
check("B  and the submission is VERIFIED, not assumed",
  b.submitVerified === true && /confirmation_page|url_changed/.test(b.submitEvidence || ""),
  `evidence=${b.submitEvidence}`);
check("B  THE ATS RECORDED IT — one submission, from this form",
  subs.count === 1 && rec?.provider === "ashby-spa", `count=${subs.count} provider=${rec?.provider}`);
if (rec) {
  console.log(`   recorded fields: ${JSON.stringify(rec.fields, null, 1).slice(0, 900)}`);
  console.log(`   recorded files:  ${JSON.stringify(rec.files)}`);
  // Every assertion below is on the RECORD, which is the only thing that cannot lie about what the
  // employer received.
  check("B  the resume arrived, in the field that asked for it",
    rec.files?._systemfield_resume?.size === RESUME_SIZE,
    JSON.stringify(rec.files?._systemfield_resume ?? null));
  check("B  the legal name is the candidate's",
    rec.fields._systemfield_name === "John Doe", rec.fields._systemfield_name);
  check("B  the email is the candidate's",
    rec.fields._systemfield_email === "johndoe.a5test@gmail.com", rec.fields._systemfield_email);
  check("B  the UUID-named phone field was resolved BY ITS LABEL",
    rec.fields["20f8883c-d278-427c-9465-dc614f612e1f"] === "+1 617 555 0142",
    rec.fields["20f8883c-d278-427c-9465-dc614f612e1f"]);
  check("B  the date came from the candidate's OWN answer, not a guess",
    rec.fields.start_date === "2026-09-15", rec.fields.start_date);
  // The negative half, and the one that matters more: nothing was invented for a question nobody
  // could answer, and no attestation was made on the candidate's behalf.
  const eeocKeys = Object.keys(rec.fields).filter(k => /_systemfield_eeoc_/.test(k));
  check("B  NO EEOC self-identification was answered for them",
    eeocKeys.length === 0, eeocKeys.join(", ") || "none");
  check("B  NO arbitration agreement was accepted on their behalf",
    !Object.keys(rec.fields).some(k => /Arbitration Agreement/.test(k)),
    Object.keys(rec.fields).filter(k => /Arbitration/.test(k)).join(", ") || "none");
  check("B  the nameless typeahead was left alone rather than typed into blind",
    !Object.keys(rec.fields).some(k => k === "unnamed:Start typing..."),
    Object.keys(rec.fields).filter(k => k.startsWith("unnamed:")).join(", ") || "none");
}

// ── CASE C: a submit-shaped button that does nothing ─────────────────────────
console.log("\n── C. ?deadsubmit=1 — clicked, and nothing happened ──");
await reset();
const c = await run("?answerable=1&deadsubmit=1", "ae7-c");
console.log(`   ${summarise(c)}`);
const cSubs = await recorded();
check("C  the run does NOT claim to have submitted",
  c.status !== "submitted", summarise(c));
check("C  it reports the click that produced no evidence",
  c.status === "filled_not_submitted" && c.submitEvidence === "clicked_no_evidence"
  && c.reasonCode === "submit_unverified", summarise(c));
check("C  and the ATS recorded nothing, which is what makes the report true",
  cSubs.count === 0, `${cSubs.count} submission(s)`);

// ── CASE D: the resume goes to the wrong input ───────────────────────────────
console.log("\n── D. ?autofilltrap=1 — the wrong file input carries the page's own resume copy ──");
await reset();
const d = await run("?answerable=1&autofilltrap=1", "ae7-d");
console.log(`   ${summarise(d)}`);
console.log(`   missingRequired: ${JSON.stringify(d.missingRequired ?? null)}`);
check("D  the run HOLDS rather than submitting without a resume",
  d.status === "held_review" && d.reasonCode === "incomplete_form", summarise(d));
check("D  and it names Resume — the required input that stayed empty",
  (d.missingRequired || []).includes("Resume"), JSON.stringify(d.missingRequired));
check("D  nothing was recorded", (await recorded()).count === 0);

console.log("");
console.log(`${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
