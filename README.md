# Draft

A job-application system for one candidate at a time. It crawls applicant-tracking systems
directly, reconciles postings into a single board, enriches and scores them against a stored
profile, and then either fills an application form or hands the filled form to the candidate in
their own browser to review and submit. A published Chrome extension captures postings from any
job page and fills applications behind login gates the server cannot cross.

**The candidate reviews and submits.** The system does not submit on their behalf without a gate.

> **New here? Read [`HANDOFF.md`](HANDOFF.md) first.** It is the orientation doc and it is blunt
> about what works versus what merely exists. This file only tells you how to run the thing.

## Running it

Requires **Node ≥ 20**. Dependencies are committed against `better-sqlite3`, so a native toolchain
must be available.

```bash
npm install
npm run build          # installs and builds the React client into client/dist
npm start              # serves API + client on PORT (default 3001)
```

`npm run dev` runs the same entry point under `node --watch`.

Configuration is read from `.env`; `.env.example` lists every key with a description. The ones that
actually gate behaviour:

| key | effect if missing |
|---|---|
| `ANTHROPIC_KEY` | every model-backed path fails — enrichment, import, generation |
| `SESSION_SECRET` | sessions do not survive a restart |
| `APP_BASE_URL` / `FRONTEND_URL` | credentialed CORS and OAuth callbacks break in production |
| `ADMIN_USER` / `ADMIN_PASSWORD` | no admin account is provisioned |

⛔ **The Anthropic balance is currently exhausted**, so on a fresh checkout every model-backed
feature returns 502 even with a valid key. That is expected, not a broken install.

## Testing

```bash
npm test                 # node --test — 2626 tests, 2624 pass, 2 deliberate failures
npm run verify:harness   # real-browser harnesses; REQUIRES the app already on :3001
```

Two tests in `test/extensionSubmission.test.js` **fail on purpose** — see `CLAUDE.md` before
treating a red board as a regression.

⛔ **A green node suite is not evidence about anything a browser does.** It stayed at 2606/0
through a live privilege escalation in the extension. Behaviour that involves a real browser, a
real session or a real form is verified by the harnesses in `scripts/`, not by `npm test`.

## Layout

```
server.js            the API, the auth stack, and the migration runner
routes/              route modules mounted by server.js
services/            ingestion, enrichment, scoring, the apply pipeline, model calls
shared/              code both server and client import — brand, auth policy, model providers
client/              React app (Vite)
extension/           the published Chrome extension
scripts/             one-off tools and the real-browser verification harnesses
test/                node --test suite
docs/                design notes, audits, and the corrections register
```

## Where to look

| | |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | current state, what works, what only exists |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how the system works, written from the code |
| [`CLAUDE.md`](CLAUDE.md) | repo rules — commit style, the line-ending trap, deliberate failures |
| [`docs/CORRECTIONS_REGISTER.md`](docs/CORRECTIONS_REGISTER.md) | how the docs went wrong before |

The two mobile clients live in their own repositories and keep their own documentation.
