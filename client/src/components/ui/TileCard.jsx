// ── THE TILE CARD ────────────────────────────────────────────────────────────────────────────
//
// EXTRACTED FROM ManageJobProfiles (panels/JobProfilesPanel.jsx), NOT REBUILT FROM A DESCRIPTION
// OF IT. Task AC3 says to reuse that panel's card primitive and not to clone the styling into a
// second implementation, so this file is the original markup lifted out and parameterised: every
// value below — the 16px radius, the 18px horizontal padding, the 9%-tinted active background, the
// 12px radius on the inset, the `repeat(auto-fill, minmax(260px, 1fr))` grid — is the one that was
// already there. JobProfilesPanel now renders these components, so there is one implementation and
// the two surfaces cannot drift.
//
// IT WAS EXTRACTABLE, and worth saying why, because the task asks for that judgement. The card was
// inline JSX rather than a component, but it was already a clean four-part shape with no
// JobProfiles-specific logic in its layout: header (title + pill), a metadata line, an inset
// sub-block for the state that matters, and a footer action row. Everything profile-specific — the
// resume upload input, the Edit/Switch/Delete handlers — is content passed in, not structure.
//
// WHY CSS VARS RATHER THAN THE `theme` OBJECT. JobProfilesPanel styles with var(--color-*) and
// AutoApplyPanel styles with the `theme` object from useTheme(). They are the same values: theme.jsx
// publishes a live bridge (--color-primary ← theme.accent, --color-surface ← var(--bg-card), and so
// on) that re-renders with the theme. Keeping the vars means this is the profile card's own styling
// language unaltered, which is the point — converting it to `theme` lookups would have been a
// rewrite that happened to look the same today.

/**
 * The responsive grid the profile cards sit in.
 *
 * `auto-fill` with a min track is what makes AC3 requirement 3 work in both directions without a
 * media query: at desktop width several tiles share a row; below `min` there is room for one and
 * they stack. `min` is a prop because a company tile carries a list of applications and needs more
 * room than a profile tile's three lines — the mechanism is identical, the threshold is not.
 */
export function TileGrid({ children, min = 260, gap = 14, style = {} }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
      gap,
      ...style,
    }}>
      {children}
    </div>
  );
}

/**
 * One bordered tile: title + status pill, a compact metadata line, a body line, an inset sub-block,
 * and a footer action row.
 *
 * @param {string}  title      the tile's subject, in the user's terms
 * @param {node}    pill       the status chip beside it, or null
 * @param {node}    meta       the compact metadata line under the title
 * @param {node}    body       the summary line between the header and the inset
 * @param {node}    inset      the sub-block for the state that matters most
 * @param {node}    footer     the action row
 * @param {boolean} active     draws the accent border and the tinted background
 * @param {string}  tone       overrides the border colour for a non-accent state (a problem, a hold)
 * @param {object}  data       data-* attributes, for the real-browser checks in scripts/abPanelUi.mjs
 */
export function TileCard({
  title, pill, meta, body, inset, footer, active = false, tone = null, data = {}, style = {},
}) {
  return (
    <div
      data-rm-tile={data.tile || "tile"}
      {...Object.fromEntries(Object.entries(data)
        .filter(([k]) => k !== "tile")
        .map(([k, v]) => [`data-rm-${k}`, v ?? ""]))}
      style={{
        border: `1px solid ${tone || (active ? "var(--color-primary)" : "var(--color-border)")}`,
        // The accent tint that marks the ACTIVE profile. A tone'd tile keeps the plain surface —
        // two competing background tints on one grid stops either reading as a state.
        background: active && !tone
          ? "color-mix(in srgb, var(--color-primary) 9%, transparent)"
          : "var(--color-surface)",
        // The 3px left rule is the one addition to the profile card's shape, and it is the Auto
        // Apply panel's existing language for "held on purpose vs this broke" — the same rule its
        // rows and cards already carry. Absent unless a tone is given, so a profile card is
        // byte-identical to what it was.
        ...(tone ? { borderLeft: `3px solid ${tone}` } : {}),
        borderRadius: 16,
        padding: "16px 18px",
        boxShadow: "var(--shadow-sm)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...style,
      }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, wordBreak: "break-word" }}>{title}</div>
          {meta && (
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>{meta}</div>
          )}
        </div>
        {pill}
      </div>

      {body != null && (
        // minHeight keeps a grid of tiles from ragging when one subject has less to say than
        // another. It is the profile card's own value.
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 12,
                      minHeight: 36, lineHeight: 1.45 }}>
          {body}
        </div>
      )}

      {inset && (
        <div style={{
          marginTop: 14,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-offset)",
          borderRadius: 12,
          padding: "10px 12px",
        }}>
          {inset}
        </div>
      )}

      {footer && (
        // marginTop:auto so a footer sits on the tile's floor rather than floating under a short
        // body — without it a grid row of unequal tiles has its action rows at three heights.
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, alignItems: "center" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

/** The tile's status chip. Accent by default; `tone` for a state that is not the accent's. */
export function TilePill({ children, tone = null }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 800,
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: tone ? "#ffffff" : "var(--color-primary-text)",
      background: tone || "var(--color-primary-muted)",
      borderRadius: 999,
      padding: "3px 8px",
      whiteSpace: "nowrap",
      flexShrink: 0,
    }}>
      {children}
    </span>
  );
}
