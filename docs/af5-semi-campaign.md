# AF5 — the semi campaign: instrumented, not run

**The campaign itself is not something I can execute, and this is not a judgement call.** AF5 asks
for "REAL applications to REAL employers under the candidate's name", chosen "on their own merits",
in **semi** mode — which by definition waits for a human to read the form and click submit. Three
things in that sentence are the owner's and cannot be delegated:

1. **Submitting.** These are irreversible, outward-facing actions in someone's own name, affecting
   their professional standing with specific employers.
2. **Choosing the roles.** "Worth applying to on their own merits" is a judgement about the
   candidate's career.
3. **Clicking submit.** Semi mode's whole design is that the human is the backstop. There is no
   version of a semi run that I complete.

What I *could* do — and did — is make the campaign **recordable**. Two of the six facts AF5 asks for
per run were not being recorded at all, so running the campaign as specified would have produced a
report that could not be written.

---

## The gap: two facts the runs already had and threw away

AF5's per-run record: *fields discovered, fields filled, provenance per field, anything the human
corrected, terminal status, and whether the gate verdict was correct.*

| Fact | Before |
|---|---|
| fields filled | recorded (`answers_json`) |
| provenance per field | recorded (`answers_json`, per answer) |
| terminal status | recorded (`status` / `reason_code`) |
| gate verdict | recorded as the *verdict*; correctness is a human call (below) |
| **fields discovered** | **not recorded** — only two hold branches reported it, never the terminal path |
| **anything the human corrected** | **not recorded anywhere, at all** |

### fields discovered — the missing denominator

`fieldsDiscovered` was set on two early-return hold branches and **not on the terminal return** —
which is the only kind of return a completing semi run produces. So a run could report "12 fields
filled" with nothing to say whether 12 was most of the form or a tenth of it, and **per-ATS discovery
reliability was not computable**. Now reported on the terminal path and persisted via `persistAudit`
(so a stale schema costs only that column). NULL, never 0, when the run never reached discovery: "we
did not look" and "we looked and found nothing" are different facts, and a default of 0 would make
every un-measured run look like a discovery failure.

### corrections — "the corrections are the signal"

AF5 is explicit that this is the most valuable output: *"each one is a resolver defect or a missing
custom answer."* Nothing recorded them, and the reason is structural — **a semi run returns while the
browser is still open.** `awaiting_user` means the human has not finished, so their edits happen
after the only moment `autoApply` could have reported anything. The audit row is already written.

So `installCorrectionWatcher` is installed *before* the run returns, and reports through a **page
binding**, not a fetch. That distinction matters: on a real employer's origin a fetch to our server
is cross-origin and would either be blocked or would put the candidate's answers on the network in
order to make a *local note*. The binding keeps every value inside the process where `answers_json`
already lives. `routes/apply.js` writes each report to `corrections_json`, last-write-wins, guarded
by a column check so an un-migrated deployment loses the note and not the application.

Each entry is `{field, was, now, provenance, confidence}` — and the provenance is the point. A
correction to a `label_fuzzy` value is a guess the human had to fix; a correction to a
`handler_exact` or `field_map_exact` value means **an exact path got it wrong**, which is worse and
is the kind of defect this campaign exists to find.

**What is deliberately NOT a correction**, because a record full of false positives would turn the
campaign's best output into noise — all six proven in `scripts/af5CorrectionWatch.mjs` against a real
Chrome:

- a field changed and changed **back** (drops out of the record)
- a field the resolver **never filled** — the human answering a question we declined to guess is not
  them correcting us, and `missingRequired` already reports that
- a `skipped` or `policy_rejected` answer, for the same reason
- a control **removed from the page** — an SPA replacing a step must not read as "was X, now nothing"
- a form nobody has touched
- anything at all on an unattended run: exactly one call site, on the semi path, because there is
  nobody there to correct anything

It also catches a change that fired **no event** — an SPA can swap a control, and a click-driven
submit can navigate before any listener runs — so the watcher polls as well as listening on
`change` / `input` / `submit` / `beforeunload`.

Migration **088**, additive, byte-identical in both paths, applied to the live database
(backup taken first).

---

## The report

`node scripts/af5CampaignReport.mjs` produces both halves of what AF5 asks for, read off the database
rather than reconstructed from memory afterwards.

Per run: discovered / filled, provenance breakdown, every correction with its provenance, what was
left to the human, terminal status, and any gate hold with its screenshot.

Per ATS: run and distinct-job counts **against AF5's bar of 10 and 10** (it prints
`SHORT OF THE BAR: needs N more run(s)`), discovery fill-rate over measured runs, runs that
discovered *nothing* (a discovery failure, which is a different defect from a fill failure),
corrections grouped by provenance, and gate holds.

Then a third section AF5 asks for that ties back to AF1: **which questions recurred often enough to
belong in the custom-answer store.** Each candidate question is checked against what the store can
*already* resolve for that employer — using the real `effectiveCustomAnswers`, so a `{company}`
template that already covers it is not proposed again — and it distinguishes a question asked by
several employers ("store it once, it recurs") from one asked by a single employer ("a per-company
override may be enough").

Excluded from `verify:harness` (read-only against the real database, like `a5Preflight`). Degrades
with a loud banner if migration 088 has not been applied, rather than crashing.

### The one thing the report refuses to compute

AF5 wants the **false-gate rate**, and says it must be zero after AE1. That is **not in the
database**, and the report says so rather than inventing it:

```
false-gate rate: NOT COMPUTABLE from the database — AF5 requires this to be zero,
                 and only you can say whether each hold above was real.
```

A false gate looks identical to a true one from the inside — that is precisely what made AE1
undiagnosable from the logs. So every gate hold is printed with its reason and its screenshot path
and marked `verdict: YOURS`. A tool that guessed here would be manufacturing the same false
confidence the campaign exists to measure.

---

## Current state, from the live database

```
1 semi run in the last 30 days — status failed/internal_error, from 2026-08-12
unknown ATS: runs 1/10 required, distinct jobs 1/10 required
SHORT OF THE BAR: needs 9 more run(s) and 9 more distinct job(s)
```

The campaign has not started. Every run in it will now be recorded in full.

## What the owner does

1. Rehearse first: `node scripts/fakeAts.js` then `node scripts/a5Rehearsal.mjs` — same mechanics
   against the fixture, where a mistake costs nothing.
2. Run the real ones in semi mode, per ATS (greenhouse, lever, ashby), 10 runs over 10 distinct jobs.
   Read every form before submitting; correct anything wrong — **the corrections are now captured
   automatically**, so correcting a field is the same action as recording the defect.
3. After each batch: `node scripts/af5CampaignReport.mjs --days 7`.
4. For each gate hold it prints, look at the screenshot and decide whether the challenge was really
   there. AF5 requires that count to be zero.
5. Feed the store-candidate questions into AF1's Custom Answers settings surface. A held run already
   offers to save them; the report is the cross-run view of which ones keep recurring.

## Verification

- `scripts/af5CorrectionWatch.mjs` — 19 assertions, real Chrome, real controls: text, select,
  checkbox and radio, plus all six false-positive cases. Registered in `verifyHarnesses`.
- `test/campaignRecord.test.js` — 19 assertions: migration 088 byte-identical and additive, both
  columns defaulting to NULL, **both** semi call sites wired (CASE A and CASE B are separate
  `autoApply` calls and wiring one would have recorded some runs and silently not others), the
  degradation guard, and the in-page probe's own rules.

1673 node tests pass. 23/23 harnesses, 607 assertions.
