// shortcutUtils.js (loaded first) provides: DEFAULT_CAPTURE_COMBO, isModifierOnlyKeyEvent,
// eventToCombo, comboHasModifier, isReservedCombo, isAssignableCombo, formatCombo.

const input   = document.getElementById('shortcut-input');
const hint    = document.getElementById('hint');
const status  = document.getElementById('status');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');

let pendingCombo = null; // set only once a valid, non-reserved combo is captured

function setHint(message, isError) {
  hint.textContent = message || '';
  hint.classList.toggle('error', !!isError);
}

function shakeInput() {
  input.classList.remove('shake');
  // Re-trigger the animation even if it just ran.
  requestAnimationFrame(() => input.classList.add('shake'));
  setTimeout(() => input.classList.remove('shake'), 450);
}

async function loadCurrentShortcut() {
  const { captureShortcut } = await chrome.storage.sync.get('captureShortcut');
  input.value = captureShortcut
    ? formatCombo(captureShortcut)
    : `${formatCombo(DEFAULT_CAPTURE_COMBO)} (default)`;
}

input.addEventListener('keydown', (event) => {
  event.preventDefault();
  if (isModifierOnlyKeyEvent(event)) return; // wait for the real key, not just the modifier

  const combo = eventToCombo(event);

  if (!comboHasModifier(combo)) {
    shakeInput();
    setHint('Include a modifier key (Ctrl, Alt, or Cmd).', true);
    return;
  }
  if (isReservedCombo(combo)) {
    shakeInput();
    setHint('That combination is reserved by your browser or OS — choose another.', true);
    return;
  }

  pendingCombo = combo;
  input.value = formatCombo(combo);
  setHint('Press Save to confirm this shortcut.', false);
  btnSave.disabled = false;
});

btnSave.addEventListener('click', async () => {
  if (!pendingCombo) return;
  await chrome.storage.sync.set({ captureShortcut: pendingCombo });
  status.textContent = `Saved — ${formatCombo(pendingCombo)} will now capture the current job.`;
  btnSave.disabled = true;
  setHint('', false);
  setTimeout(() => { status.textContent = ''; }, 4000);
});

btnReset.addEventListener('click', async () => {
  await chrome.storage.sync.remove('captureShortcut');
  pendingCombo = null;
  btnSave.disabled = true;
  await loadCurrentShortcut();
  status.textContent = 'Reset to the default Ctrl+Shift+K (⌘+Shift+K on Mac).';
  setHint('', false);
  setTimeout(() => { status.textContent = ''; }, 4000);
});

loadCurrentShortcut();
