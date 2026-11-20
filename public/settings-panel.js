// ⭐ rm-audit M20 + M17 (draft D192 (2), owner 11-19 "approving all open items") · THE SETTINGS PANEL — reached from the
// workspace's top bar (and the editor's): Appearance (draft's four themes — Dusk / Plain, light / dark / the system's) and,
// when accounts are on, the account (public/account-panel.js joins it). The theme is applied by public/theme.js (in every
// page's <head>, before it paints) and kept in this browser only.
export const THEMES = [["dusk", "Dusk"], ["plain", "Plain"]];
export const MODES = [["system", "Match this device"], ["light", "Light"], ["dark", "Dark"]];

export function appearanceNode(el) {
  const [name, mode] = String(window.rmTheme?.get?.() || "dusk:dark").split(":");
  const set = () => {
    const t = box.querySelector('input[name="rm-theme-name"]:checked')?.value || "dusk";
    const m = box.querySelector('input[name="rm-theme-mode"]:checked')?.value || "dark";
    window.rmTheme?.set?.(`${t}:${m}`);
  };
  const group = (key, label, opts, on) => el("fieldset", { class: "set-group" }, el("legend", {}, label),
    ...opts.map(([v, l]) => el("label", { class: "set-opt" },
      el("input", { type: "radio", name: key, value: v, checked: v === on ? true : null, onchange: set }), l)));
  const box = el("section", { class: "set-sec", "data-settings-appearance": "" },
    el("h3", { class: "set-h" }, "Appearance"),
    group("rm-theme-name", "Theme", THEMES, name || "dusk"),
    group("rm-theme-mode", "Light or dark", MODES, mode || "dark"),
    el("p", { class: "set-note" }, "Kept in this browser. A document's page stays white paper in every theme."));
  return box;
}
