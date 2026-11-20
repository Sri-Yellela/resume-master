// ⭐ rm-audit M16 + M17 (draft D192 (2), owner 11-19 "approving all open items") · THE ACCOUNT, inside Settings. Sign in,
// create an account and reset a password were panels scrolled into the home page only, and Account (saved documents, credits,
// export, delete) was a fifth panel there with a native prompt() for the password. Now they are one section of the Settings
// dialog, reached from the workspace's top bar, the editor and the site header on every page. Same routes, same server
// (/v1/site/account/…, /v1/site/documents/…); RM accounts stay separate from draft's. Every write carries X-RM-Client: web.
async function call(method, path, body) {
  const r = await fetch(`/v1/site${path}`, {
    method, credentials: "same-origin",
    headers: { "content-type": "application/json", "x-rm-client": "web" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}
export const accountCall = call;

/** The account section: signed out → sign in / create / reset; signed in → documents, credits, export, delete, sign out. */
export function accountNode(el, { onChange = () => {} } = {}) {
  const box = el("section", { class: "set-sec", "data-settings-account": "" }, el("h3", { class: "set-h" }, "Your account"), el("p", { class: "set-note" }, "Loading…"));
  const msg = (text, kind = "") => el("p", { class: `set-msg${kind ? ` set-msg--${kind}` : ""}`, role: kind === "bad" ? "alert" : "status" }, text);
  const field = (label, attrs) => el("label", { class: "set-field" }, label, el("input", { class: "set-in", ...attrs }));
  const draw = (...kids) => { box.replaceChildren(el("h3", { class: "set-h" }, "Your account"), ...kids.flat().filter(Boolean)); };
  const resetToken = (location.hash.match(/^#reset=([A-Za-z0-9_-]+)$/) || [])[1];

  function form(fields, action, run, extra = []) {
    const out = el("p", { class: "set-msg", role: "status" });
    const go = el("button", { type: "submit", class: "set-b set-b--p" }, action);
    const f = el("form", { class: "set-form", onsubmit: async (e) => {
      e.preventDefault(); go.disabled = true; out.textContent = ""; out.className = "set-msg";
      try { const said = await run(Object.fromEntries([...f.elements].filter(i => i.name).map(i => [i.name, i.value]))); if (said) { out.textContent = said; out.className = "set-msg set-msg--good"; } }
      catch (x) { out.textContent = x.message; out.className = "set-msg set-msg--bad"; }
      finally { go.disabled = false; }
    } }, ...fields, el("div", { class: "set-row" }, go, ...extra), out);
    return f;
  }
  function signedOut(view = "signin") {
    const tabs = el("div", { class: "set-row", role: "tablist" }, ...[["signin", "Sign in"], ["signup", "Create an account"], ["reset", "Forgot your password?"]].map(([v, l]) =>
      el("button", { type: "button", role: "tab", class: `set-b${v === view ? " set-b--on" : ""}`, "aria-selected": String(v === view), onclick: () => signedOut(v) }, l)));
    const auth = (path) => async (v) => { await call("POST", path, { email: v.email, password: v.password }); onChange(); await refresh(); return ""; };
    const body = view === "signin" ? form([field("Email", { type: "email", name: "email", required: true, autocomplete: "email" }), field("Password", { type: "password", name: "password", required: true, autocomplete: "current-password" })], "Sign in", auth("/account/signin"))
      : view === "signup" ? [el("p", { class: "set-note" }, "Free credits every month for Tailor, and a place for the documents you choose to keep. Separate from any draft account."),
          form([field("Email", { type: "email", name: "email", required: true, autocomplete: "email" }), field("Password (10+ characters)", { type: "password", name: "password", required: true, minlength: "10", autocomplete: "new-password" })], "Create account", auth("/account/signup"))]
      : form([field("Email", { type: "email", name: "email", required: true })], "Email me a link", async (v) => (await call("POST", "/account/password-reset", { email: v.email })).message);
    draw(tabs, body);
  }
  function confirmReset() {
    draw(el("p", { class: "set-note" }, "Choose a new password."), form([field("New password (10+ characters)", { type: "password", name: "password", required: true, minlength: "10", autocomplete: "new-password" })], "Set the new password",
      async (v) => { const m = (await call("POST", "/account/password-reset/confirm", { token: resetToken, password: v.password })).message; history.replaceState(null, "", location.pathname); return m; }));
  }
  async function signedIn() {
    const a = await call("GET", "/account");
    const d = await call("GET", "/documents");
    const docs = el("ul", { class: "set-docs" }, ...(d.documents.length ? d.documents.map(doc => el("li", {},
      el("span", {}, el("b", {}, doc.title || doc.kind.replace("_", " ")), el("span", { class: "set-note" }, ` · ${doc.kind.replace("_", " ")} · ${doc.pinned ? "pinned — kept until you unpin or delete it" : `deleted ${new Date(doc.expiresAt).toLocaleDateString()}`}`)),
      el("span", { class: "set-row" },
        el("button", { type: "button", class: "set-b", "data-doc-open": doc.id, onclick: () => openDoc(doc.id) }, "Open"),
        el("button", { type: "button", class: "set-b", onclick: async () => { await call("POST", `/documents/${doc.id}/pin`, { pinned: !doc.pinned }); refresh(); } }, doc.pinned ? "Unpin" : "Pin"),
        el("button", { type: "button", class: "set-b", onclick: async () => { await call("DELETE", `/documents/${doc.id}`); refresh(); } }, "Delete"))))
      : [el("li", { class: "set-note" }, "Nothing saved yet.")]));
    const ledger = el("table", { class: "set-ledger" }, el("tr", {}, ...["When", "What", "Credits"].map(h => el("th", {}, h))),
      ...a.ledger.slice(0, 20).map(l => el("tr", {}, el("td", {}, new Date(l.at).toLocaleString()), el("td", {}, l.reason === "debit" ? l.route : l.reason.replace("_", " ")), el("td", {}, `${l.delta > 0 ? "+" : ""}${l.delta}`))));
    const del = form([field("Your password, to delete the account", { type: "password", name: "password", required: true, autocomplete: "current-password" })], "Delete my account",
      async (v) => { const m = (await call("DELETE", "/account", { password: v.password })).message; onChange(); setTimeout(refresh, 1200); return m; });
    del.classList.add("set-danger");
    draw(el("p", {}, el("b", {}, a.user.email), ` · ${a.balance} credit${a.balance === 1 ? "" : "s"} · ${a.monthlyGrant} free each month`),
      el("p", { class: "set-note" }, `Saved documents are kept ${a.retentionDays} days, then deleted — unless you pin them.`),
      el("h4", { class: "set-h4" }, "Saved documents"), docs,
      el("h4", { class: "set-h4" }, "Credits"), ledger,
      el("div", { class: "set-row" }, el("a", { class: "set-b", href: "/v1/site/account/export", download: "" }, "Export everything (JSON)"),
        el("button", { type: "button", class: "set-b", onclick: async () => { await call("POST", "/account/signout", {}).catch(() => {}); onChange(); refresh(); } }, "Sign out")),
      el("details", { class: "set-more" }, el("summary", {}, "Delete the account…"), el("p", { class: "set-note" }, "This deletes your account, its credits and every saved document."), del));
  }
  /** A saved document opens where it is worked on: a résumé in the editor, a report or text as plain text. */
  async function openDoc(id) {
    const doc = await call("GET", `/documents/${id}`);
    if (doc.kind === "formatted_resume" || doc.kind === "generated_resume") {
      try { sessionStorage.setItem("rm-editor:handoff", JSON.stringify({ html: doc.content, filename: `${(doc.title || "resume").replace(/\W+/g, "-")}.html` })); } catch { /* blocked */ }
      location.href = "/editor/";
      return;
    }
    const text = typeof doc.content === "string" ? doc.content : JSON.stringify(doc.content, null, 2);
    window.open(URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })), "_blank", "noopener");
  }
  async function refresh() {
    let config;
    try { config = await call("GET", "/config"); } catch { config = { accounts: false }; }
    if (!config.accounts) return draw(el("p", { class: "set-note" }, "Accounts are not switched on here yet — every free tool works without one."));
    if (resetToken && !config.signedIn) return confirmReset();
    if (!config.signedIn) return signedOut();
    try { await signedIn(); } catch (x) { draw(msg(x.message, "bad")); }
  }
  refresh();
  return box;
}
