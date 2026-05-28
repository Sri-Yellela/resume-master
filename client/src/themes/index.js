import cinematic from "./cinematic.js";

export const THEMES_REGISTRY = { cinematic };
export const DEFAULT_THEME_ID = "cinematic";
export const AVAILABLE_THEMES = Object.values(THEMES_REGISTRY);
export function getTheme(id) {
  return THEMES_REGISTRY[id] || THEMES_REGISTRY[DEFAULT_THEME_ID];
}
