// Shared between linkedin-content.js (the custom-shortcut keydown listener) and options.js
// (the settings UI). Plain globals, loaded as a classic script by both — same pattern config.js
// already uses for RESUME_MASTER_URL (content scripts share one execution "world" per page;
// options.html just loads scripts in order like any other page).

const DEFAULT_CAPTURE_COMBO = { ctrl: true, meta: false, shift: true, alt: false, key: 'k' };

const MODIFIER_EVENT_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'OS']);

// Browser/OS-reserved combos that must never be assignable as the custom capture shortcut.
// Windows/Linux (ctrlKey) and Mac (metaKey) variants are both listed so the guard is correct
// regardless of which OS the user is on.
const RESERVED_COMBOS = [
  { key: 'c', ctrl: true }, { key: 'c', meta: true },
  { key: 'v', ctrl: true }, { key: 'v', meta: true },
  { key: 'x', ctrl: true }, { key: 'x', meta: true },
  { key: 'a', ctrl: true }, { key: 'a', meta: true },
  { key: 'z', ctrl: true }, { key: 'z', meta: true },
  { key: 'y', ctrl: true }, { key: 'y', meta: true },
  { key: 't', ctrl: true }, { key: 't', meta: true },
  { key: 'w', ctrl: true }, { key: 'w', meta: true },
  { key: 'n', ctrl: true }, { key: 'n', meta: true },
  { key: 'n', ctrl: true, shift: true }, { key: 'n', meta: true, shift: true },
  { key: 't', ctrl: true, shift: true }, { key: 't', meta: true, shift: true },
  { key: 'w', ctrl: true, shift: true }, { key: 'w', meta: true, shift: true },
  { key: 'tab', ctrl: true }, { key: 'tab', ctrl: true, shift: true },
  { key: 's', ctrl: true }, { key: 's', meta: true },
  { key: 'p', ctrl: true }, { key: 'p', meta: true },
  { key: 'f', ctrl: true }, { key: 'f', meta: true },
  { key: 'r', ctrl: true }, { key: 'r', meta: true },
  { key: 'l', ctrl: true }, { key: 'l', meta: true },
  { key: 'd', ctrl: true }, { key: 'd', meta: true },
  { key: 'h', ctrl: true }, { key: 'h', meta: true },
  { key: 'u', ctrl: true }, { key: 'u', meta: true },
  { key: 'j', ctrl: true }, { key: 'j', meta: true },
  { key: 'delete', ctrl: true, shift: true }, { key: 'delete', meta: true, shift: true },
  { key: 'i', ctrl: true, shift: true }, { key: 'i', meta: true, alt: true },
  { key: 'j', ctrl: true, shift: true }, { key: 'j', meta: true, alt: true },
  { key: 'c', ctrl: true, shift: true }, { key: 'c', meta: true, alt: true },
  { key: 'f5' }, { key: 'f11' }, { key: 'f12' },
];

function normalizeKey(key) {
  return String(key || '').toLowerCase();
}

function isModifierOnlyKeyEvent(event) {
  return MODIFIER_EVENT_KEYS.has(event.key);
}

function eventToCombo(event) {
  return {
    ctrl:  !!event.ctrlKey,
    meta:  !!event.metaKey,
    shift: !!event.shiftKey,
    alt:   !!event.altKey,
    key:   normalizeKey(event.key),
  };
}

function comboHasModifier(combo) {
  return !!(combo.ctrl || combo.meta || combo.alt);
}

function combosMatch(a, b) {
  return !!a.ctrl === !!b.ctrl && !!a.meta === !!b.meta &&
         !!a.shift === !!b.shift && !!a.alt === !!b.alt &&
         normalizeKey(a.key) === normalizeKey(b.key);
}

// Any RESERVED_COMBOS entry omits false modifiers — fill them in as false before comparing.
function isReservedCombo(combo) {
  return RESERVED_COMBOS.some(reserved => combosMatch(
    { ctrl: false, meta: false, shift: false, alt: false, ...reserved },
    combo
  ));
}

// A combo is assignable if it has at least one modifier (an unmodified key would fire while
// the user is just typing) and isn't in the reserved list.
function isAssignableCombo(combo) {
  return comboHasModifier(combo) && !isReservedCombo(combo);
}

function formatCombo(combo) {
  const parts = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.meta) parts.push('Cmd');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  const key = combo.key || '';
  parts.push(key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return parts.join('+');
}
