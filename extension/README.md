# Resume Master — Chrome Extension v1.0.0

Companion extension for Resume Master. It asks for permission to no job site at all, and reads a
page only at the moment you point it at one.

## What It Does
- **Capture the job you're viewing** — press `Ctrl+Shift+K` or open the popup and click
  **Capture job**. Both are triggers for the same implementation: same destination, same duplicate
  detection, same wording of the result. Exactly one job per press — no scrolling, no list
  harvesting, no background collection.
  Works on **any job posting**, including ones hosted on an employer's own careers domain. Tuned
  extraction for LinkedIn, Indeed, Glassdoor, Lever, Greenhouse, Workable, Ashby and Workday; a
  generic reader everywhere else.
- **Fill an application you signed in to reach** — `Ctrl+Shift+Y` on a form you have opened
  yourself. It fills answers you already saved in your account and shows a review panel. **You**
  press the employer's submit button.
- **ATS Score** — the popup's **ATS Score Tool** sends the visible text of the page you're on to
  your ATS Score page, prefilled.
- **LinkedIn Import** — opens the LinkedIn OAuth consent flow to import your name and email.
- **Quick Access** — opens the resume builder.

## What It Does NOT Do
- Does not scrape, read, or collect saved-jobs lists or any batch of listings — only the single
  job on the page you're viewing, only when you trigger it.
- Does not scrape, read, or collect any profile data.
- Does not submit an application. It fills and shows; you submit.
- Does not sign you in or attempt a CAPTCHA, and never reads any site's password or session cookie.
- Does not run in the background, and **declares no content script** — nothing runs on page load,
  anywhere.
- Does not request access to any job site. It has no standing access to anything.
- Contains no remotely hosted code.

## How it reaches a page

Through `activeTab` — the grant Chrome creates when you invoke the extension — and
`chrome.scripting.executeScript`. That is the whole access story, and it is why the manifest
declares exactly one host permission (`resumemaster.one`, our own backend) and no job boards.

It used to work the other way: a declared content script running automatically on six named sites.
That gave the extension standing access to those six and made every other job page unreachable,
including Greenhouse boards embedded on employers' own domains — which are common, and which no
list of hosts could have enumerated. See `MANIFEST_RATIONALE.md`.

## Capture Shortcut Settings
The options page (popup → "Capture Shortcut Settings") shows the current binding and links to
`chrome://extensions/shortcuts`, which is the only surface that can actually rebind a command — an
extension cannot reassign its own keys. An earlier version recorded a custom combination itself;
that only worked while one of six job sites had focus, and it was removed along with the content
script it depended on.

## Permissions Explained
- `activeTab`: reads the page you are on, only when you click the extension button or press a
  shortcut, and only that one tab. Access ends when the tab leaves that site.
- `scripting`: injects the extractor to read a posting, collect text for an ATS score, fill a form,
  and render the review panel. Nothing is injected into any other tab.
- `storage`: the result of your most recent capture (so the popup can show it), and — during a form
  fill only — the prepared answers, in memory-backed session storage with a 10-minute expiry.

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
