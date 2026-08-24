// A1 trap 8 — the resume upload. Real-run verification.
//
// This trap could not be assessed during A1: no fakeAts form declared enctype, so browsers posted
// application/x-www-form-urlencoded and a file input sent a bare filename with no content. The
// harness could not tell "the resume was uploaded" from "the resume field was skipped", so
// uploadToFileInput / handleTypedFileUploads had no end-to-end coverage at all. The forms now post
// multipart and the recorder parses it, so the trap is finally answerable.
//
// Two halves, per the A1 scope note:
//   A. does the resume actually REACH the form, on every shape of form we serve?
//   B. when resume generation yields nothing, does the run refuse to submit?
//
// (B) matters more than (A). A resume that fails to attach is a visibly broken application; a run
// that submits WITHOUT one is an application to a real employer with no resume attached, and it
// cannot be recalled.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a8FileUploadTrap.mjs
import fs from "node:fs";
import path from "node:path";
import { autoApply } from "../services/applyAutomation.js";

const ATS = "http://localhost:4599";
const RESUME = process.env.A1_RESUME;
if (!RESUME || !fs.existsSync(RESUME)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}
const RESUME_SIZE = fs.statSync(RESUME).size;

// Complete enough that nothing else holds the run — the resume must be the only variable.
const PAYLOAD = {
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", location: "Boston, MA",
    linkedin_url: "https://linkedin.com/in/ada", website_url: "https://ada.dev",
    years_of_experience: "8", available_start_date: "2026-09-01",
  },
  handler_map: {},
  custom_answers: {
    "Do you now or in the future require sponsorship for work authorization?": "No",
    "Are you legally authorized to work in the country of employment?": "Yes",
    "How did you hear about us? (free text, no standard mapping)": "Your engineering blog",
    "Are you authorized to work without sponsorship?": "yes",
    "I am authorized to work without sponsorship": "yes",
  },
};

const reset = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const subs  = () => fetch(`${ATS}/_submissions`).then(r => r.json());

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

/** The recorded upload for `field`, or undefined if the input never appeared. */
const upload = (rec, field) => (rec?.files || {})[field];
const describe = u =>
  u === undefined ? "(field absent)" : u === null ? "(present, EMPTY)"
  : `${u.filename} ${u.size}b ${u.contentType}`;

// ── WHY THIS DISTINCTION EXISTS ──────────────────────────────────────────────
// Part A reads the upload out of the SUBMITTED record, so there are two completely different
// reasons `u` can be undefined: the resume genuinely failed to attach, or the run held for some
// unrelated reason and nothing was submitted at all. The check reported both as
// "resume arrived, intact — FAIL … (field absent)", which reads unambiguously as the first.
//
// It cost a real misdiagnosis. /ashby began holding on a sponsorship checkbox the resolver refused,
// and this line said "(field absent)" — so the upload path was investigated, then the expectation
// itself was written off as stale, when the actual defect was in buildAnswers and the harness had
// been right all along. A failure message that names the wrong subsystem is worse than a bare
// assertion, because it is confidently wrong about where to look.
const explainMissing = (rec, u) => rec === undefined
  ? "NO SUBMISSION WAS RECORDED — the run never reached submit, so this says NOTHING about the upload"
  : describe(u);

// ── A. the resume reaches the form ───────────────────────────────────────────
// Each provider is a different upload shape: ashby is single-step, workday's input lives inside an
// iframe, and greenhouse takes the file at step 1 — a POST that is not itself a submission, so the
// upload has to survive the step transition to appear in the final record at all.
const SHAPES = [
  { label: "ashby (single step)",       url: `${ATS}/ashby`,   provider: "ashby",      field: "_systemfield_resume" },
  { label: "workday (inside iframe)",   url: `${ATS}/workday?ats=myworkdayjobs.com`, provider: "workday", field: "resumeUpload" },
  { label: "greenhouse (step 1 of 2)",  url: `${ATS}/greenhouse`, provider: "greenhouse", field: "job_application[resume]" },
];

console.log("=== A. does the resume actually reach the form? ===");
for (const shape of SHAPES) {
  await reset();
  const res = await autoApply(shape.url, PAYLOAD,
    { mode: "full", jobId: `a8-${shape.provider}`, resumePath: RESUME });
  const rec = (await subs()).submissions.find(s => s.provider === shape.provider);
  const u = upload(rec, shape.field);
  // Asked FIRST, and separately: did the run get far enough for the upload question to be
  // answerable? A hold here is a statement about the FORM or the resolver, not about the file path,
  // and it carries the reason so the next reader is pointed at the right subsystem.
  check(`${shape.label}: the run reached a submission, so the upload is testable`,
    !!rec,
    `status=${res.status} reason=${res.reasonCode ?? "-"} ` +
    `missingRequired=${JSON.stringify(res.missingRequired ?? null)}`);
  check(`${shape.label}: resume arrived, intact`,
    !!u && u.size === RESUME_SIZE && u.contentType === "application/pdf",
    `status=${res.status} ${explainMissing(rec, u)}`);
}

// The cover letter is optional and was never generated. It must be recorded as present-but-empty,
// not silently absent — that is the whole distinction urlencoded could not express.
const ghRec = (await subs()).submissions.find(s => s.provider === "greenhouse");
check("an optional file left unfilled is recorded as EMPTY, not omitted",
  "job_application[cover_letter]" in (ghRec?.files || {})
    && ghRec.files["job_application[cover_letter]"] === null,
  describe(upload(ghRec, "job_application[cover_letter]")));

// ── B. no resume means no submission ─────────────────────────────────────────
console.log("\n=== B. when there is no resume, does the run refuse to submit? ===");

// B1. The apply worker's path: generation runs in parallel and resolves null (generation failed, ATS
// below threshold, or PDF conversion failed). The dedicated ATS gate must catch this.
await reset();
const b1 = await autoApply(`${ATS}/ashby`, PAYLOAD, {
  mode: "full", jobId: "a8-promise-null", resumePathPromise: Promise.resolve(null),
});
const b1Subs = await subs();
check("resumePathPromise -> null is held by the ATS gate",
  b1.status === "ats_held" && b1.reasonCode === "resume_unavailable",
  `status=${b1.status} reason=${b1.reasonCode || "-"}`);
check("and NOTHING was submitted", b1Subs.count === 0, `count=${b1Subs.count}`);

// B2. The gap A1 named: the ATS gate is conditional on `resumePathPromise` being supplied, so a
// caller passing a direct resumePath of null slips past it entirely. A1 finding N2 said the
// completeness gate could not catch that either, because it exempted file inputs. N2 is now fixed,
// so this asserts the second gate covers the first one's blind spot.
await reset();
const b2 = await autoApply(`${ATS}/ashby`, PAYLOAD,
  { mode: "full", jobId: "a8-direct-null", resumePath: null });
const b2Subs = await subs();
check("a direct resumePath of null still never submits",
  b2.status !== "submitted" && b2Subs.count === 0,
  `status=${b2.status} reason=${b2.reasonCode || "-"} count=${b2Subs.count}`);
check("  ...and it is the completeness gate that catches it, naming the Resume field",
  b2.status === "held_review" && b2.reasonCode === "incomplete_form"
    && (b2.missingRequired || []).some(l => /resume/i.test(l)),
  JSON.stringify([...new Set(b2.missingRequired || [])]));

// B3. A path that no longer exists — a plausible real failure once a temp artifact is cleaned up
// early. uploadToFileInput guards on fs.existsSync, so the input stays empty and must be held.
await reset();
const gone = path.join(path.dirname(RESUME), "a8-does-not-exist.pdf");
const b3 = await autoApply(`${ATS}/ashby`, PAYLOAD,
  { mode: "full", jobId: "a8-missing-file", resumePath: gone });
const b3Subs = await subs();
check("a resumePath pointing at a missing file never submits",
  b3.status !== "submitted" && b3Subs.count === 0,
  `status=${b3.status} reason=${b3.reasonCode || "-"} count=${b3Subs.count}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
