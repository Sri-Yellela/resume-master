// ─── draft — canonical server URL ────────────────────────────────────────────
// This is the single source of truth for popup.js and content scripts.
// background.js (service worker module) keeps its own copy — keep them in sync.
//
// ⛔ The CONSTANT NAME keeps the old identifier spelling on purpose (docs/BRAND.md: identifiers
// do not get renamed, only user-visible strings do), and several harnesses rewrite this exact
// declaration to point at a local server. Change the VALUE, never the name.
//
// DEV SWITCH: comment line A, uncomment line B to point at localhost.
const RESUME_MASTER_URL = 'https://jobsviadraft.com'; // A: production
// const RESUME_MASTER_URL = 'http://localhost:3000'; // B: local dev
