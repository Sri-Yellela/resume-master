# Parsing a résumé PDF over MCP — the input design (A84, D21 step 2)

**Status 10-04: design only. Nothing here is built, and no tool is declared.** This is the input
design D21 step 2 needs before a `parse_resume_pdf` tool can be added to `/mcp`.

## Why a design first

- **D17 no longer blocks it.** `/v1/resumes/parse-pdf` reads the PDF's own text layer since `1636a01`
  (`src/parsing/extractPdfText.js`) — no model call.
- **But an assistant does not send base64.** ChatGPT hands a tool a **file reference**. Verified
  10-04 in OpenAI's Apps SDK reference (developers.openai.com/apps-sdk/reference): a tool lists its
  file inputs in `_meta["openai/fileParams"]`, and each such field receives
  `{ download_url, file_id, mime_type?, file_name? }` — *"ChatGPT always includes `download_url` and
  `file_id`; it may omit `mime_type` and `file_name`."* The reference does **not** say how long the URL
  is valid or how large a file may be; ⚠ measure both on a real call before building.
- **Base64 over MCP is the wrong shape anyway:** a 2 MB PDF is ~2.7 MB of tool arguments the model has
  to emit, past the anonymous 512 KB body cap, and an assistant that can produce it could equally send
  the text.
- **The review's minimum-necessary rule applies.** The tool should take the file, return the text,
  and keep nothing.

⚠ **First question for the owner: is the tool needed at all?** ChatGPT and Claude read PDFs
themselves; `score_ats_fit` already takes `resumeText`. The tool earns its place only if the
service's reader is better than the host's (two-column order, the scan refusal) — worth measuring on a
few real résumés before building.

## The input

```
parse_resume_pdf({ file: { download_url, file_id, mime_type?, file_name? } })
  _meta["openai/fileParams"] = ["file"]
```

Only `download_url` is used. `file_id` and `file_name` are neither stored nor logged nor echoed.
⛔ **No `base64` field and no free-form `url` field** — a free URL turns the tool into a fetch-anything
proxy.

## The fetch — every rule is a refusal before or during the read

| Rule | Why |
|---|---|
| **HTTPS only**, port 443 | no plaintext, no odd ports |
| **Host allowlist** — `RM_MCP_FETCH_HOSTS`, exact hostnames, comma-separated. Absent = the tool is OFF (like `RM_MCP_ANONYMOUS`). ⚠ The value is whatever host ChatGPT's `download_url` uses, read from a real call, not guessed | the URL comes from the model's tool arguments, so it can be anything |
| **No IP literals; resolve the host and refuse loopback, private, link-local and metadata ranges** (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10), and connect to the address that was checked | SSRF — an allowlisted name that resolves inward is still inward |
| **No redirects followed** (or at most one, to an allowlisted host, re-checked) | a redirect is a second URL the allowlist never saw |
| **No credentials sent** — no cookies, no `Authorization`, no forwarded headers | the signed URL is the only authority |
| **Timeout 10 s** total (connect + body) | an anonymous call must not hold a worker |
| **Size cap 5 MB**: refuse on `Content-Length` over the cap, and count bytes while streaming, aborting at the cap | `Content-Length` can lie or be missing |
| **It must be a PDF**: the first bytes are `%PDF-`, whatever `mime_type` or `Content-Type` say; page cap as the site reader has | the declared type is the caller's word |
| **Caps**: the anonymous per-address/per-day caps, plus a separate daily fetch ceiling (`perDayFetches`) | a fetch costs bandwidth that a score does not |

Each refusal is a tool error with a stated reason (`fetch_refused: host_not_allowed`, `too_large`,
`not_a_pdf`, `timeout`, …) — never an empty résumé. A scan (no text layer) answers `needsOcr`, as the
site does.

## No retention

- The PDF is held **in memory only**, as one buffer, for the length of the call; it is never written
  to disk, to the store or to a temp file, and the buffer is dropped when the text is returned.
- ⛔ **The URL is never logged** — a signed download URL is a credential for as long as it lives. The
  request log line stays method, path, status, duration and caller; the metering line adds the
  refusal reason or `ok`, the byte count bucket and the page count — never the URL, the host's path,
  the file name or the text.
- The answer is `{ text, chars, needsOcr }` — no URL, no file id echoed back.
- Covered the same way as the ATS tool's statelessness: a test sends a sentinel PDF and a sentinel URL
  and fails if either appears in any log line, response field other than `text`, or file on disk.

## What building it would also need

- `docs/PRIVACY.md` *Through an AI assistant*: what is fetched, from where, how long it is held (the
  call), and that the URL is not kept.
- A contract version bump (a new tool and result shape), the tool's annotations
  (`readOnlyHint: true`, `openWorldHint: true` — it reaches the network), and positive/negative
  submission test cases in `docs/CHATGPT_APP.md`.
- **Owner decisions:** whether the tool is worth having (above); the allowlist value; whether it is
  anonymous or token-only at first; the size and daily caps.
