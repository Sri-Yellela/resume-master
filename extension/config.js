// ─── Resume Master — canonical server URL ────────────────────────────────────
// This is the single source of truth for popup.js and content scripts.
// background.js (service worker module) keeps its own copy — keep them in sync.
//
// DEV SWITCH: comment line A, uncomment line B to point at localhost.
const RESUME_MASTER_URL = 'https://resumemaster.one'; // A: production
// const RESUME_MASTER_URL = 'http://localhost:3000'; // B: local dev
