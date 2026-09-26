// Shared stamp-badge logo.
// progress: 0 = the full wordmark, 1 = collapsed to its initial only.
// Uses var(--color-primary) for the accent shadow rect — no theme prop needed.
//
// ⚠ THIS COMPONENT USED TO SPELL THE OLD NAME STRUCTURALLY, and that is worth knowing before you
// change it. It rendered four spans — "R" + "esume " + "M" + "aster" — so that collapsing the two
// middle ones left "RM". A two-word mark with a two-letter collapse has no mechanical translation
// to a one-word mark, so the rebrand could not be a string substitution here: the markup itself
// had to change. It is now one fixed initial plus one collapsible tail, derived from BRAND, which
// works for any single-word name. The stamp, the rotation, the italic and the collapse animation
// are all unchanged — only what the letters spell.
import { WORDMARK } from '../../../shared/brand.js';

// WORDMARK, not BRAND: this component renders the name as a MARK, which is the one place the
// lowercase casing decided on 2026-09-26 applies. The collapse still works letter-wise — 'd' plus
// a collapsible 'raft' — because the derivation was already per-character rather than per-word.
const INITIAL = WORDMARK.slice(0, 1);
const TAIL    = WORDMARK.slice(1);

export function StampLogo({ progress = 0, size = 'sm' }) {
  const pc = Math.min(Math.max(progress, 0), 1);

  // One collapsible span: the tail after the initial.
  // At progress=1 it collapses → only the initial remains.
  //
  // Widths are per-character rather than per-word now. The old constants were hand-tuned to two
  // specific strings (88/74/64 for a six-character "esume ", 73/62/53 for a five-character
  // "aster"), which works out at a shade under 12.3px per character at 'md' and scales with the
  // font size. Deriving from TAIL.length keeps the collapse tight if the name ever changes again.
  const perChar  = size === 'lg' ? 14.7 : size === 'md' ? 12.3 : 10.7;
  const tailMaxW = Math.round(perChar * TAIL.length);
  const tailW    = Math.round((1 - pc) * tailMaxW);
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
      {/* White stamp rect (outer accent rect removed — inner stamp is sufficient) */}
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
        <span style={letterStyle}>{INITIAL}</span>
        <span style={{ ...collapseStyle, maxWidth: tailW + 'px' }}>{TAIL}</span>
      </div>
    </div>
  );
}
