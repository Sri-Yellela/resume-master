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
// WHAT IS DELIBERATELY NOT ON THIS SCALE, and why. This used to read "anything above NAV", which
// stopped being a usable description the moment Y2 moved NAV from 1500 to 250. The list, stated as
// surfaces rather than as a number:
//
//   9000-series full-screen modals   CompanyViewModal, CoverLetterModal, ImportJobModal, and
//                                    ScrollDock's marketing-only 9998 hamburger. Full-screen
//                                    takeovers: nothing else is on screen to dispute an order with.
//   DomainProfileWizard (1000/1001)  Same — a full-screen wizard.
//   AdminPanel's overlay (1100)      A different route with none of these surfaces in it.
//   InlineLoginPopover (1000)        Marketing chrome; no app panel exists on those pages.
//   MarketingNav / AdminLayout (100) Sticky headers on routes that have no overlay tier. Both are
//                                    below NAV's 250, which is the relationship they already had.
//   ScrollDock's dock (200)          Marketing/tools chrome. Also below NAV, as before.
//
// THREE THAT WERE MIGRATED IN Y2, because they DID have a dispute: JobsPanel's resume-enhance modal
// was the literal 600, which is Y2's DRAWER_SCRIM — the same z as the filters drawer's scrim, with
// render order deciding which won. AutoApplyPanel's apply-runs modal (700) and DatabasePanel's
// resume viewer (1000) are the same class of panel-local takeover, and fixing one of three while
// leaving its siblings on raw numbers is how this recurs. All three now read MODAL_SCRIM.
// ── Y2: THE TOP BAR MOVED TO THE BOTTOM OF THE OVERLAY STACK ─────────────────────────────────
//
// NAV was 1500 — above everything except POPOVER — on the reasoning recorded in its old note: "the
// drawers are inset from the top of the viewport specifically so the nav stays visible and reachable
// while one is open". That reasoning produced a bar that OCCLUDES overlay surfaces. Measured at
// 1440x900 with the filters drawer open, before this change: the drawer's own close control sat
// under the bar and `document.elementFromPoint` at the button's centre returned a nav <div>. The
// previous pass fixed that by raising the drawer. THIS REVISES THAT DECISION: the drawer was not too
// low, the bar was too high, and raising each surface the bar covers in turn is an arms race with
// one loser per round.
//
// The ordering is now, top of the stack last:
//
//     page content  <  TOP BAR  <  panel popovers  <  search surface  <  search dropdown
//                   <  filters drawer  <  panel scrim  <  panels  <  menus
//
// The bar sits ABOVE page content, so it stays usable while the board scrolls, and BELOW every
// overlay, so it can never cover one. The consequence is deliberate and is the point: with a panel
// or the filters drawer open, the top bar is dimmed by that surface's scrim and inerted with the
// rest of the app (see useBoardLock, whose threshold moved from NAV to MODAL_SCRIM for exactly this
// reason). A bar that is dimmed AND inert is coherent; the old bar was undimmed and live over a
// modal, which is the state the scrim exists to prevent.
export const Z = {
  // In-flow application content: the board, the Applications table, panel bodies.
  CONTENT: 0,

  // FIXED APPLICATION CHROME (TopBar). Above CONTENT so it stays usable while the board scrolls;
  // below every overlay tier below, so it cannot occlude a popup, dropdown, drawer, scrim or panel.
  //
  // 250 rather than something smaller because three surfaces outside this scale sit between 0 and
  // 250 and their order must not invert: LandingPage.css's hero at 1, MarketingNav and AdminLayout's
  // sticky headers at 100, and ScrollDock's marketing/tools dock at 200. The nav was above all three
  // at 1500 and is still above all three at 250.
  //
  // The PROFILE MENU is not at this tier. It is a dropdown FROM the bar, and a dropdown belongs to
  // whatever the user just clicked — it portals to POPOVER via DockPortal, which is where every menu
  // in the app lives. Only the bar itself is here; the menu it opens is in the overlay tier.
  NAV: 250,

  // Popovers OWNED BY panel content — a date picker in a table cell, an inline autocomplete.
  // Below SEARCH on purpose: panel chrome must not cover the search surface. Above NAV, because the
  // rule is that the bar never covers a popover, whoever owns it.
  //
  // NOTE, and this is the trap: several of these are absolutely-positioned inside a panel whose
  // root is `overflow:hidden` (DatabasePanel's sheet is `flex:1; overflow:hidden`). Such a popover
  // is CLIPPED by its ancestor, so it appears to "bleed into" the table no matter what z-index it
  // is given. The fix is to portal it to document.body and give it POPOVER — this tier is only for
  // popovers that are genuinely not clipped.
  PANEL_POPOVER: 300,

  // The search surface: UnifiedSearchBar (client/src/components/UnifiedSearchBar.css). Above
  // CONTENT and above PANEL_POPOVER, so it floats cleanly over panel content instead of being
  // underlapped by it. Below MODAL, because a drawer is a focused task that should cover it.
  //
  // This tier used to have TWO renderings — the expanded bar and TopBar's collapsed pill — and the
  // note here recorded why both had to be in one tier: the pill carried NAV, which put ONE surface
  // in two tiers depending only on the scroll offset, on opposite sides of MODAL_SCRIM. The pill is
  // retired, so there is one rendering again; the rule survives it. Anything that renders the
  // search surface reads SEARCH.
  SEARCH: 400,

  // The search surface's OWN dropdowns: UsbSelect's listbox and UsbSuggest's suggestion list, both
  // portalled through DockPortal. Directly above SEARCH — a dropdown must cover the control that
  // opened it — and below the drawer and the panels, because those cover the search bar itself, so
  // a dropdown belonging to a covered control has no business painting over them.
  //
  // Distinct from POPOVER, which is where MENUS live. The difference is ownership: a menu is invoked
  // from chrome that stays live over a modal, a search dropdown belongs to a surface that does not.
  SEARCH_DROPDOWN: 500,

  // The filters drawer and its scrim. Its own tier, between the search surface and the panels:
  // opening it must cover the search bar and the top bar, and opening a JD/PDF/ATS panel on top of
  // it must cover IT. Before this it shared MODAL_SCRIM/MODAL with the panels, which left the
  // relative order of two different drawers an accident of render order.
  DRAWER_SCRIM: 600,
  DRAWER: 650,

  // Modal drawers — the job-detail panel and its peers (PDF, ATS). The scrim dims the app without
  // hiding it, so it sits directly beneath the drawer it belongs to, and ABOVE SEARCH: opening a
  // drawer must cover the search surface, which is the one relationship the old 30/40 values had
  // exactly backwards.
  MODAL_SCRIM: 800,
  MODAL: 850,

  // Transient, user-invoked MENUS: the profile menu, the profile switcher, portalled popovers.
  // Above everything else by design. A menu belongs to whatever the user just clicked, so it must
  // never be clipped or underlapped — including by a modal drawer, since a drawer can itself contain
  // a menu. This is the tier that lets a portalled popover escape a clipping ancestor.
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
