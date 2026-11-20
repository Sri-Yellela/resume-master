// The shared header's behaviour, on every page (A68 — the old site's look).
//  · The stamp in the bar folds "RESUMEMASTER" to "RM" once the page scrolls, as the old site's did.
//  · The nav marks where you are.
//  · rm-audit M1 (46y): the header's account button opens Settings on EVERY page (public/site-settings.js) — the
//    home page no longer owns the account. The old home-page addresses (/#ats, /#format, /#generate, /#pdf) go where
//    those tools live now: the workspace's Résumé tab, the résumé editor, its Tailor panel, the PDF tools.
"use strict";
(() => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const fold = () => nav.classList.toggle("nav--scrolled", window.scrollY > 40);
  fold();
  window.addEventListener("scroll", fold, { passive: true });

  const MOVED = { "#ats": "/workspace/?panel=resume", "#format": "/editor/?paste=1", "#generate": "/editor/?panel=tailor", "#tools": "/workspace/?panel=resume", "#pdf": "/pdf/" };
  if (location.pathname === "/" && MOVED[location.hash]) { location.replace(MOVED[location.hash]); return; }
  const here = location.pathname.startsWith("/pdf") ? "pdf" : "";
  for (const a of nav.querySelectorAll("[data-nav]")) {
    a.classList.toggle("nav__link--active", a.dataset.nav === here);
  }

})();
