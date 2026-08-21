import { useState, useEffect, useRef } from 'react';
import { Search, MapPin, Briefcase, Building2, Tag, X } from 'lucide-react';
import UsbSelect from './UsbSelect.jsx';
import UsbSuggest from './UsbSuggest.jsx';
import './UnifiedSearchBar.css';

// ── Option lists come from the shared filter contract ────────────────────────────────────────
//
// These three selects USED to carry their own literals, and two of them were unmatchable on their
// face: 'entry level' / 'mid level' / 'staff' / 'director' against a column holding
// mid|lead|senior|entry|intern|executive, and 'ai ml' against a classifier that writes 'ai_ml'.
// Both were harmless for as long as the controls were wired to nothing and became live defects the
// moment they were wired up. W1 corrected the values in place; this removes the second copy, so
// the drawer's pills and this bar's selects cannot drift apart again — picking Senior here and
// Senior there must mean the same thing, and now it is literally the same array.
//
// `toSelect` adapts { value, label } to the { v, l } shape UsbSelect takes, and prepends the
// "any" option. It does NOT rename or remap any value.
import { EXPERIENCE_LEVELS, DOMAINS, BOARD_STATUS } from '../../../shared/jobFilterOptions.js';

const toSelect = (dim, anyLabel) => [
  { v: '', l: anyLabel },
  ...dim.options.filter(o => o.value !== '').map(o => ({ v: o.value, l: o.label })),
];

const EXP_OPTIONS    = toSelect(EXPERIENCE_LEVELS, 'Any Level');
const DOMAIN_OPTIONS = toSelect(DOMAINS, 'Any Domain');
// BOARD_STATUS already carries its own empty option, with the label this control has always used.
const STATUS_OPTIONS = BOARD_STATUS.options.map(o => ({ v: o.value, l: o.label }));

const DCLICK_MS = 5000;

export default function UnifiedSearchBar({
  mode = 'hero',
  variant = 'floating',  // 'floating' = marketing landing (position:fixed over empty hero)
                         // 'inline'   = app dashboard (position:sticky, in flow, no overlap)
  onSearch,
  onLocalFilter,
  // `tabs`, `activeTab` and `onTabChange` are GONE (Y4). The app's primary navigation was a slot on
  // the search bar, which made the tab row appear and disappear with a control that is only
  // meaningful on the Jobs board. It lives in TopBar now. `actions` stays — those really are board
  // controls and really do belong beside the board's search.
  actions,   // optional ReactNode rendered right-aligned in the actions row (see below)
  // `hidden` is GONE with the pill. It hid this bar without removing it from the layout, because
  // the caller owned exactly one of two search surfaces and unmounting this one took 386px of
  // above-the-fold layout with it, which Chrome's scroll anchoring then subtracted from the scroll
  // offset — dragging it back across the very threshold that had just been crossed. There is one
  // search surface now, so the caller simply renders it or does not, and the reason for the
  // visibility trick is gone with the threshold that needed it.
}) {
  const [q,       setQ]       = useState('');
  const [loc,     setLoc]     = useState('');
  const [exp,     setExp]     = useState('');
  const [domain,  setDomain]  = useState('');
  const [status,  setStatus]  = useState('');
  const [uiState, setUiState] = useState('idle');
  const [cdw,     setCdw]     = useState(null);

  const clicks  = useRef(0);
  const cTmr    = useRef(null);
  const cdwInt  = useRef(null);

  // Any filter change resets double-click state
  useEffect(() => {
    clicks.current = 0;
    setCdw(null);
    setUiState('idle');
    clearTimeout(cTmr.current);
    clearInterval(cdwInt.current);
  }, [q, loc, exp, domain, status]);

  function handleClick() {
    clicks.current += 1;
    const params = { query: q, location: loc, experience: exp, domain, status };

    if (clicks.current === 1) {
      setUiState('local');
      onLocalFilter?.(params);

      let rem = DCLICK_MS / 1000;
      setCdw(rem);
      cdwInt.current = setInterval(() => {
        rem -= 1;
        setCdw(rem);
        if (rem <= 0) {
          clearInterval(cdwInt.current);
          setCdw(null);
          setUiState('idle');
          clicks.current = 0;
        }
      }, 1000);
      cTmr.current = setTimeout(() => {
        clicks.current = 0;
        setUiState('idle');
        setCdw(null);
      }, DCLICK_MS);

    } else {
      clearTimeout(cTmr.current);
      clearInterval(cdwInt.current);
      clicks.current = 0;
      setCdw(null);
      setUiState('loading');
      const p = onSearch?.(params);
      if (p?.finally) p.finally(() => setUiState('live'));
      else setUiState('live');
    }
  }

  const isDock = mode === 'dock';

  return (
    <div className={'usb' + (isDock ? ' usb--dock' : ' usb--hero') + (variant === 'inline' ? ' usb--inline' : '')}
         role="search" aria-label="Job search"
         >

      {/* `actions` is an optional trailing slot in this row. It lives INSIDE .usb rather than
          being wrapped around the component by the caller because .usb is position:sticky with
          auto margins — wrapping it would change the containing block and break the docking
          transition. Rendered only when supplied, so the marketing landing page (which passes
          neither tabs nor actions) is unaffected. */}
      {/* THE ACTIONS ROW. This was the TAB row with an actions slot on the end; the tabs moved into
          TopBar (Y4) and what is left is the board's own controls — the All/Saved/Pending tabs, the
          filter and sort icons, and IMPORT.

          The vertical rhythm is the one W6 established and is deliberately unchanged: nothing above
          (the card's own 20px padding is the frame, matching the 20px left and right), 10px between
          the row and the divider, 10px between the divider and the search field. Before W6 there
          was 21px above and 0px below — all the air on the wrong side.

          The row is space-between rather than right-aligned: with the tabs gone, pushing everything
          right left the whole left half of a 920px card empty. The caller supplies two groups — the
          board's view tabs on the left, its actions on the right — which keeps the same reading
          order the tab row had. */}
      {actions && (
        <div style={{
          display: "flex", gap: 4, padding: "0 12px 10px", marginBottom: 10,
          alignItems: "center", justifyContent: "space-between",
          borderBottom: "1px solid var(--border-glass)",
        }}>
          {actions}
        </div>
      )}

      {/* Search bar */}
      <div className="usb__bar">
        {/* Keyword */}
        <div className="usb__field usb__field--main">
          <Search size={15} className="usb__icon" />
          {/* Suggestions are proposed here and nowhere else — accepting one only fills the box.
              The Enter handler below is unchanged and still runs the search; UsbSuggest only
              intercepts Enter when the user has actually highlighted a row. */}
          <UsbSuggest field="title" value={q} onChange={setQ}>
            {sugg => (
              <input
                {...sugg}
                type="text"
                placeholder="Job title or keywords"
                onKeyDown={e => { sugg.onKeyDown(e); if (!e.defaultPrevented && e.key === 'Enter') handleClick(); }}
                className="usb__input"
                aria-label="Job title"
              />
            )}
          </UsbSuggest>
          {q && (
            <button className="usb__clear" onClick={() => setQ('')} aria-label="Clear">
              <X size={11} />
            </button>
          )}
        </div>

        <div className="usb__div" />

        {/* Location */}
        <div className="usb__field usb__field--loc">
          <MapPin size={13} className="usb__icon" />
          <UsbSuggest field="location" value={loc} onChange={setLoc}>
            {sugg => (
              <input
                {...sugg}
                type="text"
                placeholder="Location or Remote"
                className="usb__input"
                aria-label="Location"
              />
            )}
          </UsbSuggest>
        </div>

        <div className="usb__div" />

        {/* Experience / Domain / Status. These were native <select>s, whose option list is painted
            by the OS and cannot be themed — see the note at the top of UsbSelect.jsx. The icon and
            the chevron moved INSIDE the control so the whole thing is one hit target and one focus
            stop, which is what a native select was; the field wrapper keeps the same class and so
            the same flex sizing. */}
        <div className="usb__field usb__field--sel">
          <UsbSelect value={exp} onChange={setExp} options={EXP_OPTIONS}
                     ariaLabel="Experience" icon={Briefcase} />
        </div>

        <div className="usb__div" />

        <div className="usb__field usb__field--sel">
          <UsbSelect value={domain} onChange={setDomain} options={DOMAIN_OPTIONS}
                     ariaLabel="Domain" icon={Building2} />
        </div>

        <div className="usb__div" />

        <div className="usb__field usb__field--sel">
          <UsbSelect value={status} onChange={setStatus} options={STATUS_OPTIONS}
                     ariaLabel="Status" icon={Tag} />
        </div>

        {/* Search button */}
        <button
          className={
            'usb__btn' +
            (uiState === 'live'    ? ' usb__btn--live'    : '') +
            (uiState === 'loading' ? ' usb__btn--loading' : '')
          }
          onClick={handleClick}
          aria-label="Search"
        >
          {uiState === 'loading'
            ? <span className="usb__spin" aria-hidden="true" />
            : <Search size={17} aria-hidden="true" />}
          {cdw !== null && (
            <span className="usb__cdw" title="Click again for live search">
              {cdw}s
            </span>
          )}
        </button>
      </div>

      {/* Hints */}
      {uiState === 'local' && cdw !== null && (
        <p className="usb__hint">
          Filtered locally · Click again within <strong>{cdw}s</strong> for live search
        </p>
      )}
      {uiState === 'live' && (
        <p className="usb__hint usb__hint--live">Searching all sources…</p>
      )}
    </div>
  );
}
