# AL8 (task H) — label → field mappings derived from captured form structure

Run 2026-09-05. Suite **2190 → 2204 passing, 0 failing** (+14). Migration **100**. No model calls —
by design, and asserted.

---

## The headline: the machinery is built and correct, and the headroom is much smaller than H assumed

Two measured findings, either of which changes how this task should be judged.

### 1. `company_form_schemas` is empty — H's input does not exist

H's stated input is *"G4's captured `company_form_schemas`"*. The table exists (G4 built it) and holds
**0 rows**, on the live database and in **all eight backups**. No schema has ever been captured.

The generator refuses to run rather than producing a table of nothing presented as coverage:

```
⛔ company_form_schemas IS EMPTY — there is nothing to derive a mapping from.
```

### 2. ⛔ Attributes are checked before labels, and that bounds the whole feature

`resolveHandler` tries `HANDLER_BY_ATTR` first, the file heuristics second, and the label map
**last**. So a derived label mapping is dead for any field whose control `name` is recognisable —
and 70 attribute spellings are recognised, from `given-name` to `years_of_experience`.

Measured on the Ashby SPA fixture, which the fixture's own comment calls the case where
*"label-based resolution is not optional"* (`_systemfield_*` beside bare GUIDs):

| resolved by | fields |
|---|---|
| attribute | Email, Phone Number |
| authored label | Legal Name, Preferred Name (if applicable) |
| **neither** | **10** — Resume, two placeholder-only controls, two acknowledgements, four EEO radios, Additional Information |

**A derived mapping can only ever help the third row. Not one of those ten has a fillable profile
key** — they are attestations, EEO questions, a file input, and free text. The fixture's own comment
describes them as "the half of the form that a resolver cannot map", and it is right for a reason
deeper than labelling: there is no profile field that answers "Which team interests you most".

> So on the evidence available, **the derived table's real headroom on these forms is zero.** That
> is not a reason to delete the machinery — it is a reason to capture real schemas before investing
> further in it, and to expect less than the task did.

I chose a bad demonstration field first (`Portfolio URL`, which looked unresolved) and it took a run
to see that `HANDLER_BY_ATTR['portfolio']` already resolves it — it is blank only because the test
payload has no `portfolio_url` value. That proposal was **rejected** in the real database rather than
left confirmed and doing nothing.

---

## ⛔ The hard boundary, asserted rather than commented

The task said *"Assert the exclusion with a test, not a comment."* It is asserted **three times over**,
at three independent layers:

1. **`recordMappingProposal` refuses**, so the row cannot exist to be confirmed later.
2. **`loadConfirmedMappings` refuses again**, so even a row that somehow reached `confirmed` cannot
   deliver an excluded key to the resolver.
3. **The merge order forbids it structurally** — a derived entry is merged *beneath* the authored
   map, so it can never override `"Work Authorization" → work_authorization`.

Refusal is checked on **both** the key and the label, and the second is what catches the real defect:

| case | refused because |
|---|---|
| `fieldKey: "requires_sponsorship"` | the key is an eligibility field |
| label *"Do you now or in the future require sponsorship for work authorization?"*, key `location` | **the label asks an eligibility question** |
| label *"Sign in email"*, key `email` | the label is a credential field |

The second row is the **sponsorship-inversion trap** exactly: a key-only check would have let it
through, because `work_authorization` "looks like" the right handler for a work-authorization
question. The question is semantically inverted, and answering it from that value is a materially
false attestation to an employer.

The third is the **`login_email` shape**: the label was a perfectly ordinary "Email". The candidate's
home address was typed into a portal's sign-in box at 0.9 confidence.

**A derived table is a label matcher with more data behind it. More data does not make an inverted
question answerable.**

The eligibility labels that *are* mapped stay where they were — in the hand-written
`PLATFORM_LABEL_MAPS`, which is the "exact handler mapping" the task says those answers must resolve
through. A test asserts every such key is simultaneously present there and on the derived table's
refusal list.

---

## VERIFY

### The A1 trap matrix — run twice, unchanged

```
G1_minimal       held_review   submissions=0      L1_lever   submitted   submissions=1
G2_status_value  held_review   submissions=0      A1_ashby   submitted   submissions=1
G3_yesno_value   held_review   submissions=0
G4_repeat_of_G3  held_review   submissions=0
G5_no_short_name held_review   submissions=0
```

Identical before and after, and `missingRequired` still reads
`["Do you now or in the future require sponsorship for work authorization?"]` — the resolver
**refuses** it, which is the required behaviour.

⚠ But the trap matrix calls `autoApply` **directly**, so it never passes `derivedLabelMaps`. It
proves **no regression**; it cannot prove the new path works, because it never takes it.

### `scripts/al8DerivedMappingVerify.mjs` — 9 checks, all passing

Proves the injected map travels `routes/apply.js → autoApply → discoverAndFill → discoverFields`
and changes what is filled (**4 → 5 fields**), at `field_map_exact`, with no eligibility or EEO field
answered in either run.

> **The probe's mapping is deliberately arbitrary and is stated as such in its own output.** Since no
> fixture field can legitimately use a derived mapping (finding 2), the probe maps "Additional
> Information" to a key it has no business holding, purely to observe the wiring. It is never
> confirmed into the real database.

It earned its place immediately: **the first version of the wiring built the merged map in
`autoApply` and then threw it away**, because `discoverFields` recomputed its own from the provider
alone. The fill was unchanged and nothing said why.

---

## Requirements 2 and 4

**Proposals never reach the resolver.** `status` defaults to `proposed`; corroboration counts
**distinct hosts** (re-capturing one employer's form ten times is one employer's evidence) and never
promotes. A rejection is sticky — the corpus that produced a bad mapping keeps producing it.

**Provenance tiers untouched.** A derived mapping resolves at `field_map_exact` — the same tier an
authored label does, because it *is* the label map — never at `label_fuzzy`. The A2 rule stands: a
`label_fuzzy` answer is not auto-submitted in `mode: 'full'`.

**No model, anywhere.** Not at fill time and not offline: the mapping is derived by matching captured
labels against the profile-key vocabulary the resolver already uses. Asserted across the module, the
detector and the generator.

**`applyAutomation` still has no database handle.** The derived map is *injected* by
`routes/apply.js` rather than loaded in the automation layer — growing a DB handle there would have
been the easy change and the wrong one. Asserted.

---

## A live near-miss found on the way — NOW FIXED

`"Preferred Name (if applicable)"` on the Ashby SPA has a **bare GUID** for a control name, so it
resolves by label only — and the generic map's `"Name"` needle matches it, mapping it to
**`full_name`**. The candidate's *legal* name is typed into a *preferred name* box.

That is the `name_ambiguity` class the A1 traps exist for, one step milder — it is still the
candidate's own name, so nothing false is asserted about a third party. It is still wrong: a
preferred name is a **different datum**, and the entire reason a form asks for it separately is that
it may not be the legal one.

**The greenhouse fixture labels the field `TRAP: name_ambiguity`, beside "Name of Referrer".** The
trap was only ever checked on the referrer half; the preferred-name half was being filled at
`field_map_exact` and the matrix reported PASS.

Fixed — see the AL9 section below.
