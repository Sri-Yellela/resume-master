// shared/tinyMascot.js — the assistant's face and name, drawn here once and used by draft (client/src/components/AppNav.jsx)
// and the extension. ⛔ MIRRORED byte-identical into extension/tinyMascot.js and the PDF-tools repo's
// public/assistant/tinyMascot.js — test/d190Assistant.test.js fails when a copy differs.
// ⭐ 46v 0c (owner 11-18: "change to their respective short logos on [the PDF-tools site] and draft" … "drop 'tiny' for the newly
// suggested ones"): the fox and the name "Tiny" are retired. On draft the assistant wears draft's SHORT LOGO, "/d", in the
// logo's colourway (the slash in LOGO_SLASH, the letter in LOGO_WORD — the theme's own CSS variables, so every theme's logo
// rule holds and there is no colour literal here), and is called by the site's name. The PDF-tools site draws its own short
// logo in its own public/assistant/tiny.js (its name and host may not appear in this product's files — the brand guard).
// The code names (TINY_NAME, tinySvg, data-tiny-*) stay; only what a person sees changed. No capsule shape (D60).

export const TINY_NAME = "draft";

/** draft's short logo "/d", as an SVG string (64 × 64). `title` gives it an accessible name; without one it is decorative. */
export function tinySvg({ size = 40, title = null } = {}) {
  const label = title ? `<title>${String(title).replace(/[<&>"]/g, "")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${title ? 'role="img"' : 'aria-hidden="true"'} focusable="false">${label}`
    + '<text x="31" y="45" text-anchor="middle" font-family="Poppins, sans-serif" font-weight="800" font-style="italic" font-size="38" letter-spacing="-1">'
    + '<tspan style="fill: var(--c-logo-slash)">/</tspan><tspan style="fill: var(--c-logo-word)">d</tspan></text>'
    + "</svg>";
}
