# AL9 — the Preferred Name defect

Run 2026-09-05. Suite **2204 → 2215 passing, 0 failing** (+11). No migration, no spend.

---

## The defect

Ashby's SPA labels a field `"Preferred Name (if applicable)"` and gives the control a **bare GUID**
for a name, so only the label can resolve it. The generic label map's `"Name"` needle is a whole
token in that label, so it matched:

```
buildAnswers:  "Preferred Name (if applicable)"  =  "Ada Lovelace"   field_map_exact
```

**The candidate's legal name, typed into a preferred-name box, at 0.9 confidence** — the
second-highest provenance tier, above the auto-submit floor.

### It was inside a fixture the suite calls a trap

The greenhouse fixture has the same field, in a fieldset labelled — in the fixture's own words —
`TRAP: name_ambiguity`:

```html
<fieldset><legend>TRAP: name_ambiguity</legend>
  Legal Name        <input name="job_application[legal_name]" required>
  Preferred Name    <input name="job_application[preferred_name]">
  Name of Referrer  <input name="job_application[referrer_name]">
</fieldset>
```

The trap was only ever checked on the **referrer** half. The preferred-name half was being filled
the whole time and `a1TrapMatrix` reported **PASS**.

## Why it matters, given nothing false is asserted

This is the `name_ambiguity` class one step milder than "Name of Referrer": it is still the
candidate's own name, so no false claim is made about a third party.

It is still wrong. **A preferred name is a different datum** — the entire reason a form asks for it
separately is that it may not be the legal one — and answering it from the legal name **silently
overwrites a question the candidate was being offered the chance to answer**. Someone who goes by a
different name than their legal one now submits an application that says otherwise, and nothing on
any screen shows it happened.

---

## The fix

`OTHER_NAME_SUBJECT_RE` in `services/applyAutomation.js`, checked inside **`refuseReason`** — the
shared policy every resolution path goes through, so the legacy sweep, the discovery handler and
`buildAnswers` cannot contradict each other. Placed after the third-party rule, because "a different
*person*" is the more serious claim and keeps its own reason code.

```
Legal Name                       ->  full-name            fills
Preferred Name (if applicable)   ->  handler_type: null   full-name:other_name_subject
```

### ⛔ The failure mode of the fix is worse than the bug

A rule that swallowed ordinary name fields would leave **every application nameless**. So the
qualifier is mandatory, and the larger half of `test/otherNameSubject.test.js` is the *"still fills"*
half:

| still fills | refused |
|---|---|
| `Name` · `Full Name` · `Legal Name` · `Full Legal Name` | `Preferred Name` · `Preferred First Name` |
| `First Name` · `Last Name` · `Given Name` · `Surname` | `Nickname` · `Maiden Name` · `Former Names` |
| `Your name` · `Candidate Name` · `Name *` | `Chosen Name` · `Other Names` · `What name do you go by?` |

Three further properties, each a test:

- **It blocks the wrong SOURCE, not the field.** If a key is *itself* an other-name key
  (`preferred_name`, `nickname`), it is the right answer and passes. The rule is about which name
  answers a name question.
- **It applies to `first-name` and `last-name` too**, not just `full-name` — Workday asks
  "Preferred First Name" separately from "Legal First Name".
- **It is not a general veto on "preferred".** `Preferred Work Location` → `location` and
  `Preferred pronouns` are untouched; only *name* keys answering *other-name* labels are refused.

### The refusal is recorded, not silent

`handler_rejected: "full-name:other_name_subject"` travels on the field, so the fill log can say
**why** a box was left empty. A field that quietly stops being filled is indistinguishable from one
the form never had.

A required preferred-name field therefore becomes an **unanswered question** rather than a wrong
answer: the run holds and the candidate is told, instead of an employer receiving a preferred name
the candidate never gave.

### A regex bug the tests caught

The first version used `goes?\s+by` for "the name you go by". That is `goe` plus an optional `s`, so
it never matches the bare **"go by"** that *"What name do you go by?"* actually contains. The
phrasing is in the test for that reason.

---

## VERIFY

**A1 trap matrix** — all seven runs, statuses identical to baseline: G1–G5 `held_review` with 0
submissions, L1/A1 `submitted` with 1 each. The sponsorship-inversion question is still refused.

**Real greenhouse form**, driven through `autoApply`: `Legal Name`, `First Name` and `Last Name` all
fill at `field_map_exact`; **"Preferred Name" never appears with a value.**

**Real Ashby SPA**, via `al8DerivedMappingVerify` — the field moved out of the "resolved by authored
label" column, and one fewer field is filled (`4 → 5` became `3 → 4`).

> Verified as *never filled*. I did not separately confirm it surfaces in the greenhouse `blanks`
> list — the field-level `handler_rejected` is asserted by unit test, and that is what the fill log
> reads, but the end-to-end open-question rendering for this specific field is unchecked.
