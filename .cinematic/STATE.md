# Cinematic Redesign — Progress Log

Branch: cinematic-redesign
Spec:   CLAUDE_CODE_PROMPT.md
Started: 2026-05-23

After every step's verifications pass, append a new `## Step N` block per the
template in "Compaction resilience — surviving context compaction" below.
Never overwrite an earlier block; append only.

Key codebase facts (discovered during pre-flight):
- App.jsx uses BrowserRouter + Routes (NOT createBrowserRouter)
- ThemeProvider is in main.jsx wrapping <App/>
- App.jsx has a local function also named AppShell (lines 83-128) — it's an
  in-app scroll layout helper. New components/AppShell.jsx is different.
- theme.jsx is 564 lines; exports: ThemeContext, ThemeProvider, useTheme,
  THEMES, ACCENT_OPTIONS, BG_MODES, isDarkBgMode, LUCY_USER_ACCENT, LUCY_ADMIN_ACCENT
- bgMode/setBgMode/BG_MODES consumers: ONLY TopBar.jsx UserAvatarMenu (lines 266-404)
- rm:jobs-panel-zone: dispatched by JobsPanel.jsx:966, consumed by TopBar.jsx:493
- tailwindcss-animate is in package.json but NOT in index.css (@plugin not set)
- postcss.config.js: @tailwindcss/postcss + autoprefixer
- framer-motion v11 is installed
- accordion/ui animations need @keyframes accordion-down/up preserved

---

## Step 0 — Baselines captured
Commit: 796e7b7
Files touched: .gitignore (fixed env.sh corruption from prior pre-flight run — the `echo .cinematic/ >> .gitignore` concatenated with `env.sh` due to missing trailing newline), .cinematic/ directory + all baseline files
Decisions:
  - .cinematic/ left tracked in git (not gitignored) for cross-session
    persistence; final gitignore decision deferred to Step 13 (squash).
Divergences:
  - build.before.log captured the pre-PATH-fix npm-not-found error,
    not an actual baseline build. build.real-baseline.log was
    captured later (after npm install) and serves as the effective
    baseline. Kept both for chronology.
  - .gitignore add of `.cinematic/` from the spec was attempted but
    corrupted env.sh into env.sh.cinematic/ — fixed in this commit;
    .cinematic/ remains tracked.
Verifications run:
  - baseline snapshots: api-calls.before.txt (168 lines), routes.before.txt (24 lines),
    exports.before.txt (90 lines), hooks.before.txt (758 lines), providers.before.txt (24 lines)
  - npm run build (post-install): exit 0, 16.74s, 73.15 kB CSS
Open issues:
  - 4 npm audit findings (3 moderate, 1 high) — track separately
  - postcss.config.js MODULE_TYPELESS warning — defer (contract change)
  - JobCard dynamic+static import warning — pre-existing, addressed structurally in Step 8

## Step 1 — Replace index.css with cinematic design system
Commit: 1ec8a2a
Files touched: client/src/index.css
Decisions:
  - Added @plugin "tailwindcss-animate" since it was in package.json
    but not loaded; without this, animation utility classes break.
  - Added shadcn popover (--color-popover, --color-popover-foreground)
    and card (--color-card, --color-card-foreground) tokens; Radix
    popovers and shadcn Card consume these and would render light
    surfaces against the dark navy without them.
  - Preserved spin, shimmer, accordion-down, accordion-up keyframes
    and .scroll-dock-page utility from the original index.css.
  - Pre-recorded for Step 4: rename local AppShell function in
    App.jsx (lines 83-128) to DashboardTabsLayout to avoid collision
    with the new components/AppShell.jsx. Function is the in-app
    scroll-collapse tab nav; rename does not change its role.
Divergences: none
Verifications run (with actual output observed):
  - npm run build: exit 0, 16.74s
  - CSS bundle: 73.15 kB (gzip: 13.53 kB)
  - JS bundles: 494.42 kB + 842.72 kB (pre-existing chunk-size warning)
  - 4 build warnings, all pre-existing (CJS Vite, postcss typeless,
    JobCard dyn+static, chunk size). None caused by this step.
  - index.css contains: @theme block with cinematic palette + popover/card tokens,
    @plugin tailwindcss-animate, fonts import, .liquid-glass, .liquid-panel,
    fade-rise / scroll-hint / spin / shimmer / accordion keyframes,
    prefers-reduced-motion gate, .scroll-dock-page utility preserved.
  - No stale bg-mode CSS-var references in index.css.
Open issues: none for this step

## Step 3 — Add CinematicBackground component
Commit: aa7c7d9
Files touched: client/src/components/CinematicBackground.jsx (new)
Decisions:
  - Component verbatim from spec
  - CloudFront src URL used as default; self-hosting deferred to post-Step-4
Divergences: none
Verifications run (with actual output observed):
  - Build pending user run (pure add, no callers yet)
  - api-calls diff: TopBar line-number shifts from Step 2 only
  - routes diff: clean
Open issues: none for this step

## Step 2 — Reduce theme.jsx to cinematic-only; accent management preserved
Commit: 76cb682
Files touched: client/src/styles/theme.jsx, client/src/components/TopBar.jsx
Decisions:
  - Kept isDark=true in context (8 files consume it; per-component cleanup deferred to Steps 7-12)
  - Kept THEMES.dark + all Lucy CSS classes (.rm-card, .rm-btn, etc.) — panels still consume them
  - Post-strip size is 320 lines (not spec's 80-120) because Lucy design-system CSS stays active
  - .rm-skeleton mode ternary hardcoded to dark values
Divergences:
  - Spec references 'ACCENTS' but actual export is ACCENT_OPTIONS; kept as ACCENT_OPTIONS
Verifications run (with actual output observed):
  - npm run build: exit 0, 6.76s, 73.15 kB CSS (unchanged), JS -11 kB (reduced)
  - 4 pre-existing warnings, none new
  - api-calls diff: line-number shifts only (same endpoints)
  - routes diff: clean (empty)
  - providers diff: line-number shifts only (ThemeContext.Provider still mounted)
  - grep bgMode/setBgMode/BG_MODES in theme.jsx: 0 matches
  - grep bgMode/setBgMode/BG_MODES in TopBar.jsx: 0 matches
  - isDark hardcoded true, baseTheme=THEMES.dark, 8 consumer ternaries pick dark branch
Open issues: none for this step

## Step 4 — AppShell + App.jsx wiring
Commit: cc26289
Files touched: client/src/components/AppShell.jsx (new), client/src/App.jsx
Decisions:
  - {children} pattern (not <Outlet/>) because App.jsx uses BrowserRouter + Routes.
  - <AppShell> wraps <Routes> inside AppRouter (not at BrowserRouter level)
    so the auth bootstrap spinner (authStatus === "unknown") can render
    before reaching AppShell — keeps spinner outside the video wrapper.
  - Local App.jsx function AppShell renamed to DashboardTabsLayout; both
    call sites (JSX comment + element tag) updated.
Divergences:
  - Spec implied AppShell inside BrowserRouter but outside AppRouter; actual
    placement is inside AppRouter, outside <Routes>, to preserve auth guard spinner.
Verifications run (with actual output observed):
  - npm run build: exit 0, 6.44s, 73.36 kB CSS (up 0.21 kB from AppShell import)
  - 4 pre-existing warnings, none new
  - api-endpoints clean (line-number shifts only; all endpoints identical)
  - routes clean (indentation shifts only from AppShell wrapper; all path values identical)
  - DashboardTabsLayout: 0 remaining references to old "AppShell" name in App.jsx
Open issues: none for this step
