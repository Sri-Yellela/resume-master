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
  tabs,
  activeTab,
  onTabChange,
  actions,   // optional ReactNode rendered right-aligned in the tabs row (see below)
  // `hidden` hides this bar WITHOUT removing it from the layout. The caller owns exactly one search
  // surface at a time (hooks/useSearchSurface.js), and it used to express that by unmounting this
  // component — which took its reserved space with it, changed the document height by 386px above
  // the fold, and let Chrome's scroll anchoring drag the scroll offset back across the very
  // threshold that had just been crossed. `visibility` keeps the space, paints nothing, and takes
  // the whole subtree out of the tab order, so the hidden surface is unreachable by keyboard too.
  //
  // It is applied HERE rather than by a wrapper for the same reason `actions` is a slot: .usb is
  // position:sticky with auto margins, and an intermediate box would become its containing block
  // and leave it nothing to stick to.
  hidden = false,
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
         aria-hidden={hidden || undefined}
         style={hidden ? { visibility: 'hidden' } : undefined}>

      {/* `actions` is an optional trailing slot in this row. It lives INSIDE .usb rather than
          being wrapped around the component by the caller because .usb is position:sticky with
          auto margins — wrapping it would change the containing block and break the docking
          transition. Rendered only when supplied, so the marketing landing page (which passes
          neither tabs nor actions) is unaffected. */}
      {/* Vertical rhythm (W6). Measured before this at 1440x900: 21px of space ABOVE the tab row
          and 0px between it and the search field — the tabs were pressed against the input with
          all the air on the wrong side. The row's own padding was "8px 12px 0", i.e. it added to
          the space above and contributed nothing below.

          Now: nothing above (the card's own 20px padding is the frame, and it matches the 20px on
          the left and right), 10px between the tabs and the divider, and 10px between the divider
          and the search field. That 10 is the same module as the row's 12px horizontal padding
          and the tab buttons' 14px, so the spacing reads as one rhythm rather than two. */}
      {((tabs && tabs.length > 0) || actions) && (
        <div style={{
          display: "flex", gap: 4, padding: "0 12px 10px", marginBottom: 10, alignItems: "center",
          borderBottom: "1px solid var(--border-glass)",
        }}>
          {(tabs || []).map(t => (
            <button key={t.id} onClick={() => onTabChange?.(t.id)}
              style={{
                padding: "8px 14px",
                background: activeTab === t.id ? "rgba(255,255,255,0.06)" : "transparent",
                border: activeTab === t.id ? "1px solid var(--color-primary)" : "1px solid transparent",
                borderRadius: 999,
                color: activeTab === t.id ? "var(--color-text)" : "var(--color-text-muted)",
                fontSize: 12, fontWeight: 600, cursor: "pointer",
                textTransform: "uppercase", letterSpacing: "0.08em",
              }}>{t.label}</button>
          ))}
          {actions && (
            <>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", alignItems: "center", paddingBottom: 4 }}>{actions}</div>
            </>
          )}
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
