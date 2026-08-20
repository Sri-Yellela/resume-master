import { useState, useEffect, useRef } from 'react';
import { Search, MapPin, Briefcase, Building2, Tag, ChevronDown, X } from 'lucide-react';
import './UnifiedSearchBar.css';

const EXP_OPTIONS = [
  { v: '',            l: 'Any Level'   },
  { v: 'intern',      l: 'Intern'      },
  { v: 'entry level', l: 'Entry Level' },
  { v: 'mid level',   l: 'Mid Level'   },
  { v: 'senior',      l: 'Senior'      },
  { v: 'staff',       l: 'Staff / Lead'},
  { v: 'director',    l: 'Director'    },
];

const DOMAIN_OPTIONS = [
  { v: '',           l: 'Any Domain'  },
  { v: 'saas',       l: 'Tech / SaaS' },
  { v: 'fintech',    l: 'Fintech'     },
  { v: 'healthtech', l: 'Healthtech'  },
  { v: 'ai ml',      l: 'AI / ML'     },
  { v: 'ecommerce',  l: 'E-commerce'  },
  { v: 'climate',    l: 'Climate Tech' },
  { v: 'devtools',   l: 'Dev Tools'   },
  { v: 'edtech',     l: 'EdTech'      },
];

const STATUS_OPTIONS = [
  { v: '',        l: 'All Jobs' },
  { v: 'new',     l: 'New Only' },
  { v: 'starred', l: 'Starred'  },
  { v: 'applied', l: 'Applied'  },
];

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
      {((tabs && tabs.length > 0) || actions) && (
        <div style={{
          display: "flex", gap: 4, padding: "8px 12px 0", alignItems: "center",
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
          <input
            type="text"
            placeholder="Job title or keywords"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleClick()}
            className="usb__input"
            aria-label="Job title"
          />
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
          <input
            type="text"
            placeholder="Location or Remote"
            value={loc}
            onChange={e => setLoc(e.target.value)}
            className="usb__input"
            aria-label="Location"
          />
        </div>

        <div className="usb__div" />

        {/* Experience */}
        <div className="usb__field usb__field--sel">
          <Briefcase size={13} className="usb__icon" />
          <select value={exp} onChange={e => setExp(e.target.value)}
                  className="usb__sel" aria-label="Experience">
            {EXP_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <ChevronDown size={11} className="usb__chev" />
        </div>

        <div className="usb__div" />

        {/* Domain */}
        <div className="usb__field usb__field--sel">
          <Building2 size={13} className="usb__icon" />
          <select value={domain} onChange={e => setDomain(e.target.value)}
                  className="usb__sel" aria-label="Domain">
            {DOMAIN_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <ChevronDown size={11} className="usb__chev" />
        </div>

        <div className="usb__div" />

        {/* Status */}
        <div className="usb__field usb__field--sel">
          <Tag size={13} className="usb__icon" />
          <select value={status} onChange={e => setStatus(e.target.value)}
                  className="usb__sel" aria-label="Status">
            {STATUS_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <ChevronDown size={11} className="usb__chev" />
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
