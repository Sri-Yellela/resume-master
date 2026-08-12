# TASK A5 — NOT STARTED. Preflight says NO-GO.

A5 submits a real application to a real employer under a real candidate's name, and a submission
cannot be recalled. Its preconditions turned out to be checkable, so they are now checked by
`scripts/a5Preflight.mjs` rather than by eye. **Two of them fail.** No application was attempted, no
browser was opened, nothing was sent.

## The two blockers

**1. The only apply-ready account is a test fixture.**

```
user 10  READY    FE4 Smoke   fe4smoke_fixed@example.com   resume=198 chars
user  1..5  BLOCKED — no base resume and/or no active profile
```

A5 states it submits "under a real candidate's name". `FE4 Smoke <fe4smoke_fixed@example.com>` is a
smoke-test fixture. Sending that to Figma would be a junk application against a real company, and it
would not be a test of anything either — the point of A5 is to see whether the resolver fills a real
form correctly for a real person.

**2. The base resume is 198 characters.**

A5's own precondition is *"PDF generation confirmed working end to end — the resume is the payload."*
The mechanism works (A4 produced a valid 29,728-byte PDF), but there is no payload: 198 characters is
placeholder text, not a resume. This would submit a stub.

## Everything else passes

```
GO  target: Figma — Forward Deployed Engineer
GO  target detects as greenhouse
GO  apply_url is a greenhouse application page  (boards.greenhouse.io/figma/jobs/6110219004)
GO  no prior attempt on this job
GO  no run in flight
GO  full-auto kill switch state is irrelevant — A5 is semi by design
```

## Two facts that change how A5 should be read

**The greenhouse pool is 110 rows, all Figma.** A5 says "651 of 684 active rows are greenhouse" — that
figure is stale. The current board is 643 rows: 110 greenhouse (Figma only), 26 ashby, 507 generic.
So "pick ONE greenhouse job the candidate genuinely wants" has a one-company menu, and of the 33
engineering-ish titles most are *Manager, Software Engineering* rather than IC roles. Whether anything
here is a role worth applying to on its own merits is the candidate's call, and it may be *no*.

**A5 is a production activity, not a local one.** The real candidate's profile and resume live in the
deployed app; this dev database contains only fixtures. Running A5 locally would first require seeding
a real profile and resume here — which means putting a real person's resume into a dev DB — or running
it against production, where I have no access (established earlier this session: the prod DB is on a
Railway volume and the only read path is an admin endpoint behind credentials I was refused).

## What the preflight checks

Read-only — opens no browser, sends nothing, uses a `readonly` DB handle so it cannot alter what it
inspects.

| check | why |
|---|---|
| account is apply-ready | the same `getMissingApplyPrerequisites` gate the run would hit |
| identity is not a fixture | `test/smoke/fixture/demo` in the name or an `@example.com` address |
| base resume ≥ ~1200 chars | the resume is the payload; a stub resume is a stub application |
| target detects as greenhouse | A5 scopes to greenhouse |
| `apply_url` is a real greenhouse application page | aggregator links often resolve to redirects, not fillable forms |
| no prior/in-flight attempt on this job | a duplicate application is worse than none |
| no run already in flight | the concurrency guard would refuse anyway |

And it prints what it cannot check, for confirmation by hand: that a human is present and will read
every field before clicking submit; that the candidate actually wants the role; that a visible browser
can open here; and that the suite and trap matrix are green.

## What I did not do, and why

I did not pick a posting, and I did not run anything against a real employer. A5 step 1 is explicitly
a judgement only the candidate can make, and step 2 requires a human at a visible browser who clicks
submit themselves. Choosing a Figma role on their behalf and submitting under a fixture name is the
one action in this whole series that cannot be undone.

## To unblock

1. Decide **where** A5 runs — production (where the real candidate exists) or locally with a real
   profile and resume seeded.
2. Populate a real base resume for that account, so there is a payload.
3. Name the posting the candidate genuinely wants.
4. Be at the machine, in semi mode, for the field-by-field review.

Re-run `node scripts/a5Preflight.mjs --user <id> --job <job_id>` until it reports PREFLIGHT CLEAR.
`--list` shows apply-ready accounts and the greenhouse pool.
