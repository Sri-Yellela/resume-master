# Resume Master - Chrome Extension v1.2

Companion extension for Resume Master. Lightweight, privacy-first.

## What It Does
- **Capture this job**: on any supported job listing (LinkedIn, Indeed, Glassdoor, Lever,
  Greenhouse, Workable), press the capture shortcut (default `Ctrl+Shift+K`, customizable in
  Settings) to send the ONE job you're currently viewing into your Resume Master job pool.
  Exactly one job per press — no scrolling, no list harvesting, no background collection.
- **Save Job**: on a supported job listing, open the popup and click "Save Job" to add it to
  your Resume Master saved list.
- **ATS Score**: on supported job listings, click the floating "ATS Score this job" button (or
  the popup's "ATS Score Tool") to send the visible job description to Resume Master's ATS
  scoring tool.
- **LinkedIn Import**: opens the secure LinkedIn OAuth consent flow so you can import your name
  and email to pre-fill your resume.
- **Quick Access**: open the resume builder from anywhere.

## What It Does NOT Do
- Does not scrape, read, or collect saved-jobs lists or any batch of listings — only the single
  job on the page you're viewing, only when you trigger it (shortcut or button click).
- Does not scrape, read, or collect any profile data.
- Does not auto-apply to any jobs.
- Does not run in the background or collect anything without a direct user action.
- Does not request access to pages you are not currently viewing.

## Capture Shortcut Settings
Open the extension's Settings page (popup → "Capture Shortcut Settings", or
`chrome://extensions` → Resume Master → Details → Extension options) to set a custom capture
shortcut. Reserved browser/OS combinations (Ctrl/Cmd+C, Ctrl/Cmd+T, devtools shortcuts, etc.)
are rejected. The default `Ctrl+Shift+K` binding is a real Chrome shortcut and can also be
changed at `chrome://extensions/shortcuts`; a custom override set in this extension's Settings
page only works while a supported job page has focus.

## Permissions Explained
- `activeTab`: reads the page you are on only when you click the extension button or trigger a
  capture.
- `scripting`: lets the popup collect visible page text from the active tab after you click ATS
  Score Tool.
- `storage`: persists your custom capture shortcut (if you set one) and the result of your most
  recent capture, so the popup can show it to you.

## Install (Development)
1. Chrome -> chrome://extensions -> Enable Developer Mode.
2. Load Unpacked -> select this folder.

## Build (Chrome Web Store submission)
```
npm run build:extension          # writes extension/submission/resume-master-extension-v<version>.zip
npm run build:extension -- --check   # validate only, write nothing (exits 1 on any problem)
```
Do NOT hand-assemble the zip. The v1.1.0 submission was built by hand and drifted badly from
this folder: it shipped a `saved-jobs-content.js` content script that no longer exists in the
repo at all, while missing the options page and capture shortcut the source had gained. Nothing
caught it because there was no build to diff against.

`scripts/buildExtension.mjs` derives the file list from `manifest.json` plus the HTML entry
points, so a newly referenced script cannot be left out and an unreferenced one is not shipped
(this README and `MANIFEST_RATIONALE.md` are excluded today; `popup.css` was deleted outright at
v1.0.0 rather than left unshipped — the popup's styles are inline in `popup.html`). It refuses to
build if a referenced file is
missing, if `manifest.json` carries a UTF-8 BOM, or if any bundled script has an **active**
`localhost` URL — i.e. the DEV SWITCH in `config.js`/`background.js` is flipped. Bump `version`
in `manifest.json` before building; the version comes from there, not from the filename.

## Publish (Chrome Web Store)
```
npm run publish:extension -- --dry-run     # full preflight, sends nothing, needs no credentials
npm run publish:extension                  # preflight, then upload as a DRAFT (nobody sees it)
npm run publish:extension -- --publish     # ...and publish to everyone
npm run publish:extension -- --publish --target=trustedTesters
npm run publish:extension -- --publish --percent=10
```
Publishing is irreversible — once a version is live it is on real users' machines and the only
remedy is another review cycle — so the default uploads a draft and stops. Going live needs
`--publish`, typed deliberately.

The preflight runs before anything leaves the machine, and a failure means nothing was touched
remotely. It refuses if the zip has drifted from `extension/`, if the dev switch is flipped, if the
version does not move forward, if the privacy policy URL does not resolve, or if
`submission/STORE_LISTING.md` is still headed with the previous version. That last one is not
bureaucracy: v1.3.0 was ready to be uploaded beside a v1.2.0 listing that declared "personally
identifiable information — not collected" about a build that fills a candidate's postal address into
an employer's form. Nothing in the store's API would have caught it.

Credentials come from the environment (`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`,
`CWS_ITEM_ID`) and are never printed; see `.env.example` for how to obtain them. `--dry-run` needs
none of them, so the preflight is safe to run anywhere, including CI on a fork.

## Privacy
Job description text is sent to Resume Master when you explicitly trigger a capture, click "Save
Job", or click "ATS Score Tool"/"Send to Resume Master".

Since v1.3.0 the extension can also fill an application form on a portal you have signed in to
yourself. When you invoke it there, it fetches the details you saved in your Resume Master account —
name, email, phone, postal address, work-authorization answers and your resume — and enters them
into that employer's form. It shows you every answer and where it came from; you press submit. It
never signs you in, never attempts a CAPTCHA, and never reads any portal's password or session
cookie.

It can optionally report the *structure* of a form it filled — the questions, their types, which are
required — so the same employer's form is recognised for other candidates. That is **off unless you
turn it on**, it stores the form's questions and never your answers, and it is enforced on the
server rather than only here.

See resumemaster.one/privacy for the full policy.
