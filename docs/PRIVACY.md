# Resume Master — privacy

**Effective:** September 28, 2026

Resume Master is a stateless résumé-processing service. It **processes what it is sent and returns
the result. It does not retain it.**

## What it receives

Only what a calling client sends in a request, and only for the endpoint called:

| Endpoint | Personal data in the request |
|---|---|
| `POST /v1/resumes/generate` | a base résumé; the candidate details the résumé draws on (name, phone, email, profile links, location, stated years of experience); a job profile (title, seniority, keywords, tools, verbs); any skills the candidate has claimed; the job description |
| `POST /v1/resumes/enhance` | a résumé, and the job profile's name, role family and domain |
| `POST /v1/resumes/parse-pdf` | a résumé PDF |
| `POST /v1/resumes/format` | a résumé as HTML |
| `POST /v1/ats/score` | a résumé's text and a job posting |

A résumé routinely contains a home address, a phone number and an employment history. It is treated
that way.

## What it keeps — nothing

- **No database.** There is no store of any kind. Requests are processed in memory and the result is
  returned.
- **No content is logged.** Each request produces one log line: method, path, status, duration and
  the calling client's id. Each model-backed request produces one metering line: the client, the
  route, and token counts. Never a request body, a prompt, a résumé, a generated document or a model
  response — enforced by `test/http.test.js`, which sends sentinel PII down every path (success,
  refusal, upstream failure, malformed JSON, an oversized body) and fails if any appears in a log
  line, and by `test/stateless.test.js`.
- **The calling client receives usage records** — token counts per model call — so it can meter its
  own spend. Counts, never content.

## Who it is shared with

| Recipient | What | Why |
|---|---|---|
| **Anthropic** | the prompt for a model-backed request, which contains the material above | the model step of generation, enhancement and PDF reading. Anthropic does not use API inputs to train models |
| **Railway** | hosting — the running service handles every request | infrastructure |

Nothing else. The ATS scorer and the formatter run locally with no network call.

## Who its clients are

Resume Master is called by other products, each with its own service token. A client — including
**draft** (`jobsviadraft.com`), a separate product run by the same operator — is responsible for
telling its own users that their data is sent here, and draft's privacy policy does so. Resume
Master has no end users of its own and no accounts.

## Contact

privacy@jobsviadraft.com
