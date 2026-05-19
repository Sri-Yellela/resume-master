// Shared stamp-badge logo.
// progress: 0 = full "RESUME MASTER", 1 = collapsed to "RM" only.
// Uses var(--color-primary) for the accent shadow rect — no theme prop needed.

export function StampLogo({ progress = 0, size = 'sm' }) {
  const pc = Math.min(Math.max(progress, 0), 1);

  // Two collapsible spans: "esume " and "aster"
  // At progress=1 both collapse → only "R" and "M" remain → "RM"
  const esumeMaxW = size === 'lg' ? 88 : size === 'md' ? 74 : 64;
  const asterMaxW = size === 'lg' ? 73 : size === 'md' ? 62 : 53;
  const esumeW    = Math.round((1 - pc) * esumeMaxW);
  const asterW    = Math.round((1 - pc) * asterMaxW);
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

  const collapseStyle = {
    ...letterStyle,
    display: 'inline-block',
    overflow: 'hidden',
    opacity: textOpacity,
    transition: 'max-width 400ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 350ms ease',
    verticalAlign: 'bottom',
  };

  return (
    <div style={{
      position: 'relative', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', flexShrink: 0, height, minWidth: 50,
    }}>
      {/* Accent shadow rect — sits behind, rotated slightly more */}
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
        <span style={{ ...collapseStyle, maxWidth: esumeW + 'px' }}>esume </span>
        <span style={letterStyle}>M</span>
        <span style={{ ...collapseStyle, maxWidth: asterW + 'px' }}>aster</span>
      </div>
    </div>
  );
}
