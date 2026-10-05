# Resume Master — privacy

**Effective:** October 4, 2026 (was October 2, 2026)

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
| `POST /mcp` | the same as the HTTP route behind the tool called: `score_ats_fit` as `/v1/ats/score`, `format_resume_print_html` as `/v1/resumes/format`. Stateless — no session is created. `score_ats_fit` can also be called **without a token**, by an AI assistant — see *Through an AI assistant* below |

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

## Through an AI assistant (ChatGPT, Claude, and others)

Resume Master's ATS check can be used from inside an AI assistant — ChatGPT, Claude, or any other app that supports the Model Context Protocol (MCP) — at `https://resumemaster.one/mcp`. No account and no sign-in are needed for it.

**The assistant receives your text first, under its own terms.** Anything you type, paste or upload into an assistant — a résumé, a job posting — goes first to the company that runs that assistant: **OpenAI** for ChatGPT, **Anthropic** for Claude, or whoever runs the app you are using. That company handles it under its own privacy policy and your settings there, including whether your conversations are kept and whether they are used to improve its models. Resume Master is not a party to that, cannot see it, and cannot delete it. To change what the assistant keeps, use the assistant's own settings and policy.

**What Resume Master receives.** Only what the assistant sends when it calls the tool. For the ATS check (`score_ats_fit`) that is a job posting — its title, and usually the company and description — and the text of a résumé. The résumé text is whatever the assistant passes on, which is usually the whole résumé, including your name and contact details. Resume Master does not receive your conversation, your account at the assistant, or any file the assistant does not send.

**What it does with it.** It scores the résumé against the posting, here, with no AI model and no network call, and sends the result back to the assistant. That is the only use.

**What it keeps — nothing of what you sent.** The résumé and the posting are processed in memory and are not stored and not logged, exactly as for the API above. Each request leaves the same content-free lines as any other request: method, path, status and duration, with the caller recorded as `(anonymous)`; and each tool call one metering line: which tool, whether it succeeded or was refused, and token counts, which are always zero here.

**The one thing held about you: a scrambled form of your network address, for at most a day.** So that a free tool with no sign-in cannot be overrun, the service limits how often it can be called from one address. To count, it keeps a one-way, salted hash of the address — never the address itself — in memory only, next to a count. The salt is random, created when the server starts and never written down, so the hash cannot be turned back into the address or matched across restarts. Counts are kept for the current minute and the current day (UTC); nothing is written to disk, and a restart erases all of it. The address is never logged.

**Who receives it.** **Railway**, which hosts the service, as for every request. Nobody else: the ATS check calls no model, so nothing goes to Anthropic, and Resume Master sends nothing to OpenAI or to any other assistant beyond the result of the call that assistant made.

**Your controls.** You choose whether to connect Resume Master to an assistant, and you can disconnect it in that assistant's settings at any time. The score matches the skills, tools and verbs in your résumé against the posting, not your contact details, so you can leave out your address, phone number and email before you paste it. Because Resume Master keeps nothing of what you send, there is nothing to export or delete on its side; the assistant's copy is governed by the assistant.

⚠ A résumé can contain sensitive details — disability or veteran status, health, religion, or a photo. Anything you paste reaches the assistant's operator first and then, when the tool is called, this service, which uses it only to score and keeps none of it. Leave out what the score does not need.

Generation and formatting are not offered anonymously: `format_resume_print_html` needs a service token, and résumé generation is not available through an assistant at all.

## What an account keeps — and only if you make one

Using the free tools on the site (ATS scoring, formatting, PDF → text) needs no account and keeps nothing of what you send.

**The one thing the free tools hold: a scrambled form of your network address, for at most a day.** So that tools with no sign-in cannot be overrun, the site limits how often they can be used from one address — a per-minute rate for every free tool, and a daily ceiling for reading PDFs. To count, it keeps a one-way, salted hash of your network address — never the address itself — in memory only, next to a count. The salt is random, created when the server starts and never written down, so the hash cannot be turned back into the address or matched across restarts. The per-minute count is held for the current minute and the daily count for the current day (UTC); each is emptied the moment its minute or day ends. Nothing is written to disk, a restart erases all of it, and the address is never logged. (Since October 4, 2026; before that the address itself was held this way, in memory, until a periodic clear.)

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

**An AI assistant is not a recipient of ours — it is where your text starts.** When you use the ATS check from ChatGPT, Claude or another assistant, that assistant's operator receives your text before Resume Master does, under its own terms; Resume Master sends it nothing but the result of the call it made. See *Through an AI assistant* above.

## Who its clients are

Resume Master is called by other products, each with its own service token. A client — including
**draft** (`jobsviadraft.com`), a separate product run by the same operator — is responsible for
telling its own users that their data is sent here, and draft's privacy policy does so. Resume
Master's own users are the people who make an account on its site (above).
An AI assistant that calls the ATS check without a token is not a client in this sense: it acts for the person using it, and that person is covered by *Through an AI assistant* above.

## Contact

privacy@jobsviadraft.com
