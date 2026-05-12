import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <main style={{
      maxWidth: '960px', margin: '0 auto',
      padding: 'calc(56px + 4rem) 1.5rem 4rem',
      minHeight: '100vh',
    }}>
      <h1 style={{
        fontFamily: 'var(--font-display, sans-serif)',
        fontSize: 'clamp(2rem, 4vw, 3.5rem)',
        fontWeight: 700,
        color: 'var(--color-text, #cdccca)',
        letterSpacing: '-0.025em',
        marginBottom: '1rem',
      }}>
        404 — Page Not Found
      </h1>
      <p style={{
        fontSize: '1.125rem',
        color: 'var(--color-text-muted, #797876)',
        maxWidth: '52ch', lineHeight: 1.7,
      }}>
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link to="/" style={{
        display: 'inline-block', marginTop: '2rem',
        padding: '.625rem 1.5rem',
        background: 'var(--color-primary, #4f98a3)',
        color: '#0f0f0f', borderRadius: '.5rem',
        fontWeight: 700, fontSize: '.875rem',
        textDecoration: 'none',
      }}>
        ← Back to home
      </Link>
    </main>
  );
}
