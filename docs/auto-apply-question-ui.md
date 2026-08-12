# Question-prompt UI (sign-off given)

The read half of the validation-correction loop. A held application used to be a dead end in the UI:
the review modal listed jobs and their `reason_code`, with no way to act. It now shows the questions
that would unblock them and takes the answers.

Built against the API from the loop commit — no server change was needed.

## Where it lives

Inside the existing **Jobs Needing Review** modal (`JobsPanel`), at the top of the body, on the
review view only (not when inspecting a single run's detail). Reusing that modal keeps one place to
answer "what do I need to do", and it already uses the opaque `theme.modalSurface` token, so the board
does not read through it.

It also gets **its own toolbar CTA** — `Answer 3 questions ↗`, accented — rather than hiding behind
the existing `N need review` badge. Answering is the actionable step; "needs review" is a status.

## What it renders

Per question, from `GET /api/apply/questions`:

| server field | rendered as |
|---|---|
| `question` | the label |
| `type` + `options` | a `<select>` of the form's real options, a Yes/No select for checkbox/toggle, a textarea for `text_area`, otherwise a text input |
| `eligibility` | an **ATTESTATION** pill plus *"You are stating this to the employer yourself. We never answer it from your profile."* |
| `reason: "low_confidence"` | framed as a **confirmation**, with the proposed value seeded into the field |
| `proposed` | the seeded value — accepting it *is* the answer |
| `blocking` | "Blocks: FakeCo, …" with a `+N more` overflow |
| `answered` | a **SAVED** pill |

Two actions, because the two are genuinely different: **Save & retry** and **Save only**. Saving
without retrying has to be possible — the daily cap can be spent or the kill switch on, and the
answers are still worth keeping.

The retry list sent is the union of every job the answered questions block. The **server** decides
which of those are actually retryable (it only retries a job once every question blocking it is
answered) and reports the rest as `skipped`. The client does not duplicate that rule.

## The safety property, carried into the UI

Eligibility answers are attestations to an employer, and the resolver refuses to infer them — that is
the invariant the whole resolution layer was built around (A1's sponsorship trap). The UI states it
rather than presenting those questions as ordinary fields, and a test asserts the treatment is driven
off `q.eligibility` rather than hardcoded.

The header says it once more for the whole set: *"Nothing here was guessed on your behalf — these are
the fields we would not fill without you."*

## Error handling

`api.js` now prefers the server's `message` over its machine `error` code (fixed earlier this
session), so a refused retry reads *"Daily application cap reached: 2 of 3 used in the last 24h"*
rather than `daily_cap_exceeded`.

A refused retry also reports `saved`, so the panel says **"Saved 3 answers, but the retry did not
start: …"** instead of implying the input was lost. Verified against the real 503 path.

## Verification

- **Client builds clean** (`vite build`), which is also what would catch a malformed JSX tree.
- **Contract tests over real HTTP** against the real router, with the question fixtures produced by
  the real `buildOpenQuestions` — so a change to the producer's shape breaks the test rather than the
  UI at runtime. Every field the panel reads is asserted present in the actual payload: the envelope
  (`questions`, `eligibilityCount`, `blockedJobs`), every question field the JSX touches, that
  `options`/`blocking` are always arrays (the panel maps them), that options carry `value` + `label`
  with the placeholder already dropped server-side, and that `blocking` entries carry
  `jobId`/`company`/`title`.
- **The write contract**: the exact body `submitApplyAnswers` sends is accepted (202), the reply
  carries `saved`/`unblocked`/`retry.queued` as the panel reads them, and the answers really land in
  `user_profile.custom_answers` where the resolver reads them on retry.
- **The refused-retry path**: with the kill switch on, the 503 still reports all three answers saved.
- **Correction loop and A3 guards**: both ALL CHECKS PASSED against the endpoints this UI drives.
- **Suite: 675 → 681 pass, 0 fail, 0 introduced.**

**Not done: the component was not visually rendered.** There is no test renderer in devDependencies,
so this is contract- and build-verified rather than screenshot-verified. Layout, wrapping and colour
contrast in the real modal are unconfirmed — worth a look on the first real held run.

## Regression review

| Surface | Verdict |
|---|---|
| `client/src/panels/JobsPanel.jsx` | Modified — additive state, two callbacks, one toolbar button, one modal section. No existing branch altered except the review modal's empty state, which is now suppressed when questions are shown so it cannot contradict them. |
| `GET /api/apply/questions`, `POST /api/apply/answers` | Consumed, unchanged. |
| `routes/apply.js`, `services/*` | **Untouched.** No server change was required. |
| Existing JobsPanel tests | No churn — 675 passed before and after; the 6 new tests are additive. |
| `api.js` | Unchanged here; relies on the `message`-over-`error` fix from an earlier commit. |

**No migration.**
