# Resume Master cinematic redesign — Sprint 1 audit + Sprint 2 execution

You are resuming work on `resume-master`. Sprint 1 (Steps 0-13) was
completed on a feature branch and merged into `main` via a merge commit
labeled `feat: cinematic redesign (Steps 0-13)`. This prompt does three
things in sequence:

1. **Phase 1 — Audit Sprint 1 on `main`.** Verify every Sprint 1
   deliverable is present and correct on `main`; conditionally run the
   mojibake hotfix on JobCard.jsx if it was missed during the original
   Sprint 1 execution; regenerate baselines so Sprint 2 diffs are clean.
2. **Phase 2 — Cleanup.** Delete the now-redundant `cinematic-redesign`
   local branch (its 27 granular commits are preserved in git's reflog
   for ~90 days; all the code is on `main`; STATE.md keeps the audit
   trail with every per-step SHA).
3. **Phase 3 — Sprint 2 (Steps 14-19).** Theme framework, inline login,
   emoji removal, poster relocation, portaled drawer, unified home.

All three phases run in one Claude Code session. Phase 1 + Phase 2 are
straight-through (no per-step pause). Phase 3 follows the per-step loop
with mandatory pauses after each commit for user review.

---

## Anchor first

```bash
cd /c/Users/duggi/WebstormProjects/resume-master
git branch --show-current        # expect: main
git log --oneline -5             # expect at top: 7fba760 feat: cinematic redesign (Steps 0-13)
git branch -a                    # expect: main + cinematic-redesign (to be deleted in Phase 2)
ls .cinematic/STATE.md           # must exist
git status --short               # only .claude/settings.local.json modified, or clean
```

If `main` isn't the current branch, the top commit isn't the cinematic
redesign squash, or STATE.md is missing — **STOP** and surface to the user.

## Environment (Windows + Git Bash)

- `npm` not on default PATH. Prefix every npm/node command:
  `PATH="/c/Program Files/nodejs:$PATH" <cmd>`
- Repo root: `/c/Users/duggi/WebstormProjects/resume-master`
- Build via: `PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15`
- `.claude/settings.local.json` floats as M between commits — NEVER stage it.
- All Sprint 2 commits use `step N:` prefix (N = 14-19).
- Audit-phase commits use `audit:` or `fix:` prefix.

## Sources of truth, priority order

1. This prompt — spec for audit + cleanup + Sprint 2.
2. `.cinematic/STATE.md` — historical progress log.
3. `git log` — canonical record.

Conversational memory is NOT a source of truth. Re-read before every step.

---

# Phase 1 — Audit Sprint 1

## A1: Build verification (must pass before anything else)

```bash
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client install 2>&1 | tail -5
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tee /tmp/audit-build.log | tail -15
```

Expect: exit 0, ~74.27 KB CSS, 4 pre-existing warnings (CJS Vite,
postcss typeless, JobCard dynamic+static, chunk size > 500 KB). Any
new error → **STOP** and surface.

## A2: Sprint 1 deliverable presence checks

These files MUST exist on `main`:

```bash
ls -la client/src/components/CinematicBackground.jsx     # Step 3
ls -la client/src/components/AppShell.jsx                 # Step 4
ls -la client/src/index.css                               # Step 1 — must contain @theme + .liquid-glass + .liquid-panel
ls -la client/src/styles/theme.jsx                        # Step 2 — should be ~320 lines (down from 564)
wc -l client/src/styles/theme.jsx                         # expect 280-380
```

Spot-check theme.jsx is reduced:

```bash
grep -c "BG_MODES\|isDarkBgMode\|setBgMode" client/src/styles/theme.jsx
# expect 0 — these were removed in Step 2
```

Spot-check index.css has cinematic content:

```bash
grep -c "@theme\|liquid-glass\|liquid-panel\|fade-rise" client/src/index.css
# expect >= 4 (at least one of each)
```

If any of these checks fail → **STOP** and report which deliverable is missing.

## A3: Mojibake check on JobCard.jsx (conditional hotfix)

The Sprint 1 prep identified UTF-8 corruption in JobCard.jsx. Step 8
may or may not have incidentally cleaned it during the repaint. Verify:

```bash
grep -c 'â˜\|âœ\|â†\|ðŸ\|ï¿½\|â€\|â”' client/src/components/JobCard.jsx
```

- **If count is 0**: JobCard.jsx is clean. Skip to A4.
- **If count > 0**: Run the conditional hotfix below.

### Conditional hotfix (only if A3 grep returned > 0)

```bash
cat > .cinematic/fix-jobcard-encoding.mjs <<'EOF'
import fs from "node:fs";
const path = "client/src/components/JobCard.jsx";
let s = fs.readFileSync(path, "utf8");
const map = [
  ["â˜…", "★"], ["â˜†", "☆"],
  ["âœ¦", "✦"],
  ["âœ\u0093", "✓"], ['âœ"', "✓"],
  ["â†»", "↻"], ["â†—", "↗"], ["â†©", "↩"],
  ["â†\u0091", "↑"], ["â†\u0093", "↓"],
  ["â†\u0090", "←"], ["â†\u0092", "→"],
  ["â³", "⏳"], ["â—†", "◆"],
  ["â€¦", "…"],
  ["â€\"", "—"], ["â€\u0093", "–"], ["â€\u0094", "—"],
  ["ï¿½", "—"],
  ["Â·", "·"], ["â”€", "─"],
  ["ðŸ\"„", "📄"], ["ðŸ'°", "💰"], ["ðŸŽ\"", "🎓"],
  ["ðŸ'¥", "👥"], ["ðŸ'", "👁"],
];
let total = 0;
for (const [from, to] of map) {
  const parts = s.split(from);
  if (parts.length > 1) { total += parts.length - 1; s = parts.join(to); }
}
fs.writeFileSync(path, s, "utf8");
console.log("Applied " + total + " character replacements.");
EOF

PATH="/c/Program Files/nodejs:$PATH" node .cinematic/fix-jobcard-encoding.mjs

# Verify
grep -c 'â˜\|âœ\|â†\|ðŸ\|ï¿½\|â€\|â”' client/src/components/JobCard.jsx
# expect 0

# If still > 0, STOP and surface the residual lines:
grep -nE 'â˜|âœ|â†|ðŸ|ï¿½|â€|â”' client/src/components/JobCard.jsx | head -20
```

Also scan other files for the same pattern:

```bash
grep -rln 'â˜\|âœ\|â†\|ðŸ\|ï¿½\|ðŸŽ' client/src --include='*.jsx' --include='*.js' | grep -v node_modules
```

If anything else needs the same treatment, surface the file list to the
user and STOP — don't blindly copy the script to unknown patterns.

### Hotfix commit (only if hotfix ran)

```bash
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -5
# expect exit 0

git add client/src/components/JobCard.jsx .cinematic/fix-jobcard-encoding.mjs
git commit -m "fix: restore UTF-8 in JobCard.jsx (mojibake from prior tool encoding)

Audit caught mojibake that Step 8's repaint didn't clean. Same CP1252
decoded-as-UTF-8 corruption pattern documented in pre-Sprint-1 analysis.
Repair script kept under .cinematic/ for audit (idempotent).

Not a Sprint 2 step — Sprint 1 follow-up surfaced during audit."
```

Also harden the `--font-body` fallback if not already done:

```bash
grep -A1 '\-\-font-body:' client/src/index.css | head -3
```

If the font-body line lacks emoji fallbacks (no "Apple Color Emoji" or
"Segoe UI Emoji"), apply this edit to `client/src/index.css`:

Find:
```css
--font-body: 'Inter', ui-sans-serif, system-ui, sans-serif;
```

Replace:
```css
--font-body: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
```

Then commit:

```bash
git add client/src/index.css
git commit -m "fix: add emoji + symbol font fallbacks to --font-body

Audit surfaced that the body font chain lacks emoji/symbol coverage
on Windows. Adding Apple Color Emoji / Segoe UI Emoji / Segoe UI Symbol
/ Noto Color Emoji fallbacks ensures any current or future emoji char
renders correctly.

Not a Sprint 2 step — Sprint 1 hardening surfaced during audit."
```

## A4: Contract diffs against baselines

```bash
cd client
grep -rnE 'api\(|fetch\(' src --include='*.jsx' --include='*.js' | grep -v node_modules | sort > /tmp/api-calls.now.txt
diff ../.cinematic/api-calls.before.txt /tmp/api-calls.now.txt
# Note: line-number shifts are OK; missing/added endpoints are NOT OK.

grep -rnE '<Route\s+path=|path:\s*["'"'"']' src --include='*.jsx' --include='*.js' | sort > /tmp/routes.now.txt
diff ../.cinematic/routes.before.txt /tmp/routes.now.txt
# expect: identical or only line-number shifts

cd ..
```

Read each diff carefully:
- **Pure line-number shifts** (same endpoint paths, different line numbers): OK,
  baselines need regenerating in A5.
- **Missing endpoints** in current code that were in baseline: **STOP**.
  Report which endpoints disappeared.
- **New endpoints** in current code that weren't in baseline: probably
  Sprint 1 additions. OK; baselines need regenerating.

## A5: Baseline regeneration (for clean Sprint 2 diffs)

Sprint 1 work shifted line numbers everywhere. Regenerate the baselines
so Sprint 2 has a current snapshot to diff against:

```bash
cd client
grep -rnE 'api\(|fetch\(' src --include='*.jsx' --include='*.js' | grep -v node_modules | sort > ../.cinematic/api-calls.before.txt
grep -rnE '<Route\s+path=|path:\s*["'"'"']' src --include='*.jsx' --include='*.js' | sort > ../.cinematic/routes.before.txt
grep -rnE '^export\s+(default\s+)?function|^export\s+const\s+[A-Z]' src --include='*.jsx' --include='*.js' | sort > ../.cinematic/exports.before.txt
grep -rnE 'use[A-Z][A-Za-z]+\(' src --include='*.jsx' --include='*.js' | sort > ../.cinematic/hooks.before.txt
grep -rnE 'Provider\s+value=|<.*Provider\b' src --include='*.jsx' | sort > ../.cinematic/providers.before.txt
PATH="/c/Program Files/nodejs:$PATH" npm run build 2>&1 | tee ../.cinematic/build.before.log
du -sb dist 2>/dev/null | tee ../.cinematic/bundle.before.txt
cd ..
```

Commit the regenerated baselines:

```bash
git add .cinematic/
git commit -m "audit: regenerate Sprint 1 baselines for Sprint 2 reference

Sprint 1 merge into main shifted line numbers throughout. Regenerated
api-calls / routes / exports / hooks / providers / build / bundle
snapshots so Sprint 2's per-step diffs start from a current baseline.

No content changes to any source file."
```

## A6: STATE.md audit-phase append

Append to `.cinematic/STATE.md` (after the existing Step 13 entry):

```markdown
## Audit pass (between Sprint 1 and Sprint 2) — verify + regen baselines

Trigger: Sprint 1 was merged to main via squash; cinematic-redesign
feature branch remained local-only. Verifying nothing was lost in the
squash and the merged code is build-clean before starting Sprint 2.

Verifications run:
- main branch confirmed (`git branch --show-current` → main)
- Top commit confirmed (`7fba760 feat: cinematic redesign (Steps 0-13)`)
- npm run build (audit): exit 0, ~74.27 kB CSS, 4 pre-existing warnings
- Sprint 1 deliverable files present: CinematicBackground, AppShell,
  cinematic index.css, reduced theme.jsx (~320 lines)
- Mojibake grep on JobCard.jsx: <RESULT — clean OR fixed>
- Contract diffs: <line-shift only / clean>
- Baselines regenerated for Sprint 2 reference

Commits:
- <hotfix sha if any>  fix: restore UTF-8 in JobCard.jsx
- <font-fix sha if any>  fix: add emoji + symbol font fallbacks
- <baseline-regen sha>  audit: regenerate Sprint 1 baselines

Open issues: none — Sprint 1 verified clean on main, ready for Sprint 2.
```

Commit:

```bash
git add .cinematic/STATE.md
git commit -m "audit: STATE.md append for audit phase"
```

---

# Phase 2 — Cleanup

## C1: Delete redundant cinematic-redesign branch

The cinematic-redesign branch is now redundant — its 27 granular commits
were squash-merged to main, all code is preserved, all docs are in
STATE.md, and git reflog retains the granular SHAs for ~90 days locally.

```bash
git branch -D cinematic-redesign
git branch -a
# expect: only main (plus remotes/origin/main)
```

The cinematic-redesign branch was never pushed to origin (verified pre-prompt),
so no remote cleanup is needed.

## C2: Final repo state verification

```bash
git status --short              # clean (or only .claude/settings.local.json)
git log --oneline -10           # all recent commits visible
git branch --show-current       # main
git branch -a                   # only main + origin/main
```

Print the post-cleanup state:

```
Phase 1 + 2 complete.
Branch: main (single working branch).
Top commits:
  <list last 5-7 from git log --oneline>
Build: exit 0 / ~74.27 kB CSS / 4 pre-existing warnings
Mojibake: clean (or fixed in <sha>)
Baselines: regenerated for Sprint 2

Beginning Sprint 2.
```

**Do NOT pause here** — flow straight into Step 14.

---

# Phase 3 — Sprint 2 (Steps 14-19)

From this point forward, each step follows the discipline:

```
re-anchor → read affected files → execute → verify (build + diffs) →
append to STATE.md → commit → PAUSE for review
```

After every commit, print exactly:

```
Step N complete. SHA: <sha>
Build: exit 0 / <CSS-size> CSS / <warnings>
Diffs: api-calls clean | routes clean
Ready for Step N+1 review.
```

**PAUSE after each step.** Do not advance until the user triggers the next.

## Hard constraints

- Every `api()` call signature and endpoint path preserved.
- Hook signatures preserved.
- Router paths in App.jsx preserved.
- Job, ATS, resume data shapes preserved.
- HTTP-only session cookies + X-RM-Auth-Context header preserved.
- All OAuth gating via `GET /api/auth/oauth/status` preserved.

---

# Step 14 — Theme framework (foundational)

Refactor cinematic into a swappable theme registry. Future themes plug
in without touching consumers.

## Architecture

A theme is a structured object:

```js
{
  id: "cinematic",                 // stable key
  label: "Cinematic",              // user-facing
  description: "...",
  baseTheme: { /* THEMES.dark shape */ },
  cssVars: { /* --bg-page, --bg-card, etc. */ },
  styles: `/* per-theme CSS block */`,
  Wrapper: CinematicBackground,    // optional React component
  fonts: { display: "...", body: "..." },
}
```

## Files to create

**`client/src/themes/cinematic.js`** — extract current cinematic content:
- The `--bg-*` and `--border-glass` var values from theme.jsx's html block
- The `THEMES.dark` object (rename to `baseTheme`)
- The big inline `<style>` block (body styles, keyframes, .glass-surface,
  .rm-card*, .rm-btn*, .rm-input, .rm-badge, .rm-tag, .rm-section-label,
  .animate-in, .rm-table-row, .rm-skeleton) — paste verbatim into `styles`
- `Wrapper: CinematicBackground` (import from `../components/CinematicBackground.jsx`)
- `fonts.body`: keep the emoji-fallback chain established by the audit

**`client/src/themes/index.js`** — registry:

```js
import cinematic from "./cinematic.js";

export const THEMES_REGISTRY = { cinematic };
export const DEFAULT_THEME_ID = "cinematic";
export const AVAILABLE_THEMES = Object.values(THEMES_REGISTRY);
export function getTheme(id) {
  return THEMES_REGISTRY[id] || THEMES_REGISTRY[DEFAULT_THEME_ID];
}
```

## Files to modify

**`client/src/styles/theme.jsx`**: refactor `ThemeProvider`:
1. Read `localStorage.getItem("rm_theme_id")`, default to `DEFAULT_THEME_ID`.
2. Look up active theme via `getTheme(themeId)`.
3. Mount theme's `Wrapper` (if present).
4. Inject `cssVars` into html block + `styles` block.
5. Use `activeTheme.baseTheme` as the source for the `theme` object.
6. Provide `themeId`, `setThemeId`, `availableThemes` in context.

Context shape after refactor:
```js
{
  theme, tokens, isDark,                       // unchanged
  themeId, setThemeId, availableThemes,        // NEW
  accentId, setAccentId, ACCENT_OPTIONS,       // unchanged
}
```

`LUCY_USER_ACCENT`, `LUCY_ADMIN_ACCENT`, `ACCENT_OPTIONS` exports unchanged.

**`client/src/components/AppShell.jsx`**: use theme's Wrapper:

```jsx
import { useTheme } from "../styles/theme.jsx";

export default function AppShell({ children }) {
  const { themeId, availableThemes } = useTheme();
  const theme = availableThemes.find(t => t.id === themeId);
  const Wrapper = theme?.Wrapper;
  return (
    <>
      {Wrapper && <Wrapper />}
      <div className="relative z-10 min-h-screen">{children}</div>
    </>
  );
}
```

**`client/src/components/TopBar.jsx`**: add theme picker to UserAvatarMenu
(after accent picker). Guard with `availableThemes.length > 1` so picker
is hidden until a second theme is registered.

```jsx
const { themeId, setThemeId, availableThemes } = useTheme();
// ... in the menu, after Accent section:
{availableThemes.length > 1 && (
  <>
    <div className="rm-section-label" style={{ marginTop: 12 }}>Theme</div>
    {availableThemes.map(t => (
      <button key={t.id} onClick={() => setThemeId(t.id)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", marginBottom: 4, width: "100%",
          background: themeId === t.id ? "rgba(255,255,255,0.06)" : "transparent",
          border: themeId === t.id ? "1px solid var(--color-primary)" : "1px solid var(--border-glass)",
          borderRadius: 8, cursor: "pointer", color: "var(--color-text)",
          fontSize: 12, textAlign: "left",
        }}>
        <span style={{ fontWeight: 600 }}>{t.label}</span>
        <span style={{ marginLeft: "auto", color: "var(--color-text-faint)", fontSize: 10 }}>
          {themeId === t.id ? "Active" : "Switch"}
        </span>
      </button>
    ))}
  </>
)}
```

## Verify

```bash
PATH="/c/Program Files/nodejs:$PATH" npm --prefix client run build 2>&1 | tail -15
```

Expect exit 0, CSS bundle within ±2 KB of baseline, no new warnings.

In dev mode (manual smoke): app looks identical to before — cinematic
video, glass nav, all panels render the same. Theme picker hidden
(only 1 theme registered).

```bash
cd client
grep -rnE 'api\(|fetch\(' src --include='*.jsx' --include='*.js' | grep -v node_modules | sort > /tmp/api-calls.now.txt
diff ../.cinematic/api-calls.before.txt /tmp/api-calls.now.txt && echo "api-calls clean"
cd ..
```

## Commit

```bash
git add client/src/themes/ client/src/styles/theme.jsx client/src/components/AppShell.jsx client/src/components/TopBar.jsx
git commit -m "step 14: theme framework refactor

Extract cinematic palette into themes/cinematic.js. New themes/index.js
registry exposes AVAILABLE_THEMES + getTheme(). ThemeProvider reads
active theme from localStorage, looks up via registry, mounts the
theme's optional Wrapper component, injects per-theme cssVars + styles.

AppShell now uses theme.Wrapper instead of hardcoded CinematicBackground.
TopBar UserAvatarMenu gains a theme picker, hidden when only one theme
is registered.

Decisions:
- Theme is a structured object with optional Wrapper, cssVars, styles
- Wrapper renders inside AppShell — themes can opt out of video bg
- localStorage key 'rm_theme_id'
- Accent picker untouched (orthogonal personalization)

Divergences from spec: none."
```

Append Step 14 entry to STATE.md per the standard template. PAUSE.

---

# Step 15 — Inline login popover on landing

Replace `/login` navigation from the Sign In button with a Radix Popover
containing credentials form + OAuth buttons. `/login` route preserved
as fallback for direct URL access.

## File to create

**`client/src/components/InlineLoginPopover.jsx`** — Radix Popover with:
- Username/password form (submit calls `/api/auth/login`)
- OAuth buttons gated by `/api/auth/oauth/status` (loaded on popover open)
- Link to `/register`
- liquid-panel container, liquid-glass buttons

```jsx
import { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { api, setAuthContext } from "../lib/api.js";

const OAUTH_PROVIDERS = ["google", "linkedin", "github"];

export default function InlineLoginPopover({ trigger, onLogin, align = "end", sideOffset = 8 }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);

  useEffect(() => {
    if (!open) return;
    api("/api/auth/oauth/status").then(setOauthStatus).catch(() => {});
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      const d = await api("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }),
      });
      if (d.success && d.user) {
        if (d.authContext) setAuthContext(d.authContext);
        setOpen(false);
        onLogin?.(d.user);
      } else { setError(d.error || "Login failed"); }
    } catch (err) { setError(err?.message || "Network error"); }
    finally { setLoading(false); }
  };

  const handleOAuth = (provider) => {
    window.location.href = `/api/auth/oauth/${provider}/start`;
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={sideOffset}
          className="liquid-panel"
          style={{ width: 320, padding: 20, borderRadius: 16, zIndex: 1000, color: "var(--color-text)" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, marginBottom: 4 }}>
            Welcome back
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 16 }}>
            Sign in to your account
          </div>
          <form onSubmit={handleSubmit}>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Username or email" autoComplete="username" required
              style={{ width: "100%", height: 38, padding: "0 12px", marginBottom: 8,
                background: "var(--bg-input)", border: "1px solid var(--border-glass)",
                borderRadius: 8, color: "var(--color-text)", fontSize: 13, outline: "none" }}/>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" autoComplete="current-password" required
              style={{ width: "100%", height: 38, padding: "0 12px", marginBottom: 8,
                background: "var(--bg-input)", border: "1px solid var(--border-glass)",
                borderRadius: 8, color: "var(--color-text)", fontSize: 13, outline: "none" }}/>
            {error && (
              <div style={{ color: "var(--color-warning, #f59e0b)", fontSize: 11, marginBottom: 8 }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} className="liquid-glass"
              style={{ width: "100%", height: 40, borderRadius: 999, fontSize: 13, fontWeight: 600,
                cursor: "pointer", color: "var(--color-text)", opacity: loading ? 0.6 : 1, marginBottom: 12 }}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {oauthStatus && OAUTH_PROVIDERS.some(p => oauthStatus[p]?.configured) && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10,
                color: "var(--color-text-faint)", textTransform: "uppercase",
                letterSpacing: "0.1em", marginBottom: 10 }}>
                <div style={{ flex: 1, height: 1, background: "var(--border-glass)" }}/>
                or
                <div style={{ flex: 1, height: 1, background: "var(--border-glass)" }}/>
              </div>
              {OAUTH_PROVIDERS.filter(p => oauthStatus[p]?.configured).map(p => (
                <button key={p} onClick={() => handleOAuth(p)} type="button"
                  className="liquid-glass"
                  style={{ width: "100%", height: 36, borderRadius: 999, fontSize: 12, fontWeight: 500,
                    cursor: "pointer", color: "var(--color-text)", marginBottom: 6, textTransform: "capitalize" }}>
                  Continue with {p}
                </button>
              ))}
            </>
          )}
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 12, textAlign: "center" }}>
            No account? <a href="/register" style={{ color: "var(--color-primary)", textDecoration: "none" }}>Create one</a>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

## Files to modify

**`client/src/components/NavBar.jsx`**: read first to find the Sign In
button. Wrap it in `<InlineLoginPopover trigger={<existing button>} onLogin={onLogin}/>`.

**`client/src/App.jsx`**: pass `onLogin` to NavBar:

```jsx
const navBar = (
  <NavBar user={authUser} onLogout={handlePublicLogout}
    onLogin={(user) => { setAuthUser(user); setAuthStatus("authenticated"); }}/>
);
```

## Verify + commit

Build clean. Dev mode: clicking Sign In opens the popover, credentials
submit logs in inline, OAuth buttons render only for configured providers.

```
step 15: inline login popover on landing

NavBar Sign In button opens a Radix Popover with credentials form +
OAuth buttons (gated by /api/auth/oauth/status). Submit logs in via
existing endpoint, updates app auth state via onLogin callback. /login
route preserved for direct URL access.

Divergences from spec: none.
```

PAUSE.

---

# Step 16 — Remove emoji icons from BelowFoldContent

## File to modify

**`client/src/components/BelowFoldContent.jsx`**:

- Remove `icon` field from FEATURES array.
- Remove `useTheme()` import and `theme` destructure.
- Replace icon `<div>` with numbered badge `01 / 02 / 03 / 04` in
  display serif + thin accent rule.
- Replace `theme.text` / `theme.textMuted` / `theme.accent` with CSS
  vars (`var(--color-text)`, `var(--color-text-muted)`, `var(--color-primary)`).

New card JSX pattern (inside the existing `.map`):

```jsx
{FEATURES.map((f, i) => (
  <div key={f.title} style={{
    background: "var(--bg-card)",
    backdropFilter: "var(--bg-blur-sm)", WebkitBackdropFilter: "var(--bg-blur-sm)",
    border: "1px solid var(--border-glass)", borderRadius: 12,
    padding: "24px 22px",
  }}>
    <div style={{
      fontFamily: "var(--font-display, 'Instrument Serif', serif)",
      fontSize: 28, fontWeight: 400,
      color: "var(--color-primary)",
      letterSpacing: "-0.02em", lineHeight: 1, marginBottom: 4,
    }}>{String(i + 1).padStart(2, "0")}</div>
    <div style={{
      width: 24, height: 1.5, background: "var(--color-primary)",
      opacity: 0.4, marginBottom: 14,
    }}/>
    <div style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text)", marginBottom: 6 }}>{f.title}</div>
    <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.6 }}>{f.desc}</div>
  </div>
))}
```

CTA at bottom: `background: theme.accent` → `background: "var(--color-primary)"`.

## Verify + commit

```
step 16: remove emoji icons from BelowFoldContent

Replaced stock emoji (✦, 🎯, ✉, ⚡) with numbered badges (01/02/03/04)
in display serif + thin accent rule. Removed useTheme dependency;
all colors via CSS vars (consistent with Step 11 marketing pages).

Divergences from spec: none.
```

PAUSE.

---

# Step 17 — Relocate PosterBanner to landing bottom

## Files to modify

**`client/src/components/PosterBanner.jsx`** — rewrite as horizontal marquee:

```jsx
const POSTER_CARDS = [
  { headline: "ATS-Optimised Resumes", sub: "Generated from the job description" },
  { headline: "Land Your Next Role",   sub: "Intelligent resume generation" },
  { headline: "Apply Smarter",          sub: "Not harder — let AI do the heavy lifting" },
  { headline: "Track Every Application",sub: "Never lose a lead again" },
  { headline: "AI-Powered Writing",     sub: "Claude rewrites every bullet" },
  { headline: "Ghost Job Detection",    sub: "Filtered before you even see them" },
  { headline: "One-Click Autofill",     sub: "Chrome extension fills forms instantly" },
  { headline: "Beat the Screener",      sub: "ATS scoring on every generated resume" },
];

const items = [...POSTER_CARDS, ...POSTER_CARDS];

export function PosterBanner() {
  return (
    <div style={{
      width: "100%", overflow: "hidden", padding: "60px 0",
      maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      WebkitMaskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
    }}>
      <style>{`
        @keyframes posterScrollLeft {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .poster-track { animation: posterScrollLeft 60s linear infinite; }
        .poster-track:hover { animation-play-state: paused; }
      `}</style>
      <div className="poster-track" style={{ display: "flex", gap: 16, width: "max-content" }}>
        {items.map((c, i) => (
          <div key={i} style={{
            flexShrink: 0, width: 280,
            background: "var(--bg-card)",
            backdropFilter: "var(--bg-blur-sm)", WebkitBackdropFilter: "var(--bg-blur-sm)",
            border: "1px solid var(--border-glass)", borderRadius: 14,
            padding: "20px 22px",
          }}>
            <div style={{
              fontFamily: "var(--font-display, 'Instrument Serif', serif)",
              fontSize: 18, fontWeight: 400, color: "var(--color-text)",
              marginBottom: 6, letterSpacing: "-0.01em", lineHeight: 1.2,
            }}>{c.headline}</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5 }}>{c.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**`client/src/components/AuthScreen.jsx`** — remove PosterBanner mount
and restructure from 2-column to 1-column centered. Read the file first;
strip the right column entirely. Form column expands to centered.

**`client/src/pages/LandingPage.jsx`** — add at the very bottom of `<main>`:

```jsx
import { PosterBanner } from "../components/PosterBanner.jsx";
// ... in JSX, after <BelowFoldContent />:
{!authUser && <PosterBanner />}
```

## Verify + commit

```
step 17: relocate PosterBanner to landing bottom, horizontalize

Moved PosterBanner from AuthScreen (2-col vertical) to LandingPage
bottom (full-width horizontal marquee). Removed emoji icons; cards
typography-led with display serif headlines.

AuthScreen restructured 2-col → 1-col centered.

PosterBanner renders only when logged out.

Divergences from spec: none.
```

PAUSE.

---

# Step 18 — Portaled drawer for JobDetailPanel

Lift selectedJob from JobsPanel local state to JobBoardContext.
Convert JobDetailPanel to portal'd slide-in drawer.

## Files to modify

**`client/src/contexts/JobBoardContext.jsx`** — add `selectedJob`,
`setSelectedJob` to state and context value. Read first; the addition
is two lines of useState + two keys in the provider value.

**`client/src/panels/JobsPanel.jsx`** — replace local `selectedJob`
useState with `useJobBoard().selectedJob`. Setter from context.
Remove the split-panel JobDetailPanel render (drawer mounts at app root).

**`client/src/components/JobDetailPanel.jsx`** — major refactor:

```jsx
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useJobBoard } from "../contexts/JobBoardContext.jsx";

export default function JobDetailPanel() {
  const { selectedJob, setSelectedJob } = useJobBoard();
  const closeBtnRef = useRef(null);

  const close = () => setSelectedJob(null);

  useEffect(() => {
    if (!selectedJob) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedJob]);

  return createPortal(
    <AnimatePresence>
      {selectedJob && (
        <>
          <motion.div key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }} onClick={close}
            className="fixed inset-0 z-30"
            style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}/>
          <motion.div key="drawer"
            initial={{ x: 560, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 560, opacity: 0 }}
            transition={{ type: "spring", damping: 26, stiffness: 220 }}
            className="liquid-panel"
            style={{
              position: "fixed", right: 16, top: 80, bottom: 16,
              width: "min(560px, 92vw)", borderRadius: 16,
              zIndex: 40, overflow: "hidden",
              display: "flex", flexDirection: "column",
            }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "16px 20px", borderBottom: "1px solid var(--border-glass)",
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text)", flex: 1 }}>
                {selectedJob.company} — {selectedJob.title}
              </div>
              <button ref={closeBtnRef} onClick={close} className="liquid-glass"
                style={{ width: 32, height: 32, borderRadius: 999,
                  display: "grid", placeItems: "center", cursor: "pointer",
                  color: "var(--color-text)" }} aria-label="Close detail">×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              {/* PRESERVE ALL EXISTING JobDetailPanel CONTENT HERE:
                  action bar (Generate, Preview, PDF, Apply, Queue Auto,
                  Close Browser, Star, Pass, Cover Letter — all handlers
                  intact), scrollable description with HighlightedDescription,
                  direct apply link at bottom. Wire to selectedJob from
                  context, not from props. */}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
```

**`client/src/App.jsx`** — mount `<JobDetailPanel/>` inside the
AppDashboard's JobBoardProvider scope. The drawer renders its content
only when selectedJob is set; harmless when not.

## Verify + commit

```
step 18: portaled drawer for JobDetailPanel

Lifted selectedJob from JobsPanel local state to JobBoardContext.
JobDetailPanel reads from context, renders via createPortal to
document.body, framer-motion spring slide-in from right. Backdrop +
ESC + click-to-close. Close button focused on open.

Preserved all action handlers: Generate, Preview, PDF, Apply, Queue
Auto, Close Browser, Star, Pass, Cover Letter. Network surface unchanged.

JobsPanel split-panel layout removed — full width for card grid.

Decisions:
- Drawer mounts inside AppDashboard's JobBoardProvider scope (option B
  per spec). Drawer-from-non-dashboard routes deferred.

Divergences from spec: focus restoration to originating card not
implemented; tracked as polish item.
```

PAUSE.

---

# Step 19 — Unified signed-in home

Fold panel switcher into UnifiedSearchBar. Remove DashboardTabsLayout.
AppDashboard structure mirrors LandingPage.

## Files to modify

**`client/src/components/UnifiedSearchBar.jsx`** — add optional `tabs`,
`activeTab`, `onTabChange` props. Render tab strip above search inputs
when tabs provided:

```jsx
{tabs && tabs.length > 0 && (
  <div style={{
    display: "flex", gap: 4, padding: "8px 12px 0",
    borderBottom: "1px solid var(--border-glass)",
  }}>
    {tabs.map(t => (
      <button key={t.id} onClick={() => onTabChange?.(t.id)}
        style={{
          padding: "8px 14px",
          background: activeTab === t.id ? "rgba(255,255,255,0.06)" : "transparent",
          border: activeTab === t.id ? "1px solid var(--color-primary)" : "1px solid transparent",
          borderRadius: 999,
          color: activeTab === t.id ? "var(--color-text)" : "var(--color-text-muted)",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
          textTransform: "uppercase", letterSpacing: "0.08em",
        }}>{t.label}</button>
    ))}
  </div>
)}
```

**`client/src/App.jsx`** — rewrite `AppDashboard`. Delete
`DashboardTabsLayout`. New shape:

```jsx
function AppDashboard({ authUser, setAuthUser }) {
  const { theme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [jobBoardRefreshKey, setJobBoardRefreshKey] = useState(0);
  const [uiMode, setUiMode] = useState("hero");
  const DOCK_THRESHOLD = 80;
  const consolePath = `/app/${CONSOLE_ROUTE}`;
  const routeKey = location.pathname.replace(/^\/app\/?/, "") || "";
  const activeTab = routeKey === CONSOLE_ROUTE || LEGACY_CONSOLE_ROUTES.has(routeKey) || routeKey === ""
    ? "console" : routeKey;
  const appTabs = [
    { id: "console",      label: "Jobs" },
    { id: "job-profiles", label: "Job Profiles" },
    { id: "database",     label: "Database" },
  ];

  // PRESERVE: handleLogout, handlePanelChange, handleProfileActivate,
  // useInactivityLogout, useSyncEvents, all existing useEffects.

  // Scroll-driven hero ↔ dock
  useEffect(() => {
    const onScroll = () => setUiMode(window.scrollY > DOCK_THRESHOLD ? "dock" : "hero");
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <JobBoardProvider>
      <AppScrollProvider>
        <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 13,
          minHeight: "100vh", display: "flex", flexDirection: "column", color: theme.text }}>
          <TopBar user={authUser} onLogout={handleLogout}
            onUserChange={setAuthUser} onProfileActivate={handleProfileActivate}/>
          {activeTab === "console" && uiMode === "hero" && (
            <div style={{ textAlign: "center", padding: "80px 20px 40px",
              animation: "fadeUp 0.6s ease both" }}>
              <div style={{
                fontFamily: "var(--font-display, 'Instrument Serif', serif)",
                fontSize: "clamp(2rem, 5vw, 4rem)", fontWeight: 400,
                color: "var(--color-text)", letterSpacing: "-0.025em", marginBottom: 8,
              }}>
                {authUser?.first_name ? `Welcome back, ${authUser.first_name}.` : "Your jobs."}
              </div>
              <div style={{
                fontSize: 14, color: "var(--color-text-muted)",
                maxWidth: 520, margin: "0 auto",
              }}>Pick up where you left off.</div>
            </div>
          )}
          <UnifiedSearchBar mode={uiMode} tabs={appTabs} activeTab={activeTab}
            onTabChange={handlePanelChange}
            onSearch={() => {}} onLocalFilter={() => {}}/>
          <main style={{ flex: 1, paddingTop: uiMode === "dock" ? 80 : 24 }}>
            {activeTab === "console" && (
              <JobsConsole user={authUser} onUserChange={setAuthUser}
                refreshKey={jobBoardRefreshKey} isActive={activeTab === "console"}/>
            )}
            {activeTab === "database"      && <DatabasePanel user={authUser}/>}
            {activeTab === "integrations"  && <IntegrationsPanel/>}
            {activeTab === "plans"         && <PlansPanel user={authUser} onUserChange={setAuthUser}/>}
            {activeTab === "profile"       && <ProfilePanel user={authUser} onOpenJobProfiles={() => handlePanelChange("job-profiles")}/>}
            {activeTab === "job-profiles"  && <JobProfilesPanel/>}
          </main>
          <JobDetailPanel/>
        </div>
      </AppScrollProvider>
    </JobBoardProvider>
  );
}
```

Delete the entire `function DashboardTabsLayout(...)` definition from App.jsx.

Verify TopBar doesn't still render panel tabs (Step 7 should have removed them).

## Verify + commit

```
step 19: unified signed-in home architecture

Removed DashboardTabsLayout. Folded panel switcher (Jobs / Job Profiles
/ Database) into UnifiedSearchBar via new tabs prop. AppDashboard now
mirrors LandingPage: hero (Jobs panel only) → UnifiedSearchBar with
tabs → active panel content. Scroll-driven hero ↔ dock convergence
reused from LandingPage.

TopBar remains as always-visible glass chrome with logo + utility icons.
JobDetailPanel mounted inside JobBoardProvider scope so drawer renders
from any panel.

Decisions:
- Hero only on Jobs panel — feels out of place on Job Profiles / Database
- Welcome copy reads firstName when available, fallback "Your jobs."

Divergences from spec: none.
```

PAUSE.

---

# Final report

After Step 19 commits and STATE.md is updated, print:

```
Sprint 2 complete (Steps 14-19) on branch main.

Audit phase:
  - <hotfix sha or "no mojibake hotfix needed">
  - <font-fix sha or "font fallback already present">
  - audit baselines regenerated: <sha>

Cleanup phase:
  - cinematic-redesign branch deleted

Sprint 2 commits:
  - step 14 (theme framework):   <sha>
  - step 15 (inline login):      <sha>
  - step 16 (emoji removal):     <sha>
  - step 17 (poster relocate):   <sha>
  - step 18 (portaled drawer):   <sha>
  - step 19 (unified home):      <sha>

Final build: exit 0 / <CSS-size> CSS / <warnings>
Final diffs: api-calls clean | routes clean

Single branch: main
Theme framework: 1 theme registered (cinematic); picker hidden until more added
Inline login: live
Emoji-free: BelowFoldContent + PosterBanner
PosterBanner: landing bottom, horizontal marquee
JobDetailPanel: portaled drawer
Signed-in home: unified — single UnifiedSearchBar with panel tabs

Ready for visual review.
```

**Do NOT advance** — wait for user review.

---

# Failure handling

- **Build fails**: read the error. Common causes:
  - Theme refactor: wrong import path in themes/cinematic.js
  - framer-motion drawer: initial-state mismatch causing render flash
  - Context destructure typo when lifting selectedJob
  - Tailwind v4 arbitrary-value syntax with whitespace
  Fix forward unless approach is fundamentally wrong; then `git restore .`
- **Contract diff non-empty**: STOP and surface. Never adapt frontend
  to swallow an API change.
- **Mojibake check fails after hotfix**: STOP. Don't extend the byte-map
  by guessing — surface unmapped patterns to the user.
- **Compaction mid-step**: STOP, re-read this prompt + STATE.md + the
  current step's spec, resume from the step's anchor.
- **Ambiguous contract**: ask user. **Ambiguous visual**: pick
  cinematic-restrained option, note in STATE.md under Decisions.

Begin with Phase 1 (audit). Flow straight into Phase 2 (cleanup) when
audit is clean. Then begin Step 14 with its re-anchor commands.
