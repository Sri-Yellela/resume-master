import { useState, useRef, useEffect } from 'react';
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
  onSearch,
  onLocalFilter,
  isLoggedOut = false,
  brandingText = 'Resume Master',
  greeting,
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
    <div className={'usb' + (isDock ? ' usb--dock' : ' usb--hero')}
         role="search" aria-label="Job search">

      {/* Branding — hero: visible, dock: hidden via CSS */}
      <div className="usb__brand">
        <h1 className="usb__title">{brandingText}</h1>
        <p className="usb__sub">
          {greeting
            ? `Welcome back, ${greeting}`
            : isLoggedOut
              ? 'Build the perfect resume. Land your next role.'
              : 'Your personalized job feed.'}
        </p>
      </div>

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
