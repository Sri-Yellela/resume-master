// REVAMP v1 — main.jsx
import React from "react";
import { createRoot } from "react-dom/client";

// ── SELF-HOSTED WEB FONTS ───────────────────────────────────────────────────────────────────────
// These four families were loaded from fonts.googleapis.com until 2026-09-15 — two via a <link> in
// index.html, two via an @import at the top of index.css. Either way, every visitor's browser
// requested them from Google on every page, which handed Google the visitor's IP address and
// user-agent, and the privacy policy did not name Google anywhere. Same shape as the Google S2
// favicon fallback that task X removed: a third party seeing browsing that nothing disclosed.
//
// Serving them from our own origin is what makes the policy's "we send Google nothing" true, so
// these imports are load-bearing for a legal statement, not a performance tweak.
//
// ⛔ EXACTLY THE WEIGHTS THE OLD REQUESTS ASKED FOR, AND NO MORE. Importing a package's index.css
// pulls every weight it ships (9 for Barlow, plus italics), which is a payload nobody asked for.
//
// ⛔ DO NOT SWAP IN @fontsource-variable/dm-sans. It declares the family as 'DM Sans Variable',
// while ~40 call sites ask for 'DM Sans' — so every one of them would silently fall through to
// system-ui and nothing would fail. Pinned by test/selfHostedFonts.test.js.
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-sans/800.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";

import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
