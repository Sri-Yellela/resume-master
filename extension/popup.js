// RESUME_MASTER_URL is defined by config.js, loaded before this script.

function setStatus(msg, timeout = 0) {
  document.getElementById('status').textContent = msg;
  if (timeout) setTimeout(() => setStatus(''), timeout);
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showJobPreview(jobData) {
  document.getElementById('preview-title').textContent = jobData.title || '';
  document.getElementById('preview-company').textContent =
    (jobData.company || '') + (jobData.location ? ' · ' + jobData.location : '');
  document.getElementById('job-preview').style.display = 'block';
  document.getElementById('btn-capture-job').style.display = 'flex';
}

let currentJobData = null;

// A hotkey capture (BYO-2) happens on the page in view, not the popup — there's nothing to
// show "live" in a popup that wasn't open at that moment. This shows the last result, if any,
// as a secondary/bonus status line whenever the popup happens to be opened afterward.
async function showLastCapture() {
  try {
    const { lastCapture } = await chrome.storage.local.get('lastCapture');
    const el = document.getElementById('last-capture');
    if (!el || !lastCapture) return;
    el.textContent = (lastCapture.success ? '✓ Captured: ' : '✗ ') + (lastCapture.message || '');
    el.className = 'result-text ' + (lastCapture.success ? 'success' : 'error');
    el.style.display = 'block';
  } catch (_) { /* storage unavailable */ }
}

// Asked via the service worker, not fetched here. A popup's fetch carries chrome-extension:// as
// its origin, which server.js's corsOrigin refuses in production — so this worked in development
// and would have shown "Sign in" to every production user, hiding the capture button entirely.
//
// Now returns the whole identity, not just a boolean, because the popup has to NAME it.
async function probeAuth() {
  try {
    return await chrome.runtime.sendMessage({ type: 'PROBE_AUTH' });
  } catch (_) {
    return { authenticated: false };
  }
}

// ── WHO THE EXTENSION IS ACTING AS ─────────────────────────────────────────────────────────────
// The extension used to act as whatever session the browser held, and said nothing about it — so
// a user signed in as an admin had an extension with admin reach and no way to notice. It now
// holds its own credential, and this line is how that becomes checkable rather than merely true.
//
// The admin note is shown rather than hidden: an admin should be able to see that their extension
// is deliberately NOT one. The server enforces that regardless of what this says.
function renderIdentity(identity) {
  const who = document.getElementById('identity-who');
  const btn = document.getElementById('btn-disconnect');
  if (!who) return;

  if (!identity?.authenticated) {
    who.textContent = 'Not signed in';
    if (btn) btn.style.display = 'none';
    return;
  }
  who.innerHTML = '';
  who.append('Signed in as ');
  const name = document.createElement('strong');
  name.textContent = identity.username || 'your account';   // textContent: never parse a username
  who.append(name);
  if (identity.accountIsAdmin) {
    const note = document.createElement('span');
    note.className = 'not-admin';
    note.textContent = ' · not acting as admin';
    who.append(note);
  }
  if (btn) btn.style.display = 'inline';
}

async function init() {
  const identity = await probeAuth();
  renderIdentity(identity);

  if (!identity?.authenticated) {
    document.getElementById('btn-sign-in').style.display = 'flex';
    setStatus('Sign in to capture jobs');
    return;
  }

  await showLastCapture();

  // The popup no longer decides whether this page is capturable from a hardcoded list of six
  // hostnames. It asks the service worker, which injects the real extractor under the activeTab
  // grant this popup's own opening created (measured in scripts/e6PopupGrant.mjs).
  //
  // That inverts the old rule. Before, the button appeared only where a content script was
  // declared, so a Greenhouse board on a company's own domain looked unsupported — the extension
  // was not broken there, it was absent. Now the button appears on any http(s) page and the
  // extractor decides. Being wrong costs one "No job found on this page"; the old behaviour cost
  // every embedded board, silently.
  const preview = await chrome.runtime.sendMessage({ type: 'PREVIEW_ACTIVE_TAB' }).catch(() => null);

  if (!preview?.capturable) {
    setStatus('Open a job posting to capture it');
    return;
  }

  document.getElementById('btn-capture-job').style.display = 'flex';

  if (preview.ok) {
    currentJobData = { title: preview.title, company: preview.company, location: preview.location };
    showJobPreview(currentJobData);
    setStatus('Job detected');
  } else if (preview.unreadable) {
    // No grant yet, so the speculative read failed. Clicking the button is itself an invocation.
    setStatus('Ready to capture');
  } else {
    setStatus('No job detected here — capture anyway to try');
  }
}


// The SAME capture the hotkey runs — same message, same implementation, same destination, same
// wording. Previously this button called a second implementation that wrote to a different table
// with a different dedup identity, so "Save Job" and Ctrl+Shift+K were two features wearing one name.
document.getElementById('btn-capture-job').addEventListener('click', async () => {
  const btn = document.getElementById('btn-capture-job');
  btn.textContent = 'Capturing...';
  btn.disabled = true;

  try {
    // One message to the service worker, which runs the same captureActiveTab() the hotkey runs.
    // The popup does not extract, does not fetch, and does not word the outcome.
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_ACTIVE_TAB' });
    setStatus(result?.message || 'Capture failed — try again', 3000);
    if (result?.success) {
      btn.textContent = 'Captured';
    } else {
      btn.textContent = 'Capture job';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = 'Capture job';
    btn.disabled = false;
    setStatus('Could not reach the page — reload and try again', 3000);
  }
});

// Ending the extension's credential on purpose. Revokes server-side and clears it locally, so the
// next invocation bootstraps a fresh one from whatever session is signed in THEN — which is how a
// user switches the identity the extension holds.
document.getElementById('btn-disconnect')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-disconnect');
  btn.disabled = true;
  btn.textContent = 'Disconnecting…';
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {});
  renderIdentity({ authenticated: false });
  document.getElementById('btn-sign-in').style.display = 'flex';
  document.getElementById('btn-capture-job').style.display = 'none';
  setStatus('Disconnected. Sign in to reconnect.');
});

document.getElementById('btn-sign-in').addEventListener('click', () => {
  chrome.tabs.create({ url: `${RESUME_MASTER_URL}/login` });
  setTimeout(() => window.close(), 300);
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_RESUME_BUILDER' });
  setStatus('Opening...', 800);
  setTimeout(() => window.close(), 800);
});

document.getElementById('btn-linkedin').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_LINKEDIN_IMPORT' });
  setStatus('Opening sign in...', 1000);
  setTimeout(() => window.close(), 900);
});

// Collecting the page text was gated on the same hardcoded six-hostname list the capture button
// used, so the ATS tool refused to read a Greenhouse posting on a company's own careers domain and
// opened an empty scorer instead. The gate was never what made the read legal — the activeTab grant
// from opening this popup is — so it is gone. On a page with nothing to read the extraction simply
// comes back empty and the scorer opens blank, which is the old else-branch behaviour anyway.
document.getElementById('btn-ats').addEventListener('click', async () => {
  const tab = await getCurrentTab();
  let jobText = '';
  if (tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body?.innerText?.slice(0, 6000) || '',
      });
      jobText = result || '';
    } catch (_err) { /* no grant, or a page that cannot be injected: open the scorer empty */ }
  }
  await chrome.runtime.sendMessage({ type: 'OPEN_ATS_SCORE', jobText });
  setStatus('Sending to ATS Score...', 1000);
  setTimeout(() => window.close(), 900);
});

// ─── Settings (keyboard shortcuts) ─────────────────────────────────────────
// Named for both commands, not just capture: this button was the only route to the shortcuts page
// and it advertised one of the two hotkeys, which is how the fill shortcut stayed invisible.

document.getElementById('btn-settings')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
