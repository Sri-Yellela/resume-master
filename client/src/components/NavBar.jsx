import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { StampLogo } from './StampLogo.jsx';
import { useLogoSize } from '../hooks/useLogoSize.js';
import InlineLoginPopover from './InlineLoginPopover.jsx';
import './NavBar.css';

const PUBLIC_LINKS = [
  { to: '/products', label: 'Products' },
  { to: '/pricing',  label: 'Pricing'  },
  { to: '/about',    label: 'About'    },
  { to: '/blog',     label: 'Blog'     },
];

// user: authUser object | null
// onLogout: async function
// onLogin: callback(user) invoked after successful inline login
export default function NavBar({ user = null, onLogout, onLogin }) {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const isWide = useLogoSize(); // true when >=768px → show full "RESUME MASTER"

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  return (
    <nav className="navbar" aria-label="Site navigation">

      {/* Logo — full "RESUME MASTER" on wide, "RM" on narrow */}
      <Link to="/" className="navbar__logo" aria-label="Resume Master home">
        <StampLogo progress={isWide ? 0 : 1} />
      </Link>

      {/* Desktop nav links */}
      <div className="navbar__links" role="list">
        {PUBLIC_LINKS.map(({ to, label }) => (
          <Link key={to} to={to} role="listitem"
                className={'navbar__link' + (loc.pathname === to ? ' navbar__link--active' : '')}>
            {label}
          </Link>
        ))}
      </div>

      {/* Desktop auth */}
      <div className="navbar__auth">
        {user ? (
          <>
            <Link to="/app" className="navbar__link">Dashboard</Link>
            {user.isAdmin && (
              <Link to="/admin" className="navbar__link navbar__link--admin">Admin</Link>
            )}
            <button className="navbar__btn navbar__btn--ghost" onClick={onLogout}>
              Sign Out
            </button>
          </>
        ) : (
          <>
            <InlineLoginPopover
              onLogin={onLogin}
              trigger={
                <button className="navbar__btn navbar__btn--ghost" type="button">Sign In</button>
              }
            />
            <Link to="/register" className="navbar__btn navbar__btn--primary">Get Started</Link>
          </>
        )}
      </div>

      {/* Mobile hamburger */}
      <button className="navbar__hamburger" aria-label="Toggle menu"
              aria-expanded={open} onClick={() => setOpen(p => !p)}>
        {open ? <X size={22}/> : <Menu size={22}/>}
      </button>

      {/* Mobile drawer */}
      {open && (
        <div className="navbar__drawer" role="dialog" aria-label="Navigation menu">
          {PUBLIC_LINKS.map(({ to, label }) => (
            <Link key={to} to={to} className="navbar__drawer-link"
                  onClick={() => setOpen(false)}>
              {label}
            </Link>
          ))}
          <hr className="navbar__drawer-divider"/>
          {user ? (
            <>
              <Link to="/app" className="navbar__drawer-link"
                    onClick={() => setOpen(false)}>Dashboard</Link>
              {user.isAdmin && (
                <Link to="/admin" className="navbar__drawer-link"
                      onClick={() => setOpen(false)}>Admin Panel</Link>
              )}
              <button className="navbar__drawer-link navbar__drawer-signout"
                      onClick={() => { onLogout?.(); setOpen(false); }}>
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link to="/login"    className="navbar__drawer-link"
                    onClick={() => setOpen(false)}>Sign In</Link>
              <Link to="/register" className="navbar__drawer-link"
                    onClick={() => setOpen(false)}>Create Account</Link>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
