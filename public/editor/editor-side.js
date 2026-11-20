// ⭐ rm-audit M6 + M7 + M5 (draft D192 (2) / (3d), owner 11-19 "approving all open items") · the résumé editor, BY ITSELF on
// resumemaster.one (never when draft embeds it — rm-editor/1 and draft's focused mode are untouched):
//   · Format is merged in: "Paste a résumé" (text or HTML) opens it here already formatted (POST /v1/site/tools/format — the
//     deterministic formatter, no model), instead of a one-shot preview with no editing;
//   · a properties column beside the page: the Résumé tab is the ONE ATS panel (public/ats-panel.js) over this document's
//     text, and the Tailor tab is the old Tailor form — the job comes from the panel, the result opens HERE as a new
//     version with "Back to before tailoring" (POST /v1/site/tools/generate: signed in, 1 credit only if a résumé comes
//     back; the claim guard withholds a draft that claims more than the résumé states). ⛔ D190: Tailor is the one tool
//     whose new text comes from a model (owner question 3, 11-19: it stays); nothing else here calls one.
import { mountAtsPanel } from "/ats-panel.js";

const $ = (s, el = document) => el.querySelector(s);
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
async function call(path, body) {
  const r = await fetch(`/v1/site${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "x-rm-client": "web" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}
// replaceChildren writes "null" for a null child — every optional line goes through put()
const put = (box, ...kids) => box.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toHtml = (text) => /<[a-z][\s\S]*>/i.test(text) ? text
  : `<div>${text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join("")}</div>`;
const openSettings = async () => { await import("/site-settings.js"); window.rmOpenSettings?.(); };

// ⭐ draft D192 (2) / P4 · THE COVER LETTER, a document type in the same editor: the editor's own section model
// (src/editor/sections.js — data-rm-section wrappers), so it is edited, reordered, styled, kept and downloaded like a résumé.
// A synthetic placeholder person; every line is meant to be replaced.
export const COVER_LETTER = `<html><body>
<section data-rm-section="head" data-rm-kind="header"><div class="header"><div class="name">Your Name</div><div class="contact">City, ST · you@example.com · (555) 010-0000</div></div></section>
<section data-rm-section="to" data-rm-kind="other" data-rm-title="Date and recipient"><div>${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div><div>Hiring team · Company name · City, ST</div></section>
<section data-rm-section="letter" data-rm-kind="other" data-rm-title="The letter"><p>Dear hiring team,</p>
<p>The first paragraph names the role and why this company: one specific thing they build or care about, in a sentence.</p>
<p>The second paragraph is the evidence — two results from your résumé that match what the posting asks for, with their numbers.</p>
<p>The last paragraph says what you would do first in the role, and asks for the conversation.</p></section>
<section data-rm-section="close" data-rm-kind="other" data-rm-title="Closing"><p>Sincerely,</p><p>Your Name</p></section>
</body></html>`;

// ⭐ D192 P4 · THE WORKSPACE'S SHELL around the structured editor (D189): the top bar (the stamp, the file's name, its saved
// state, Download ▾, Settings), the mode tabs — the workspace's five PDF modes (they open the workspace) with Structured
// selected — and the editor's own bar as the tool bar under them. By itself only; the embedded editor never draws it.
export function mountShell() {
  const name = el("span", { class: "ws-name", id: "ed-name" }, "Untitled");
  const dl = el("div", { class: "ws-menu", id: "ed-dl-menu", role: "menu", hidden: true },
    el("button", { type: "button", role: "menuitem", class: "ws-menu__i", "data-dl": "pdf", onclick: () => { dl.hidden = true; $("#download-pdf")?.click(); } }, "PDF"),
    el("button", { type: "button", role: "menuitem", class: "ws-menu__i", "data-dl": "html", onclick: () => { dl.hidden = true; $("#download-html")?.click(); } }, "HTML"));
  const dlBtn = el("button", { type: "button", class: "ws-b", id: "ed-download", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => { dl.hidden = !dl.hidden; dlBtn.setAttribute("aria-expanded", String(!dl.hidden)); } }, "Download ▾");
  document.addEventListener("click", (e) => { if (!dl.hidden && !e.target.closest("#ed-dl-menu, #ed-download")) dl.hidden = true; });
  const top = el("header", { class: "ed-top", "data-shell": "", role: "banner" },
    el("a", { class: "ws-stamp", href: "/", "aria-label": "Resume Master — home" }, el("span", {}, "RM")),
    name, el("span", { class: "ws-grow" }),
    el("span", { class: "ws-dl" }, dlBtn, dl),
    el("button", { type: "button", class: "ws-b ws-ic", "aria-label": "Settings", title: "Settings — appearance, your account", onclick: openSettings }, "⚙"));
  const modes = el("nav", { class: "ws-modes ed-modes", role: "tablist", "aria-label": "Modes" },
    ...[["edit", "Edit"], ["annotate", "Annotate"], ["sign", "Fill & sign"], ["pages", "Pages"], ["convert", "Convert"]].map(([m, l]) =>
      el("a", { role: "tab", class: "ws-mode", href: `/workspace/?mode=${m}`, "aria-selected": "false", title: "A PDF mode — opens the workspace" }, l)),
    el("span", { role: "tab", class: "ws-mode", "aria-selected": "true", "data-mode": "structured" }, "Structured"));
  document.body.prepend(top, modes);
  document.documentElement.dataset.shell = "true";
  // the file's name follows the document (a cover letter is named as one)
  const sync = () => { const k = window.__rmEditorKind?.(); name.textContent = k === "cover-letter" ? "Cover letter" : $("#menu-title")?.textContent && !$(".wrap")?.hidden ? "Résumé" : "Untitled"; };
  new MutationObserver(sync).observe($("#menu-title"), { childList: true, characterData: true, subtree: true });
  sync();
  return { sync };
}

export function mountSide({ load: loadDoc, getText, params }) {
  // every load (paste, tailor, cover letter, back) redraws the ATS panel's source line — it was drawn for an empty page
  let ats = null;
  const load = (html, m) => { loadDoc(html, m); ats?.refresh(); };
  mountShell();
  // ── the cover letter: a start option, and /editor/?doc=cover-letter ──
  const startCover = () => load(COVER_LETTER, { filename: "cover-letter.html", kind: "cover-letter" });
  $(".start__row", $("#start"))?.append(el("button", { type: "button", class: "btnlike", id: "open-cover", onclick: startCover }, "Start a cover letter"));
  if (params.get("doc") === "cover-letter") startCover();
  // ── Format, merged: paste a résumé on the start page ──
  const start = $("#start");
  const paste = el("form", { class: "paste", "data-paste": "", hidden: params.get("paste") !== "1", onsubmit: async (e) => {
    e.preventDefault();
    const err = $("#start-error"); err.textContent = "Formatting…";
    try {
      const r = await call("/tools/format", { html: toHtml(paste.text.value), title: "Résumé" });
      err.textContent = ""; load(r.html, { filename: "resume.html" });
    } catch (x) { err.textContent = x.message; }
  } }, el("label", { class: "paste__l" }, "Paste your résumé — text with one line per heading, role or bullet, or HTML",
    el("textarea", { name: "text", rows: "10", required: true, class: "paste__t" })), el("button", { type: "submit", class: "btnlike cta" }, "Format it and edit"));
  $(".start__row", start)?.append(el("button", { type: "button", class: "btnlike", id: "open-paste", onclick: () => { paste.hidden = false; paste.text.focus(); } }, "Paste a résumé"));
  $(".start__row", start)?.after(paste);

  // ── the properties column: Résumé (the ATS panel) · Tailor ──
  const tabs = el("div", { class: "side__tabs", role: "tablist" });
  const side = el("aside", { class: "side", id: "side", "aria-label": "Properties" }, tabs);
  const panels = {};
  const tab = (id, label) => {
    const b = el("button", { type: "button", role: "tab", class: "side__tab", "data-side": id, "aria-selected": "false", onclick: () => pick(id) }, label);
    tabs.append(b);
    panels[id] = el("section", { class: "side__panel", "data-side-panel": id, hidden: true });
    side.append(panels[id]);
  };
  const pick = (id) => { for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.side === id)); for (const [k, p] of Object.entries(panels)) p.hidden = k !== id; if (id === "resume") ats.refresh(); };
  tab("resume", "Résumé"); tab("tailor", "Tailor");
  tabs.append(el("button", { type: "button", class: "side__set", title: "Settings — appearance, your account", "aria-label": "Settings", onclick: openSettings }, "⚙"));
  ats = mountAtsPanel(panels.resume, { resumeText: getText, resumeLabel: () => "Scored from this résumé as it reads now." });

  // Tailor (M7): the job from the panel above (kept in this tab of the browser), the rest here
  const job = () => { try { return JSON.parse(sessionStorage.getItem("rm-ats:job") || "{}"); } catch { return {}; } };
  const out = el("div", { class: "tailor__out", role: "status" });
  let before = null;
  const f = el("form", { class: "ats-form", "data-tailor": "", onsubmit: async (e) => {
    e.preventDefault();
    const j = job(), go = f.querySelector("button[type=submit]");
    // D192 P4: Tailor rewrites résumés. A cover letter would need a NEW model prompt — not added (the lane's instruction, D190):
    // it says so instead of sending a letter through the résumé prompt.
    if (window.__rmEditorKind?.() === "cover-letter") { put(out, el("p", { class: "note", "data-tailor-letter": "" }, "Tailor rewrites résumés. Tailoring a cover letter would need a new writing prompt, which isn't offered — edit the letter in place, and check your résumé against the job in the Résumé tab.")); return; }
    if (!j.title || !j.description) { put(out, el("p", { class: "ats-bad" }, "Put the job in the Résumé tab first (its title and description).")); pick("resume"); return; }
    go.disabled = true; put(out, el("p", { class: "note" }, "Tailoring — this takes up to a minute…"));
    try {
      const years = f.years.value === "" ? undefined : Number(f.years.value);
      const r = await call("/tools/generate", { mode: "GENERATE", baseResumeText: getText(),
        candidate: { fullName: f.fullName.value, ...(years != null ? { yearsOfExperience: years } : {}) },
        job: { title: j.title, company: j.company || "", description: j.description }, options: { includeSummary: f.includeSummary.checked } });
      before = window.__rmEditorHtml?.() || null;
      load(r.html, { filename: `resume-${(j.company || "tailored").replace(/\W+/g, "-")}.html` });
      put(out, el("p", { class: "tailor__ok" }, `Tailored for ${j.title}${j.company ? ` at ${j.company}` : ""} — ${r.credits.charged} credit used, ${r.credits.balance} left. Read every line before you send it.`),
        before ? el("button", { type: "button", class: "ws-b", onclick: () => { load(before, {}); before = null; put(out, el("p", { class: "note" }, "Back to the résumé from before tailoring.")); } }, "Back to before tailoring") : null);
    } catch (x) {
      const v = x.body?.violations;
      put(out, el("p", { class: "ats-bad" }, x.status === 422 ? "Withheld: the draft claimed more than your résumé states, so it was not shown. No credit was used — try again."
        : x.status === 401 ? "Tailor uses an account — sign in (an account gets free credits every month)." : x.message),
        x.status === 401 ? el("button", { type: "button", class: "ws-b", onclick: openSettings }, "Sign in") : null,
        v ? el("ul", {}, ...v.map(y => el("li", {}, y.message || y.kind || JSON.stringify(y)))) : null);
    } finally { go.disabled = false; }
  } },
    el("p", { class: "note" }, "Rewrites this résumé for the job in the Résumé tab. It is checked before you see it: a draft that claims more years or seniority than you stated is withheld. One credit, only if a résumé comes back."),
    el("label", { class: "ats-f" }, "Your name", el("input", { type: "text", name: "fullName", required: true, autocomplete: "name" })),
    el("label", { class: "ats-f" }, "Years of experience", el("input", { type: "number", name: "years", min: "0", max: "60", step: "0.5" })),
    el("label", { class: "ats-f tailor__chk" }, el("input", { type: "checkbox", name: "includeSummary" }), "Include a summary paragraph"),
    el("button", { type: "submit", class: "ws-b ws-p" }, "Tailor it (1 credit)"));
  panels.tailor.append(f, out);

  const wrap = $(".wrap");
  wrap.classList.add("wrap--side");
  wrap.append(side);
  pick(params.get("panel") === "tailor" ? "tailor" : "resume");
  return { refresh: () => ats.refresh(), pick };
}
