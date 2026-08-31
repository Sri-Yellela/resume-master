# Mobile State — Phase 1 Audit

> ## ⚠️ SCOPE CORRECTION — READ BEFORE THE HEADLINE BELOW
>
> **This audit covers `resume-master` ONLY. Its conclusion is true of this repository and false of
> the project.** The mobile apps are real and they live in two SIBLING repositories:
>
> | Repo | Contains |
> |---|---|
> | `../resume-master-android` | Kotlin / Jetpack Compose app, Gradle version catalog, `PHASE_2A.md` |
> | `../resume-master-ios` | SwiftUI app, `ResumeMaster.xcodeproj`, `PHASE_1_AUDIT.md` |
>
> The section below concludes "no mobile project has ever existed in any commit, on any branch."
> That sentence is scoped to this repository's history and nothing else. Read without this header
> it asserts the opposite of the truth, and it has already caused that confusion in reverse — which
> is why the header is here rather than a footnote.
>
> Verified 2026-08-30 during the corruption sweep: both sibling repos exist, are git repositories
> with their own remotes, and contain committed application source.

**Read-only audit. No mobile code was changed, and none exists to change *in this repository*.**
Audited at `c8639e7` (2026-08-27). Web test baseline re-derived: **1915 passing, 0 failing.**

---

## 0. THE HEADLINE: THE PREMISE IS FALSE

The task states that "mobile modules reportedly exist in this repo and have been untouched for a
long time." **They do not exist.** Not stale, not broken, not abandoned scaffolding — absent.

**No mobile project has ever existed in any commit, on any branch, in this repository's entire
history.**

Evidence, four independent checks:

| Check | Command | Result |
|---|---|---|
| Tracked files | `git ls-files \| grep -iE 'mobile\|android\|ios\|expo\|capacitor\|cordova\|react-native\|xcodeproj\|gradle\|Podfile\|swift\|kotlin'` | 3 incidental hits: `docs/mobile-linkedin-import.md`, `scripts/export_jds.js`, `.cinematic/exports.*.txt`. **Zero project files.** |
| **All history, all branches** | `git log --all --diff-filter=A --name-only` filtered as above | **Identical 3 hits.** No mobile project file was ever *added* and later deleted. |
| Dependencies | root + `client/package.json` | No `react-native`, `expo`, `@capacitor/*`, `cordova`. Client is React 18 + Vite 5 + Radix + Tailwind — a plain SPA. |
| PWA surface | `client/index.html`, `client/src/` | **No** `manifest.webmanifest`, no `manifest.json`, no service worker, no `serviceWorker.register`, no `apple-touch-icon`, no `theme-color`. No `client/public/` directory at all. |

So of the five possibilities the task asked me to choose between:

- ❌ React Native / Expo — no
- ❌ Capacitor / Cordova wrapper — no
- ❌ Native iOS (Swift/Obj-C) / Android (Kotlin/Java) — no
- ❌ PWA manifest + service worker only — no
- ❌ Abandoned scaffolding with no working build — **no; there is not even scaffolding**

**The correct answer is a sixth option the list did not contain: nothing exists.** The only mobile
artifact in the repository is a 21-line user-facing help article.

### The one mobile artifact, and why it misleads

`docs/mobile-linkedin-import.md` — 21 lines, UTF-8 BOM, titled "LinkedIn Profile Import - Mobile".
It opens: *"Resume Master supports importing your basic profile information from LinkedIn to
pre-fill your resume on iOS and Android."* It then describes a five-step tap-through flow
("Tap 'Import from LinkedIn'", "A secure browser opens LinkedIn's login page").

It is written in the present indicative, as though describing a shipped feature. It is not.

Its provenance explains it. Single commit, no edits since:

```
c818b9c  2026-05-08  feat: remove Apify scraping, migrate to LinkedIn OIDC,
                     rebuild extension Manifest V3
```

That is a **web and extension** commit. The mobile help article arrived as documentation alongside
a web-side LinkedIn OIDC migration — it reads as store-listing or support copy drafted in advance
of a mobile app, or as OAuth-consent-screen supporting material. LinkedIn OIDC itself **does** exist
server-side (`server.js:148`–`152`, `OAUTH_PROVIDERS`), but as a **web** OAuth provider.

> **This is exactly the trap the task warned about** — "never treat a documented feature as an
> existing one without finding the code." The document describes a mobile LinkedIn import; there is
> no mobile client to import into.

### `documentation.md` says nothing about mobile

Worth stating because the task assumed otherwise. `grep -i 'mobile|ios|android|app store|play store'`
over `documentation.md` returns **one hit**, and it is coincidental: the string `410` on a line
about form-fill flow. `documentation.md` carries **no mobile intent at all** — not stale mobile
intent, none. So there is no §6/§8 mobile content to read as intent, because there is no mobile
content.

---

## 1. LAST TOUCHED, AND THE DRIFT

There is no mobile code to date. The nearest meaningful anchor is the sole mobile *document*:

| | |
|---|---|
| Mobile doc last touched | **2026-05-08** (`c818b9c`) |
| HEAD | **2026-08-27** (`c8639e7`) |
| Elapsed | ~3.5 months |
| **Commits since** | **341** |
| **Migrations then → now** | **54 → 93** (high-water **`092_profile_summary_opt_in`**) |

The task predicted migration high-water "at least 090". Actual is **092**. Confirmed present:
`090_auth_context_session_binding`, `091_fill_log_and_artifact_provenance`,
`092_profile_summary_opt_in`.

This drift figure is *descriptive only*. Since no mobile code exists, nothing has drifted out of
sync — there is no compatibility debt, because there is no client. The number matters only as a
measure of how much the server moved while the mobile idea sat in a help file.

---

## 2. DOES IT BUILD?

**Not applicable — there is no mobile target to build.** No `xcodebuild` project, no Gradle
wrapper, no `expo` config, no Capacitor config. There is no build to attempt and therefore no
verbatim failure to report.

What I did instead, per the task's instruction to re-derive the web baseline first:

```
npm test  →  ℹ tests 1915   ℹ pass 1915   ℹ fail 0   duration_ms 17850
```

**Baseline: 1915 passing, 0 failing.** Note this is **not** the "last known 1858" quoted in the
task — the suite has grown by 57 tests since that figure was recorded. 1915/0 is the number to
compare against later.

Per `node-suite-cannot-see-pipeline-defects`, a green `npm test` does not cover the apply pipeline;
`npm run verify:harness` is the complement. It was **not** run in this audit: it is unrelated to
mobile, and several of its harnesses make real model calls on a key that is out of credit, so
running it would produce failures that say nothing about mobile state.

---

## 3. API SURFACE DRIFT

**The requested per-endpoint table cannot be built as specified, and I am not going to fabricate
one.** It asks me to "enumerate every endpoint the mobile code calls." There is no mobile code, so
that set is empty. A table of EXISTS / CHANGED SHAPE / GONE against an empty set would be
theatre.

What is useful, and what I verified instead: **the retirements and contract changes any future
mobile client would have to be built against.** Every row below was read in the current source, not
taken from the task's premise.

| Endpoint | Status | Evidence |
|---|---|---|
| `POST /api/scrape` | **GONE — 410** | `server.js:6852`. *"External scraping has been removed. Job search now uses /api/jobs."* |
| `ALL /api/extension/save-job` | **GONE — 410** | `server.js:5580`. Redirects callers to `/api/import/job`. |
| `ALL /api/imported-jobs/*` | **GONE — 410** | `server.js:5541` (regex route). Merged into the board's Saved tab. |
| `POST /api/apply/session/save` | **GONE — 410** | `routes/apply.js` — `SESSION_RETIRED`. |
| `GET /api/apply/session/:domain` | **GONE — 410** | `routes/apply.js` — `SESSION_RETIRED`. |
| `PATCH /api/settings/apply-mode` | **GONE — 410** | `routes/account.js:111`. *"Plans control tool access."* |
| `GET /api/jobs` | **EXISTS, CHANGED SHAPE** | Response now normalised through `services/jobs/mapJobRow.js`, extracted out of `server.js`. Board rows are per-`domain_profile_id`. |
| `POST /api/apply/runs` | **EXISTS, CHANGED SHAPE** | Approval-required by default; `queued`/`dailyCap` in the 202 body. Apply status vocabulary rebuilt (`queued`/`running`/`submitted`/`held_review`/`held_gate`/`failed`/`dismissed`/`superseded`/`cancelled`, partitioned in `shared/applyOutcomeGroups.js`). |
| `POST /api/auth/login` | **EXISTS** | Returns `authContext` token in the JSON body — see §4. |

`mapJobRow` did move out of `server.js` (now `services/jobs/mapJobRow.js`), as the task said. One
correction to flag for whoever builds the mobile client: **`mapJobRow`'s `sourcePlatform` is
mislabelled** — it reads `j.sourcePlatform` (camelCase) while the column is `source_platform`, so
it silently resolves to `j.source`. Documented in full in `docs/SWIPE_FEED_DESIGN.md` Finding 2a.
Do not build a mobile ATS badge on it.

---

## 4. AUTH — **NOT THE BLOCKER THE TASK EXPECTED**

The task states: *"AUTH IS THE LIKELIEST HARD BLOCKER… If it needs a token-based path the server
does not currently offer, say so."*

**Stated plainly: the server already offers a token-based path, and it is complete end to end.**
This is a correction to the premise, and it is the most consequential finding after §0, because it
removes what was expected to be the hardest obstacle.

**How mobile authenticates today:** it does not. There is no mobile code. So the question becomes
whether a token-only client *could* authenticate against today's server. It can:

**1. A token is issued in the login response body.** `server.js:5191`:

```js
req.logIn(user, e => e ? next(e)
  : res.json({ ok:true, user:publicUser(user), authContext:issueAuthContext(user.id, req) }));
```

`POST /api/auth/login` returns `authContext` as JSON. Also issued by register (`:5242`) and the
OAuth callback (`:5334`, `:5385`). No cookie handling is required to *obtain* one.

**2. The server accepts it as a bearer token.** `getRequestAuthContextToken` (`server.js:4409`):

```js
const header = req.get("x-rm-auth-context");
const bearer = (req.get("authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1] || null;
return header || bearer || req.query?.authContext || null;
```

Three transports: `Authorization: Bearer`, `X-RM-Auth-Context`, or `?authContext=`.

**3. A token alone is sufficient — no cookie needed.** `requireAuth` (`server.js:4486`):

```js
if (req.isAuthenticated() || req.authContextToken) return next();
```

`bindAuthContext` (`:4436`) validates the token against `auth_contexts` (non-revoked, non-expired,
user exists), sets `req.user`, and lets the request through. The comment there is explicit that this
exists so a valid token works even when the Passport session is gone.

**4. There is already precedent for a non-browser, session-free client.** `issueAuthContext`
accepts `options.sessionLess` (`server.js:4337`), used by
`GET /api/auth/extension-token` (`:5499`) so the extension's token is *not* tied to a browser
session. A mobile client is the same shape of consumer.

So AH1's model is cookie-**or**-token, not cookie-**plus**-token. No new auth mechanism has to be
invented, and I have not invented one.

### Two real caveats — design decisions, not blockers

1. **Hard 7-day expiry, no sliding renewal, no refresh endpoint.** `issueAuthContext` sets
   `expires_at = now + 7*24*3600`. `bindAuthContext` updates `last_seen_at` but **does not extend
   `expires_at`**. So a mobile user is force-logged-out weekly regardless of activity. Acceptable
   for an extension; poor for a phone app. Adding sliding expiry or a refresh path is a
   **server-side decision for the owner**, and I am flagging it rather than proposing a mechanism.
2. **Login-issued tokens are session-bound, which is wrong for a cookie-less client.**
   `issueAuthContext` stores `session_sid = req.sessionID` unless `sessionLess` is set.
   `revokeBrowserAuthContexts` (`:4347`) then revokes every token sharing that sid. A mobile client
   that discards cookies gets a throwaway sid it never reuses, so the binding is meaningless at best
   and the revocation semantics were not designed for it. The right answer is almost certainly a
   `sessionLess`-style mint for mobile, mirroring the extension token — **a small server-side design
   decision, and the owner's to make.**

---

## 5. INTENDED SCOPE vs. WHAT EXISTS

The task asked for this as a table. The honest table has one row, because there is exactly one
piece of mobile intent evidence in the repository.

| Intended feature | Evidence it was intended | Does code exist? | Web equivalent today |
|---|---|---|---|
| LinkedIn profile import on iOS/Android — name, email, photo only; explicitly *not* work history, education, skills | `docs/mobile-linkedin-import.md` (21 lines, added 2026-05-08, never edited) | **No mobile code.** LinkedIn OIDC exists server-side as a **web** OAuth provider (`server.js:148`–`152`, `OAUTH_PROVIDERS`, `isLinkedInOAuthConfigured()`) | Web OAuth sign-in/link works. The described *mobile tap-through* flow has no implementation. |

**Everything else about mobile scope is unwritten.** `documentation.md` contains no mobile section
(§0). There is no mobile PRD, no mobile design doc, no mobile ADR. The task's context says "feature
scope on mobile is intended to differ from web" — **that intent exists only in the owner's head; it
is nowhere in this repository.** Capturing it is a prerequisite for Phase 2, not something this
audit can recover.

---

## 6. WHAT CANNOT PORT

Named, not solved, as instructed.

| Feature | Verdict | Why |
|---|---|---|
| **Chrome extension** — capture, `Ctrl+Shift+K/Y` | **No mobile analogue** | `extension/manifest.json` is Manifest V3 with `activeTab`/`scripting`/`storage` and a `commands` block. Mobile browsers support no extension platform, and keyboard chords are not a phone gesture. |
| **Gated handoff (G1–G5)** | **Cannot exist on mobile** | Its security property *is* the desktop browser. `docs/GATED_HANDOFF_ARCHITECTURE.md` §2: the user's own browser holds the authenticated portal session and the extension borrows it for one gesture under `activeTab`; the extension pulls, and `externally_connectable` "stays absent". No extension → no `activeTab` → **a `held_gate` row is unresolvable from a phone.** See below. |
| **Puppeteer auto-apply** | **Portable — it is server-side** | `services/applyAutomation.js` runs `puppeteer-core` on the server, so a phone can trigger and review a run. The **review** surface is HTTP-only (provenance, resume PDF, screenshot, approve/reject) and is phone-renderable. |
| **PDF rendering / editing** | **Materially different** | `htmlToPdf` is server-side (fine), but reading and editing a full-page A4 document on a phone screen is a different product. Viewing is feasible; editing is not a port. |
| **Multi-panel tiled overlay UI** | **Desktop-shaped** | `react-resizable-panels`, `DockPortal`, `PanelShell`, `usePanelHost`, `useBoardLock`, `useChromeHeight`, `useCollapsibleHeight`. A draggable tiled dock has no phone equivalent — mobile needs a single-surface navigation model, which is a redesign, not a responsive pass. |

**What a "mobile gated handoff" would even mean — answering the question directly:** *nothing
coherent.* The mechanism is "borrow the session already sitting in this browser." A phone app cannot
borrow a desktop browser's session, and the phone's own browser has no extension to do the
borrowing. The only honest mobile behaviours are (a) show the job as needing a desktop and say so
plainly, or (b) exclude it. There is no third option that preserves the security property. This is
designed out in `docs/SWIPE_FEED_DESIGN.md` §2.5, and the conclusion there is the same.

**Web client's mobile readiness, measured:** only **13** `@media`/`matchMedia`/`max-width`
occurrences across all of `client/src/`. A `useViewport.js` hook exists. Touch handlers appear in 5
files (`DockPortal`, `PanelShell`, `UsbSelect`, `UsbSuggest`, `JobsPanel`). **The web client is not
responsive in any meaningful sense** — so "just load the web app on a phone" is not a shortcut
either.

---

## 7. STORE READINESS

**Every item requested is absent, because there is no app.** Reporting factually rather than as a
gap list against a project that does not exist:

| Requirement | State |
|---|---|
| iOS bundle identifier | **Does not exist** |
| Android `applicationId` | **Does not exist** |
| Signing config (iOS provisioning/certs, Android keystore) | **Does not exist** |
| `versionCode` / `versionName` / `CFBundleShortVersionString` | **Does not exist** |
| Minimum OS targets (`minSdkVersion`, `IPHONEOS_DEPLOYMENT_TARGET`) | **Does not exist** |
| App Store privacy manifest (`PrivacyInfo.xcprivacy`) | **Does not exist** |
| Play Data Safety declaration | **Does not exist** |
| Apple Developer / Google Play account enrolment | Not determinable from the repo |

**The privacy-policy problem is real and worth surfacing now.** The live policy
(`docs/privacy/index.html`, 48 lines, served at `resumemaster.one/privacy`) mentions the
**extension** but contains **zero** references to mobile, iOS, or Android. Both stores require their
own declarations, and the task correctly notes they must not contradict the live policy. Today they
would not contradict it — **they would have no basis in it at all**, because it does not describe a
mobile app, its data collection, or its permissions. The policy needs amending *before* either
store declaration can be written honestly.

For precedent on how this project handles a store submission, `extension/manifest.json` carries
`privacy_policy_url: https://resumemaster.one/privacy`, and `docs/af4-extension-publish.md` /
`docs/ai2-store-screenshots.md` record the Chrome Web Store process. Note the extension itself is
**not yet submitted** (`GATED_HANDOFF_ARCHITECTURE.md` §1: batched at v1.3.0, "not yet submitted"),
so this repository has **no completed app-store submission of any kind** to model a mobile one on.

---

## 8. SIZING VERDICT

Of the three options offered:

- ❌ "Update a working app" — there is no app.
- ❌ "Revive a stale but sound app" — there is nothing to revive. Not stale code; **no code.**
- ✅ **"The scaffolding is not viable and mobile is effectively greenfield."**

**With one amendment: "effectively" is too weak. Mobile is *literally* greenfield.** There is no
scaffolding whose viability could be assessed. The verdict is not "the existing attempt is too far
gone" — it is "no attempt was ever made." Every line of a mobile client is yet to be written, along
with the platform choice, the scope, and the store accounts.

**What makes this cheaper than a normal greenfield, and this is the genuinely good news:**

1. **Auth is solved** (§4). A bearer-token path exists end to end and is already proven by the
   extension. This was expected to be the hard blocker and is not one. Two small server-side
   decisions remain (sliding expiry; a `sessionLess` mint for mobile).
2. **The server is a clean JSON API** with `requireAuth` accepting tokens, CORS configured, and
   the retirements already tombstoned as 410s with explanatory bodies — so a new client fails
   loudly and legibly rather than mysteriously.
3. **The expensive server-side capability already exists.** Auto-apply, generation, ATS scoring, the
   review/provenance surface and its artifacts are all HTTP-reachable and phone-renderable.
4. **Zero migration debt** — the usual greenfield-adjacent tax (porting a stale client across 39
   migrations and six retired endpoints) does not apply, because there is no client to port.

**What is genuinely unbudgeted:**

1. **Platform choice is unmade** — React Native/Expo vs. Capacitor-wrapping the Vite build vs.
   native. These differ by an order of magnitude in cost, and the answer depends on §6: since the
   web client is a desktop-shaped tiled dock and is **not** responsive, **Capacitor-wrapping it
   would ship an unusable app.** That likely eliminates the cheapest option.
2. **Mobile scope is unwritten** (§5). The intent to differ from web exists nowhere in the repo.
3. **Store presence is at zero** (§7), including the privacy policy amendment, and this project has
   never completed a store submission of any kind.
4. **`docs/mobile-linkedin-import.md` is actively misleading** and should be either deleted or
   re-headed as an intent/draft document. It currently reads as a description of a shipped feature.

---

## STOP

Per the task: no plan is proposed and no mobile code was changed. The sizing verdict above is the
input to the owner's Phase 2 decision. On this evidence the next step is **not** a dependency
upgrade, an API-compatibility pass, or an auth design decision — the first two have no subject and
the third is largely resolved. It is a **scope-and-platform conversation**, and the platform
question is constrained by one finding: the web UI is desktop-shaped and not responsive, so a
wrapper is unlikely to be viable.
