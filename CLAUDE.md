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

### ⚠ "Don't change the test" is the right rule for ONE of the two cases. Work out which you have.

The rule above is correct **because `server.js` and `scripts/migrations.js` must be byte-identical
to each other.** Byte-level line endings ARE the invariant under test there, so a test that stopped
caring about them would stop testing the thing it exists for. Convert the file.

**But a test can also be line-ending sensitive by accident, and then the test is the defect.** A
markdown parser, a source-string search, a config reader — none of those has any business caring
whether a line ends `\n` or `\r\n`, and one that does will pass on the machine where the file
happens to sit LF and fail on a fresh clone.

That is not hypothetical. `test/manifestMinimumPermission.test.js` located sections with
`startsWith(heading + "\n")`, which is false for `"Permissions\r\n"`. It passed for months and then
four tests went red the moment a branch checkout round-tripped `extension/MANIFEST_RATIONALE.md`
through git — reporting *"MANIFEST_RATIONALE.md has no ## Permissions section"*, which blames the
document. Any fresh Windows clone would have hit it. Fixed by normalising on read, 2026-09-26.

**Ask: is byte-for-byte equality the property being asserted, or is it incidental to how the file
is read?**

| | Fix the FILE | Fix the TEST |
|---|---|---|
| `server.js` ↔ `scripts/migrations.js` byte identity | ⭐ | |
| Source-string assertions that quote real code | ⭐ | |
| Parsing markdown, config or prose for structure | | ⭐ |
| Anything that would fail on a colleague's fresh clone | | ⭐ |

⛔ **The checkout is a way in, not just whole-file writes.** `.gitattributes` declares `* text=auto`,
so this repository stores LF and materialises the platform convention. `git checkout` of another
branch — including the round trip a merge makes — rewrites every file that differs and converts it.
A tree whose *content* is byte-identical to one that just passed can therefore fail, with
`git status` clean. If tests break right after a branch switch and nothing you did explains it,
this is why.

## Deliberate test failures — currently 0

`npm test` is **2655 tests, 2655 pass, 0 fail**.

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
