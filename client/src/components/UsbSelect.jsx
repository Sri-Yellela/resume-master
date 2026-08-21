// The search bar's dropdowns, as a real listbox instead of a native <select>.
//
// WHY THIS EXISTS, rather than a few extra CSS rules on .usb__sel option:
//
// The three bar dropdowns rendered near-white text on a near-white surface, invisible until hover,
// which then showed the OS highlight (purple on cyan) — neither belonging to this app's dark
// translucent glass. Probed on the running board, the cause is exact and it is not a wrong colour
// anywhere in our CSS:
//
//   .usb__sel  color rgb(245,245,245)  background rgba(0,0,0,0)
//   option     color rgb(245,245,245)  background rgba(0,0,0,0)   <- no rule of its own
//
// The <option> elements have no style at all. They inherit `color` from the select — the dark
// theme's near-white --color-text, which is correct for the CLOSED control sitting on the glass bar
// — and their background is transparent, because the popup surface is painted by the browser and
// the OS, not by the page. So the text was our colour and the surface was theirs, and the two knew
// nothing about each other. Hover was the OS highlight for the same reason.
//
// `color-scheme: dark` is already set on <html> and computes as `dark` on these selects; the popup
// stayed light regardless. That is the known cross-platform limit on styling native option lists,
// and it is why this is a replacement rather than a patch: adding `.usb__sel option { background }`
// does work on Windows and Linux Chrome, and is silently ignored on macOS, where the popup is a
// native AppKit menu. A fix that only holds on the platform you happened to test is how the app
// ends up with two different-looking dropdowns instead of none.
//
// So this is the same route the rest of the app already takes: DockPortal, which is the in-use
// dropdown primitive behind ProfileSelectorDropdown, TopBar and DatabasePanel. Reusing it rather
// than writing a fourth popup means this inherits the behaviour those already got right —
// dismiss-on-outside-pointerdown WITHOUT eating the click, Escape to close, the POPOVER z tier, and
// portalling to document.body so no sticky/transform ancestor can clip it (.usb is position:fixed
// with a transform, which would have clipped an in-flow panel).
//
// Everything is drawn from the same tokens as the FILTERS drawer — --color-surface, --border-glass,
// --color-primary, --color-text, --color-text-muted, --shadow-sm — so there is no second palette.
import { useRef, useState, useEffect, useId } from "react";
import { ChevronDown } from "lucide-react";
import { DockPortal } from "./DockPortal.jsx";

// DockPortal takes a theme OBJECT (it predates this surface and its other three callers pass the
// JS theme from useTheme). CSS custom properties are valid inline style values, so handing it the
// token names keeps this component on the same palette as the stylesheet beside it and avoids
// threading a theme prop through UnifiedSearchBar — which the marketing landing page renders too.
const PORTAL_THEME = {
  menuSurface: "var(--bg-card, #14110f)",
  surface:     "var(--bg-card, #14110f)",
  border:      "var(--border-glass, rgba(255,255,255,0.08))",
  shadowLg:    "0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px var(--border-glass, rgba(255,255,255,0.08))",
};

export default function UsbSelect({ value, onChange, options, ariaLabel, icon: Icon }) {
  const [open, setOpen]   = useState(false);
  const [rect, setRect]   = useState(null);
  // The keyboard cursor. Distinct from `value`: moving through the list with the arrows must not
  // commit anything until Enter, or every arrow press would fire a board refetch.
  const [active, setActive] = useState(-1);
  const btnRef = useRef(null);
  const listId = useId();

  const selected = options.find(o => o.v === value) || options[0];
  const selectedIndex = Math.max(0, options.findIndex(o => o.v === value));

  const openList = () => {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = ({ refocus = true } = {}) => {
    setOpen(false);
    setActive(-1);
    if (refocus) btnRef.current?.focus();
  };
  const commit = (v) => { onChange?.(v); close(); };

  // The bar is position:fixed and swaps with the collapsed pill on scroll, so a popup left open
  // across that swap would be anchored to an element that is no longer showing. The portal is
  // positioned from a rect captured at open time and does not follow anything, so close instead of
  // trying to track. Capture phase, so it also catches scrolls inside the board's own containers.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close({ refocus: false });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  function onKeyDown(e) {
    // Tab must keep working as Tab. It closes the list and moves on rather than being swallowed —
    // a dropdown that traps Tab is worse for a keyboard user than one that is merely ugly.
    if (e.key === "Tab") { if (open) close({ refocus: false }); return; }

    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case "Escape":    e.preventDefault(); close(); break;
      case "Enter":
      case " ":         e.preventDefault(); commit(options[active]?.v ?? value); break;
      case "ArrowDown": e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); break;
      case "ArrowUp":   e.preventDefault(); setActive(i => Math.max(0, i - 1)); break;
      case "Home":      e.preventDefault(); setActive(0); break;
      case "End":       e.preventDefault(); setActive(options.length - 1); break;
      default: break;
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"usb__sel usb__sel--btn" + (open ? " usb__sel--open" : "")}
        // The combobox pattern: focus stays on this button and aria-activedescendant names the
        // highlighted row, so screen readers follow the arrows without the focus moving into a
        // portalled list that lives elsewhere in the DOM.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
      >
        {Icon && <Icon size={13} className="usb__icon" aria-hidden="true" />}
        <span className="usb__sel-label">{selected?.l}</span>
        <ChevronDown size={11} className="usb__chev" aria-hidden="true" />
      </button>

      {open && rect && (
        <DockPortal
          anchorRect={rect}
          theme={PORTAL_THEME}
          onClose={() => close({ refocus: false })}
          style={{ minWidth: Math.max(176, Math.round(rect.width) + 48), padding: 6 }}
        >
          <div id={listId} role="listbox" aria-label={ariaLabel} className="usb__opts">
            {options.map((o, i) => {
              const isSelected = o.v === value;
              const isActive   = i === active;
              return (
                <div
                  key={o.v || "__any"}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  className={
                    "usb__opt" +
                    (isSelected ? " usb__opt--selected" : "") +
                    (isActive   ? " usb__opt--active"   : "")
                  }
                  // Pointer, not click: DockPortal dismisses on document pointerdown, and a click
                  // handler here would race that and lose. mousemove keeps the keyboard cursor and
                  // the pointer agreeing on one highlight instead of showing two.
                  onPointerDown={e => { e.preventDefault(); commit(o.v); }}
                  onMouseMove={() => setActive(i)}
                >
                  <span className="usb__opt-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                  <span className="usb__opt-label">{o.l}</span>
                </div>
              );
            })}
          </div>
        </DockPortal>
      )}
    </>
  );
}
