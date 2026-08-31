# TASK A5 — NOT STARTED. Preflight says NO-GO.

> **SUPERSEDED in part — read `auto-apply-a5-live-run.md` first.** The identity blocker below is
> cleared: a real candidate (user 15) now exists and the preflight reports CLEAR for them. The
> greenhouse pool is 101 rows, not 35. Still true, and still the reason nothing has been sent: no
> posting has been chosen, and no live gate has been crossed.

A5 submits a real application to a real employer under a real candidate's name, and a submission
cannot be recalled. Its preconditions turned out to be checkable, so they are now checked by
`scripts/a5Preflight.mjs` rather than by eye. **One of them still fails.** No application has been
attempted, no browser has been opened, nothing has been sent.

Latest run: `node scripts/a5Preflight.mjs --user 14 --job greenhouse::6110219004` → exit 1.

## The remaining blocker

**The apply-ready account is a fabricated identity.**

```
STOP  the account is a FABRICATED identity, not a real candidate
      name="John Doe" email="johndoe.a5test@gmail.com"
```

A5 states it submits "under a real candidate's name". Sending `John Doe` to Figma would be a junk
application against a real company, and it would not be a test of anything either — the point of A5
is to see whether the resolver fills a real form correctly for a real person. `--allow-fixture`
exists to override this deliberately; it should not be used to reach a real employer.

## The resume blocker cleared — on length, not on substance

Previously `user 10 (FE4 Smoke)` was the only apply-ready account, with a 198-character base resume.
`scripts/a5SeedFixture.mjs` now seeds `user 14` from `data/a5-fixture/`, giving a 1,466-character
resume, and the `MIN_RESUME_CHARS` check reads GO.

**Do not read that GO as "there is a payload."** The seeded `John Doe Resume.pdf` is an unedited
sample document — `fakeemail@gmail.com`, `(111) 222-3333`, "University Near You", "Anticipated
Spring 2020" — and `data/a5-fixture/profile.json` is still the scaffold the seeder ships with, down
to its `_readme` and `_note` keys. The gate measures character count and cannot see placeholder
content, so a stub resume of sufficient length passes it. A5's precondition is *"the resume is the
payload"*; by that standard it is not met.

Both the cleared check and the remaining one trace to the same unmet precondition: **the fixture has
never been filled in with a real candidate.** They are one blocker, not two.

## The seeder was picking the wrong file

Worth recording, because it nearly reached an employer as a resume. `a5SeedFixture.mjs` accepts a
resume under its own filename and selected by extension priority (`.html`, `.txt`, `.md`, `.pdf`).
`data/a5-fixture/` also holds `cookies.txt` — a 135-byte session cookie jar written there by an
earlier curl-driven session — and `.txt` outranks `.pdf`, so the cookie jar won. The 1,200-character
floor would have stopped it, but only incidentally: the rule as written made **any** stray file in
that directory eligible to be submitted as a candidate's resume.

Fixed in `bba3cee`: a filename must contain `resume`/`cv` unless it is exactly
`resume.(txt|md|html|pdf)`, and the seeder prints what it ignored, so the selection is visible rather
than inferred.

## Everything else passes

```
GO    user 14 is apply-ready
GO    base resume is substantive — 1466 chars ("John Doe Resume.pdf")   [see the caveat above]
GO    target: Figma — Forward Deployed Engineer
GO    target detects as greenhouse
GO    apply_url is a greenhouse application page  (boards.greenhouse.io/figma/jobs/6110219004)
GO    no run in flight
GO    full-auto kill switch state is irrelevant — A5 is semi by design
WARN  this job was attempted before — status "failed"
```

The WARN is new and is not blocking: a `failed` row is not a submitted application, so the "duplicate
application" hazard does not apply. It does mean this posting has been driven before, and whatever
made that attempt fail has not been diagnosed here.

## Two facts that change how A5 should be read

**The greenhouse pool is 35 rows, all Figma.** A5 says "651 of 684 active rows are greenhouse" — that
figure is stale, and so is the 643-row board this doc previously described. `runExpiredJobsCleanup`
(`server.js:3142`) deletes anything whose `scraped_at` is older than 7 days, and on a server boot it
removed 637 of the 643 rows. The board was then refilled from real posting URLs through
`scripts/importJobUrls.mjs`, which drives the app's own `services/jobs/importJob.js`.

So "pick ONE greenhouse job the candidate genuinely wants" has a one-company menu, and of the 35
engineering-ish titles most are *Manager, Software Engineering* rather than IC roles. Whether anything
here is a role worth applying to on its own merits is the candidate's call, and it may be *no*.

**The board expires, so a target has a shelf life.** Anything imported stops being a valid A5 target
7 days after import. `POST /api/admin/db/force-scrape` — the only crawl path — needs a
`users.apify_token` that no account currently has, so refills go through `importJobUrls.mjs` until
one is configured. Re-run it before A5 rather than trusting a stale board:

```
node scripts/importJobUrls.mjs --greenhouse <slug> --match "engineer" --list   # look first
node scripts/importJobUrls.mjs --greenhouse <slug> --match "engineer"          # import
node scripts/importJobUrls.mjs <url> [<url> ...]                               # or specific postings
```

A greenhouse/lever/ashby URL costs no model credits — `importJob` refetches that company's board
through the source's own `fetchCompanyJobs` and matches the posting, which is the same structured
data a crawl would produce. Imports run with no Anthropic client, so **`runEnrichment` is skipped**
and rows carry the ATS's own fields without the derived ones (YoE, extracted skills). That does not
affect the apply path; it affects board filtering.

**A5 is a production activity, not a local one.** The real candidate's profile and resume live in the
deployed app; this dev database contains only fixtures. Running A5 locally would first require seeding
a real profile and resume here — which means putting a real person's resume into a dev DB — or running
it against production, where I have no access (established earlier: the prod DB is on a Railway volume
and the only read path is an admin endpoint behind credentials that were refused).

`a5SeedFixture.mjs` makes the local path mechanical rather than difficult — drop a real `profile.json`
and resume into the gitignored `data/a5-fixture/` and re-run it. That it is now easy does not make it
the right call; it is a decision about where a real person's resume is allowed to live, and it belongs
to the candidate.

## What the preflight checks

Read-only — opens no browser, sends nothing, uses a `readonly` DB handle so it cannot alter what it
inspects.

| check | why |
|---|---|
| account is apply-ready | the same `getMissingApplyPrerequisites` gate the run would hit |
| identity is not a fixture | `test/smoke/fixture/sample/demo/qa/john doe/jane doe` in the name or email, or an `@example`/`@test`/`@invalid`/`@localhost` address. The name match is what catches the current fixture — its address is a plausible `gmail.com` one. Overridable with `--allow-fixture` |
| base resume ≥ ~1200 chars | the resume is the payload; a stub resume is a stub application |
| target detects as greenhouse | A5 scopes to greenhouse |
| `apply_url` is a real greenhouse application page | aggregator links often resolve to redirects, not fillable forms |
| no prior/in-flight attempt on this job | a duplicate application is worse than none |
| no run already in flight | the concurrency guard would refuse anyway |

And it prints what it cannot check, for confirmation by hand: that a human is present and will read
every field before clicking submit; that the candidate actually wants the role; that a visible browser
can open here; and that the suite and trap matrix are green.

## What I did not do, and why

I did not pick a posting, and I have not run anything against a real employer. A5 step 1 is
explicitly a judgement only the candidate can make, and step 2 requires a human at a visible browser
who clicks submit themselves. Choosing a Figma role on their behalf and submitting under a fixture
name is the one action in this whole series that cannot be undone.

Seeding `user 14` changed the dev database only. No run was started, no browser opened, and the
preflight itself uses a `readonly` handle.

## To unblock

1. Decide **where** A5 runs — production (where the real candidate exists) or locally with a real
   profile and resume seeded into `data/a5-fixture/`.
2. Replace the placeholder `profile.json` and `John Doe Resume.pdf` with the candidate's real ones,
   so there is an actual payload — this clears the identity check and the resume check together.
3. Name the posting the candidate genuinely wants. The pool is whatever was last imported; import
   the specific posting if it is not already on the board.
4. Be at the machine, in semi mode, for the field-by-field review.

Re-run `node scripts/a5Preflight.mjs --user <id> --job <job_id>` until it reports PREFLIGHT CLEAR
(exit 0). `--list` shows apply-ready accounts and the greenhouse pool.
