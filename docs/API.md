# Resume Master API — v1

Stateless résumé tools: generation, deterministic formatting, PDF text extraction, ATS scoring.
**No database. Nothing a caller sends is stored.** Every response is JSON, including errors and
"not found".

> ⚠ The request/response schema will be **generated** from the implementation in A3, with an
> envelope harness that checks declared shapes against real responses; where the generated
> contract and this prose disagree, the contract wins and this file is corrected.

---

## Authentication — one service token per client

Every `/v1` route except `/v1/version` requires `Authorization: Bearer rmk_<clientId>.<secret>`.
`/health` is open. A missing, malformed, unknown or revoked token is `401 unauthenticated`, and it
is checked **before** the body is parsed.

- **Every caller is a third party**, draft included: no shared cookie, no shared session secret, no
  shared environment. That is what keeps two products two products, and what makes draft's traffic
  a real test of the API.
- **The service stores only `sha256(token)`**, in `RESUME_MASTER_CLIENT_TOKENS`
  (`draft:<sha256hex>,acme:<sha256hex>`). A leaked environment yields no usable token.
- **Mint:** `node scripts/mintClientToken.mjs <clientId>` prints the token once (it goes into the
  caller's environment — draft: `RESUME_MASTER_TOKEN`) and the entry to append here.
- **Revoke:** delete the client's entry and restart. **Rotate:** add the new entry beside the old one
  (a client may hold several), move the caller, delete the old one — no window without a valid token.
- **No clients configured fails closed** (`503 auth_unconfigured`), and a malformed entry refuses
  to boot rather than silently dropping a client.

## Per-client accounting — built, limits OFF

Each model-backed request emits one metering line: `{ metering, client, route, calls, failed_calls,
input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` — counts, never
content. Failed calls are metered too; they can still have spent. With no database, that log line
is the ledger, and the caller also receives the per-call usage records in the response.

A limit hook runs on every model route **before any spend**. It allows everything: limits are off by
decision. Enabling them means giving the hook a policy; no call site changes. A refusal will be
`429 limit_exceeded`.

---

## ⛔ What this service promises — contractual, not implementation detail

These were internal protections in draft. Offered as an API they are promises to every caller and
to every candidate whose résumé passes through.

### 1. Processes, does not retain

- A request is processed and answered. **No request body, prompt, résumé, generated document or
  model response is written to disk, to a database, or to a log.** There is no database.
- The only thing logged per request is: method, path, status, duration, calling client. On an
  error, the error's code and name — never its message, which can echo upstream text.
- What the caller receives besides the result is a **usage record** per model call: purpose,
  model, token counts, cache token counts, duration, success. Counts, never content. The caller
  meters and prices these; this service keeps no ledger.
- Candidate data goes to exactly one model provider, Anthropic, and to nothing else.

*Enforced by:* `test/http.test.js` (sentinel PII sent down every path — success, refusal,
upstream failure, malformed JSON, oversized body — must appear in no log line) and
`test/stateless.test.js` (no storage dependency; no runtime code writes to disk or logs content).

### 2. A generated résumé never claims more than the candidate's profile states

Every document from `/v1/resumes/generate` passes the claim guard **before** it is returned:

- **Years.** The document may not claim more years of experience than
  `candidate.yearsOfExperience`, anywhere in the document — and the summary may not claim *fewer*.
  A job description may steer emphasis; it never sets a quantity.
- **Seniority.** The document may not assert a level above the higher of
  `profile.seniority` (the candidate's own declaration) and what the base résumé evidences.
  A JD asking for "Senior" does not make the candidate senior.
- **A violation withholds the document.** The response is `422 resume_claim_violation` with the
  violations; the document is not in it. There is no option to skip the check.
- **"No violation" always means "was read".** If the guard is handed no document text it refuses
  (`502 resume_claim_not_inspected`) rather than passing an unread document.

### 3. Flag, don't fabricate

The generation prompt (`prompts/layer1_global_rules.md`, §7 truthfulness) instructs the model never
to invent employers, projects, durations, metrics, credentials, clearances or seniority, and never
to "correct" an implausible base-résumé claim into a plausible one. Candidate-supplied `claims`
may change which skills and verbs a bullet names where the base résumé supports the work — they are
never a title, a level or a headline. The claim guard (promise 2) is the enforced floor under it.

*Enforced by:* `test/resumeClaimGuard.test.js` (behaviour and the prompt rules themselves),
`test/generate.test.js` (the kernel withholds, cannot be told to skip, refuses an unread document).

### 4. A failure says whether retrying can help

Every model-backed error carries `retryable`. An exhausted balance, a bad key or a permission
error is `retryable: false, permanent: true` — "please try again" for a billing failure is a
message that can never be true. A 429 is always retryable.

---

## Endpoints

| | | model call | cost |
|---|---|---|---|
| `GET /health` | `{ ok, service }` | no | free |
| `GET /v1/version` | `{ service: "resume-master", version, commit, scorer, llmFormat }` | no | free |
| `POST /v1/resumes/format` | `{ html }` → `{ html }` — the deterministic renderer | no | free |
| `POST /v1/ats/score` | `{ job, resumeText, signalProfile?, domainProfile?, claims?, termWeights?, synonyms? }` → `{ report }` | no | free |
| `POST /v1/resumes/generate` | see below → `{ html, domainModuleKey, claimCheck, usage[] }` | yes | metered |
| `POST /v1/resumes/enhance` | `{ resumeText, profile: { name, roleFamily, domain }, selectedAdditions[] }` → `{ text, usage[] }` | yes | metered |
| `POST /v1/resumes/parse-pdf` | `{ pdfBase64 }` (≤ 10 MB) → `{ text, chars, usage[] }` | yes | metered |

### `POST /v1/resumes/generate`

```json
{
  "mode": "GENERATE | A_PLUS",
  "domainModuleKey": "engineering",        // optional — else roleFamily/domain, else classified
  "roleFamily": "pm", "domain": "construction",
  "candidate": { "fullName": "", "phone": "", "email": "", "linkedinUrl": "", "githubUrl": "",
                 "location": "City, ST", "yearsOfExperience": 4 },
  "profile":   { "name": "", "seniority": "junior | mid | senior | executive",
                 "keywords": [], "tools": [], "actionVerbs": [] },
  "claims":    { "skills": [], "actionVerbs": [] },
  "employers": ["Employer 1", "Employer 2"],
  "job":       { "title": "", "company": "", "category": "", "description": "", "stack": "" },
  "baseResumeText": "…",
  "options":   { "includeSummary": false }
}
```

`candidate.yearsOfExperience` and `profile.seniority` are **the authority** the claim guard
enforces. Omitting them does not disable the guard; it falls back to what the base résumé states.

### ATS scoring

The same `@draft/ats-scorer` package draft uses, vendored with a checksum manifest. Deterministic,
no model call. JSON has no Map, so `termWeights` and `synonyms` are **arrays of `[key, value]`
pairs**; any other shape is a 400, never a silent unweighted score. The report carries **no band**:
bands are each product's presentation decision, calibrated against its own users.

### Errors

| status | `error` | `retryable` |
|---|---|---|
| 400 | `invalid_request`, `invalid_json` | — |
| 401 | `unauthenticated` | false |
| 429 | `limit_exceeded` (limits are currently off) | true |
| 503 | `auth_unconfigured` | false |
| 404 | `not_found` | — |
| 413 | `payload_too_large` | — |
| 422 | `resume_claim_violation` (+ `violations`, no document) | true — generation is stochastic |
| 502 | `upstream_model_failure` (+ `permanent`) | `!permanent` |
| 502 | `resume_claim_not_inspected` | true |
| 503 | `model_unconfigured` | false |

Model-backed errors include `usage` for whatever was spent before the failure.

---

## Operator levers

| env | default | |
|---|---|---|
| `RESUME_MASTER_CLIENT_TOKENS` | unset | `clientId:sha256hex,…` — unset fails closed (503 `auth_unconfigured`) |
| `ANTHROPIC_API_KEY` | unset | unset is supported: deterministic routes serve, model routes answer 503 |
| `RESUME_MASTER_LLM_FORMAT` | off | `1` adds a Haiku reformatting pass, instructed with the renderer's own stylesheet |
| `PORT` | 3100 | |

Prompt caching: the static system layers carry the breakpoints and every per-request value is in
the user message after them — verified correct against the API's placement rules at the move. The
prefix is written once per 5-minute window and read by any request inside it; a burst of
generations reads it, a lone one does not. Pre-warming is deliberately not built yet.
