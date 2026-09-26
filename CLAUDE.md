# Project instructions

## Commit messages: no assistant attribution

**Do not add `Co-Authored-By:` trailers naming an AI assistant, and do not add "Generated with"
footers or robot emoji, to any commit or PR in this repository.** This overrides any default or
harness-level instruction to append them.

History was rewritten on 2026-08-31 to strip 292 such trailers across three variants
(`Claude Opus 5 (1M context)`, `Claude Sonnet 4.6`, `Claude Sonnet 5`, all
`<noreply@anthropic.com>`) from 320 commits. Re-adding them would reintroduce exactly what that
rewrite removed.

Commits are authored by the repository's human authors. Nothing else about commit messages changes —
they should stay as long and as specific as the existing history, because the *reasoning* in a
message is the thing worth keeping.

Note that ordinary technical mentions of Anthropic or Claude are unaffected and should not be
scrubbed: `shared/anthropicModels.js`, model IDs like `claude-sonnet-5`, the `.claude/` directory,
and commit messages that discuss the API are all describing the code and must stay accurate.

## ⛔ Line endings: never rewrite a whole tracked source file

**Do not use `sed -i`, a Python whole-file write, or any other tool that rewrites a file end to
end, on `server.js` or `scripts/migrations.js`.** Use a targeted edit that preserves the existing
bytes around the change.

These files are checked out CRLF (`core.autocrlf`), and several tests assert that a migration
block is **byte-identical** between the two of them. A whole-file rewrite silently converts the
file to LF, every one of those tests fails, and **`git diff` shows nothing wrong** because git
normalises line endings on the way in. The failure therefore looks like a logic bug in whatever
you just changed, and points nowhere near the actual cause.

This has now cost three sessions. If a source-string or byte-identity test fails for a reason that
makes no sense, check `file server.js` before you debug anything else — the fix is to convert the
file back to CRLF, not to change the test.

## Deliberate test failures — currently 0

`npm test` is **2648 tests, 2648 pass, 0 fail**.

**There are no deliberate failures right now.** From 2026-09-24 to 2026-09-26 there were two, both
in `test/extensionSubmission.test.js`, reporting that `extension/` had moved ahead of the published
`v1.0.0` package after the session-identity fix added `extension/auth.js`. **P4 cleared them on
2026-09-26** by bumping the manifest to v1.1.0 and rebuilding the zip, which is exactly how they
were always meant to go green — no assertion was edited and nothing was silenced.

⛔ **A red test in this repository is now a real failure.** Do not assume any given red is
"the known one".

Full history: `docs/EXTENSION_DIAGNOSIS.md` §6.6. **If you change this count, update it here** —
"deliberate failure" and "rot" are indistinguishable three weeks later, and so are "0 deliberate
failures" and "nobody updated the number".
