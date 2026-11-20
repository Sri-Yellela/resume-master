// ⭐ rm-audit M20 (draft D192, owner 11-19 "approving all open items") · ONE token source for the whole site.
//
// The four themes are draft's (client/src/themes/{dusk,plain}-{dark,light}.js — D149's Dusk, D181's Plain), copied here
// value for value because the tools service stands alone (no build step reads draft). The names are rm-editor/1's token set
// (src/editor/sections.js THEME_TOKENS: bg, card, raise, raise2, line, ink, body, muted, accent, accent2, onAccent) — the
// set draft already sends the embedded editor — plus status, band, shadow and scrim tokens. scripts/site/buildSite.mjs
// writes them into public/tokens.css; every stylesheet on the site reads that file and keeps no colour of its own.
//
// draft key → token:  CANVAS → bg · SURFACE_SOLID → card · FH_WELL → raise · BORDER → raise2 and line · INK → ink ·
// INK_MUTED → body · INK_FAINT → muted · ACCENT → accent · FH_ACCENT_EDGE → accent2 · ON_ACCENT → on-accent ·
// CANVAS_SHADE → surface (the canvas under a document; Dusk dark keeps the workspace's deeper #141414) · SUCCESS / WARNING / DANGER → good / warn / bad · BAND_* → band-* · DEPTH_* → rest / hover /
// press / glow · SHADOW_LG → shadow-lg · SCRIM → scrim · SURFACE_INPUT → field.
const T = (scheme, v) => Object.freeze({ scheme, ...v });

export const THEMES = Object.freeze({
  "dusk-dark": T("dark", {
    bg: "#1B1B1B", card: "#262626", raise: "#2E2E2E", raise2: "#343434", line: "#343434", ink: "#FFFFFF", body: "#A3A3A3", muted: "#959595",
    accent: "#FBD3C4", accent2: "#F2C2B2", "on-accent": "#1B1B1B", surface: "#141414",
    good: "#8FD6A8", warn: "#F2C26B", bad: "#F27F72", "band-strong": "#72D59D", "band-moderate": "#EAB95E", "band-weak": "#F48F83",
    rest: "0 3px 8px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.08)",
    hover: "0 7px 17px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.10)",
    press: "0 2px 5px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
    glow: "0 10px 26px rgba(251,211,196,0.16), inset 0 1px 0 rgba(255,255,255,0.30)",
    "shadow-lg": "0 18px 40px rgba(0,0,0,0.50), 0 6px 14px rgba(0,0,0,0.35)", scrim: "rgba(0,0,0,0.55)", field: "rgba(255,240,225,0.06)",
  }),
  "dusk-light": T("light", {
    bg: "#F7F3F0", card: "#FFFFFF", raise: "#FBF8F6", raise2: "#E6DED8", line: "#E6DED8", ink: "#1B1B1B", body: "#55504C", muted: "#6B6763",
    accent: "#BE5739", accent2: "#AD4C30", "on-accent": "#FFFFFF", surface: "#EEE8E2",
    good: "#1B7440", warn: "#8B5A00", bad: "#B3261E", "band-strong": "#17663A", "band-moderate": "#7A5300", "band-weak": "#A3281E",
    rest: "0 3px 8px rgba(30,25,21,0.11), inset 0 1px 0 rgba(255,255,255,0.66)",
    hover: "0 7px 17px rgba(30,25,21,0.15), inset 0 1px 0 rgba(255,255,255,0.66)",
    press: "0 2px 5px rgba(30,25,21,0.13), inset 0 1px 0 rgba(255,255,255,0.5)",
    glow: "0 6px 18px rgba(194,89,58,0.22), inset 0 1px 0 rgba(255,255,255,0.20)",
    "shadow-lg": "0 18px 40px rgba(30,25,21,0.14), 0 6px 14px rgba(30,25,21,0.08)", scrim: "rgba(30,25,21,0.28)", field: "rgba(255,255,255,0.55)",
  }),
  "plain-dark": T("dark", {
    bg: "#111315", card: "#1B1E21", raise: "#24282C", raise2: "#2E3338", line: "#2E3338", ink: "#F3F4F6", body: "#C2C7CE", muted: "#A9B0B8",
    accent: "#8AB4F8", accent2: "#8AB4F8", "on-accent": "#0B1220", surface: "#16191C",
    good: "#5FCB8C", warn: "#E6AA4E", bad: "#F27F72", "band-strong": "#72D59D", "band-moderate": "#EAB95E", "band-weak": "#F48F83",
    rest: "0 3px 8px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.08)",
    hover: "0 7px 17px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.10)",
    press: "0 2px 5px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
    glow: "0 2px 6px rgba(0,0,0,0.14)",
    "shadow-lg": "0 18px 40px rgba(0,0,0,0.50), 0 6px 14px rgba(0,0,0,0.35)", scrim: "rgba(0,0,0,0.55)", field: "rgba(255,240,225,0.06)",
  }),
  "plain-light": T("light", {
    bg: "#F6F7F9", card: "#FFFFFF", raise: "#F1F3F5", raise2: "#E3E6EA", line: "#E3E6EA", ink: "#111111", body: "#4B5563", muted: "#5F6672",
    accent: "#1D4ED8", accent2: "#1D4ED8", "on-accent": "#FFFFFF", surface: "#ECEEF1",
    good: "#1A6B33", warn: "#855000", bad: "#B3261E", "band-strong": "#17663A", "band-moderate": "#7A5300", "band-weak": "#A3281E",
    rest: "0 3px 8px rgba(30,25,21,0.11), inset 0 1px 0 rgba(255,255,255,0.66)",
    hover: "0 7px 17px rgba(30,25,21,0.15), inset 0 1px 0 rgba(255,255,255,0.66)",
    press: "0 2px 5px rgba(30,25,21,0.13), inset 0 1px 0 rgba(255,255,255,0.5)",
    glow: "0 2px 6px rgba(17,17,17,0.14)",
    "shadow-lg": "0 18px 40px rgba(30,25,21,0.14), 0 6px 14px rgba(30,25,21,0.08)", scrim: "rgba(30,25,21,0.28)", field: "rgba(255,255,255,0.55)",
  }),
});
export const DEFAULT_THEME = "dusk-dark";

/** The document's own colours — the same in every theme (a résumé is white paper wherever it is shown). */
const PAPER = { paper: "#ffffff", "paper-ink": "#111111", "stamp-paper": "#ffffff", "stamp-ink": "#0f0f0f" };

export function renderTokens() {
  const block = (sel, name) => {
    const t = THEMES[name];
    const lines = Object.entries(t).filter(([k]) => k !== "scheme").map(([k, v]) => `  --${k}: ${v};`);
    return `${sel} {\n  color-scheme: ${t.scheme};\n${lines.join("\n")}\n}`;
  };
  return `/* ⛔ GENERATED by scripts/site/buildSite.mjs from scripts/site/themes.mjs — do not hand-edit (rm-audit M20).
   The site's ONE token source: draft's four themes (Dusk / Plain × dark / light), named after rm-editor/1's token set.
   Every stylesheet reads these; a theme is chosen in Settings → Appearance (public/theme.js sets <html data-theme>). */
:root {
${Object.entries(PAPER).map(([k, v]) => `  --${k}: ${v};`).join("\n")}
  --font: "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --serif: "Instrument Serif", Georgia, serif;
}
${block(`:root, :root[data-theme="${DEFAULT_THEME}"]`, DEFAULT_THEME)}
${Object.keys(THEMES).filter(n => n !== DEFAULT_THEME).map(n => block(`:root[data-theme="${n}"]`, n)).join("\n")}
`;
}

/** public/theme.js — runs first in <head>: the stored choice becomes <html data-theme>, before anything paints. */
export function renderThemeScript() {
  return `// ⛔ GENERATED by scripts/site/buildSite.mjs (rm-audit M20) — the Appearance choice, applied before the page paints.
// Stored in this browser as "rm-theme" = "<dusk|plain>:<system|light|dark>". window.rmTheme lets Settings change it.
(function () {
  var NAMES = ${JSON.stringify(["dusk", "plain"])}, KEY = "rm-theme", DEF = "dusk:dark";
  function read() { try { return localStorage.getItem(KEY) || DEF; } catch (e) { return DEF; } }
  function resolve(pref) {
    var p = String(pref || DEF).split(":"), name = NAMES.indexOf(p[0]) >= 0 ? p[0] : "dusk", mode = p[1] || "dark";
    if (mode === "system") mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    return name + "-" + (mode === "light" ? "light" : "dark");
  }
  function apply(pref) { document.documentElement.setAttribute("data-theme", resolve(pref)); }
  apply(read());
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () { apply(read()); });
  window.rmTheme = {
    get: read,
    set: function (pref) { try { localStorage.setItem(KEY, pref); } catch (e) { /* this visit only */ } apply(pref); try { window.dispatchEvent(new Event("rm-theme")); } catch (e) {} },
    resolve: resolve,
  };
})();
`;
}
