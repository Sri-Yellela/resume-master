// public/assistant/tiny.js — ⭐ D190 · TINY, Resume Master's side panel (draft's Ask draft runs the same engine).
// The engine (assistantEngine.js) and the vocabulary (commands-v1.json) are MIRRORED byte-identical from draft
// (shared/assistantEngine.js, content/assistant/commands-v1.json). This file only draws the panel and keeps the turns.
// ⛔ The owner's rule (11-14): nothing within the site's own data or functions calls a model — T1 / T2 run here, in this
// browser, with no request at all. T3 (new writing the person asked for) is the only tier that may reach a server.
import { createAssistant, TIER_LABEL } from "/assistant/assistantEngine.js";
import { voiceSupported, listenOnce, voiceNote, VOICE_ERRORS } from "/assistant/assistantVoice.js";   // D190 P4

const KEY = "rm-tiny:turns";

export async function mountTiny({ el, host, toggle, handlers, onOpenChange = () => {} }) {
  const commands = await fetch("/assistant/commands-v1.json").then(r => r.json());
  const ledger = (window.__tinyLedger ||= []);
  const examples = ["replace 2023 with 2024", "make the header bold", "delete page 2", "download as Word", "what's on page 1?"];
  const bot = createAssistant({ commands, site: "rm", handlers, ledger, examples });

  const list = el("ol", { class: "tiny-turns", "data-tiny-turns": "", "aria-live": "polite" });
  const input = el("textarea", { class: "tiny-input", rows: "2", maxlength: "600", "aria-label": "Tell Tiny what to do", "data-tiny-input": "",
    placeholder: "e.g. replace 2023 with 2024 on line 3" });
  const send = el("button", { type: "submit", class: "ws-b ws-p", "data-tiny-send": "" }, "Send");
  // ⭐ D190 P4 · voice: the browser's speech-to-text; the words go through the same engine as typed ones
  const voiceLine = el("p", { class: "ws-faint ws-small tiny-voice", "data-tiny-voice-note": "", "aria-live": "polite" });
  let listening = null;
  const mic = voiceSupported(window) ? el("button", { type: "button", class: "ws-b ws-ic", "data-tiny-mic": "", "aria-pressed": "false", title: "Speak a command", "aria-label": "Speak a command",
    onclick: async () => {
      if (listening) { listening.stop(); return; }
      try {
        mic.setAttribute("aria-pressed", "true");
        listening = await listenOnce({ onText: (t) => { input.value = t; form.requestSubmit(); },
          onEnd: (code) => { listening = null; mic.setAttribute("aria-pressed", "false"); voiceLine.textContent = code ? (VOICE_ERRORS[code] || "Voice stopped — type instead.") : ""; } });
        voiceLine.textContent = voiceNote(listening.local);
      } catch (e) { listening = null; mic.setAttribute("aria-pressed", "false"); voiceLine.textContent = e.message; }
    } }, "🎙") : null;
  const form = el("form", { class: "tiny-form" }, input, el("div", { class: "tiny-actions" }, mic, send), voiceLine);
  const panel = el("aside", { class: "ws-tiny", id: "ws-tiny", "aria-label": "Tiny", "data-tiny": "", hidden: true },
    el("header", { class: "tiny-head" }, el("b", {}, "Tiny"),
      el("span", { class: "ws-faint ws-small" }, "Acts on this document in your browser — no AI for anything already here."),
      el("button", { type: "button", class: "ws-b", "data-tiny-close": "", onclick: () => setOpen(false) }, "Close")),
    list, form);
  host.append(panel);

  // the conversation, for this tab's session only (Undo links are not kept across a reload — the words are)
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { saved = []; }
  const keep = () => { try { sessionStorage.setItem(KEY, JSON.stringify(saved.slice(-60))); } catch { /* storage blocked */ } };
  for (const t of saved) list.append(turnNode(t, null));

  function turnNode(t, live) {
    const li = el("li", { class: "tiny-turn", "data-tiny-turn": t.who, "data-tier": t.tier || null, "data-intent": t.intent || null });
    if (t.who === "you") li.append(el("p", { class: "tiny-text" }, el("b", {}, "You: "), t.text));
    else {
      if (t.label) li.append(el("span", { class: "tiny-label", "data-tiny-label": t.tier }, t.label));
      li.append(el("p", { class: `tiny-text${t.failed ? " ws-warn" : ""}` }, t.text));
      if (live?.undo) {
        const u = el("button", { type: "button", class: "tiny-link", "data-tiny-undo": "", onclick: async () => {
          u.disabled = true;
          try { const r = await live.undo(); u.replaceWith(el("span", { class: "ws-faint ws-small", "data-tiny-undone": "" }, (r && r.text) || "Undone.")); }
          catch (e) { u.replaceWith(el("span", { class: "ws-warn ws-small" }, e?.message || String(e))); }
        } }, "Undo");
        li.append(u);
      }
      if (live?.confirm) {
        const row = el("div", { class: "tiny-confirm" },
          el("button", { type: "button", class: "ws-b ws-p", "data-tiny-yes": "", onclick: () => { row.remove(); say("Yes", true); } }, "Yes"),
          el("button", { type: "button", class: "ws-b", "data-tiny-no": "", onclick: () => { row.remove(); say("No", true); } }, "No"));
        li.append(row);
      }
    }
    return li;
  }
  function push(t, live) {
    saved.push(t); keep();
    list.append(turnNode(t, live));
    list.scrollTop = list.scrollHeight;
  }
  let busy = false;
  async function say(text, fromButton = false) {
    const q = String(text || "").trim();
    if (!q || busy) return;
    busy = true; send.disabled = true;
    push({ who: "you", text: q });
    try {
      const m = await bot.handle(q);
      push({ who: "tiny", tier: m.tier, label: m.label || TIER_LABEL[m.tier] || null, text: m.text, intent: m.intent || null, failed: !!m.failed }, m);
    } finally { busy = false; send.disabled = false; if (!fromButton) input.focus(); }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; say(q); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    onOpenChange(open);
    if (open) setTimeout(() => input.focus(), 0);
  }
  toggle.addEventListener("click", () => setOpen(panel.hidden));
  return { panel, say, setOpen, bot, clear() { saved = []; keep(); list.replaceChildren(); bot.reset(); } };
}
