// shared/tinyMascot.js — ⭐ D190 (46n, owner 11-15: "make tiny a floating bot … give it a cute logo animal") · TINY'S FACE.
// An original small fox head, drawn here once and used by draft (client/src/components/AppNav.jsx), the PDF-tools site and
// the extension. ⛔ MIRRORED byte-identical into resume-master public/assistant/tinyMascot.js and extension/tinyMascot.js —
// test/d190Assistant.test.js fails when a copy differs.
// The fox's own colours are ILLUSTRATION, not theme: they stay the same in every theme (like a logo), which is why they are
// literals here and not tokens. A mascot made of perfect circles and curves — no capsule shapes (D60).

export const TINY_NAME = "Tiny";

/** The fox, as an SVG string (64 × 64). `title` gives it an accessible name; without one it is decorative. */
export function tinySvg({ size = 40, title = null } = {}) {
  const label = title ? `<title>${String(title).replace(/[<&>]/g, "")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${title ? 'role="img"' : 'aria-hidden="true"'} focusable="false">${label}`
    + '<path d="M9 7 L27 21 L16 33 Z" fill="#E8743B"/><path d="M55 7 L37 21 L48 33 Z" fill="#E8743B"/>'
    + '<path d="M13 12 L23 21 L17 27 Z" fill="#5B3426"/><path d="M51 12 L41 21 L47 27 Z" fill="#5B3426"/>'
    + '<path d="M32 17 C18 17 9 27 9 38 C9 50 19 57 32 57 C45 57 55 50 55 38 C55 27 46 17 32 17 Z" fill="#E8743B"/>'
    + '<path d="M9.5 39 C13 49 21 55 32 55 C43 55 51 49 54.5 39 C47 42 40 44.5 32 50.5 C24 44.5 17 42 9.5 39 Z" fill="#FFF3E6"/>'
    + '<circle cx="23.5" cy="36" r="3.4" fill="#2B1D17"/><circle cx="40.5" cy="36" r="3.4" fill="#2B1D17"/>'
    + '<circle cx="24.6" cy="34.9" r="1.1" fill="#FFFFFF"/><circle cx="41.6" cy="34.9" r="1.1" fill="#FFFFFF"/>'
    + '<ellipse cx="32" cy="47.5" rx="3.4" ry="2.5" fill="#2B1D17"/>'
    + '<circle cx="17" cy="44" r="2.6" fill="#F6A98A" opacity="0.7"/><circle cx="47" cy="44" r="2.6" fill="#F6A98A" opacity="0.7"/>'
    + "</svg>";
}
