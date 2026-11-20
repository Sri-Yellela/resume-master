// rm-audit M1 / M16 / M17 · the Settings dialog on every page that wears the site header (home, /pdf/*, privacy): the header's
// one account button opens it — Appearance and the account (sign in / create / reset, or saved documents, credits, export,
// delete). It was the home page's five in-flow panels, hidden on every other page. A reset link (/#reset=…) opens it too.
import { appearanceNode } from "/settings-panel.js";
import { accountNode, accountCall } from "/account-panel.js";

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
};
if (!document.querySelector('link[href="/settings.css"]')) document.head.append(el("link", { rel: "stylesheet", href: "/settings.css" }));

const buttons = [...document.querySelectorAll("[data-open-settings]")];
async function label() {
  let c = null;
  try { c = await accountCall("GET", "/config"); } catch { /* offline: the button stays "Settings" */ }
  for (const b of buttons) b.textContent = c?.signedIn ? `${c.balance} credit${c.balance === 1 ? "" : "s"} · Account` : c?.accounts ? "Sign in" : "Settings";
}
let dlg = null;
export function openSettings() {
  dlg?.remove();
  const close = el("button", { type: "button", class: "set-b", onclick: () => dlg.close() }, "Close");
  dlg = el("dialog", { class: "set-dialog", "aria-labelledby": "set-title", "data-settings": "" },
    el("div", { class: "set-box" }, el("h2", { class: "set-title", id: "set-title" }, "Settings"), appearanceNode(el), accountNode(el, { onChange: label }), el("div", { class: "set-row" }, close)));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
for (const b of buttons) b.addEventListener("click", openSettings);
label();
if (/^#(reset=|signin|signup|account)/.test(location.hash)) openSettings();
window.rmOpenSettings = openSettings;
