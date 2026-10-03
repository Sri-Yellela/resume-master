// The shared header's behaviour, on every page (A68 — the old site's look).
//  · The stamp in the bar folds "RESUMEMASTER" to "RM" once the page scrolls, as the old site's did.
//  · The nav marks where you are.
//  · On a page without the account dialogs (the PDF pages, privacy) the account controls are hidden:
//    the home page owns them, and only it knows whether accounts are switched on.
"use strict";
(() => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const fold = () => nav.classList.toggle("nav--scrolled", window.scrollY > 40);
  fold();
  window.addEventListener("scroll", fold, { passive: true });

  const here = location.pathname.startsWith("/pdf") ? "pdf"
    : location.pathname === "/" ? (location.hash.replace("#", "") || "ats") : "";
  for (const a of nav.querySelectorAll("[data-nav]")) {
    a.classList.toggle("nav__link--active", a.dataset.nav === here);
  }

  if (!document.querySelector("[data-dialog]")) {
    const account = nav.querySelector(".nav__account");
    if (account) account.hidden = true;
  }
})();
