# Resume Master

Stateless résumé tools — generation, deterministic formatting, PDF text extraction and ATS scoring —
served as an HTTP API on `resumemaster.one`. **No database; nothing a caller sends is retained.**
The API and its promises are in [`docs/API.md`](docs/API.md).

Resume Master is a separate product from draft (`jobsviadraft.com`). draft calls this API as a
third-party client would, with its own service token, and keeps its own users, database and
deployment. The two share one package, `@draft/ats-scorer`, vendored here.

```
npm install
npm test          # the whole suite; no network, no model, no key needed
npm start         # PORT (default 3100); ANTHROPIC_API_KEY optional
```

## Layout

| | |
|---|---|
| `src/generation/` | the generation kernel, prompt assembly, runtime inputs, domain resolution, classifier, A+ enhancement |
| `src/integrity/resumeClaimGuard.js` | ⛔ the claim guard — every generated document passes it before it is returned |
| `src/formatting/` | the deterministic HTML renderer, and the optional LLM pass's prompt built from its stylesheet |
| `src/parsing/` | PDF → text |
| `src/model/anthropicCall.js` | the one model path: returns usage records, logs no content, knows what is retryable |
| `src/http/app.js` | routes; every answer is JSON, including 404 |
| `src/http/auth.js`, `metering.js` | per-client service tokens (hash-only storage) and per-client accounting, limits off |
| `scripts/mintClientToken.mjs` | mint a client token |
| `prompts/` | the three prompt layers |
| `vendor/ats-scorer/` | `@draft/ats-scorer`, vendored |

## ⛔ The vendored scorer is not edited here

`vendor/ats-scorer` is a copy of `draft/packages/ats-scorer`. Its own test re-hashes every file
against its `CHECKSUMS.json` (LF-normalised), so a hand-edit here fails `npm test`. Change it in
draft, run `npm run checksums` there, and copy the directory across.

## Provenance

Moved from draft on 2026-09-27 (Phase A2). The formatter, claim guard, prompt assembler, prompts and
their tests were copied byte-for-byte from draft at `85570d4`; the kernel, runtime inputs, model
path and HTTP layer were re-written from draft's `server.js` and `services/modelCall.js` without
their database. The generation prompt's runtime-inputs text was verified byte-identical to draft's
over 324 cases.
