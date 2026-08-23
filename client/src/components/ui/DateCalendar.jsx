// ── THE CALENDAR ─────────────────────────────────────────────────────────────────────────────
//
// EXTRACTED FROM DatabasePanel (panels/DatabasePanel.jsx), NOT REBUILT. Task AC4 says to reuse the
// Database panel's calendar widget rather than building a second date picker, so this is that
// component moved out whole and DatabasePanel now imports it. Both of its uses there — the
// applied-jobs date FILTER in the toolbar and the per-row "set date" cell — render this.
//
// NAMED DateCalendar, NOT Calendar, and the reason is a real hazard rather than taste: there is an
// unrelated components/ui/calendar.jsx in this tree — a shadcn DayPicker wrapper with a different
// API that nothing imports. On a case-insensitive filesystem (this project is developed on Windows)
// a file called Calendar.jsx SILENTLY OVERWRITES it, and git reports the overwrite as a
// modification to the lowercase path rather than as a new file. Reusing "the Database panel's
// calendar" means THIS widget; the distinct name is what keeps the other one from being destroyed
// by an editor that thinks the two paths are the same.
//
// WHAT WAS ADDED, and it is the only change: `markers`. AC4 requirement 7 asks that dates with
// activity be discoverable so the user does not hunt blindly. It is an optional prop and defaults
// to empty, so the Database panel's two call sites render exactly what they rendered before.
//
// A KNOWN QUIRK, PRESERVED DELIBERATELY. `pick` returns `new Date(y, m, d).toISOString().slice(0,10)`
// — local midnight converted to UTC. East of Greenwich that lands on the PREVIOUS day, so a user in
// Kolkata clicking the 15th gets "2023-11-14". This is the behaviour DatabasePanel has always had
// and it is not changed here, because changing it would silently move every date already stored
// through that panel. AC4's own consumer does not inherit the bug: the history endpoint is given
// the browser's getTimezoneOffset() and computes the day boundary from it, so the string this
// returns and the range the server reads agree. Worth fixing on its own, with its own migration of
// existing job_applications.applied_at values; not worth fixing silently inside this task.

import { useState } from "react";

const DAYS   = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

/** The YYYY-MM-DD a day cell resolves to. Exported so a caller can agree with it exactly. */
export function isoForDay(year, month, day) {
  return new Date(year, month, day).toISOString().slice(0, 10);
}

/**
 * @param {string}   value     the selected date, YYYY-MM-DD, or ""
 * @param {function} onChange  called with the new YYYY-MM-DD, or "" for Clear
 * @param {function} onClose   called after a pick
 * @param {object}   theme
 * @param {object}   markers   { "YYYY-MM-DD": count } — days to dot. AC4 requirement 7.
 * @param {function} onMonth   called with "YYYY-MM" when the visible month changes, so a caller can
 *                             fetch that month's markers. Not called on mount by the calendar: the
 *                             caller decides when the first fetch happens, which is what keeps
 *                             AC4 requirement 2 (nothing preloaded) the caller's decision to make.
 */
export function DateCalendar({ value, onChange, onClose, theme, markers = {}, onMonth }) {
  const today = new Date();
  const init  = value ? new Date(value) : today;
  const [view, setView] = useState({ year: init.getFullYear(), month: init.getMonth() });

  const selected = value ? new Date(value) : null;
  const firstDay = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells = Array(firstDay).fill(null).concat(
    Array.from({ length: daysInMonth }, (_, i) => i + 1)
  );
  while (cells.length % 7 !== 0) cells.push(null);

  const go = (next) => { setView(next); onMonth?.(`${next.year}-${String(next.month + 1).padStart(2, "0")}`); };
  const prev = () => go(view.month === 0
    ? { year: view.year - 1, month: 11 }
    : { year: view.year, month: view.month - 1 });
  const next = () => go(view.month === 11
    ? { year: view.year + 1, month: 0 }
    : { year: view.year, month: view.month + 1 });

  const pick = day => {
    if (!day) return;
    onChange(isoForDay(view.year, view.month, day));
    onClose();
  };

  const isSelected = day => {
    if (!day || !selected) return false;
    return selected.getFullYear() === view.year &&
           selected.getMonth()    === view.month &&
           selected.getDate()     === day;
  };
  const isToday = day => {
    if (!day) return false;
    return today.getFullYear() === view.year &&
           today.getMonth()    === view.month &&
           today.getDate()     === day;
  };
  const markerFor = day => day ? markers[isoForDay(view.year, view.month, day)] : undefined;

  return (
    // No position/z-index/frame of its own: this is rendered INSIDE a DockPortal, which supplies
    // the surface, the viewport clamping and the tier. It used to be position:absolute with
    // z-index:300 inside the Applications sheet — and the sheet's root is `flex:1; overflow:hidden`,
    // so the popover was CLIPPED by its ancestor rather than underlapped. That is why it appeared to
    // bleed into the table, and why no z-index value could have fixed it: clipping is resolved before
    // stacking is even considered. Only leaving the clipping ancestor fixes it.
    <div data-rm-calendar="1" style={{ padding:16, width:260, maxHeight:"320px", overflowY:"auto" }}>
      <div style={{ display:"flex", alignItems:"center",
                    justifyContent:"space-between", marginBottom:12 }}>
        <button aria-label="Previous month"
          style={{ background:"transparent",
                   border:`1px solid ${theme.border}`,
                   color:theme.textMuted, borderRadius:"999px", width:28, height:28,
                   cursor:"pointer", fontSize:16,
                   display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={prev}>‹</button>
        <span style={{ fontWeight:700, fontSize:13, color:theme.text }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button aria-label="Next month"
          style={{ background:"transparent",
                   border:`1px solid ${theme.border}`,
                   color:theme.textMuted, borderRadius:"999px", width:28, height:28,
                   cursor:"pointer", fontSize:16,
                   display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={next}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:700,
                                color:theme.textMuted, padding:"4px 0",
                                textTransform:"uppercase" }}>
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          const sel = isSelected(day);
          const tod = isToday(day);
          const mark = markerFor(day);
          return (
            <div key={i}
              data-rm-day={day ? isoForDay(view.year, view.month, day) : ""}
              data-rm-marked={mark ? String(mark) : ""}
              title={mark ? `${mark} application${mark === 1 ? "" : "s"} on this date` : undefined}
              style={{
                textAlign:"center", fontSize:11, padding:"6px 2px", borderRadius:6,
                cursor:day ? "pointer" : "default", userSelect:"none",
                color:sel ? "#fff" : tod ? theme.accent : day ? theme.text : "transparent",
                background:sel ? theme.accent : "transparent",
                border:tod && !sel ? `1px solid ${theme.accent}` : "1px solid transparent",
                fontWeight:sel || tod || mark ? 700 : 400,
                position:"relative",
              }}
              onClick={() => pick(day)}>
              {day || ""}
              {/* AC4 requirement 7: a day with activity is dotted, so the user is not hunting
                  blindly through a calendar of empty days. The dot sits where TODAY's dot sits and
                  defers to it — two marks on one cell reads as noise, and "today" is the more
                  useful of the two when both apply. */}
              {tod && !sel ? (
                <span style={{ position:"absolute", bottom:1, left:"50%",
                               transform:"translateX(-50%)",
                               width:3, height:3, borderRadius:"50%",
                               background:theme.accent, display:"block" }}/>
              ) : mark && !sel ? (
                <span style={{ position:"absolute", bottom:1, left:"50%",
                               transform:"translateX(-50%)",
                               width:3, height:3, borderRadius:"50%",
                               background:theme.textMuted, display:"block" }}/>
              ) : null}
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:10,
                    paddingTop:10, borderTop:`1px solid ${theme.border}` }}>
        <button style={{ background:"transparent", border:"none",
                         color:theme.textMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
          onClick={() => { onChange(""); onClose(); }}>Clear date</button>
        <button style={{ background:"transparent", border:"none",
                         color:theme.textMuted, fontSize:10, cursor:"pointer", fontWeight:600 }}
          onClick={() => { onChange(new Date().toISOString().slice(0,10)); onClose(); }}>
          Today
        </button>
      </div>
    </div>
  );
}

export default DateCalendar;
