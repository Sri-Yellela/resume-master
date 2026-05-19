// Shared stamp-badge logo — matches TopBar.jsx AnimatedLucyLogo exactly.
// progress: 0 = full "RESUME MASTER", 1 = collapsed to "R" only.
// Uses var(--color-primary) for the accent shadow rect — no theme prop needed.

export function StampLogo({ progress = 0, size = 'sm' }) {
  const pc = Math.min(Math.max(progress, 0), 1);
  const maxW = size === 'lg' ? 175 : size === 'md' ? 148 : 128;
  const textMaxW = Math.round((1 - pc) * maxW);
  const textOpacity = Math.max(0, 1 - pc * 1.8);
  const fontSize = size === 'lg' ? 20 : size === 'md' ? 17 : 15;
  const height   = size === 'lg' ? 50 : size === 'md' ? 42 : 36;
  const padV     = size === 'lg' ? 5  : size === 'md' ? 4  : 3;
  const padH     = size === 'lg' ? 14 : size === 'md' ? 12 : 10;

  const letterStyle = {
    fontFamily: "'Barlow Condensed','DM Sans',system-ui,sans-serif",
    fontWeight: 800,
    fontSize,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: '#0f0f0f',
    fontStyle: 'italic',
    lineHeight: 1,
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{
      position: 'relative', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', flexShrink: 0, height, minWidth: 50,
    }}>
      {/* Accent shadow rect — sits behind and rotated slightly more */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'var(--color-primary, #4f98a3)',
        transform: 'rotate(-3deg)', borderRadius: 2,
      }}/>
      {/* White stamp rect */}
      <div style={{
        position: 'relative', zIndex: 1,
        padding: `${padV}px ${padH}px`,
        background: '#ffffff',
        border: '2.5px solid #0f0f0f',
        transform: 'rotate(-2deg)',
        borderRadius: 2,
        display: 'flex', alignItems: 'center',
        overflow: 'hidden',
      }}>
        <span style={letterStyle}>R</span>
        <span style={{
          ...letterStyle,
          display: 'inline-block',
          maxWidth: textMaxW + 'px',
          overflow: 'hidden',
          opacity: textOpacity,
          transition: 'max-width 0.075s linear, opacity 0.075s linear',
          verticalAlign: 'bottom',
        }}>esume Master</span>
      </div>
    </div>
  );
}
