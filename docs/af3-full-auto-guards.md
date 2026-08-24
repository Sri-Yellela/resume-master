# AF3 — full-auto guards: what was already there, and what was never proven

The brief said these "were specced in A3 and appear not to have landed". Most of them **had** landed.
What had not happened is the part that matters: **proof that they fire**. Under semi a human is the
backstop, so a guard that exists and never runs looks exactly like a guard that works.

Status of each requirement, and where the evidence now lives.

---

## 1. Kill switch — one flag, no deploy, semi keeps working

**Already live.** `fullAutoDisabled()` (routes/apply.js) reads an env flag *and* an `app_settings`
row, so the row wins and the switch flips with no restart. Checked at admission **and** re-checked
per job inside `processRunJob`.

Already covered:
- `test/applyGuards.test.js` — env flag blocks full-auto while semi still starts (202); the DB row
  overrides env mid-process.
- `scripts/a3GuardsIntegration.mjs §3` — 503 at admission with a real browser and ATS, nothing
  recorded, semi unaffected.

**What was missing: "Verify it takes effect on an in-flight batch."** Every existing check tested
*admission* — refusing a new run. That is a door lock on a room people are already in. Nothing tested
a batch that was already admitted and part-way through.

Added: `scripts/a3GuardsIntegration.mjs §4`. Admit a three-job auto batch with the switch off, flip
the `app_settings` row while the run is live, let it drain. Deterministic because `processRun` puts a
1–3s jitter between job launches, so job 1 is inside a browser while jobs 2 and 3 have not reached
their check yet. Measured:

```
ash1:submitted/-   ash2:held_review/full_auto_disabled   ash3:held_review/full_auto_disabled
ATS submissions: 1 of 3 jobs
```

The job already in flight completed; the two that had not gone were **held for a human**, not
dropped. `submissions < jobs` is asserted against the fixture ATS's own record, not against a status
the pipeline reports about itself.

## 2. Per-user daily cap and concurrency limit

**Already live and configurable.** `APPLY_DAILY_CAP` (env, default 25) and `APPLY_WORKER_LIMIT`.
Enforced at admission and re-checked per job, because a run can cross the cap mid-flight.

Exceeding is a **clear error, never a silent drop** — verified:
- `test/applyGuards.test.js` — the cap returns an explicit error; semi is exempt (a human submits
  those); a user may not stack concurrent runs.
- `scripts/a3GuardsIntegration.mjs §2` — 429 `daily_cap_exceeded` with the numbers in the body
  (`submittedLast24h`, `requested`, `limit`, `remaining`), nothing queued, nothing at the ATS.

A job that crosses the cap mid-run is `held_review` / `daily_cap_reached`, which is a hold the user
can see and act on rather than a lost application.

No change needed. Recorded here because "appears not to have landed" was the premise, and it had.

## 3. Idempotency on POST /api/apply/runs

**Already live.** `withIdempotency` wraps `/api/apply/runs`, and also `/api/apply`,
`/api/apply/approve` and `/api/apply/answers`.

- `test/applyGuards.test.js` — a repeated `Idempotency-Key` returns the original run and queues
  nothing; without a key two posts are two runs (replay protection is opt-in); reusing a key against
  a *different* endpoint is a 409 rather than a wrong body; a rejected request is not cached.
- `scripts/a3GuardsIntegration.mjs §1` — the claim that actually matters, end to end with a browser:
  one key, **exactly one submission at the ATS**.

No change needed.

## 4. The gates must actually run ⛔ this was the real gap

`isUnattended = isFullAuto || isPreview`. Semi is neither, so in a semi run **neither gate is
reached**. Every real run to date has been semi. So both unattended gates were code that had never
executed against a form.

### Completeness gate — already proven

`scripts/ae7SubmitOnRealShape.mjs` cases **A** and **D** drive `mode:'full'` against `/ashby-spa`,
the measured shape of the live Ashby posting:

- **A** — the form exactly as measured. The required date control's only identity is the placeholder
  "Pick date...", so nothing can answer it → `held_review` / `incomplete_form`, and the ATS recorded
  nothing.
- **D** — the resume uploads into the *wrong* file input (that input carries the real page's own
  "Upload your resume here to autofill" copy), so `_systemfield_resume` stays empty → holds naming
  "Resume". Nothing recorded.

A blank required field HOLDS. Proven, live, on a real form's shape.

### Low-confidence gate — had no coverage at all; added

No fixture case had ever produced a form that was **complete but partly guessed**, which is the only
state that reaches this defence. Added `?fuzzylabel=1` to the fixture: one required free-text
question, "Which team interests you most", whose only relation to the profile is that the word "team"
appears in both. That is `label_fuzzy` / **0.3**, under `AUTO_SUBMIT_MIN_CONFIDENCE` (0.8).

`ae7` case **E** — every required field now has a value, so the completeness gate is satisfied and
the low-confidence defence is the only thing left standing between a guess and a real employer:

```
status=held_review reason=low_confidence_answers filled=0
lowConfidence: [{"field":"Which team interests you most","value":"Platform Infrastructure",
                 "provenance":"label_fuzzy","confidence":0.3,"matched_on":"team"}]
ATS submissions: 0
```

Case **E2** is its control: the same form *without* that field submits and the ATS records exactly
one. Without the control, "it held" could just mean the fixture is broken.

**Which mechanism fired, stated precisely.** There are two low-confidence defences, and this run
proves the *first*: the **step-approval policy escalated at step 0**, before anything was typed —
which is why `fieldsFilled` is 0 and nothing reached the page at all. `policyEscalation` is
`{step: 0, reason: "low_confidence_answers"}`, and that is now asserted rather than assumed.

The post-fill gate inside the `isUnattended` block (`lowConfidenceAnswers(resolvedAnswers)`) is a
**second** line, reachable only if resolution changes between the step check and the post-fill
re-discovery — a field revealed by filling, say. This fixture cannot reach it because escalation
preempts it. Saying so is more useful than implying both fired; if that second gate is meant to be
reachable independently, it needs a case that changes the form mid-fill, and it does not have one.

## 5. The gate detector's false positive — confirmed fixed and live

The AE1 case: invisible reCAPTCHA's hidden 256×60 anchor iframe read as `captcha_required`,
terminating a run on a plain 15-field apply form. Under full-auto a false gate produces a held
application nobody looks at.

Confirmed live in `services/applyAutomation.js`:

- **Visible and interactable only.** `GATE_EVIDENCE_SRC` measures rendered-ness — `getClientRects()`,
  computed style walked through ancestors for opacity/display, and a `MIN_W`×`MIN_H` floor (24×12).
  Presence is not proof.
- **`[data-sitekey]` decides nothing, in any visibility state.** It is a *configuration* attribute:
  invisible Turnstile and reCAPTCHA v3 carry it on pages that challenge nobody. Collected as log
  context only.
- **Nothing reads page source.** Every probe is a DOM query against live nodes. A JS chunk that
  merely mentions `hcaptcha` is not a challenge.
- **Discovery is not preempted by a gate (AE2).** Only a *credential wall* halts the fill, and that
  asymmetry is deliberate: a sign-in box is a third party's credential form, so an email typed there
  is an account-existence probe against the candidate's own identity. A challenge sits *on* the real
  application form, so the run fills it and holds afterwards — a hold that carries answers matched
  against the employer's actual controls, rather than the empty handoff AE1 produced.
- **Re-checked after fill**, so a challenge presented in response to the fill is still caught.

Unit-tested against the exact element, in `test/credentialFields.test.js`:
"THE EXACT ELEMENT THAT CAUSED AE1: an invisible reCAPTCHA anchor frame is not a gate" — the measured
node, 256×60, `visibility:hidden`, from the live posting. Plus: `data-sitekey` never decides; a hidden
node never outvotes the absence of a visible one.

The credential half deliberately keeps a wider net, because the two errors are not symmetric.

---

## Verification summary

| Requirement | Status | Evidence |
|---|---|---|
| Kill switch, no deploy, semi unaffected | already live | `applyGuards.test.js`, `a3GuardsIntegration §3` |
| **Kill switch stops an in-flight batch** | **added** | `a3GuardsIntegration §4` — 1 of 3 submitted, 2 held |
| Daily cap, configurable, clear error | already live | `applyGuards.test.js`, `a3GuardsIntegration §2` (429) |
| Concurrency limit | already live | `applyGuards.test.js` |
| Idempotency → one run, one submission | already live | `applyGuards.test.js`, `a3GuardsIntegration §1` |
| **Completeness gate fires live** | proven | `ae7` A, D — holds, ATS records nothing |
| **Low-confidence gate fires live** | **added** | `ae7` E + E2 control — holds at step 0, ATS records nothing |
| AE1 false positive fixed and live | confirmed | `credentialFields.test.js`, AE2 fill ordering |

1654 node tests pass. 22/22 harnesses, 588 assertions (was 572; the two raised floors are committed
in `scripts/harnessBaseline.json` so a future truncation still fails).

**Still not verified by any of this:** these all run against a fixture. A fixture transcribed from a
measured live posting is much better than a hand-written replica, and it is still not an employer.
That is what AF5 is for.
