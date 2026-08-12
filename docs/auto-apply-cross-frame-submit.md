# Cross-frame submission (sign-off given)

The submit scan was main-frame-only, so an iframe-hosted form was discovered, filled, upload-attached
and passed through every gate — then stopped at `no_submit_button`. Now enabled.

## Why this is a consistency fix, not a new risk

I had flagged this as needing to be decided with the provider allowlist, on the grounds that it would
"start submitting where runs currently stop". Having built it, that framing was half right and worth
correcting:

**greenhouse embeds its application in an iframe on some boards and not others.** So today, whether an
application is actually sent depends on the embed — two identical runs, same guards passed, same ATS,
and one goes out while the other silently does not. The fix removes that arbitrariness.

A run reaching the submit step has already cleared: the prerequisite gate, the kill switch, the daily
cap, the concurrency limit, the provider allowlist, the ATS threshold, the completeness gate, and the
step-scoped low-confidence policy. The only thing stopping it was a technical limitation in *where we
looked for the button*. So this does not widen what may be submitted — it makes the existing decision
take effect.

**`V1_AUTO_PROVIDERS` is still unchanged** (`greenhouse`, `lever`, `ashby`). workday/icims/taleo remain
routed to review; this only means that when one of them is eventually allowed, submission will work.

## The safety property that had to be added

Main-frame-only scanning was, by accident, preventing something real: clicking a submit-shaped button
in a **third-party** frame. A live posting carries ads, captchas and analytics widgets, any of which
can contain a visible "Submit".

So the scan is scoped to **the main frame plus frames that received an approved answer** — a frame
only becomes a candidate once we have filled something in it. Naively iterating `frameList(page)`
would have reintroduced the risk.

Verified rather than asserted: the fixture now hosts a **decoy** frame with a visible "Submit" button
and no fillable field, placed **first in the DOM** so a naive all-frames walk reaches it before the
real form. It is never clicked; if it ever were, `/_submissions` records provider `decoy` and the
check fails.

## Verification had to move too

A1's finding N1 requires post-click **evidence** before claiming `submitted`. An iframe-hosted form
leaves the main document's URL and body untouched, so main-frame-only checks would have reported
`clicked_no_evidence` for a submission that genuinely succeeded — **N1's guarantee inverted into a
false negative**, which is worse than it sounds: the duplicate guard would not skip the job, so it
would be retried and the employer would receive a second application.

Evidence is now gathered where the submission happened:

| evidence | meaning |
|---|---|
| `confirmation_page` | the main document reached a confirmation |
| `frame_confirmation_page` | the submitting frame did |
| `url_changed` / `frame_url_changed` | the main document or a candidate frame navigated |
| `…\|frame` suffix | the click was in an embedded frame, not the main document |

No evidence still means **not submitted** (`clicked_no_evidence` / `submit_unverified`). Which frame
submitted is recorded, so a cross-frame claim is checkable after the fact.

## Verification

`scripts/a7CrossFrameSubmit.mjs` — real runs, **ALL CHECKS PASSED**:

```
iframe-hosted form   submitted, VERIFIED, evidence=frame_confirmation_page,frame_url_changed|frame
                     exactly one submission, provider=workday
                     fields correct (firstName=Ada, lastName=Lovelace, workAuthorization=Yes)
                     the resume reached the frame's file input
decoy frame          NOT clicked — and it sits first in the DOM
no matching button   lever "Review and Submit" -> filled_not_submitted, submitVerified=false,
                     0 submissions  (A1 trap 4 still holds; frame-awareness did not turn a
                     non-match into a claimed submission)
```

Regression: **trap matrix unchanged** (all greenhouse variants hold, lever `filled_not_submitted`,
ashby submits), **correction loop** and **A3 guards** both ALL CHECKS PASSED.
**Suite 681 → 682 pass, 0 fail, 0 introduced.**

The test I had written asserting this was *deliberately not enabled* failed on the change — which is
what it was for — and is replaced by the inverse invariants: the scan is frame-aware, it is scoped to
touched frames, and the evidence is gathered in the submitting frame.

## Regression review

| Surface | Verdict |
|---|---|
| `services/applyAutomation.js` | Submit scan and post-click verification are frame-aware; `discoverAndFill` records touched frames via an injected `Set`. No change to what may be submitted, only to where the button is found and where evidence is read. |
| `routes/apply.js` | **Untouched.** `submitVerified` / `submit_evidence` keep their meaning, so A3's audit persistence records the frame provenance with no change. |
| `scripts/fakeAts.js` | Decoy frame added to the workday shell. |
| Client | **No change.** |
| `test/platformLabelMaps.test.js` | The "deliberately not enabled" test replaced by the inverse invariants. |

**No migration.**

## What is left

**A5 is now the only thing gating a real application** — and it matters more, not less, than before:
this makes the first live greenhouse submission possible on boards where it previously stopped. Its
procedure stands: semi mode, human present, one posting the candidate genuinely wants, every resolved
answer reviewed against the rendered form before anyone clicks submit.

Also still open from earlier work: real-form validation of the thin provider maps, and adding a
provider to `V1_AUTO_PROVIDERS` — both after A5.
