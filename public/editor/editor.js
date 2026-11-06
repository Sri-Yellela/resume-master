// D157 · the résumé editor — resumemaster.one/editor/, and embedded in draft through the rm-editor/1 contract.
//
// The page is the résumé: each section its own box, edited in place; the section menu reorders them (drag, ▲ ▼,
// Alt + ↑ / ↓) and the page re-lays itself; the tool pill changes the document's font, size, line spacing and margins
// and applies bold / italic / bullets to the selection. The document model and its HTML live in
// /lib/editor/sections.js — the same file the server's tests read.
//
// EMBEDDED (?embed=1&host=<origin>): only a host whose origin is on the allow-list may talk to it, and only messages
// from window.parent with that origin and this contract are read. The host loads the document, sends its theme, and
// is told about every change (it saves) and every export (it downloads). The editor stores nothing itself.
// BY ITSELF: a résumé opened from a file or the sample; kept in this browser only; PDF by the browser's print.
import {
  EDITOR_CONTRACT, FONTS, SIZE, ADDABLE, sectionsFromHtml, htmlFromSections, moveSection, placeSection,
  addSection, normalizeStyle, paperCss, sanitizeFragment, isAllowedHost, cleanTheme, escapeHtml,
} from "/lib/editor/sections.js";

const $ = (s, el = document) => el.querySelector(s);
const params = new URLSearchParams(location.search);
const framed = window.parent !== window;
const host = params.get("host") || "";
const embedded = framed && params.get("embed") === "1" && isAllowedHost(host);
const STORE_KEY = "rm-editor:doc";

let doc = null;           // { contract, style, sections }
let meta = {};            // { company, title, changes[], filename, readOnly, readOnlyNote }
let focusId = null;
let dragId = null;
let showChanges = false;

// ── messages ────────────────────────────────────────────────────────────────────────────────────────────────────
function post(type, payload = {}) {
  if (embedded) window.parent.postMessage({ contract: EDITOR_CONTRACT, type, ...payload }, host);
}
window.addEventListener("message", (e) => {
  if (!embedded || e.source !== window.parent || e.origin !== host) return;
  const m = e.data;
  if (!m || typeof m !== "object" || m.contract !== EDITOR_CONTRACT) return;
  if (m.type === "load") load(String(m.html || ""), m.meta || {});
  else if (m.type === "theme") applyTheme(m.tokens);
  else if (m.type === "saved") setSaved(m.ok === false ? "failed" : "saved", m.message);
  else if (m.type === "request-html") post("html", { html: currentHtml() });
});

function applyTheme(tokens) {
  const t = cleanTheme(tokens);
  const map = { bg: "--bg", card: "--card", raise: "--raise", raise2: "--raise2", line: "--line", ink: "--ink", body: "--body",
    muted: "--muted", accent: "--accent", accent2: "--accent2", onAccent: "--on-accent", font: "--font", radius: "--radius" };
  for (const [k, v] of Object.entries(map)) {
    if (t[k]) document.documentElement.style.setProperty(v, t[k]);
  }
  if (t.bg) {
    // Light or dark chrome follows the host's background (the native controls' colour scheme only).
    const light = /^#(?:f|e|d)/i.test(t.bg) || /^rgb\(\s*2[0-5]\d/.test(t.bg);
    document.documentElement.style.colorScheme = light ? "light" : "dark";
  }
}

// ── the document ────────────────────────────────────────────────────────────────────────────────────────────────
function load(html, m) {
  try {
    doc = sectionsFromHtml(html);
    meta = { company: String(m.company || ""), title: String(m.title || ""), filename: String(m.filename || ""),
      changes: Array.isArray(m.changes) ? m.changes.map(String).filter(s => s.trim().length >= 8).slice(0, 200) : [],
      // READ ONLY: a résumé that was already sent is shown as it was — it can be read, highlighted and downloaded, not changed.
      readOnly: m.readOnly === true, readOnlyNote: String(m.readOnlyNote || "") };
    document.documentElement.dataset.readonly = String(meta.readOnly);
    if (!doc.sections.length) throw new Error("No sections were found in this résumé.");
    focusId = (doc.sections.find(s => !s.locked) || doc.sections[0]).id;
    showUi();
    renderAll(true);
    post("loaded", { sections: outline() });
  } catch (err) {
    post("error", { message: String(err?.message || err) });
    if (!embedded) { $("#start").hidden = false; $("#start-error").textContent = String(err?.message || err); }
  }
}

function outline() { return doc.sections.map(s => ({ id: s.id, kind: s.kind, title: s.title })); }
function currentHtml() { return doc ? htmlFromSections(doc) : ""; }

let changeTimer = null;
function changed() {
  if (meta.readOnly) return;
  setSaved("saving");
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const html = currentHtml();
    if (embedded) post("changed", { html, sections: outline() });
    else {
      try { localStorage.setItem(STORE_KEY, html); setSaved("saved", "Saved in this browser"); } catch { setSaved("saved", "Not saved — this browser blocks storage"); }
    }
  }, 700);
}
function setSaved(state, text) {
  const el = $("#saved");
  el.dataset.state = state;
  el.textContent = text || (state === "saving" ? "Saving…" : state === "failed" ? "Couldn't save" : "Saved");
}

// ── the page (a shadow root, so the résumé's own stylesheet styles only the page) ───────────────────────────────────
const paperHost = $("#paper");
const root = paperHost.attachShadow({ mode: "open" });
const EDIT_CSS = `
  :host { display: block; }
  .rm-doc { min-height: 1056px; background-image: repeating-linear-gradient(to bottom, transparent 0 1055px, var(--paper-break) 1055px 1056px); }
  .sec { position: relative; border-radius: 6px; padding: 6px 10px; margin: 0 -10px 2px; outline: 1px solid transparent; transition: outline-color .15s, background .15s; }
  .sec:hover { outline-color: var(--paper-line); }
  .sec.focus { outline: 1.5px solid var(--paper-mark); background: var(--paper-focus); }
  .tag { position: absolute; top: -9px; left: 8px; font: 600 10px/1 var(--font); color: var(--paper-mark); background: var(--paper); padding: 0 4px;
    border-radius: 4px; opacity: 0; transition: opacity .15s; user-select: none; pointer-events: none; }
  .sec.focus .tag, .sec:hover .tag { opacity: 1; }
  .ed, .section-title { outline: none; }
  .section-title { margin-top: 2pt; }
  mark.rm-chg { background: var(--chg); color: inherit; border-radius: 2px; }
  .moving { transition: transform .32s cubic-bezier(.22,1,.36,1); }
`;
let pageEl = null, styleEl = null;

function renderAll(fresh = false) {
  renderToolbar();
  renderMenu();
  renderPage(fresh);
}

function renderPage(fresh) {
  if (fresh || !pageEl) {
    root.innerHTML = "";
    styleEl = document.createElement("style");
    root.appendChild(styleEl);
    pageEl = document.createElement("div");
    pageEl.className = "rm-doc";
    root.appendChild(pageEl);
  }
  styleEl.textContent = paperCss(doc.style) + EDIT_CSS;
  const first = {};
  pageEl.querySelectorAll(".sec").forEach(el => { first[el.dataset.id] = el.getBoundingClientRect().top; });
  const keep = new Set(doc.sections.map(s => s.id));
  pageEl.querySelectorAll(".sec").forEach(el => { if (!keep.has(el.dataset.id)) el.remove(); });
  for (const s of doc.sections) {
    let el = pageEl.querySelector(`.sec[data-id="${CSS.escape(s.id)}"]`);
    if (!el) el = buildSection(s);
    pageEl.appendChild(el);
  }
  pageEl.querySelectorAll(".sec").forEach(el => {
    const t0 = first[el.dataset.id];
    if (t0 == null) return;
    const d = t0 - el.getBoundingClientRect().top;
    if (!d) return;
    el.classList.remove("moving");
    el.style.transform = `translateY(${d}px)`;
    requestAnimationFrame(() => { el.classList.add("moving"); el.style.transform = ""; });
  });
  markFocus();
  if (showChanges) highlightChanges(true);
}

function buildSection(s) {
  const el = document.createElement("section");
  el.className = "sec";
  el.dataset.id = s.id;
  el.innerHTML = `<span class="tag" contenteditable="false">${escapeHtml(s.title)}</span>`
    + (s.locked ? "" : `<div class="section-title" contenteditable="${!meta.readOnly}" spellcheck="true">${escapeHtml(s.heading)}</div>`)
    + `<div class="ed" contenteditable="${!meta.readOnly}" spellcheck="true">${sanitizeFragment(s.html)}</div>`;
  el.addEventListener("focusin", () => setFocus(s.id));
  el.addEventListener("pointerdown", () => setFocus(s.id));
  el.addEventListener("input", () => readSection(el));
  el.querySelector(".section-title")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.querySelector(".ed")?.focus(); } });
  return el;
}

/** The section's html as the document should keep it: the change marks unwrapped, nothing that runs. */
function cleanHtml(ed) {
  const c = ed.cloneNode(true);
  c.querySelectorAll("mark.rm-chg").forEach(mk => mk.replaceWith(...mk.childNodes));
  c.querySelectorAll("ul:not([class])").forEach(ul => ul.classList.add("bullets"));
  return sanitizeFragment(c.innerHTML);
}

function readSection(el) {
  const s = doc.sections.find(x => x.id === el.dataset.id);
  if (!s) return;
  s.html = cleanHtml(el.querySelector(".ed"));
  const h = el.querySelector(".section-title");
  if (h) s.heading = h.textContent.replace(/\s+/g, " ").trim();
  changed();
}

function setFocus(id) {
  if (focusId === id) return;
  focusId = id;
  markFocus();
  $("#section-list").querySelectorAll(".si").forEach(li => li.classList.toggle("on", li.dataset.id === id));
}
function markFocus() {
  pageEl?.querySelectorAll(".sec").forEach(el => el.classList.toggle("focus", el.dataset.id === focusId));
}

// ── Review changes: what draft's tailoring rewrote, highlighted on the page (never saved into the document) ────────
function highlightChanges(on) {
  pageEl.querySelectorAll("mark.rm-chg").forEach(mk => mk.replaceWith(...mk.childNodes));
  pageEl.normalize();
  if (!on || !meta.changes?.length) return 0;
  let n = 0;
  const needles = [...new Set(meta.changes.map(c => c.replace(/\s+/g, " ").trim()))].sort((a, b) => b.length - a.length);
  for (const ed of pageEl.querySelectorAll(".ed")) {
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) nodes.push(t);
    for (const t of nodes) {
      const text = t.nodeValue;
      const hit = needles.map(nd => [nd, text.indexOf(nd)]).find(([, i]) => i >= 0);
      if (!hit) continue;
      const [nd, i] = hit;
      const range = document.createRange();
      range.setStart(t, i); range.setEnd(t, i + nd.length);
      const mk = document.createElement("mark");
      mk.className = "rm-chg";
      range.surroundContents(mk);
      n++;
    }
  }
  return n;
}

// ── the section menu ────────────────────────────────────────────────────────────────────────────────────────────
function renderMenu() {
  $("#eyebrow").textContent = meta.company ? "Tailored for" : "Your résumé";
  $("#menu-title").textContent = meta.company || "Résumé editor";
  $("#menu-sub").textContent = meta.title || (meta.company ? "" : "Edit each section in place.");
  const list = $("#section-list");
  list.innerHTML = "";
  doc.sections.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "si" + (s.locked ? " lock" : "") + (s.id === focusId ? " on" : "");
    li.dataset.id = s.id;
    li.tabIndex = 0;
    li.draggable = !s.locked && !meta.readOnly;
    li.innerHTML = `<span class="num">${i + 1}</span><b>${escapeHtml(s.title)}</b>`
      + (s.locked ? `<span class="pin">at the top</span>` : meta.readOnly ? `<span></span>` : `<span class="mv"><button type="button" aria-label="Move ${escapeHtml(s.title)} up">▲</button><button type="button" aria-label="Move ${escapeHtml(s.title)} down">▼</button></span>`)
      + `<span class="grip" aria-hidden="true"><i></i><i></i><i></i></span>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      setFocus(s.id);
      pageEl.querySelector(`.sec[data-id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    if (!s.locked && !meta.readOnly) {
      const [up, down] = li.querySelectorAll(".mv button");
      up.addEventListener("click", () => move(s.id, -1));
      down.addEventListener("click", () => move(s.id, 1));
      li.addEventListener("keydown", (e) => {
        if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); move(s.id, -1); }
        if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); move(s.id, 1); }
      });
      li.addEventListener("dragstart", (e) => { dragId = s.id; li.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); });
      li.addEventListener("dragend", () => { li.classList.remove("drag"); dragId = null; list.querySelectorAll(".over").forEach(x => x.classList.remove("over")); });
    }
    li.addEventListener("dragover", (e) => { if (!dragId || s.locked || dragId === s.id) return; e.preventDefault(); li.classList.add("over"); });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("over");
      if (!dragId || dragId === s.id || s.locked) return;
      doc = placeSection(doc, dragId, s.id);
      renderMenu(); renderPage(false); changed();
    });
    list.appendChild(li);
  });
  const add = $("#add-list");
  add.innerHTML = "";
  for (const a of ADDABLE) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.kind === "other" ? "Another section" : a.heading[0] + a.heading.slice(1).toLowerCase();
    b.addEventListener("click", () => {
      const r = addSection(doc, a.kind);
      doc = r.doc; focusId = r.id;
      $("#add").open = false;
      renderMenu(); renderPage(false); changed();
      const el = pageEl.querySelector(`.sec[data-id="${CSS.escape(r.id)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.querySelector(".ed")?.focus();
    });
    add.appendChild(b);
  }
}

function move(id, delta) {
  const before = doc;
  doc = moveSection(doc, id, delta);
  if (doc === before) return;
  renderMenu(); renderPage(false); changed();
  $(`#section-list .si[data-id="${CSS.escape(id)}"]`)?.focus();
}

// ── the tool pill ───────────────────────────────────────────────────────────────────────────────────────────────
function effectiveSize() { return doc.style.sizePt ?? SIZE.base; }
function renderToolbar() {
  const font = $("#font");
  if (!font.options.length) {
    font.add(new Option("Document font", ""));
    for (const f of FONTS) font.add(new Option(f.label, f.id));
  }
  font.value = doc.style.font || "";
  $("#size-value").textContent = String(effectiveSize());
  $("#size-down").disabled = effectiveSize() <= SIZE.min;
  $("#size-up").disabled = effectiveSize() >= SIZE.max;
  document.querySelectorAll("[data-spacing]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.spacing === doc.style.spacing)));
  document.querySelectorAll("[data-margin]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.margin === doc.style.margin)));
  // Read only: the document's options and the selection commands are off; reading, Review changes and the downloads stay.
  document.querySelectorAll("#font, [data-spacing], [data-margin], #cmd-bold, #cmd-italic, #cmd-bullets")
    .forEach(el => { el.disabled = !!meta.readOnly; });
  if (meta.readOnly) { $("#size-down").disabled = true; $("#size-up").disabled = true; }
  document.querySelector(".hint").textContent = meta.readOnly
    ? "This is the résumé as it was sent. Read it, review what was rewritten, or download it."
    : "Drag a section to move it on the page, or use the arrows (Alt + ↑ / ↓). Name and contact stay at the top.";
  $("#add").hidden = !!meta.readOnly;
  if (meta.readOnly) setSaved("saved", meta.readOnlyNote || "Sent — shown as it was sent");
  const rc = $("#review-changes");
  rc.disabled = !meta.changes?.length;
  rc.title = meta.changes?.length ? "Highlight what draft's tailoring rewrote" : "Nothing was rewritten in this résumé";
  rc.setAttribute("aria-pressed", String(showChanges));
}
function setStyle(patch) {
  doc = { ...doc, style: normalizeStyle({ ...doc.style, ...patch }) };
  renderToolbar();
  styleEl.textContent = paperCss(doc.style) + EDIT_CSS;
  changed();
}
$("#font").addEventListener("change", (e) => setStyle({ font: e.target.value || null }));
$("#size-down").addEventListener("click", () => setStyle({ sizePt: effectiveSize() - SIZE.step }));
$("#size-up").addEventListener("click", () => setStyle({ sizePt: effectiveSize() + SIZE.step }));
document.querySelectorAll("[data-spacing]").forEach(b => b.addEventListener("click", () => setStyle({ spacing: b.dataset.spacing })));
document.querySelectorAll("[data-margin]").forEach(b => b.addEventListener("click", () => setStyle({ margin: b.dataset.margin })));

function command(name) {
  // The selection lives inside the page's shadow root; the commands act on it and the section's input handler records it.
  document.execCommand(name, false);
  const sel = root.getSelection ? root.getSelection() : document.getSelection();
  const node = sel?.anchorNode;
  const sec = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(".sec");
  if (sec) readSection(sec);
}
for (const [id, name] of [["#cmd-bold", "bold"], ["#cmd-italic", "italic"], ["#cmd-bullets", "insertUnorderedList"]]) {
  $(id).addEventListener("mousedown", (e) => { e.preventDefault(); command(name); });
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); command(name); } });
}
$("#review-changes").addEventListener("click", () => {
  showChanges = !showChanges;
  const n = highlightChanges(showChanges);
  renderToolbar();
  if (showChanges && !n) setSaved("saved", "No rewritten lines are on the page now");
});

function filename(ext) {
  const base = (meta.filename || `Resume_${meta.company || "edited"}`).replace(/[^\w.-]+/g, "_").replace(/\.(html?|pdf)$/i, "");
  return `${base}.${ext}`;
}
$("#download-html").addEventListener("click", () => {
  const html = currentHtml();
  if (embedded) return post("export", { format: "html", html, filename: filename("html") });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = filename("html");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$("#download-pdf").addEventListener("click", () => {
  const html = currentHtml();
  if (embedded) return post("export", { format: "pdf", html, filename: filename("pdf") });
  // By itself: the browser prints the document exactly as it will be sent — a frame that runs no script.
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-modals allow-same-origin");
  f.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  f.srcdoc = html;
  f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 60000); } };
  document.body.appendChild(f);
});

// Esc hands the person back to where they were (the host closes the view); it never fights an open menu.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#add").open) { $("#add").open = false; return; }
  post("close");
});
root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); post("close"); } });

function showUi() {
  $("#start").hidden = true;
  document.querySelector(".bar").hidden = false;
  document.querySelector(".wrap").hidden = false;
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────────────────────
const SAMPLE = `<html><body><div class="header"><div class="name">Alex Example</div><div class="contact">Boston, MA · alex@example.com · github.com/alex-example</div></div>
<div class="section-title">SUMMARY</div><div>Software engineer building full-stack web products with React and Node, from data pipelines to the interface.</div>
<div class="section-title">TECHNICAL SKILLS</div><ul class="bullets"><li><strong>Languages:</strong> JavaScript, TypeScript, Python, SQL</li><li><strong>Tools:</strong> PostgreSQL, Docker, AWS, Git</li></ul>
<div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-header"><div><span class="entry-org">Acme Analytics</span></div><div class="entry-date">2024 – Present</div></div><div class="entry-role">Software Engineer</div><ul class="bullets"><li>Built React and Node features used by three product teams, cutting report load time by 40%.</li><li>Designed a PostgreSQL schema for event data serving two million rows a day.</li></ul></div>
<div class="section-title">EDUCATION</div><div class="entry"><div class="entry-header"><div><span class="entry-org">Northeastern University</span></div><div class="entry-date">2025</div></div><div class="entry-role">MS Computer Science</div></div>
</body></html>`;

if (framed && !embedded) {
  $("#refused").hidden = false;
} else if (embedded) {
  document.documentElement.dataset.embedded = "true";
  post("ready", { version: params.get("v") || null });
} else {
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch { /* storage blocked */ }
  if (saved) load(saved, {});
  else $("#start").hidden = false;
  $("#open-sample").addEventListener("click", () => load(SAMPLE, {}));
  $("#open-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { $("#start-error").textContent = "That file is larger than 2 MB — is it a résumé?"; return; }
    load(await file.text(), { filename: file.name });
  });
}
