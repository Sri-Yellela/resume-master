// Typeahead for the search bar's two free-text inputs.
//
// The suggestions come from GET /api/jobs/suggest, which derives them from scraped_jobs rows in the
// caller's active role scope and ranks them by frequency — there is no hand-maintained list of
// roles on either side of the wire. Typing "s" leads with "Software Engineer" because that is the
// most common role on the board, not because anyone wrote it down.
//
// This wraps the input rather than replacing it: the caller still owns the value, still owns
// onChange, and search BEHAVIOUR is untouched — accepting a suggestion only fills the box. What
// happens next is still the bar's double-click local->live pattern.
import { useState, useEffect, useRef, useId, useCallback } from "react";
import { getAuthContext } from "../lib/api.js";
import { DockPortal } from "./DockPortal.jsx";

// Same portal, same tokens, as the bar's dropdowns (UsbSelect) — one popup style, not two.
//
// It has to be a portal: .usb__bar is `overflow: hidden` (it clips the inner fields to the bar's
// rounded corners), so an absolutely-positioned list inside it is invisible. Measured that way
// first — the list was in the DOM with all eight rows and a correct 240x280 rect, painting nothing,
// because the ancestor two levels up cut it off. That is precisely what DockPortal's own header
// says it exists to prevent.
const PORTAL_THEME = {
  menuSurface: "var(--bg-card, #14110f)",
  surface:     "var(--bg-card, #14110f)",
  border:      "var(--border-glass, rgba(255,255,255,0.08))",
  shadowLg:    "0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px var(--border-glass, rgba(255,255,255,0.08))",
};

// Long enough that a fast typist makes one request for a word rather than one per letter, short
// enough to feel immediate. The server also caches per role scope, so bursts cost nothing.
const DEBOUNCE_MS = 180;
const MIN_CHARS   = 1;

/**
 * Deliberately NOT lib/api.js's `api()`.
 *
 * That helper treats ANY 401 as session expiry: it clears the stored auth context and dispatches
 * `rm:session-expired`, which force-logs-out the app shell. Correct for a real request, wrong for
 * this one twice over. UnifiedSearchBar also renders on the PUBLIC landing page, where there is no
 * session at all and every keystroke would have fired that event; and on the board, a lapsed
 * session would have been surfaced by a typeahead rather than by whatever the user was actually
 * doing. A suggestion that cannot be fetched is not an event in the application's life — it is
 * just no suggestion.
 *
 * Returns [] for absolutely everything that is not a clean 200, and reports 401 separately so the
 * caller can stop asking.
 */
async function fetchSuggestions(field, q) {
  const headers = { Accept: "application/json" };
  const token = getAuthContext();
  if (token) headers["x-rm-auth-context"] = token;
  const r = await fetch(
    `/api/jobs/suggest?field=${field}&q=${encodeURIComponent(q)}`,
    { credentials: "include", headers },
  );
  if (r.status === 401) return { unauthorised: true, suggestions: [] };
  if (!r.ok) return { suggestions: [] };
  const d = await r.json().catch(() => ({}));
  return { suggestions: Array.isArray(d?.suggestions) ? d.suggestions : [] };
}

export default function UsbSuggest({
  field,            // "title" | "location"
  value,
  onChange,
  onAccept,         // optional: called after a suggestion is committed
  children,         // render prop: (inputProps) => <input {...inputProps}/>
}) {
  const [items, setItems]   = useState([]);
  const [open, setOpen]     = useState(false);
  // -1 means "nothing highlighted". Tab is only intercepted when this is >= 0, so a user who is
  // tabbing THROUGH the field still gets a plain Tab.
  const [active, setActive] = useState(-1);
  const listId = useId();
  const boxRef = useRef(null);
  // Captured when the list opens, so DockPortal can place itself under the input.
  const [rect, setRect] = useState(null);
  // Set while we are writing the value ourselves, so the fetch effect below can tell "the user
  // typed" from "we just accepted a suggestion" and not immediately reopen the list under them.
  const selfEdit = useRef(false);
  // Monotonic request id. Without it a slow response for "so" can land after a fast one for "soft"
  // and repopulate the list with results for text that is no longer in the box.
  const seq = useRef(0);
  // Set once the endpoint says 401 — i.e. this bar is the logged-out landing page's. There is
  // nothing to suggest and nothing will change that while the component is mounted, so stop
  // asking rather than spending a request per word for the whole visit.
  const unauthorised = useRef(false);

  useEffect(() => {
    if (selfEdit.current) { selfEdit.current = false; return; }
    if (unauthorised.current) return;
    const q = (value || "").trim();
    if (q.length < MIN_CHARS) { setItems([]); setOpen(false); setActive(-1); return; }

    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const d = await fetchSuggestions(field, q);
        if (mine !== seq.current) return;               // a newer keystroke already won
        if (d.unauthorised) { unauthorised.current = true; setItems([]); setOpen(false); return; }
        const next = d.suggestions;
        setItems(next);
        if (next.length) setRect(boxRef.current?.getBoundingClientRect() || null);
        // Zero suggestions is a normal state: show NOTHING. Not an error, not an empty box.
        setOpen(next.length > 0);
        setActive(-1);
      } catch {
        // A convenience that cannot answer is a convenience that stays quiet.
        if (mine === seq.current) { setItems([]); setOpen(false); setActive(-1); }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, field]);

  const dismiss = useCallback(() => { setOpen(false); setActive(-1); }, []);

  // The bar is position:fixed/sticky and swaps with the collapsed pill on scroll. DockPortal places
  // itself from a rect captured at open time and does not follow anything, so close rather than let
  // the list drift away from the input it belongs to. Same call as UsbSelect.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => dismiss();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, dismiss]);

  const accept = (text) => {
    selfEdit.current = true;
    onChange(text);
    setItems([]);
    setOpen(false);
    setActive(-1);
    onAccept?.(text);
  };

  function onKeyDown(e) {
    // TAB. Accepts the highlighted suggestion — and ONLY then. With nothing highlighted this does
    // not run at all, so Tab keeps its normal meaning and moves focus to the next field. A
    // typeahead that swallows Tab unconditionally makes the bar impossible to tab through.
    if (e.key === "Tab") {
      if (open && active >= 0 && items[active]) { e.preventDefault(); accept(items[active]); }
      else dismiss();
      return;
    }
    if (e.key === "Escape") {
      // Dismiss WITHOUT altering the typed text. The user is rejecting the list, not the word they
      // were in the middle of writing.
      if (open) { e.preventDefault(); e.stopPropagation(); dismiss(); }
      return;
    }
    if (!open || items.length === 0) {
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setOpen(true); setActive(0); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive(i => (i + 1) % items.length); break;
      case "ArrowUp":   e.preventDefault(); setActive(i => (i <= 0 ? items.length : i) - 1); break;
      case "Home":      e.preventDefault(); setActive(0); break;
      case "End":       e.preventDefault(); setActive(items.length - 1); break;
      case "Enter":
        // Only intercept Enter when the user has actually picked something. Otherwise it falls
        // through to the input's own onKeyDown, which is what runs the search — pressing Enter to
        // search must not be stolen by a list the user was ignoring.
        if (active >= 0 && items[active]) { e.preventDefault(); accept(items[active]); }
        else dismiss();
        break;
      default: break;
    }
  }

  const showList = open && items.length > 0 && !!rect;

  return (
    <div className="usb__suggest" ref={boxRef}>
      {children({
        value,
        onChange: e => onChange(e.target.value),
        onKeyDown,
        // Rows commit on pointerdown with preventDefault, so the input never loses focus to them and
        // this cannot close the list out from under a click.
        onBlur: () => dismiss(),
        onFocus: () => {
          if (!items.length) return;
          setRect(boxRef.current?.getBoundingClientRect() || null);
          setOpen(true);
        },
        role: "combobox",
        "aria-expanded": showList,
        "aria-controls": showList ? listId : undefined,
        "aria-autocomplete": "list",
        "aria-activedescendant": showList && active >= 0 ? `${listId}-${active}` : undefined,
        autoComplete: "off",
      })}

      {showList && (
        <DockPortal
          anchorRect={rect}
          theme={PORTAL_THEME}
          onClose={dismiss}
          style={{ minWidth: Math.max(240, Math.round(rect.width)), maxWidth: 360, padding: 6 }}
        >
          <ul className="usb__suggest-list" id={listId} role="listbox" aria-label={
            field === "location" ? "Location suggestions" : "Job title suggestions"
          }>
            {items.map((s, i) => (
              <li
                key={s}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={"usb__suggest-item" + (i === active ? " usb__suggest-item--active" : "")}
                // pointerdown, not click: the input's blur fires first on a click and would unmount
                // the row out from under it.
                onPointerDown={e => { e.preventDefault(); accept(s); }}
                onMouseMove={() => setActive(i)}
              >
                {s}
              </li>
            ))}
          </ul>
        </DockPortal>
      )}
    </div>
  );
}
