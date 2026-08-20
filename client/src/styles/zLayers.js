// ── The z-index scale ────────────────────────────────────────────────────────────────────────
//
// One ordered scale, named, in one file. Before this there were twelve-plus ad-hoc values spread
// across components, and the ordering between any two surfaces was an accident of whoever picked
// the larger number: the app search bar sat at 50, a date popover inside the Applications sheet at
// 300, the job-detail drawer at 30/40 (i.e. UNDER the search bar), TopBar at 1000, a dropdown
// portal at 10000, and NavBar.css carried the comment "above UnifiedSearchBar (z-index:200)" —
// a hardcoded cross-reference to another component's number, which is the clearest possible sign
// that the values had become a shared secret rather than a design.
//
// Two rules make this a scale rather than a fresh set of magic numbers:
//
//   1. Read the TIER, not the number. Callers import a name. The integers exist only to be
//      compared, and are spaced so a surface can be slotted between two tiers without renumbering.
//   2. A raw bump is not a fix. If a surface renders below something it should cover, the question
//      is which TIER it belongs to. And if it is being CLIPPED rather than underlapped — an
//      absolutely-positioned child inside an `overflow:hidden` ancestor — no z-index value of any
//      size will help, because clipping happens before stacking is considered. That case needs a
//      portal out of the clipping ancestor (see PANEL_POPOVER's note).
//
// The chosen integers deliberately preserve the existing relationships that were already correct,
// so surfaces not yet migrated keep behaving exactly as they do today. Anything above NAV in the
// app (the 9000-series full-screen modals in CompanyViewModal / CoverLetterModal / ImportJobModal,
// and ScrollDock's marketing-only 9998 hamburger) is intentionally left alone: they are full-screen
// takeovers with no ordering dispute against these tiers, and renumbering them would be churn with
// no defect behind it.
export const Z = {
  // In-flow application content: the board, the Applications table, panel bodies.
  CONTENT: 0,

  // Popovers OWNED BY panel content — a date picker in a table cell, an inline autocomplete.
  // Below SEARCH on purpose: panel chrome must not cover the search surface.
  //
  // NOTE, and this is the trap: several of these are absolutely-positioned inside a panel whose
  // root is `overflow:hidden` (DatabasePanel's sheet is `flex:1; overflow:hidden`). Such a popover
  // is CLIPPED by its ancestor, so it appears to "bleed into" the table no matter what z-index it
  // is given. The fix is to portal it to document.body and give it POPOVER — this tier is only for
  // popovers that are genuinely not clipped.
  PANEL_POPOVER: 300,

  // The search surface: the main bar OR the collapsed pill, never both (see useSearchSurface).
  // Above CONTENT and above PANEL_POPOVER, so it floats cleanly over panel content instead of
  // being underlapped by it. Below MODAL, because a drawer is a focused task that should cover it.
  SEARCH: 400,

  // Modal drawers — the job-detail panel and its peers (PDF, ATS). The scrim dims the app without
  // hiding it, so it sits directly beneath the drawer it belongs to, and ABOVE SEARCH: opening a
  // drawer must cover the search surface, which is the one relationship the old 30/40 values had
  // exactly backwards.
  MODAL_SCRIM: 800,
  MODAL: 850,

  // Fixed application chrome (TopBar). Above MODAL, matching today's behaviour: the drawers are
  // inset from the top of the viewport specifically so the nav stays visible and reachable while
  // one is open. Changing that is a design decision, not a layering fix, so it is preserved.
  NAV: 1500,

  // Transient, user-invoked overlays: dropdown menus, portalled popovers, command surfaces.
  // Above everything else by design. A dropdown belongs to whatever the user just clicked, so it
  // must never be clipped or underlapped — including by a modal drawer, since a drawer can itself
  // contain a menu. This is the tier that lets a portalled popover escape a clipping ancestor.
  POPOVER: 10000,
};

// CSS needs the same numbers (UnifiedSearchBar.css positions the search surface), and two copies of
// a scale is how a scale rots. Publish them as custom properties from this one definition so the
// stylesheet can say `var(--z-search)` and never hold a literal.
export function installZLayerVars(doc = typeof document !== "undefined" ? document : null) {
  if (!doc?.documentElement) return;
  for (const [name, value] of Object.entries(Z)) {
    doc.documentElement.style.setProperty(`--z-${name.toLowerCase().replace(/_/g, "-")}`, String(value));
  }
}

installZLayerVars();
