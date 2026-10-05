# Resume Master in ChatGPT (and every MCP host) — D21

**Status 10-04:** built on branch `d21-mcp-anonymous` (contract 1.3.0; 1.4.0 on `a81-a83-rm` — A81), **not deployed**. What exists:
`score_ats_fit` on `POST /mcp` with no token, once `RM_MCP_ANONYMOUS` sets its caps. Nothing else is
anonymous. See `docs/API.md` (MCP → Anonymous) and `docs/PRIVACY.md` (*Through an AI assistant*).

## What OpenAI's own docs say (read 10-04 — re-check before submitting)

| | | source |
|---|---|---|
| Connection | A plugin (formerly "app") reaches tools through an **MCP server**, Streamable HTTP, at a stable public HTTPS URL; the origin may not change between versions | [submission](https://developers.openai.com/plugins/deploy/submission), [review](https://developers.openai.com/plugins/deploy/app-review.md) |
| Auth | *"Many plugin MCP servers can operate in a read-only, anonymous mode"*; otherwise **OAuth 2.1** (protected-resource metadata, PKCE `S256`, CIMD or DCR). **No static API key.** Per tool: `noauth` and/or `oauth2` | [auth](https://developers.openai.com/plugins/build/auth) |
| Annotations | `readOnlyHint`, `destructiveHint`, `openWorldHint` on every tool, checked in review | [review](https://developers.openai.com/plugins/deploy/app-review.md) |
| Data | Restricted: PCI, PHI, government IDs, credentials. Minimum-necessary inputs; outputs without internal IDs, timestamps or secrets | [guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) |
| Privacy policy | Must state categories, purposes, recipients, retention, controls | [guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) |
| Submission | Verified individual or business identity; website, support, privacy and **terms** URLs; logo; **5 positive + 3 negative test cases** | [submission](https://developers.openai.com/plugins/deploy/submission) |
| Money | *"plugins may conduct commerce only for physical goods"* — no credits or subscriptions in the app | [guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) |
| UI (later) | MCP Apps standard: resource `text/html;profile=mcp-app`, `_meta.ui.resourceUri` — shared with Claude; `_meta.ui.csp` allowlists checked in review | [MCP apps](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) |
| Custom GPTs | No new ones from **Oct 26 2026**, stop working **Dec 11 2026**; Actions do not migrate (press reports quoting OpenAI; OpenAI's help-center FAQ answered 403 here) | [FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq) |

## Known limits a reviewer will meet

- **Years and a stated clearance are read from the résumé text; citizenship never is** (A81, scorer
  1.1.0, contract 1.4.0). With no `signalProfile` — what an assistant sends — the years come from the
  résumé's dated roles (their union, whole years rounded down) and a clearance counts when the résumé
  states it is held (a hedged line such as "eligible for" does not). `report.facts_from_text` shows what
  was read. ⛔ **Citizenship is not read** — it is sensitive and an owner decision; a citizenship
  requirement stays in `hard_constraint_misses`, and the tool description tells the assistant to word it
  as "the posting requires it; check whether you meet it" and not to ask for the status. (Until A81 none
  of the three was read and the experience line always said the years were not set.)
- **Contact details do not affect the score** — measured: the same synthetic résumé with and without
  its contact block gives byte-identical reports.
- `report.source` is a scorer version string (`local_ats_v4`) — provenance, not an identifier; noted
  in case review asks.

## Listing

**App name:** Resume Master

**Short description** (≈80 chars; confirm the dashboard's limit):
> Check how a résumé matches a job posting — matched and missing terms, no AI guessing.

**Long description:**
> Resume Master scores how well a résumé's text matches one job posting, with a deterministic ATS
> scorer: no AI model, no network call, and the same input always gives the same result. You get a
> 0–100 score and the evidence behind it — the required terms the résumé shows and the ones it
> misses, competencies, action verbs, and requirements such as a security clearance.
>
> It declines rather than guesses. If the posting or résumé carries too few scorable terms to measure
> fit, it says so and asks for the full job description, instead of inventing a number. A declined
> check is not a low score.
>
> Nothing you send is stored or logged, and no account is needed. It works on a job posting and your
> own résumé only — it does not look up or profile any person.

(Deliberately absent: credits, accounts, pricing, "bands". The site sells credits; apps may not sell
digital goods, and the listing should not point at them. The tool returns no band — `ATS_MEANING.scored`
says "what counts as a strong score is the calling product's decision — do not invent one".)

**Category:** Productivity (or "Business"/"Career" if the dashboard offers a closer one — the category
list was not in the docs read 10-04; pick in the dashboard).

**MCP server URL:** `https://resumemaster.one/mcp` — Streamable HTTP, stateless, JSON responses, POST
only (GET/DELETE answer 405). **Auth:** none (anonymous, read-only) — allowed per
https://developers.openai.com/plugins/build/auth; no static API key is involved.

---

## Tool annotations — `score_ats_fit`

Generated by `src/contract/build.js` for every MCP tool and present in the contract's `x-mcp`:

| Annotation | Value | Justification |
|---|---|---|
| `readOnlyHint` | `true` | It computes a report from its arguments and changes nothing: no write to any store, no account, no file, no session (`sessionIdGenerator: undefined`). The only state touched is the in-memory rate counter, which is not the user's data. |
| `destructiveHint` | `false` | Nothing exists for it to delete or overwrite. |
| `openWorldHint` | `false` | No network call and no model call (`src/tools/deterministic.js` imports nothing that reaches `src/model/`; `test/mcp.test.js` walks the import graph). It does not post, send, look up or contact anything outside the server. |
| `idempotentHint` | `true` | Deterministic: the same `job` + `resumeText` always give the same report. |
| `title` | "ATS fit score (deterministic)" | from `MCP_TOOLS`. |

---

## Test cases

Use a **synthetic** résumé (no real person, no contact details — the review forbids sensitive data and
the tool does not need contact details). Suggested fixture: "Backend engineer. Python, Go, PostgreSQL,
Kubernetes, AWS. Designed and built payment APIs; led migration of services to Kubernetes; reduced p99
latency 40%." Postings below are paraphrased; paste full text in the real submission.

The arguments shape for every positive case is:
```json
{ "job": { "title": "<string, required>", "company": "<string>", "description": "<full posting text>" },
  "resumeText": "<the résumé as plain text>" }
```
No other fields. The tool answers `structuredContent = { outcome, score, meaning, report }` and a text
whose first line is either "Scored N/100 against this posting. …" or the not-enough-signal meaning
plus "Reasons: …".

### Five positive cases (the tool SHOULD be called)

**P1 — basic fit check.**
- *Prompt:* "Here's my résumé and a posting for a Senior Backend Engineer at Northwind. How well do I match? [résumé] [full posting listing Python, Go, PostgreSQL, Kafka, Terraform]"
- *Call:* `score_ats_fit` with `job.title` "Senior Backend Engineer", `job.company` "Northwind", `job.description` = the posting, `resumeText` = the résumé.
- *Expected:* `outcome: "scored"`, `score` an integer 0–100. The assistant reports the number, then what matched (`tier1_matched`: e.g. Python, Go, PostgreSQL) and what is missing (`tier1_missing`: e.g. Kafka, Terraform). It does **not** call the score "good"/"strong"/"a B" — no band is returned and the tool says not to invent one.

**P2 — missing terms.**
- *Prompt:* "Which skills from this job description aren't on my résumé? [résumé] [posting]"
- *Call:* same shape.
- *Expected:* the assistant answers from `tier1_missing` and `competencies_missing`; it may mention `action_verbs_missing` but treats `action_verbs_generic` as language, not gaps. The score may be mentioned but is not the point.

**P3 — re-check after an edit (determinism).**
- *Prompt (two turns):* "Score my résumé against this posting." → then "I added Kafka and Terraform to my skills. Check again against the same posting."
- *Call:* two `score_ats_fit` calls, same `job`, the second with the edited `resumeText`.
- *Expected:* both `scored`; Kafka and Terraform move from `tier1_missing` to `tier1_matched` and the score does not go down. Re-sending the first résumé unchanged returns the identical report.

**P4 — not enough signal (the tool is right to be called; the right answer is a decline).**
- *Prompt:* "Score my résumé for this job: 'Software Engineer at Contoso — join our growing team!' [résumé]"
- *Call:* `job.title` "Software Engineer", `job.description` the one-line ad, `resumeText` the résumé.
- *Expected:* `outcome: "not_enough_signal"`, `score: null`, `report.decline_reasons` contains "Only N scorable term(s) could be extracted from this posting." (N < 4, `MIN_SCORABLE_TERMS`). The assistant says the résumé **could not be scored** and why, and asks for the full job description. It must **not** say "low score", "0", "poor fit", or give any percentage.

**P5 — hard requirement in the posting.**
- *Prompt:* "Can you check my résumé against this defense-contractor posting? It requires an active Secret clearance. [résumé without any clearance] [posting]"
- *Call:* same shape.
- *Expected:* `scored` (if the posting has ≥ 4 scorable terms); `report.hard_constraint_misses` includes "Security clearance". The assistant names it as an unmet requirement alongside the score. ⚠ Use a résumé **without** a clearance: one that states "Active Secret clearance" satisfies the requirement since A81 and the miss is not listed (`report.facts_from_text.clearance` shows it). For a citizenship requirement the miss is always listed — citizenship is never read from text (see *Known limits*).

### Three negative cases (the tool should NOT be called)

**N1 — generation.**
- *Prompt:* "Write me a cover letter for this Senior Backend Engineer job."
- *Expected:* no `score_ats_fit` call. Writing is not what the tool does (`MCP_INSTRUCTIONS`: "Résumé generation is not offered here."); the assistant writes the letter itself or declines, without invoking Resume Master.

**N2 — profiling a person.**
- *Prompt:* "Look up Jane Doe on LinkedIn and tell me if she'd be a good fit for our data-engineer opening."
- *Expected:* no call. The tool's scope is "a job posting … and the candidate's own résumé. It does not research, look up or profile any individual". There is no résumé the user provided; the tool must not be used to assess a third party.

**N3 — a general question about scores.**
- *Prompt:* "What ATS score do I need to get an interview? Is 70 good?"
- *Expected:* no call — there is no résumé or posting to score. The assistant does not cite Resume Master as defining a passing band (the tool returns none and says not to invent one).

---

## Owner-only checklist

- [ ] **Deploy** (push `resume-master` main after merging `d21-mcp-anonymous`; pushing auto-deploys).
- [ ] **Production env:** `RM_MCP_ANONYMOUS="perIpPerMinute=10,perIpPerDay=200,perDay=5000"` (or your
      numbers — all three, or the service refuses to boot). Consider `RM_FREE_LIMITS_PER_DAY` too.
      Then from outside: `initialize` to `https://resumemaster.one/mcp` with **no** Authorization header
      answers a JSON-RPC result (today: 401) and `tools/list` shows one tool.
- [ ] **Log retention:** look up how long Railway keeps this service's logs on your plan; the policy
      should state it (it does not today).
- [ ] **Identity verification** in the OpenAI Platform; the policy should name the same operator (it
      names none today, and its contact is `privacy@jobsviadraft.com`, another product's domain).
- [ ] **Support URL / contact** on resumemaster.one — none exists.
- [ ] **Terms URL** — ⛔ resumemaster.one has **no terms page**. Owner/legal to write and publish one.
- [ ] **Privacy URL** `https://resumemaster.one/privacy.html` — ⚠ JavaScript-rendered ("Loading…"
      until a fetch completes); a no-JS reviewer sees nothing. Fix before submitting.
- [ ] **Logo** at the size the dashboard asks (only `public/favicon.svg` exists).
- [ ] **Test cases:** paste P1–P5 and N1–N3 with synthetic fixtures; run each in ChatGPT developer mode
      against production first.
- [ ] **No monetisation in the app:** the listing and tool output never mention credits or paid tools.
