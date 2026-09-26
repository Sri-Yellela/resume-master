# The Board Cannot Serve Students — measurement and decision

**Measured 2026-09-25** against the live board, `experience_level` on active postings.

```
mid        1285
senior      674
lead        616
entry        51
intern       29
executive     8
           ────
           2663
```

**Student-relevant (entry + intern) = 80 of 2663 = 3.0%.**
**Mid, senior and lead = 2575 = 96.7%.**

---

## What this means

`AUDIT_AND_REPLAN.md` Phase 1 item 2 set the test in advance: *"If the answer is small, the scoring
reinvention is premature and ingestion is the thing to change first."*

The answer is small.

**80 postings is not a product.** The board is a global pool shared by every user, so those 80 serve
*all* students, not 80 per student. A daily draft of ten exhausts the entire relevant board in
eight days — for one user. There is nothing to select from.

⛔ **The scoring reinvention for students is premature.** Inverting the seniority guard, rebuilding
the résumé-side extractor for coursework and projects, and drawing a new graded reference set would
all be work aimed at 3% of a board. None of it should start.

**What is NOT blocked:** P4, the `MIGRATION_AND_REBRAND.md` corrections, the Resume Master split,
the shared scorer package, the generated API contract, and AF5. None depends on the audience.

---

## ✅ RESOLVED 2026-09-26 — the measurement ran, and it does not invalidate this

**The follow-up below was carried out. All three of its candidate causes were tested and the
finding stands — if anything it is stronger than when it was written.** Jump to
§ *The follow-up measurement, carried out* for the numbers; the original framing is kept beneath it
because the way the question was posed is what made it answerable.

---

## ⛔ Before concluding, one measurement could invalidate this

**29 interns out of 2663 is low even for a senior-tuned board.** The configured companies —
OpenAI, Stripe, Figma, Airbnb, Notion and the rest — run large, well-publicised internship and
new-grad programmes. Twenty-nine total is not what those companies post.

So one of three things is true, and they have completely different fixes:

| | Cause | Fix |
|---|---|---|
| **A** | The sources genuinely do not carry them — separate boards, separate ATS tenants, seasonal posting windows | Ingestion: new sources |
| **B** | ⭐ The **classifier is mislabelling them** — an intern posting read as `entry` or `mid` | Classification, and the 80 is wrong |
| **C** | They are **discarded before the board** — greenhouse drops ~28% of postings as unclassifiable, ashby 31%, workable 74%, recruitee 75% | The discard path, already the largest unexamined number in the system |

**Distinguish them with a title-pattern count, independent of `experience_level`:**

```sql
SELECT COUNT(*) FROM scraped_jobs
WHERE is_active = 1
  AND (LOWER(title) LIKE '%intern%'
    OR LOWER(title) LIKE '%new grad%'
    OR LOWER(title) LIKE '%new-grad%'
    OR LOWER(title) LIKE '%university%'
    OR LOWER(title) LIKE '%campus%'
    OR LOWER(title) LIKE '%graduate%'
    OR LOWER(title) LIKE '%entry level%'
    OR LOWER(title) LIKE '%apprentice%'
    OR LOWER(title) LIKE '%co-op%');
```

⚠ `%intern%` also matches "internal" and "international" — inspect the titles, do not trust the
count alone.

**If that number is materially higher than 80, the classifier is the defect and the board is better
than it looks.** That is a far cheaper fix than changing ingestion, and it would change this
document's conclusion.

Also worth measuring: the same breakdown **per source**, and whether the discard rate differs for
student-shaped titles. If greenhouse is dropping 28% and those drops skew junior, cause C is live.

---

## The follow-up measurement, carried out — 2026-09-26

**Measured against the local board copy: 2,460 active rows.** The original figures above are
production's, at 2,663 active. ⚠ Production reads were not available in this session, so these are
the local board, which is 92% of production's size and the same shape — mid/senior/lead 2,401 of
2,460 (97.6%) against production's 96.7%, entry+intern 56 (2.28%) against production's 80 (3.0%).
Every conclusion below turns on ratios an order of magnitude apart, so the 8% size gap does not
reach any of them; **re-run it against production before quoting an exact number.**

### 1 · The title-pattern query — the count is LOWER than 80, not higher

The doc's nine-pattern query, run verbatim: **44 rows.** Inspecting the titles rather than trusting
the count, as warned — **12 are the predicted false positives** and every one of them is
`internal`/`international`:

```
Software Engineer, Internal Applications - Enterprise  — OpenAI        Software Engineer, International — Ramp
Software Engineer, Internal Systems — Stripe                           Product Manager | International — Ramp
Internal Product Engineer, Developer Productivity AI — Stripe          Financial Partnerships Manager, International — Ramp
Internal Auditor - APAC Regulatory & Financial Operations — Stripe     Applied AI Engineer, Government, International — OpenAI
Product Designer, Internal Tools — Stripe                              Staff Experience Designer, International — Airbnb
Warehouse and Logistics Manager - International — Anthropic            Product Designer, International Growth (Tinder Seoul) — Match Group
```

**32 real matches.** Because a null result from the doc's nine patterns alone would not be enough to
clear the classifier — the list misses the vocabulary Notion actually uses — the sweep was widened
to nine word-boundary families (`internship`, `new grad`, `early career`, `co-op`, `apprentice /
trainee / residency`, `campus / university / student / PhD`, `entry level`, `junior / Jr / associate
engineer`, `fellowship`). That finds **36**, of which 33 are student-shaped and 3 are
`University Recruiter` — a job recruiting students, not a job for one.

```
internship     17      co-op          0      entry level    0
new grad       12      apprentice     0      junior         0
early career    4      campus/uni     3      fellowship     0
```

⛔ **36 is not materially higher than 80. It is materially LOWER.** The classifier is not the
defect, and the board is not better than it looks. **Cause B is dead.**

**And 33 rows is itself an overcount of opportunity.** Only **19 are distinct `(company, title)`** —
`Software Engineer, New Grad — Stripe` is six separate active rows, `Software Engineer, Intern —
Stripe` is four, `Software Engineering Intern (Summer 2027) — Scale AI` is three. Five companies
carry all of it: Stripe 15, Notion 7, Scale AI 6, Duolingo 3, Vercel 2. **Nineteen distinct student
postings, from five companies.**

### 2 · The classifier is right about them, in both directions

| student-shaped title → classified as | |
|---|---|
| `intern` | 17 |
| `entry` | 11 |
| `mid` | 3 — all three are `University Recruiter`, correctly |
| `lead` | 1 — `Product Manager: New Grad Accelerator` (Stripe) |

**One genuine misclassification in the whole board.** Going the other way, of the 56 rows labelled
`entry`/`intern`, 28 match a student-shaped title and the other 28 are `Business Development
Representative`, `Sales Development Representative`, `Commercial Solutions Consultant` and
`Software Engineer, Early Career` — junior roles that simply do not say "student" in the title. The
label is doing real work that the title pattern cannot see. **Union of the two: 60 of 2,460 = 2.4%.**

### 3 · The discard path — measured live, and it does NOT skew junior

A write-free replay of the crawl: the real fetch against the real ATS hosts with the real configured
company list, the same `classifyJob` call, and nothing done with the verdict but counted. **No
upsert, no watermark, no reject row.**

```
source       fetched   kept  dropped  ejected  dropShare   doc's figure
greenhouse      2337   1680      657        0     0.281       ~0.28  ✓
lever            189    130       59        0     0.312       ~0.28
ashby           1145    793      352        0     0.307       ~0.31  ✓
workable          23      7       14        2     0.609       ~0.74
recruitee         11      4        7        0     0.636       ~0.75
                                ─────
                                 1089 dropped per crawl
```

The two small sources come in below their recorded figure, but at n=23 and n=11 that is noise, not
movement. The three that matter reproduce.

**Of 1,089 dropped postings, 12 carry student vocabulary — 1.10%.** Here is the entire population,
the first time it has been looked at:

```
[greenhouse] Operations Associate, New Grad (Mexico)          — Stripe
[greenhouse] Tech Operations Associate, New Grad (Mexico)     — Stripe
[greenhouse] University Recruiting Manager                    — Stripe
[greenhouse] Brand Design Intern (Summer 2027)                — Figma
[greenhouse] Data Science Intern (2027)                       — Figma
[greenhouse] PhD Intern, Data Science (2027)                  — Figma
[greenhouse] Product Design Intern (2027)                     — Figma
[lever]      CoLM 2026 — Intern                               — Spotify
[lever]      RecSys 2026 — Intern                             — Spotify
[ashby]      Head of Early Career Recruiting                  — Notion
[ashby]      Data Science Intern (Winter 2027)                — Notion
[ashby]      University Grad | Customer Experience Associate  — Ramp
```

The drop skews **senior**, hard and consistently: **67.9% of greenhouse's drop, 67.8% of lever's and
67.9% of ashby's** carry senior vocabulary (`senior`, `staff`, `principal`, `director`, `head of`,
`VP`, `manager`). Reading the titles says the same thing more plainly — the discard is finance,
sales, legal, comms, marketing, ops and support: `Accounts Receivable Manager`, `Capital Markets,
FX Specialist`, `Director, Indirect Tax`, `Chief of Staff, Sales`, `Warehouse Staff Night Shift`.
**⛔ Cause C is dead. The discard is a role-taxonomy refusal working as designed on a
software-engineering board.**

**That is also exactly why the 12 are refused.** Re-classifying each one by hand:

```
roleKey=NULL  seniority=intern   Brand Design Intern (Summer 2027)
roleKey=NULL  seniority=intern   Data Science Intern (2027)
roleKey=NULL  seniority=intern   PhD Intern, Data Science (2027)
roleKey=NULL  seniority=entry    Operations Associate, New Grad (Mexico)
   …control:
roleKey=engineering  conf=0.845  seniority=intern  Software Engineering Intern (Summer 2027)
roleKey=engineering  conf=0.845  seniority=entry   Software Engineer, New Grad
```

**The classifier reads the seniority correctly on every one of the 12 and refuses them on role.**
They are design, data-science, ops and recruiting internships, refused for the same reason the
`Director, Indirect Tax` beside them is. Admitting all 12 would take the board from 33 student-shaped
rows to 45, or 1.8% — and nine of the twelve would not be software-engineering postings anyway.

### 4 · Verdict

**Cause A.** The sources genuinely do not carry student-relevant software-engineering postings at
volume — nineteen distinct postings from five companies. Not a classifier bug, not a discard bug.

**⛔ The finding stands unchanged, and the cheap fix does not exist.** The scoring reinvention stays
premature, and the thing to change is still ingestion — specifically the *company list*, since even
Figma, Airbnb, Anthropic, Brex, Mercury, Linear, OpenAI and Wealthfront contribute **zero** distinct
student postings between them.

**The one defect worth fixing, and it is one row:** `Product Manager: New Grad Accelerator` (Stripe)
is classified `lead`. Not worth a project.

---

## The decision, and only the owner can make it

**1 · Is the student pivot still right?**

The board is an experienced-engineer board. Everything measured — ρ = 0.746, the band cutpoints, the
seniority guard, the graded corpus — was built for that audience and works for it.

Three options:

| | | Cost |
|---|---|---|
| **Keep the current audience** | Nothing is wasted. Everything built continues to apply | None |
| **Change ingestion to serve students** | New sources: university job boards, Handshake-shaped aggregators, companies with large campus programmes. The seven ATS sources stay; the *company list* changes | Real — and it is an ingestion project, not a scoring one |
| **Serve both, segmented** | The daily draft is per-profile anyway. A student profile and a senior profile draw from one pool with different filters | Middling. Needs the board to carry both, so it still needs option 2's ingestion work |

**2 · If students, what changes first?**

⛔ **Ingestion, not scoring.** There is no point scoring 80 postings well. The order is: source the
postings → confirm the board carries them → *then* rebuild the guard, the extractor and the
reference set.

---

## What stays true either way

- **The seniority guard is needed in BOTH directions.** A senior posting shown to a student needs
  demoting exactly as much as an intern posting shown to a senior engineer did. It becomes
  profile-relative rather than deleted, whichever audience wins.
- **`docs/am1-ats-graded-corpus.json` stays.** Irreplaceable — the original postings were destroyed
  in the id-85 deletion. Mark it historical only if the audience changes.
- **`job_applications` is still the validation story.** Per-user behavioural signals do not depend
  on which audience is served.
- ⚠ **`ats_term_weights` go stale around 2026-10-13**, after which scoring silently reverts to
  unweighted with a `console.warn`. Days away, and independent of every decision here.
