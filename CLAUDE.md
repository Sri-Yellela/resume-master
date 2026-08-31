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
