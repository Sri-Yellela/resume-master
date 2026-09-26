# Product Model — two products, one daily draft

**Design document.** Nothing here is built. ⛔ Do not write any of it into `ARCHITECTURE.md`, which
documents what exists. Owner decisions recorded 2026-09-25.

---

## The decisions

| | |
|---|---|
| **Brand** | **draft**, lowercase, as a wordmark. Not "drafted." — the screenshots were visual reference only. `BRAND.md` is authoritative and says Draft; update it for the lowercase treatment |
| **Two products** | `jobsviadraft.com` (draft) and `resumemaster.one` (Resume Master). **Not linked.** Separate user bases, separate databases, separate deployments |
| **Resume Master** | A **stateless processor**. Takes input, returns output, **stores nothing**. Sessions only, plus accounts for its own direct consumers |
| **draft** | Stores everything: résumés, profiles, applications, outcomes |
| **The API** | Real, because draft is genuinely a third-party caller. It earns itself |
| **Audience** | **Students and new grads.** Major, graduation year, internship / full-time / micro job |
| **Validation** | **Per-user, not board-exhaustive.** ρ against a graded corpus is retired as the primary measure |
| **`www`** | Dropped for now. Railway's two-domain limit; bare apex is canonical |
| **VM / remote browser** | Later. After the split, the UI, and AF5 |

---

## ⛔ What the student pivot breaks

**The seniority guard is now backwards.** It exists because a Figma intern posting scored 60 against
an experienced-engineer profile and the owner graded it 2; removing that inversion moved ρ from
0.643 to 0.732. **For a student audience, intern and new-grad postings are the product.** That guard
must be inverted or made profile-relative.

**The graded corpus is historical.** `docs/am1-ats-graded-corpus.json` is 30 senior engineering
postings graded by an experienced engineer. ⛔ **Keep the file** — it is irreplaceable, since the
original postings were destroyed in the id-85 deletion — but it no longer validates the product.
A new reference set is needed, graded against student-relevant roles.

**The board's composition is wrong for the audience.** Ingestion is tuned to engineering postings
from Greenhouse and Ashby. Whether those carry enough intern and new-grad roles is an open question
that should be **measured before anything is designed around it.**

**`profileTitleSql` and the bridge inherit the same problem.** Both were tuned against senior
engineering titles. A student's target titles are different in kind, not only in level.

---

## Resume Master — the stateless processor

**What moves there:** résumé generation, the formatting system, the PDF artifact and editor, résumé
parsing, and the ATS scorer as a *product surface*.

⛔ **Stateless means stateless.** Input in, output back, nothing persisted. That is what keeps the
privacy story simple, and it is the whole reason the boundary is safe.

### The API boundary

```
draft  --(résumé text + JD text)-->  Resume Master  --(artifact)-->  draft
                                     stores nothing
```

**⛔ Personal data crosses a service boundary.** A candidate's résumé carries a home address, phone,
employment history and sometimes work-authorisation answers. Consequences:

- Both privacy policies must describe the flow. Resume Master's says **processes, does not retain**.
- The Web Store data-use declaration needs re-checking; `PRIVACY_RECONCILIATION.md`'s four-column
  join gains a fifth column for the cross-service flow.
- ⛔ The **integrity rules become contractual**, not internal. AF2's assertion that generated output
  cannot claim more experience than the profile states, flag-don't-fabricate, and the §7 rules are
  currently protections. Sold as an API, they are promises to third parties.
- Logging must not retain payloads. `usage_events` records tokens and cost, never content.

### ⛔ The ATS scorer is a SHARED MODULE, not an HTTP call

`scoreAtsLocally` is deterministic, local, free and fast, and **makes zero model calls** — pinned by
a test asserting the scrape block contains no `messages.create`.

Putting it behind HTTP adds latency and a contract boundary for no benefit. draft's daily selection
runs it against thousands of rows; that cannot be a network hop.

**Publish it as a package both products import.** One implementation, two consumers. Resume Master
may expose it over HTTP for *its own* customers; draft calls the module directly.

### The rebrand guard needs a carve-out

The P2 sweep removed every `resumemaster` literal and added a test that fails on reintroduction.
A product legitimately named Resume Master needs an **allowlist entry with a stated reason**, not a
fight. Note the allowlist self-prunes, so the entry must be genuine.

### Deployment

Two Railway services, two databases. ⛔ **`resumemaster.one` is never retired and the 301 never
happens** — `MIGRATION_AND_REBRAND.md` assumed both. Correct that file.

⚠ **Domain slots:** two are in use. A separate Resume Master service needs its own. Confirm whether
custom domains are per-service or per-account before planning.

---

## draft — the daily draft

### Why a daily set rather than a board

ρ ≈ 0.75 supports **coarse ordering**, not a trustworthy ranking. A full board implies
exhaustiveness and invites the user to judge the ordering across thousands of rows — the one thing
the engine cannot support. **A daily set of ten only requires that the top ten are good**, which
coarse ordering *can* deliver.

It also sidesteps the open "the board does not rank by fit" problem by changing what is promised,
and it makes the name literal.

### Open design questions — decide before building

- **How many per day?** Ten is a guess.
- **What happens on a thin day?** Fewer honest picks, or pad the set? ⛔ Padding is fabrication in a
  different costume.
- **Does an undrafted job return tomorrow,** or is a draft a one-time offer?
- **Is the full board still reachable?** Hiding it entirely is cleaner; hiding it is also a
  capability users will ask for.

### ⛔ Validation: per-user, from behaviour

The owner's judgement is no longer the reference. **But asking users to rate their own fit inherits
a known bias** — people rate generously, and a semantic layer learning from those ratings inherits
it.

**Prefer signals the user cannot flatter:**

| Signal | What it says | Cost to collect |
|---|---|---|
| **Did they draft it?** | fit, judged by action | free, already in the interaction |
| **Did they complete the application?** | real intent | free |
| **Did the employer reply?** | ⭐ the only ground truth | needs `job_applications` populated |

⛔ **`job_applications` is still empty.** Migration 095's columns exist —
`ats_score_at_apply`, `response_outcome`, `first_response_at` — and have never held a row. **That
table is the entire validation story for this model.** AF5 is what starts filling it.

Asking directly is acceptable as a cold-start supplement, never as the primary measure.

### The semantic layer

CC4 made claimed terms reach both the band and the board ranking — the user-enrichable layer now
exists. For students it needs different vocabulary: coursework, projects, clubs, teaching
assistantships. The résumé-side extractor is a **hardcoded 32-item `SKILL_HINTS` list**, and 8 of
those 32 appear nowhere on the board as an exact value. That list is wrong for this audience and is
the real gate on everything the matching work could achieve.

---

## UI direction

From the reference screenshots: dark, high contrast, serif display type at large sizes, **one thing
per screen**, generous whitespace, a single primary action.

⚠ **This is close to a client rewrite.** The current UI is a desktop-shaped tiled dock with 13 media
queries in total — the audit's words. It was built for a full board with panels; the daily draft is
a different information architecture.

Worth taking seriously: a stepped onboarding (the screenshots show 6 steps) is a much better fit for
students than the current signup, and the résumé-upload step maps onto existing parsing.

⛔ **The mobile apps inherit this.** `ANDROID.md` Phase 2c/2d specify a swipe feed and review queue
against the *board* model. Both need revisiting before they are built.

---

## Later, with its own security design

### Remote browser profiles

**Not a VM per user.** Persist an **encrypted browser profile** per user — cookies and localStorage,
tens of megabytes — and mount it into an ephemeral container per run. A worker pool, not idle VMs.

**The sign-in flow is the security design.** The user signs into the portal themselves through a
streamed remote view. **You never see the password.** A breach yields session cookies — time-limited,
revocable by the portal, scoped to one site — not reusable credentials.

**What it buys:** the gated tier (Workday, Meta, Amazon) — disproportionately the employers people
most want. And it is **the only thing that makes mobile auto-apply possible**, since there is no
extension on a phone.

**Costs, all real:**
- Datacenter IPs are the detectable shape for automated submission, and the gated portals are
  exactly the ones that check.
- Some ATS terms prohibit automated submission regardless of authorisation. **Per-platform fact —
  check which.**
- ⛔ `/api/apply/session/*` returns **410** with the replacement named, retired for precisely this.
  Reversing it is legitimate but must be a **recorded deliberate reversal**, not a feature that
  quietly arrives.

⛔ **The security design is the first task, not a follow-up:** what is stored, encrypted how, revoked
how, and what a breach exposes.

### MCP connectors

The strongest candidate is **not** generation — an LLM calling an API to call an LLM is odd. It is
the **ATS scorer**: deterministic, local, free, reproducible, and doing something an assistant
genuinely cannot do well. "Paste a job description, get a fit band plus matched and missing terms."

Same for PDF formatting and résumé parsing — deterministic work an assistant cannot do itself.

---

## Sequence

| | | |
|---|---|---|
| 1 | ✅ **P4** — extension repackage | **Done 2026-09-26** except the dashboard upload. Both red tests cleared; the suite is green |
| 2 | ✅ **Measure the student question** | **Done 2026-09-26. The answer is no.** 19 distinct student postings from 5 companies; the classifier and the discard path were both tested and cleared. `docs/STUDENT_BOARD_FINDING.md` |
| 3 | **Extract the shared scorer package** | Both products import it. Smallest piece with the widest effect |
| 4 | **Split Resume Master out** | Own service, own database, stateless. Privacy policies for both |
| 5 | **The API and its contract** | Generated-and-guarded, per the mobile contract pattern. ⛔ Never hand-written |
| 6 | **The draft UI and the daily draft** | The largest piece |
| 7 | **AF5** | Supervised applications. ⭐ Starts filling `job_applications`, which is the only validation this model has |
| 8 | **Remote browser profiles** | Security design first |

---

## Corrections this forces elsewhere

- ✅ `MIGRATION_AND_REBRAND.md` — **done 2026-09-26.** Four instructions struck in place with the
  reason attached, not deleted: the retirement, the OAuth removal, "state when the 301 becomes
  safe", and the `www` activation. ⚠ `DOMAIN_MIGRATION.md` carried the same four in its literal
  owner checklist and was corrected in the same pass — the ticklist a reader actually works
  through lived there, not here. `shared/brand.js`'s own comments were rewritten too: the single
  source described `LEGACY_HOST` as "the domain being migrated away from"
- ✅ `BRAND.md` — **done 2026-09-26.** Lowercase wordmark shipped as `WORDMARK` beside `BRAND`,
  with a guard asserting they are one name in two cases. The Resume Master carve-out is written as
  a RULE rather than an allowlist entry, because ⛔ **the entry cannot be pre-added** — the
  allowlist self-prunes, so an entry whose files do not yet exist fails immediately. It goes in the
  same commit as the first file that needs it, scoped to that directory
- `ARCHITECTURE.md` — unchanged. ⛔ It documents what exists
- `ANDROID.md` / `IOS.md` — Phase 2c/2d specify a board-model feed; revisit before building
- `docs/am1-ats-graded-corpus.json` — keep, mark **historical**, note it validates a different
  audience
