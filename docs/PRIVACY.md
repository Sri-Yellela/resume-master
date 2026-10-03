# Resume Master — privacy

**Effective:** October 2, 2026 (was September 28, 2026)

Resume Master **processes what it is sent and returns the result.** Called through its API by another
product, it retains nothing. **Since October 2, 2026 it also has its own site, `resumemaster.one`,
where a person can make an account** — and an account is the one place anything is kept, and only
what that person asks to keep. Both are described below.

## What it receives

Only what a calling client sends in a request, and only for the endpoint called:

| Endpoint | Personal data in the request |
|---|---|
| `POST /v1/resumes/generate` | a base résumé; the candidate details the résumé draws on (name, phone, email, profile links, location, stated years of experience); a job profile (title, seniority, keywords, tools, verbs); any skills the candidate has claimed; the job description |
| `POST /v1/resumes/enhance` | a résumé, and the job profile's name, role family and domain |
| `POST /v1/resumes/parse-pdf` | a résumé PDF |
| `POST /v1/resumes/format` | a résumé as HTML |
| `POST /v1/ats/score` | a résumé's text and a job posting |
| `POST /mcp` | the same as the HTTP route behind the tool called: `score_ats_fit` as `/v1/ats/score`, `format_resume_print_html` as `/v1/resumes/format`. Stateless — no session is created |

A résumé routinely contains a home address, a phone number and an employment history. It is treated
that way.

## What it keeps — nothing

- **No database.** There is no store of any kind. Requests are processed in memory and the result is
  returned.
- **No content is logged.** Each request produces one log line: method, path, status, duration and
  the calling client's id. Each model-backed request, and each MCP tool call, produces one metering
  line: the client, the route, and token counts. Never a request body, a prompt, a résumé, a generated document or a model
  response — enforced by `test/http.test.js`, which sends sentinel PII down every path (success,
  refusal, upstream failure, malformed JSON, an oversized body) and fails if any appears in a log
  line, and by `test/stateless.test.js`.
- **The calling client receives usage records** — token counts per model call — so it can meter its
  own spend. Counts, never content.

## What an account keeps — and only if you make one

Using the free tools on the site (ATS scoring, formatting) needs no account and keeps nothing.

| What | Why | How long | How it goes |
|---|---|---|---|
| Your email address and a password hash (scrypt — the password itself is never stored) | to sign you in | until you delete the account | **Delete account** removes it at once |
| A session record — only a hash of the cookie's value | to keep you signed in | 30 days, or until you sign out | signing out, or a password reset, ends it |
| Your credit ledger — grants, and for each tool you used: which tool, when, and how many model tokens it took | credits are granted free each month; the ledger is how a balance is kept honest | until you delete the account | deleted with the account |
| **Documents you choose to save** — the OUTPUT of a tool (a generated or formatted résumé, text read from a PDF, an ATS report), and only when you tick "Save to my account" for that run | so you can come back to it | **90 days**, then deleted automatically — or sooner, when you delete it. A document you **pin** is kept until you unpin it (its 90 days then start again) or delete it; up to 20 can be pinned | **Delete** on the document removes it; the store zeroes the freed space |
| A one-time password-reset token (a hash of it) | to reset a forgotten password | 30 minutes, used once | expires |

**The PDF tools (merge, split, compress, protect, unlock, images, text) send nothing at all.** They run in your browser; your file is never uploaded to this service or anyone else (since 10-02).

**Never kept, account or not:** the résumé, job description or PDF you send in. A document is kept
only as the result, only when you ask, per document.

**Your access:** *Export* downloads everything held for your account as JSON. *Delete account*
removes the account, its sessions, its ledger and every saved document.

⚠ A résumé can contain a home address, a phone number and sometimes sensitive details (veteran or
disability status). If you save one, it is kept as above. Do not save a document you do not want
held for up to 90 days — or, if you pin it, until you unpin it.

**Backups.** So that an account and its credits survive a failed disk, the whole store is copied
once a day to a backup on the same private volume. Backups are rotated, not kept forever: the
newest are kept within a fixed share of the volume (at most 30 copies), and older ones are deleted.
⚠ This means a document or an account you delete is gone from the live store at once, but **can
remain inside a backup copy until that copy rotates out**. Backups are never shared, never read
except to restore the service after a failure, and a restore is a deliberate act by the operator.

## Who it is shared with

| Recipient | What | Why |
|---|---|---|
| **Anthropic** | the prompt for a model-backed request, which contains the material above | the model step of generation and enhancement — nothing else (D17, 10-03). **PDF → text sends nothing to Anthropic**, on the site (since 10-02) or through the token API (since 10-03, contract 1.2.0) — it reads the text the PDF already carries, here, with no model. Anthropic does not use API inputs to train models |
| **Railway** | hosting — the running service handles every request | infrastructure |

Nothing else. The ATS scorer and the formatter run locally with no network call.

## Who its clients are

Resume Master is called by other products, each with its own service token. A client — including
**draft** (`jobsviadraft.com`), a separate product run by the same operator — is responsible for
telling its own users that their data is sent here, and draft's privacy policy does so. Resume
Master's own users are the people who make an account on its site (above).

## Contact

privacy@jobsviadraft.com
