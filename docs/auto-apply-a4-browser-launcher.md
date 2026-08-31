# TASK A4 — browserLauncher path resolution (gate before A5)

**The bug A4 describes is not present. It was fixed before this task series began.** A4 is therefore
closed by verification rather than by a fix: no production code was changed. What was missing was
proof that the *failure signature* cannot occur, and test cover for half of the invariant.

## Why the premise is stale

A4 states that `launchBrowser` (~:246) uses `process.env.PUPPETEER_EXECUTABLE_PATH || resolution.path`,
discarding the existsSync-validated resolution the readiness probe (~:186) uses correctly.

The line numbers are right; the code at them is not what A4 describes:

| Site | Actual code |
|---|---|
| `probeBrowserAvailability` :186 | `executablePath: resolution.path` |
| `launchBrowser` :246 | `executablePath: resolution.path` |

Both call the same `resolveBrowserExecutable()`, and a repo-wide grep finds **no**
`process.env.… || resolution.path` construction anywhere. The env var is read in exactly one place —
`resolveBrowserExecutable` line 54 — where it is `existsSync`-checked and falls through to the system
path search with a warning if it does not resolve.

Git history confirms it was fixed twice over:

- **`0ea689f`** — *"fix: browserLauncher.launchBrowser re-reads raw PUPPETEER_EXECUTABLE_PATH,
  bypassing validated fallback"*. That is A4's bug, by name.
- **`e54ed88`** — *"fix Chromium path mismatch on Railway"*, which added the resolver's `existsSync`
  guard. The mismatch was real: `3b7fbcd` had set the var to `/usr/bin/chromium-browser` while the
  container package installs `/usr/bin/chromium`.

A regression test already existed at `test/browserLauncher.test.js:89`, and its comment documents
the exact signature A4 restates.

*(Minor correction to my own A1 note, which cited `:244`: `puppeteer.launch` is at :244 and
`executablePath: resolution.path` at :246. Same conclusion.)*

## What was actually missing, and is now done

**1. The signature was never proven impossible — only the line proven absent.** "Readiness reports
healthy while real launches fail" requires the probe and the launch to resolve *differently*. That is
now verified behaviourally under the hostile condition, in `scripts/a4BrowserResolution.mjs`. Each
case runs in its own child process because `probeBrowserAvailability` caches in module state.

**2. The test cover was asymmetric.** The existing guard checks `launchBrowser` only. Two tests were
added: one asserting the **probe** also resolves through `resolveBrowserExecutable` and takes
`resolution.path` (never a raw env read), and one asserting the resolver's `existsSync` guard —
including that the env branch is not a bare early return, which is what would reinstate the bug.
Both were confirmed to **fail** against a deliberately reintroduced version of each bug, then the
file was restored byte-identically.

## Verification (real runs)

`node scripts/a4BrowserResolution.mjs` — all checks passed:

```
1. env UNSET                    resolves system:windows chrome.exe, probe available, launch OK
2. env SET to /usr/bin/chromium resolver does NOT return it; falls back to an existing binary;
   (nonexistent here — the       probe path == resolved path; LAUNCH SUCCEEDS
    exact value .env sets)        -> probe and launch cannot diverge
3. env SET to a real path       override honoured, source=env:PUPPETEER_EXECUTABLE_PATH, launch OK
4. PDF end to end               29,728 bytes, "%PDF-" magic — with the stale env var still set
```

Case 2 is the failure signature, and it is structurally unreachable: one resolver, one path, used by
both callers.

Case 4 closes **A5's other precondition** ("PDF generation confirmed working end to end… if PDF is
still broken, STOP"). It replicates `server.js`'s `htmlToPdf` Chromium usage exactly — same viewport,
`waitUntil: networkidle0`, Letter format, zero margins, `printBackground` — and produces a valid PDF.
Note this verifies the launcher and Chromium PDF path; it does not exercise the HTTP route that calls
`htmlToPdf`, which needs auth and a generated resume.

## Production posture

`Dockerfile` installs the `chromium` package and sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`;
`railway.toml` sets the same. So in the container the override points at a real binary and is used
directly (`source=env:PUPPETEER_EXECUTABLE_PATH`). If that package path moves again, the resolver
falls through `LINUX_SYSTEM_PATHS` — which contains both `/usr/bin/chromium-browser` and
`/usr/bin/chromium` — and then the `@sparticuz/chromium` bundle. The class of incident that produced
`e54ed88` can no longer take the process down.

**Local papercut, not a bug:** `.env` sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, which does
not exist on Windows, so every local launch logs
`env:PUPPETEER_EXECUTABLE_PATH=… does not exist on disk — falling back to system paths` and then
works. Harmless, and the warning is doing its job, but it means local dev always runs on the fallback
path rather than the configured one. Worth removing from the local `.env` (or making it
platform-conditional) so local runs exercise the same branch as production. `.env` is not tracked, so
that is an operator change, not a commit.

## Regression review

| Surface | Verdict |
|---|---|
| `services/browserLauncher.js` | **Unmodified.** No production code changed in this task. |
| `services/applyAutomation.js` (importer) | Untouched; already asserted to use `launchBrowser` with no direct `puppeteer.launch`. |
| `server.js` `htmlToPdf` (importer) | Untouched; already asserted the same. PDF path verified working. |
| `test/browserLauncher.test.js` | +2 tests, both verified to bite. |
| `scripts/a4BrowserResolution.mjs` | New, additive, dev-only. |

**No migration.** **Baseline: 621 pass / 0 fail before → 623 pass / 0 fail after (2 added).
Introduced failures: 0.**

## A5 gate status

A5 says: *do not start until A1–A4 are committed and the trap matrix is fully green.*

| Precondition | Status |
|---|---|
| A1–A4 committed | ✅ `3d61e40`, `915c75e`, `ad931ad`, and this commit |
| A1 trap matrix all PASS/HOLD | ✅ A2 — every trap passes or holds, no wrong answer submitted |
| A2 low-confidence policy active | ✅ `label_fuzzy` cannot auto-submit |
| A3 audit trail recording | ✅ verified end to end, `submit_verified=1` with evidence |
| A4 browserLauncher | ✅ verified — nothing to fix |
| PDF generation working | ✅ 29,728-byte valid PDF through the launcher |

**A5 is unblocked but must not be started autonomously.** It submits one real application to a real
employer under a real candidate's name, and its procedure requires a human present to review and
click submit, plus a job "the candidate genuinely wants". Two things need an owner first: choosing
that specific greenhouse posting, and the sign-off items still open from A2/A3 — the `label_exact`
provenance tier, and the client error-flattening that currently hides the cap and kill-switch
messages behind generic copy.
