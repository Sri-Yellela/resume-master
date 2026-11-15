// public/assistant/tiny.js — ⭐ D190 · TINY, the PDF-tools site's floating bot (owner 11-15: "make tiny a floating bot on the
// site rather than a panel button. give it a cute logo animal … answer faqs"). A fox bubble fixed at the bottom-right of
// EVERY page; it opens a floating chat card (a bottom sheet on phones). draft runs the same Tiny.
// The engine (assistantEngine.js), the vocabulary (commands-v1.json), the voice helper and the fox (tinyMascot.js) are
// MIRRORED byte-identical from draft. On the workspace, workspace.js passes the document's handlers; on every other page
// Tiny opens the site's tools and answers FAQs (faq-rm.json), and a document command says where it works.
// ⛔ The owner's rule (11-14): nothing within the site's own data or functions calls a model — no request at all here.
import { createAssistant, TIER_LABEL } from "/assistant/assistantEngine.js";
import { voiceSupported, listenOnce, voiceNote, VOICE_ERRORS } from "/assistant/assistantVoice.js";   // D190 P4
import { tinySvg, TINY_NAME } from "/assistant/tinyMascot.js";
import { PLACES, faqAnswer, placeHref } from "/assistant/tinySite.js";

const KEY = "rm-tiny:turns";
const OPEN_KEY = "rm-tiny:open";

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
  return n;
};

export { PLACES, faqAnswer, placeHref };   // (the pure part lives in tinySite.js, so node's tests import it)

export async function mountTiny({ handlers = {}, onDocument = false } = {}) {
  const [commands, faq] = await Promise.all([fetch("/assistant/commands-v1.json").then(r => r.json()), fetch("/assistant/faq-rm.json").then(r => r.json()).catch(() => ({ entries: [] }))]);
  const ledger = (window.__tinyLedger ||= []);
  const examples = onDocument ? ["replace 2023 with 2024", "make the header bold", "delete page 2", "download as Word"]
    : ["open the compress tool", "is my file uploaded?", "take me to the workspace", "how do I sign a PDF?"];
  // the site's own handlers; a document command off the workspace says where it works (never "not available")
  const site = {
    help: () => ({ text: onDocument
      ? "I act on this document without AI: replace words (“replace 2023 with 2024 on line 3”, or several at once: “rewrite letter as page and Boston as NYC”), bold / italic / underline / size, delete, duplicate, rotate or move pages, compress, download as PDF, Word, text or pictures, print, go to a page, zoom, undo and redo, read a page or find a word, check it for what an ATS may trip on — and I answer questions about the site."
      : "I open the site's tools (“open the compress tool”, “take me to the workspace”) and answer questions about them (“is my file uploaded?”, “how do I sign a PDF?”). Open a PDF in the workspace and I can change it for you too." }),
    openPlace: (a) => {
      const hit = placeHref(a.place);
      if (!hit) return { ask: "I can open the workspace, the résumé editor, Documents, or a tool — compress, merge, split, OCR, edit, sign, organise, watermark, protect, unlock, or a converter. Which one?" };
      setTimeout(() => { location.href = hit.href; }, 350);
      return { text: `Opening ${hit.key}…` };
    },
  };
  const elsewhere = { ask: "That works on an open document — open a PDF in the workspace and ask me again there.", extra: { links: [{ title: "Open the workspace", href: "/workspace/" }] } };
  const bot = createAssistant({ commands, site: "rm", handlers: { ...site, ...handlers }, ledger, examples, unavailable: () => elsewhere,
    fallback: async (text) => { const e = faqAnswer(faq.entries, text); return e ? { tier: "T2", intent: "faq", text: e.a, links: e.href ? [{ title: "Open it", href: e.href }] : [] } : null; } });

  // ── the bubble and the card ──
  const launcher = el("button", { type: "button", class: "tiny-launch", "data-tiny-launch": "", "aria-expanded": "false", "aria-controls": "tiny-card",
    title: `${TINY_NAME} — tell me what to change, or ask about the site`, "aria-label": `Open ${TINY_NAME}` });
  launcher.innerHTML = tinySvg({ size: 44 });
  const list = el("ol", { class: "tiny-turns", "data-tiny-turns": "", "aria-live": "polite" });
  const input = el("textarea", { class: "tiny-input", rows: "2", maxlength: "600", "aria-label": `Tell ${TINY_NAME} what to do`, "data-tiny-input": "",
    placeholder: onDocument ? "e.g. replace 2023 with 2024 on line 3" : "e.g. open the compress tool · is my file uploaded?" });
  const send = el("button", { type: "submit", class: "tiny-btn tiny-btn--p", "data-tiny-send": "" }, "Send");
  const voiceLine = el("p", { class: "tiny-voice", "data-tiny-voice-note": "", "aria-live": "polite" });
  let listening = null;
  const mic = voiceSupported(window) ? el("button", { type: "button", class: "tiny-btn", "data-tiny-mic": "", "aria-pressed": "false", title: "Speak a command", "aria-label": "Speak a command",
    onclick: async () => {
      if (listening) { listening.stop(); return; }
      try {
        mic.setAttribute("aria-pressed", "true");
        listening = await listenOnce({ onText: (t) => { input.value = ""; say(t); },
          onEnd: (code) => { listening = null; mic.setAttribute("aria-pressed", "false"); voiceLine.textContent = code ? (VOICE_ERRORS[code] || "Voice stopped — type instead.") : ""; } });
        voiceLine.textContent = voiceNote(listening.local);
      } catch (e) { listening = null; mic.setAttribute("aria-pressed", "false"); voiceLine.textContent = e.message; }
    } }, "🎙") : null;
  const form = el("form", { class: "tiny-form" }, input, el("div", { class: "tiny-actions" }, mic, send), voiceLine);
  const face = el("span", { class: "tiny-face", "aria-hidden": "true" }); face.innerHTML = tinySvg({ size: 30 });
  const card = el("section", { class: "tiny-card", id: "tiny-card", role: "dialog", "aria-label": TINY_NAME, "data-tiny": "", hidden: true },
    el("header", { class: "tiny-head" }, face,
      el("div", { class: "tiny-who" }, el("b", {}, TINY_NAME), el("span", {}, onDocument ? "Acts on this document — no AI for anything already here." : "Opens the tools and answers questions — no AI.")),
      el("button", { type: "button", class: "tiny-btn", "data-tiny-close": "", "aria-label": `Close ${TINY_NAME}`, onclick: () => setOpen(false) }, "✕")),
    list, form);
  const root = el("div", { class: "tiny-root", "data-tiny-root": "" }, card, launcher);
  document.body.append(root);

  // the conversation, for this tab's session only (Undo links are not kept across a reload — the words are)
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { saved = []; }
  const keep = () => { try { sessionStorage.setItem(KEY, JSON.stringify(saved.slice(-60))); } catch { /* storage blocked */ } };
  for (const t of saved) list.append(turnNode(t, null));

  function turnNode(t, live) {
    const li = el("li", { class: "tiny-turn", "data-tiny-turn": t.who, "data-tier": t.tier || null, "data-intent": t.intent || null });
    if (t.who === "you") li.append(el("p", { class: "tiny-text" }, t.text));
    else {
      if (t.label) li.append(el("span", { class: "tiny-label", "data-tiny-label": t.tier }, t.label));
      li.append(el("p", { class: `tiny-text${t.failed ? " tiny-text--warn" : ""}` }, t.text));
      for (const l of t.links || []) li.append(el("a", { class: "tiny-link", href: l.href, "data-tiny-link": "" }, l.title));
      if (live?.undo) {
        const u = el("button", { type: "button", class: "tiny-link", "data-tiny-undo": "", onclick: async () => {
          u.disabled = true;
          try { const r = await live.undo(); u.replaceWith(el("span", { class: "tiny-label", "data-tiny-undone": "" }, (r && r.text) || "Undone.")); }
          catch (e) { u.replaceWith(el("span", { class: "tiny-label" }, e?.message || String(e))); }
        } }, "Undo");
        li.append(u);
      }
      if (live?.confirm) {
        const row = el("div", { class: "tiny-confirm" },
          el("button", { type: "button", class: "tiny-btn tiny-btn--p", "data-tiny-yes": "", onclick: () => { row.remove(); say("Yes", true); } }, "Yes"),
          el("button", { type: "button", class: "tiny-btn", "data-tiny-no": "", onclick: () => { row.remove(); say("No", true); } }, "No"));
        li.append(row);
      }
    }
    return li;
  }
  function push(t, live) { saved.push(t); keep(); list.append(turnNode(t, live)); list.scrollTop = list.scrollHeight; }
  let busy = false;
  async function say(text, fromButton = false) {
    const q = String(text || "").trim();
    if (!q || busy) return;
    busy = true; send.disabled = true;
    push({ who: "you", text: q });
    try {
      const m = await bot.handle(q);
      push({ who: "tiny", tier: m.tier, label: m.label || TIER_LABEL[m.tier] || null, text: m.text, intent: m.intent || null, failed: !!m.failed, links: m.links || [] }, m);
    } finally { busy = false; send.disabled = false; if (!fromButton) input.focus(); }
  }
  // (Enter and the button call the same function — no programmatic form submit)
  const sendTyped = () => { const q = input.value; input.value = ""; say(q); };
  form.addEventListener("submit", (e) => { e.preventDefault(); sendTyped(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTyped(); } });

  function setOpen(open) {
    card.hidden = !open;
    root.dataset.open = open ? "true" : "false";
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", `${open ? "Close" : "Open"} ${TINY_NAME}`);
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : ""); } catch { /* storage blocked */ }
    if (open) setTimeout(() => input.focus(), 0);
  }
  launcher.addEventListener("click", () => setOpen(card.hidden));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !card.hidden && root.contains(document.activeElement)) { setOpen(false); launcher.focus(); } });
  let reopen = false; try { reopen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch { reopen = false; }
  if (reopen) setOpen(true);
  return { root, card, launcher, say, setOpen, bot, clear() { saved = []; keep(); list.replaceChildren(); bot.reset(); } };
}
