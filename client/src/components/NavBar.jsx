import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { StampLogo } from './StampLogo.jsx';
import './NavBar.css';

const PUBLIC_LINKS = [
  { to: '/products', label: 'Products' },
  { to: '/pricing',  label: 'Pricing'  },
  { to: '/about',    label: 'About'    },
  { to: '/blog',     label: 'Blog'     },
];

// user: authUser object | null
// onLogout: async function
export default function NavBar({ user = null, onLogout }) {
  const loc = useLocation();
  const [open,     setOpen]     = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const isLanding = loc.pathname === '/';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const navClass =
    'navbar' +
    (isLanding ? ' navbar--landing' : '') +
    (scrolled  ? ' navbar--scrolled' : '');

  return (
    <nav className={navClass} aria-label="Site navigation">

      {/* Logo */}
      <Link to="/" className="navbar__logo" aria-label="Resume Master home">
        <StampLogo />
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
            <Link to="/login"    className="navbar__btn navbar__btn--ghost">Sign In</Link>
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
