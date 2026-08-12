// Cross-frame submission — real-run verification.
//
// Main-frame-only submit scanning made submission ARBITRARY on greenhouse: it embeds its form in an
// iframe on some boards and not others, so identical applications either went out or silently
// stopped at `no_submit_button` depending on the embed. This proves the two properties that make
// enabling it safe:
//
//   1. An iframe-hosted form submits, and the evidence says it was an embedded submission.
//   2. A submit-shaped button in an UNTOUCHED third-party frame is never clicked. The fixture puts a
//      decoy FIRST in the DOM, so a naive walk over every frame would reach it before the real form.
//
// Requires: node scripts/fakeAts.js
// Usage:    A1_RESUME=/path/to/any.pdf node scripts/a7CrossFrameSubmit.mjs
import fs from "node:fs";
import { autoApply } from "../services/applyAutomation.js";

const ATS = "http://localhost:4599";
const RESUME = process.env.A1_RESUME;
if (!RESUME || !fs.existsSync(RESUME)) {
  console.error("Set A1_RESUME to an existing PDF path."); process.exit(1);
}

const PAYLOAD = {
  field_map: {
    first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace",
    email: "ada@example.com", phone: "+1 555 0100", work_authorization: "Yes",
  },
  handler_map: {}, custom_answers: {},
};

const reset = () => fetch(`${ATS}/_reset`, { method: "POST" }).then(r => r.json());
const subs  = () => fetch(`${ATS}/_submissions`).then(r => r.json());

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
};

// ── 1. an iframe-hosted form submits ─────────────────────────────────────────
console.log("=== iframe-hosted form (workday shape) ===");
await reset();
const wd = await autoApply(`${ATS}/workday?ats=myworkdayjobs.com`, PAYLOAD,
  { mode: "full", jobId: "xf-workday", resumePath: RESUME });
const wdSubs = await subs();
const providers = wdSubs.submissions.map(s => s.provider);

check("status is submitted", wd.status === "submitted", `status=${wd.status} reason=${wd.reasonCode || "-"}`);
check("and it is VERIFIED, not merely clicked", wd.submitVerified === true, wd.submitEvidence || "");
check("the evidence records an EMBEDDED submission", /\|frame$/.test(wd.submitEvidence || ""), wd.submitEvidence || "");
check("the evidence came from the frame, not the main document",
  /frame_confirmation_page|frame_url_changed/.test(wd.submitEvidence || ""), wd.submitEvidence || "");
check("exactly one submission reached the ATS", wdSubs.count === 1, `count=${wdSubs.count}`);
check("it was the real application form", providers.includes("workday"), JSON.stringify(providers));

const wdRecord = wdSubs.submissions.find(s => s.provider === "workday") || {};
const fields = wdRecord.fields || {};
check("the embedded form's fields were filled correctly",
  fields.firstName === "Ada" && fields.lastName === "Lovelace" && fields.workAuthorization === "Yes",
  JSON.stringify(fields));

// The form now posts multipart, so the resume is a real upload with a size, not a bare filename
// echoed back by a urlencoded post. `files.resumeUpload === null` means the input was present and
// left EMPTY — the failure this assertion previously could not see.
const upload = (wdRecord.files || {}).resumeUpload;
check("and the resume reached the frame's file input",
  !!upload && upload.size > 0,
  upload ? `${upload.filename} (${upload.size} bytes, ${upload.contentType})` : "(no file chosen)");

// ── 2. an untouched third-party frame is never submitted ─────────────────────
console.log("\n=== the decoy third-party frame ===");
check("the decoy was NOT clicked", !providers.includes("decoy"), JSON.stringify(providers));
console.log("  (the decoy sits FIRST in the shell's DOM, so walking every frame would have hit it)");

// ── 3. the no-false-submitted guarantee still holds ──────────────────────────
// Lever's button reads "Review and Submit", which SUBMIT_RE does not match. Frame-awareness must not
// have turned that into a claimed submission — A1 trap 4.
console.log("\n=== a form with no matching submit button (A1 trap 4) ===");
await reset();
const lever = await autoApply(`${ATS}/lever`, {
  ...PAYLOAD,
  custom_answers: { "Are you authorized to work without sponsorship?": "yes" },
}, { mode: "full", jobId: "xf-lever", resumePath: RESUME });
const leverSubs = await subs();
check("status is filled_not_submitted", lever.status === "filled_not_submitted", `status=${lever.status}`);
check("submitVerified is false", lever.submitVerified === false, String(lever.submitEvidence));
check("no submission reached the ATS", leverSubs.count === 0, `count=${leverSubs.count}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
