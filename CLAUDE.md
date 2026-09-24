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

## Deliberate test failures — currently 2

`npm test` is **2619 tests, 2617 pass, 2 fail**, and those two failures are intentional:

```
test/extensionSubmission.test.js
  ✖ every file in the submission zip is byte-identical to extension/ source
  ✖ every file the manifest references is present in the zip
```

`extension/` has moved ahead of the published `v1.0.0` package (the session-identity security fix
added `extension/auth.js`). The tests are correctly reporting that drift. **Do not silence them
and do not "fix" them by editing the assertions.** They clear on their own when the zip is rebuilt
at **P4**, which repackages for the domain flip anyway; repackaging sooner means a version bump,
and `docs/DOMAIN_MIGRATION.md` warns that touching the package while v1.0.0 is in Web Store
review can reset the queue position.

Full reasoning: `docs/EXTENSION_DIAGNOSIS.md` §6.6. **If you change this count, update it here** —
"deliberate failure" and "rot" are indistinguishable three weeks later.
