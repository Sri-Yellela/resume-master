// Reads the real bindings from Chrome and sends the user to the only page that can change them.
//
// EVERY DECLARED COMMAND IS LISTED, not just capture. This page named one hotkey while the manifest
// declared two, and that gap is the whole reason the fill shortcut got reported as missing when it
// had been declared, bound and working the entire time — a feature nothing in the UI mentions is
// indistinguishable from a feature that does not exist. The roster comes from
// chrome.commands.getAll(), which returns every declared command with the SAME description string
// chrome://extensions/shortcuts shows, so there is no second inventory to drift: declaring a third
// command lists it here with no change to this file.
//
// This page used to record a custom key combination into chrome.storage.sync, which the content
// script then watched for. That mechanism died with the content script — and it was always the
// weaker of the two, because a page-scoped keydown listener only fires while one of the six
// declared job sites has focus. Capture now runs wherever you invoke it, so a shortcut that only
// worked on six sites would be the one limited thing left.
//
// An extension cannot rebind its own chrome.commands entry; chrome://extensions/shortcuts is the
// only surface that can, so this defers to it rather than pretending otherwise. Saving a setting
// that quietly does nothing is worse than having no setting.

const rows      = document.getElementById('shortcut-rows');
const status    = document.getElementById('status');
const btnChange = document.getElementById('btn-change');

/** Built with createElement rather than innerHTML: the shortcut strings come from Chrome, and the
 *  extension pages run under script-src 'self' with no inline script to spare. */
function renderRow({ description, value, problem }) {
  const row = document.createElement('div');
  row.className = 'shortcut-row';

  const label = document.createElement('label');
  label.textContent = description;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = problem ? 'shortcut-input unset' : 'shortcut-input';
  input.readOnly = true;
  input.tabIndex = -1;
  input.value = value;

  const hint = document.createElement('p');
  hint.className = problem ? 'hint error' : 'hint';
  hint.textContent = problem;

  row.append(label, input, hint);
  rows.append(row);
}

async function loadShortcuts() {
  let commands = null;
  try { commands = await chrome.commands.getAll(); } catch (_) { /* reported per row below */ }

  rows.textContent = '';                    // rebuilt wholesale, so a reload cannot double the list
  if (!commands) {
    renderRow({ description: 'Shortcuts', value: 'Unavailable', problem: '' });
    return;
  }

  // `_execute_action` and friends are Chrome's own reserved entries, not ours to explain.
  for (const { name, description, shortcut } of commands) {
    if (name.startsWith('_')) continue;
    // Chrome silently refuses some combinations — most often because another installed extension
    // already owns the key — which leaves a command with no key at all and no error anywhere.
    // Saying so beats showing a blank box, and this page is the only place it gets said.
    renderRow({
      description: description || name,
      value: shortcut || 'Not set',
      problem: shortcut ? '' : 'No key is bound to this one — set one below.',
    });
  }
}

btnChange.addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  status.textContent = 'Find "Resume Master" in the list — both shortcuts are set there.';
  setTimeout(() => { status.textContent = ''; }, 6000);
});

// A combination saved by the retired recorder would sit in sync storage forever, doing nothing.
chrome.storage.sync.remove('captureShortcut').catch(() => {});

loadShortcuts();

// Coming back from chrome://extensions/shortcuts is the one moment a binding is likely to have
// changed, and this page stays open behind that tab. Without this it would still be showing the
// stale "Not set" the user just went and fixed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadShortcuts();
});
