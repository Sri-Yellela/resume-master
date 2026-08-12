# A1 trap 8 — the resume upload

An eighth trap, added to TASK A1's scope after the original seven were run and deferred because the
harness could not exercise it. Companion to `docs/auto-apply-a1-trap-matrix.md`, whose finding N2
and "second blocker" note are the same territory seen from the other side.

Reproduce: `node scripts/fakeAts.js`, then
`A1_RESUME=/path/to/any.pdf node scripts/a8FileUploadTrap.mjs`

Every result below is from a real `autoApply(..., mode:'full')` run against `scripts/fakeAts.js` on
`localhost:4599`. Nothing was pointed at a real ATS.

## Why it was unanswerable until now

No fakeAts form declared `enctype`, so browsers posted `application/x-www-form-urlencoded`. Under
that encoding a file input sends a bare filename and no content, and the recorder did not parse
multipart at all. The consequence was not that upload coverage was thin — it was that **the harness
could not distinguish "the resume was uploaded" from "the resume field was skipped."** Both produced
the same recorded shape. `uploadToFileInput` and `handleTypedFileUploads` had no end-to-end coverage
of any kind.

Fixed in `196f4cf`: the four forms with file inputs post `multipart/form-data`, and each submission
now records `files` (name → `filename`/`contentType`/`size`) separately from `fields`, with `null`
for an input that was present but left empty.

## Result

| # | Case | Expected | Actual | Verdict |
|---|---|---|---|---|
| 8a | ashby — single step | resume arrives intact | `John Doe Resume.pdf` 65413b `application/pdf`, `submitted` | **PASS** |
| 8b | workday — input inside an iframe | resume arrives intact | same file, same byte count, `submitted` | **PASS** |
| 8c | greenhouse — uploaded at step 1 of 2 | survives the step transition | same file, same byte count, `submitted` | **PASS** |
| 8d | optional cover letter, never generated | recorded present-but-empty | `null`, not omitted | **PASS** |
| 8e | `resumePathPromise` → `null` | ATS gate holds | `ats_held` / `resume_unavailable`, 0 submissions | **PASS** |
| 8f | direct `resumePath: null` | never submits | `held_review` / `incomplete_form`, `missingRequired: ["Resume"]`, 0 submissions | **PASS** |
| 8g | `resumePath` → a file that does not exist | never submits | `held_review` / `incomplete_form`, 0 submissions | **PASS** |

**Trap 8: PASS.** 65413 bytes is the source file's exact on-disk size, so the bytes crossed the wire
intact rather than a filename being echoed back.

## The half that matters

8a–8c are the reassuring half and the less important one. A resume that fails to attach produces a
visibly broken application. A run that submits **without** one is a real application to a real
employer with no resume attached, and it cannot be recalled. That is 8e–8g.

**8e — the apply worker's path.** Generation runs in parallel and resolves `null` when it fails, when
the ATS score is below threshold, or when PDF conversion fails. `applyAutomation.js:1453` catches
exactly this and returns `ats_held` / `resume_unavailable`. Working as designed.

**8f — the gap A1 named, now closed by a different gate.** That ATS gate is conditional on
`resumePathPromise` being supplied. A caller passing a direct `resumePath` of `null` never reaches
it. A1 finding N2 recorded that the completeness gate could not catch that either, because it
filtered out file inputs (`f.type !== 'file'`) — so a required-but-empty resume field passed the gate
while the browser refused to submit the form, and the run reported `filled_not_submitted` with no
`reasonCode`.

N2 was fixed in A2 (`applyAutomation.js:1498`, which cites the finding). This run confirms the
repair holds at the level that matters: `missingRequired` came back as exactly `["Resume"]` — the
resume was the *only* unsatisfied field, so the hold is attributable to it and nothing else. **The
two gates are independent, and the second covers the first one's blind spot.**

**8g — a path that no longer exists.** `uploadToFileInput` guards on `fs.existsSync`, so a stale temp
path leaves the input empty rather than throwing. That is the right direction, but it means the only
thing standing between a vanished artifact and a resume-less submission is the completeness gate —
the same one 8f depends on. Both failure modes now rest on that single check.

## What this does not prove

- **The file is never validated.** The harness records `size` and `contentType` and asserts on them;
  nothing in `applyAutomation.js` checks that what it uploads is a readable PDF, only that the path
  exists. A zero-byte or truncated artifact would upload and submit. Not exercised here.
- **A required file input is the only thing keeping 8f and 8g safe.** An ATS whose resume field is
  not marked required would not appear in `missingRequired`, and neither gate would fire. Every
  fakeAts form marks it required; a real form may not. This is the residual risk and it is worth a
  targeted fixture before full-auto is widened.
- **`partCount` is not evidence of an upload.** Greenhouse's final POST carries zero parts — the
  resume was taken at step 1 and carried forward. Assert on `files`.

## Regression surface

- `scripts/a8FileUploadTrap.mjs` — added. Imports `services/applyAutomation.js` read-only, asserts
  against `GET /_submissions`. Dependents: none. **Verdict: additive.**
- `services/applyAutomation.js` — **read only, unmodified.** **Verdict: unchanged.**
- No migration — this task adds no schema.
- Suite **682 pass / 0 fail; introduced failures: 0.**
