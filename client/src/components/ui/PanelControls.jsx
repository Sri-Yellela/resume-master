// client/src/components/ui/PanelControls.jsx — Design System v4
//
// ── TASK AD1: THE DATABASE PANEL'S CHROME, EXTRACTED ─────────────────────────────────────────
//
// The Auto Apply panel adopts the Database panel's layout — a sub-tab row with per-tab counts, a
// control row holding a search box and a "Filter by date" calendar, and a body underneath. AD1's
// instruction is "REUSE, DO NOT CLONE": a second copy of this layout is how two surfaces that look
// identical today drift apart, and this repository has already paid for that lesson three times
// (the three hardcoded tab lists, the two calendars, the two company-card implementations).
//
// So the three primitives live here and BOTH panels render them. DatabasePanel's own markup was
// replaced by these components rather than duplicated into them — see the call sites there; if it
// still held its own copy the extraction would be a clone with extra steps.
//
// WHAT WAS *NOT* EXTRACTED, and why, because "report before diverging" applies to the omissions
// too: the Database panel's LISTING ROWS are a fixed-column <table> with inline cell editing, sort
// headers and a per-row date cell. Auto Apply's body is specified by AD1 itself as "individual
// listings, grouped company → application, as AC2/AC3 established" — a two-tier hierarchy of
// company tiles holding application rows, which is not a table and has no columns to share. Those
// are two different bodies under one chrome, deliberately. The chrome is what AD1 asks to match and
// the chrome is what is shared.
//
// Nothing here holds state that belongs to a panel. Which tab is active, what the search says and
// which date is picked are all owned by the caller — these render and report, so the two panels can
// keep their own (quite different) fetching rules without this file knowing about either.
import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DockPortal } from "../DockPortal.jsx";
import { DateCalendar } from "./DateCalendar.jsx";

/**
 * THE SUB-TAB ROW: underline-style tabs, each with a count pill.
 *
 * @param {Array<{id:string,label:string,count?:number|string|null,title?:string}>} tabs
 * @param {string}   active
 * @param {function} onSelect   (id) => void
 * @param {string}   layoutId   the framer-motion shared-layout key for the underline. A PROP rather
 *                              than a constant: two panels rendering the same literal would make
 *                              the underline try to animate between them if both were ever mounted
 *                              at once, and a shared-layout id that silently couples two surfaces
 *                              is exactly the kind of coupling this extraction is meant to avoid.
 * @param {node}     right      trailing content, aligned to the far edge (the Database panel's
 *                              Refresh / Export Excel buttons live here).
 */
export function PanelSubTabs({ tabs, active, onSelect, theme, layoutId, right = null, style = {} }) {
  return (
    <div data-rm-subtabs={layoutId} style={{
      background: "rgba(17,17,17,0.92)",
      backdropFilter: "blur(16px)",
      borderBottom: `1px solid ${theme.border}`,
      display: "flex", alignItems: "stretch", flexShrink: 0,
      padding: "0 14px",
      ...style,
    }}>
      <div style={{ display: "flex" }}>
        {tabs.map(({ id, label, count, title }) => (
          <button key={id} title={title} data-rm-subtab={id} data-rm-subtab-active={active === id ? "1" : ""}
            style={{ background: "transparent",
                     color: active === id ? theme.accent : theme.textMuted,
                     border: "none", padding: "12px 16px",
                     cursor: "pointer", fontSize: 13,
                     fontWeight: active === id ? 700 : 500,
                     position: "relative", transition: "color 0.15s",
                     display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}
            onClick={() => onSelect(id)}>
            {label}
            {count !== null && count !== undefined && (
              <span data-rm-subtab-count={id}
                style={{ background: active === id ? theme.accentMuted : theme.surfaceHigh,
                         color: active === id ? theme.accentText : theme.textMuted,
                         fontSize: 10, fontWeight: 700,
                         padding: "1px 7px", borderRadius: 999 }}>
                {count}
              </span>
            )}
            {active === id && (
              <motion.div layoutId={layoutId}
                style={{ position: "absolute", bottom: 0, left: 0, right: 0,
                         height: 2, background: theme.accent, borderRadius: 999 }} />
            )}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/** THE SEARCH INPUT: rounded, magnifier inside, Escape and ✕ both clear it. */
export function PanelSearch({ value, onChange, placeholder, theme, width = 260 }) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center",
                  flex: `0 0 ${width}px` }}>
      <span style={{ position: "absolute", left: 12, fontSize: 13,
                     pointerEvents: "none", color: theme.textDim }}>🔍</span>
      <input value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") onChange(""); }}
        placeholder={placeholder}
        data-rm-panel-search="1"
        className="rm-input"
        style={{ paddingLeft: 36, borderRadius: 999 }} />
      {value && (
        <button style={{ position: "absolute", right: 12, background: "transparent",
                         border: "none", color: theme.textMuted, cursor: "pointer",
                         fontSize: 11 }}
          onClick={() => onChange("")}>✕</button>
      )}
    </div>
  );
}

/**
 * THE "FILTER BY DATE" CONTROL: the pill button, the portal, and the calendar inside it.
 *
 * PORTALLED, and that is not decoration. Both panels put this inside a column that scrolls, and an
 * absolutely-positioned popover inside a scrolling ancestor is CLIPPED by it — clipping is resolved
 * before stacking, so no z-index fixes it. DockPortal is anchored by the button's rect, which is
 * why the rect is captured on the click rather than measured later.
 *
 * @param {string}   value      "YYYY-MM-DD" or ""
 * @param {function} onChange   (iso) => void
 * @param {function} onClear    optional; when given, the pill grows an inline ✕
 * @param {function} onOpen     optional; fired when the popover OPENS, so a caller can fetch
 *                              month markers on a user action rather than on render
 * @param {object}   markers    optional "YYYY-MM-DD" -> count; opt-in, so a panel that passes
 *                              nothing renders exactly what it always did
 * @param {string}   label      what the pill says with no date picked
 */
export function DateFilterButton({
  value, onChange, onClear, onOpen, onMonth, markers, theme,
  label = "Filter by date", format = (iso) => iso, portalKey = "panel-date-filter",
}) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        data-rm-date-filter="1"
        style={{ display: "flex", alignItems: "center", gap: 6,
                 background: value ? theme.accentMuted : theme.surfaceHigh,
                 color: value ? theme.accentText : theme.textMuted,
                 border: `1px solid ${value ? "color-mix(in srgb, var(--color-primary) 25%, transparent)" : theme.border}`,
                 borderRadius: 999, padding: "6px 14px", cursor: "pointer", fontSize: 12,
                 fontWeight: 600, whiteSpace: "nowrap" }}
        onClick={() => {
          const opening = !open;
          setRect(ref.current?.getBoundingClientRect() || null);
          setOpen(opening);
          if (opening) onOpen?.(value);
        }}>
        📅 {value ? `Date: ${format(value)}` : label}
        {value && onClear && (
          <span style={{ marginLeft: 4, color: theme.textMuted, fontWeight: 700, fontSize: 10 }}
            onClick={e => { e.stopPropagation(); onClear(); }}>✕</span>
        )}
      </button>
      <AnimatePresence>
        {open && rect && (
          <DockPortal anchorRect={rect} theme={theme}
            onClose={() => setOpen(false)} style={{ minWidth: 260, padding: 0 }}>
            <motion.div key={portalKey}
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={{ duration: 0.15 }}>
              <DateCalendar theme={theme}
                value={value || ""}
                markers={markers}
                onMonth={onMonth}
                onChange={onChange}
                onClose={() => setOpen(false)} />
            </motion.div>
          </DockPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
