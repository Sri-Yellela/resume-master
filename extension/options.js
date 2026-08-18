// Reads the real binding from Chrome and sends the user to the only page that can change it.
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

const input   = document.getElementById('shortcut-input');
const hint    = document.getElementById('hint');
const status  = document.getElementById('status');
const btnChange = document.getElementById('btn-change');

async function loadCurrentShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const capture = commands.find(c => c.name === 'capture-job');
    if (capture?.shortcut) {
      input.value = capture.shortcut;
      hint.textContent = '';
    } else {
      // Chrome silently refuses some combinations, which leaves a command with no key at all and
      // no error anywhere. Saying so beats showing a blank box.
      input.value = 'Not set';
      hint.textContent = 'No key is bound to capture right now — set one below.';
      hint.classList.add('error');
    }
  } catch (_) {
    input.value = 'Unavailable';
  }
}

btnChange.addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  status.textContent = 'Find "Resume Master" in the list and set the capture shortcut.';
  setTimeout(() => { status.textContent = ''; }, 6000);
});

// A combination saved by the retired recorder would sit in sync storage forever, doing nothing.
chrome.storage.sync.remove('captureShortcut').catch(() => {});

loadCurrentShortcut();
