// services/appSettings.js
//
// THE ONE DEFINITION OF A RUNTIME-FLIPPABLE SETTING, and in particular of the full-auto kill
// switch. This module exists because the switch was about to get a second reader.
//
// `fullAutoDisabled()` lived inside the closure in routes/apply.js, where the apply pipeline could
// reach it and nothing else could. Giving the admin surface its own copy of "read the row, fall
// back to the env var, coerce with these four truthy spellings" is the defect shape this codebase
// keeps paying for — mapJobRow vs the client mapper, popup vs hotkey, three hardcoded tab lists,
// matchScore vs baseAtsScore. A kill switch whose ADMIN PAGE and whose ENFORCEMENT can disagree
// about whether it is on is worse than one with no admin page at all: it would let someone read
// "disabled" on a screen while runs kept submitting.
//
// So there is one definition here, and both sides import it.

/** Reads a setting, or null. Returns null (not a throw) on an un-migrated DB, so callers fall
 *  through to their env default rather than failing to boot. */
export function getSetting(db, key) {
  try { return db.prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value ?? null; }
  catch { return null; }
}

/** The four spellings accepted everywhere in this repo. Unchanged from routes/apply.js. */
export function settingTruthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

/** Writes a setting and stamps updated_at. Value is stored as TEXT; booleans are canonicalised to
 *  "1"/"0" so a later read cannot depend on which spelling the writer happened to use. */
export function setSetting(db, key, value) {
  const stored = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, stored);
  return stored;
}

/** Removes the override entirely, so the caller falls back to its env default. This is a THIRD
 *  state and it is not decoration: "forced off", "forced on" and "inherit the deploy default" are
 *  genuinely different, and without a delete there is no way back to the third one. */
export function clearSetting(db, key) {
  db.prepare("DELETE FROM app_settings WHERE key=?").run(key);
}

export const FULL_AUTO_KEY = "apply_full_auto_disabled";

/**
 * KILL SWITCH. Blocks all full-auto submission; semi mode keeps working.
 * The DB row wins so it can be flipped with no restart and no deploy; the env var is the
 * boot-level default. Read at request time — never cached — which is the whole point.
 */
export function fullAutoDisabled(db, env = process.env) {
  const row = getSetting(db, FULL_AUTO_KEY);
  if (row !== null) return settingTruthy(row);
  return settingTruthy(env?.APPLY_FULL_AUTO_DISABLED);
}

/** The full picture, for an admin surface that has to explain WHY the switch is where it is.
 *  A screen that says only "disabled: true" cannot tell an operator whether clearing the override
 *  will change anything — which is the one thing they need to know before clearing it. */
export function fullAutoState(db, env = process.env) {
  const override = getSetting(db, FULL_AUTO_KEY);
  const envDefault = settingTruthy(env?.APPLY_FULL_AUTO_DISABLED);
  return {
    disabled: override !== null ? settingTruthy(override) : envDefault,
    source: override !== null ? "override" : "env",
    override,                                   // raw stored text, or null when inheriting
    envDefault,
    envRaw: env?.APPLY_FULL_AUTO_DISABLED ?? null,
  };
}
