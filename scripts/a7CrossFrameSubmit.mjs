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

// ── 3. a qualifier before the verb is a real submit control ──────────────────
//
// THIS CHECK WAS INVERTED, and the inversion outlived its reason. It was written when SUBMIT_RE was
// anchored at ^, so "Review and Submit" — Lever's actual wording — never matched and the run ended
// as `filled_not_submitted`. A1 trap 4 recorded that as the defect, and this case asserted the
// broken behaviour as though it were the guarantee.
//
// classifySubmitLabel then fixed it on purpose: STRONG_SUBMIT_RE is /\b(?:submit|send)\b/, so a
// qualifier may precede the verb, and NOT_SUBMIT_RE still excludes "Save and Continue" and
// "Submit Draft". "Review and Submit" scores 2. So the correct expectation is the opposite of what
// stood here, and the trap registry's own wording already allowed for it: "the run either submits
// or reports filled_not_submitted — never a FALSE submitted".
//
// The guarantee being protected is therefore unchanged, and this is still where it is checked — it
// is just checked in the direction that is now true. What makes the submission not false is that the
// ATS RECORDED IT, exactly once, so the three assertions below are about the record and not about
// the status. The other half of the same guarantee — a submit-shaped button that changes NOTHING
// must report clicked_no_evidence — is exercised by scripts/ae7SubmitOnRealShape.mjs case C, which
// has a JS-submitted form to do it on; this fixture's button cannot be made inert without changing
// what it is testing.
console.log("\n=== a qualifier before the verb: Lever's \"Review and Submit\" (A1 trap 4) ===");
await reset();
const lever = await autoApply(`${ATS}/lever`, {
  ...PAYLOAD,
  custom_answers: { "Are you authorized to work without sponsorship?": "yes" },
}, { mode: "full", jobId: "xf-lever", resumePath: RESUME });
const leverSubs = await subs();
check("\"Review and Submit\" is recognised as the submit control",
  lever.status === "submitted", `status=${lever.status} reason=${lever.reasonCode ?? "-"}`);
check("and the submission is VERIFIED by evidence, not by the click alone",
  lever.submitVerified === true && /confirmation_page|url_changed/.test(lever.submitEvidence || ""),
  String(lever.submitEvidence));
check("EXACTLY ONE submission reached the ATS — which is what makes it not a false claim",
  leverSubs.count === 1, `count=${leverSubs.count}`);
check("and it was the lever form", leverSubs.submissions[0]?.provider === "lever",
  String(leverSubs.submissions[0]?.provider));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
