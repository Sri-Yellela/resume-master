export default function ProductsPage() {
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
        Products
      </h1>
      <p style={{
        fontSize: '1.125rem',
        color: 'var(--color-text-muted, #797876)',
        maxWidth: '52ch', lineHeight: 1.7,
      }}>
        Resume scoring, cover letter generation, job tracking,
        and ATS optimization tools — all in one place.
      </p>
      <div style={{
        marginTop: '3rem', padding: '2rem',
        background: 'var(--color-surface, #1c1b19)',
        borderRadius: '1rem',
        border: '1px solid var(--color-border, #393836)',
        color: 'var(--color-text-muted, #797876)',
        fontSize: '.875rem',
      }}>
        🚧 This page is coming soon.
      </div>
    </main>
  );
}
