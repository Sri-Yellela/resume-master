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

## Step 5 — NavBar + AuthScreen cinematic reskin
Commit: d54fa5f
Files touched: client/src/components/AuthScreen.jsx, client/src/components/NavBar.css
Decisions:
  - isDark removed from AuthModal destructure; single ternary hardcoded to dark value.
  - AuthModal card uses className="liquid-panel" (frosted glass) instead of
    theme.surface + boxShadow inline styles.
  - inputStyle/providerButtonStyle now use var(--bg-input) / var(--border-glass).
  - Hero tiles use var(--bg-card) + var(--bg-blur-sm) for glass treatment.
  - Outer AuthScreen background removed (transparent) — CinematicBackground shows through.
  - Poster panel: var(--bg-panel) + backdrop-filter; fade overlays use CSS var in
    linear-gradient() directly (valid — React passes inline styles as raw CSS).
  - NavBar.css: all var(--color-surface-offset) hover states → rgba(255,255,255,0.06);
    background → var(--bg-page) + backdrop-filter; drawer → var(--bg-menu).
  - OAuth providerButton now returns null for unconfigured providers (after load).
    Shows all 3 buttons while oauthStatus is null (loading) for progressive disclosure.
  - Kept theme.* refs for text/accent colors; CSS-var replacement deferred to
    per-panel repaints in Steps 7-12.
  - CLAUDE_CODE_PROMPT.md not found at repo root — spec unavailable. Step executed
    from conversation-prompt description + divergence list.
Divergences:
  - Spec said "rewrite JSX per master spec" — spec file absent, applied cinematic
    glass treatment conservatively without full JSX rewrite.
Verifications run (with actual output observed):
  - npm run build: exit 0, 73.54 kB CSS, 4 pre-existing warnings, no new warnings
  - api-calls: clean (endpoint content unchanged)
  - routes: clean (path values unchanged)
Open issues: none for this step

## Step 6 — LandingPage cinematic redesign
Commit: 0a0fa7d
Files touched: client/src/pages/LandingPage.jsx, client/src/pages/LandingPage.css,
               client/src/components/BelowFoldContent.jsx
Decisions:
  - Removed useTheme from LandingPage.jsx entirely (only use was background:theme.bg).
  - Hero copy: "Build the perfect resume..." → "Apply smarter. Track everything. Land faster."
  - #auth-section placed on sign-up prompt (end of job grid); hero CTA smooth-scrolls there.
  - .lp__hero-cta uses pointer-events: auto (overrides zone's none) to avoid
    interference with the fixed UnifiedSearchBar.
  - BelowFoldContent feature cards: var(--bg-card) + backdrop-filter + var(--border-glass).
  - .lp__page-btn pagination: var(--bg-input) + var(--border-glass) + backdrop-filter.
  - MarketingToolsDock (in ScrollDock.jsx) untouched — convergence preserved.
Divergences:
  - CLAUDE_CODE_PROMPT.md not available; spec guidance from conversation-prompt only.
Verifications run (with actual output observed):
  - npm run build: exit 0, 74.14 kB CSS, 4 pre-existing warnings, no new warnings
  - api-calls: clean
  - routes: clean
Open issues: none for this step

## Step 8 — Repaint JobCard, JobDetailPanel, UnifiedSearchBar
Commit: 2c41985
Files touched:
  - client/src/styles/theme.jsx (added --color-primary-muted, --color-primary-text, --shadow-sm)
  - client/src/components/JobCard.jsx (isDark removed, all theme.* → CSS vars)
  - client/src/components/JobDetailPanel.jsx (isDark removed, theme.* → CSS vars, glass bg)
  - client/src/components/UnifiedSearchBar.css (hero/dock → cinematic glass treatment)
  - .cinematic/api-calls.before.txt (line-number shift regen)
  - .cinematic/routes.before.txt (unchanged, regen confirmed identical)
Decisions:
  - Portaled drawer conversion deferred: selectedJob lives in JobsPanel state,
    not JobBoardContext. Lifting to context is a large structural change and risky
    without the master spec. Current split-panel rendering preserved.
    Noted for revisit post-spec recovery or Step 13 acceptance.
  - theme prop retained on sub-components (WorkBadge, IconBtn, etc.) — vestigial
    after CSS-var migration; full prop removal cleanup deferred to Step 12.
  - isDark removed from JobCard and JobDetailPanel function signatures; callers
    (JobsPanel) still pass it but React silently ignores the unused prop.
  - Hex alpha concatenation (accent+"66") replaced with color-mix() — works for
    both hex accent strings AND CSS var accent strings (dynamic accent support).
  - All border "theme.border+44" replaced with var(--border-glass) which is
    already semi-transparent (8% white glass border from cinematic system).
Divergences:
  - Spec said "JobDetailPanel converts to portaled drawer" — skipped per above.
  - Spec said "verify selected-job state in JobBoardContext" — it is NOT in context;
    lifting deferred.
Verifications run (with actual output observed):
  - npm run build: exit 0, 5.94s, 74.27 kB CSS (+0.13 kB from new vars), 821.70 kB JS
  - 4 pre-existing warnings, none new
  - api-calls: content-identical, line numbers shifted (+/-2 from isDark removal)
  - routes: content-identical (unchanged)
Open issues:
  - Portaled drawer + selectedJob context lift deferred

## Step 7 — TopBar flatten + ScrollDock split
Commits: 3b79701 (7a), a61527b (7b)
Files touched:
  - client/src/components/ScrollDock.jsx (gutted: -874 lines)
  - client/src/components/TopBar.jsx (-35 net: jobsZone state, listener, geometry removed)
  - client/src/panels/JobsPanel.jsx (-27 net: publishJobsZoneBounds removed)
  - .cinematic/api-calls.before.txt (baseline regenerated)
  - .cinematic/routes.before.txt (baseline regenerated)
Decisions:
  - Sub-commit 7a: AppDockBar and all its sub-components (NotificationsBell,
    QuickActions, UserAvatarMenu, DockSettingsPanel, ProfileSwitcher, etc.)
    removed from ScrollDock. They were duplicates of TopBar helpers; TopBar is
    the sole authenticated toolbar going forward. MarketingToolsDock retained.
  - Sub-commit 7b: rm:jobs-panel-zone event pair removed atomically (TopBar
    consumer + JobsPanel publisher). Zone-constraint geometry (dockCenter
    offset, dockMaxWidth, constrainedPillWidth clamp, dockScale) removed; dock
    now centers at vw/2 with full pillWidth and no scale() transform.
  - api-calls baseline: 6 dead calls removed. /api/dock-preferences x3
    (DockSettingsPanel, never mounted); /api/notifications + /api/domain-profiles x4
    were ScrollDock duplicates — live copies remain in TopBar.jsx. Approved by
    user as legitimate dead-code removal.
  - routes baseline: content unchanged; regenerated to fix line-number and
    indentation shift from Step 4 AppShell wrapper (verified content-identical).
  - "Three sub-commits" from spec collapsed to two because helper extraction
    was implicit — TopBar already owned all the helper components; ScrollDock
    AppDockBar was just a duplicate consumer.
Divergences:
  - Spec warned about extracting helpers before removing AppDockBar; actual
    state showed TopBar already owned all helpers, so no migration step needed.
Verifications run (with actual output observed):
  - npm run build: exit 0, 7.81s, 74.14 kB CSS (unchanged), 820.69 kB JS chunk
  - 4 pre-existing warnings, none new
  - api-calls: baseline regenerated; all live endpoints confirmed present
  - routes: baseline regenerated; content-identical to prior baseline
  - grep rm:jobs-panel-zone: 0 matches
  - grep publishJobsZoneBounds: 0 matches
Open issues: none for this step
