// shared/assistantEngine.js — ⭐ D190 · ONE ENGINE FOR TINY (the PDF-tools site) AND ASK DRAFT (draft).
// ⛔ MIRRORED byte-identical into resume-master at public/assistant/assistantEngine.js — change both (the guard
// test/d190EngineMirror.test.js fails when the two copies differ). Pure: no imports, no network, no DOM.
//
// The owner's rule (11-14): nothing within a site's own data or functions calls a model. Every request goes:
//   T1  an ACTION — a row of content/assistant/commands-v1.json, run by the SAME function the toolbar / button calls
//   T2  a LOOKUP — the site's own data + a template sentence
//   ask back — an ambiguous request ("fix this") asks what to change; a destructive one asks "Are you sure?" first
//   T3  the model — ONLY a row marked tier "T3" (the person explicitly asked for new writing), labelled
//       "written by the assistant". Nothing that fails to match ever reaches T3 on its own.
//
// Rows (commands-v1.json): { intent, site: "rm" | "draft" | "both", tier: "T1" | "T2" | "T3" | "ask",
//   patterns: ["replace {old} with {new}[ on line {line:int}]"], calls: "<handler name>", confirm?: "<question with {param}>",
//   reply?: "<ask-back text>", examples: [{ say, args }] }
// Pattern grammar: words match literally (any case, any spacing) · {name} captures text · {name:int} a whole number ·
// (a|b) one of the words · [ … ] optional (put the leading space inside the brackets) · x? the character before is optional.

export const ENGINE_VERSION = 1;
export const TIER_LABEL = Object.freeze({ T1: "T1 • action", T2: "T2 • from your data", T3: "T3 • written by the assistant" });
const YES = /^(y|yes|yeah|yep|sure|ok|okay|confirm|do it|go ahead|i'?m sure)$/i;
const NO = /^(n|no|nope|cancel|stop|never ?mind|don'?t)$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pattern template → { re, names, kinds }. Throws on a malformed template (the vocabulary test catches it). */
export function compilePattern(template) {
  const names = [], kinds = {};
  let i = 0, out = "";
  const t = String(template).trim();
  while (i < t.length) {
    const c = t[i];
    if (c === "{") {
      const j = t.indexOf("}", i); if (j < 0) throw new Error(`unclosed { in "${template}"`);
      const [name, kind = "text"] = t.slice(i + 1, j).split(":");
      if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error(`bad parameter name "${name}" in "${template}"`);
      names.push(name); kinds[name] = kind;
      out += kind === "int" ? "(\\d{1,4})" : kind === "num" ? "(-?\\d[\\d,]*(?:\\.\\d+)?)" : "(.+?)";
      i = j + 1;
    } else if (c === "(") {
      const j = t.indexOf(")", i); if (j < 0) throw new Error(`unclosed ( in "${template}"`);
      out += `(?:${t.slice(i + 1, j).split("|").map(w => w.trim().split(/\s+/).map(esc).join("\\s+")).join("|")})`;
      i = j + 1;
    } else if (c === "[") { out += "(?:"; i++; }
    else if (c === "]") { out += ")?"; i++; }
    else if (c === "?") { out += "?"; i++; }   // the character or group before it is optional ("what'?s")
    else if (c === "|") throw new Error(`a | outside ( ) in "${template}" — write the choices as (a|b)`);
    else if (/\s/.test(c)) { while (i < t.length && /\s/.test(t[i])) i++; out += "\\s+"; }
    else { out += esc(c); i++; }
  }
  return { re: new RegExp(`^${out}$`, "i"), names, kinds };
}

/** The rows for one site, compiled. */
export function compileCommands(file, site) {
  const rows = Array.isArray(file) ? file : file?.commands;
  if (!Array.isArray(rows)) throw new Error("commands: no rows");
  const seen = new Set();
  return rows.filter(r => r.site === site || r.site === "both").map(r => {
    const key = `${r.site}:${r.intent}`;
    if (seen.has(key)) throw new Error(`commands: duplicate intent ${key}`);
    seen.add(key);
    return { ...r, compiled: (r.patterns || []).map(compilePattern) };
  });
}

/** What the person typed, tidied: politeness and a trailing full stop don't change the command. */
export function normalise(text) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  for (let k = 0; k < 3; k++) s = s.replace(/^(please|pls|can you|could you|would you|will you|hey|hi|tiny|ask draft)[,:]?\s+/i, "");
  return s.replace(/[\s.!?]+$/, "").replace(/\s+please$/i, "").trim();
}
const unquote = (v) => String(v).trim().replace(/^["'“‘`](.*)["'”’`]$/s, "$1").trim();

/** Text → the first matching row and its arguments, or null. Rows are tried in file order. */
export function parse(text, compiled) {
  const s = normalise(text);
  if (!s) return null;
  for (const row of compiled) {
    for (const p of row.compiled) {
      const m = p.re.exec(s);
      if (!m) continue;
      const args = {};
      p.names.forEach((n, k) => {
        const v = m[k + 1];
        if (v == null) return;
        args[n] = p.kinds[n] === "int" ? Number(v) : unquote(v);
      });
      if (Object.values(args).some(v => v === "")) continue;
      return { row, args, said: s };
    }
  }
  return null;
}

const fill = (tpl, args) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (args[k] != null ? String(args[k]) : ""));

/**
 * One assistant for one site.
 *   handlers: { [calls]: async (args, ctx) => ({ text, undo?, ask? }) } — `undo` is a function that reverses it;
 *             `ask` (instead of text) asks back and changes nothing.
 *   fallback: async (text) => message | null — the site's T2 lookup for what no row matched (draft: its own data, Atlas,
 *             help — never a model). Return null when nothing covers it.
 *   ledger:   an array the engine appends { tier, intent } to — the tests read it (0 T3 during T1 / T2).
 */
export function createAssistant({ commands, site, handlers = {}, fallback = null, ledger = null, examples = null }) {
  const compiled = compileCommands(commands, site);
  let pending = null;
  const note = (tier, intent) => { if (ledger) ledger.push({ tier, intent, at: Date.now() }); };
  const msg = (tier, text, extra = {}) => ({ tier, label: TIER_LABEL[tier] || null, text, ...extra });
  const hint = () => {
    const ex = (examples || compiled.filter(r => r.tier === "T1" || r.tier === "T2").slice(0, 4).map(r => r.examples?.[0]?.say).filter(Boolean));
    return ex.length ? ` Try: ${ex.map(e => `“${e}”`).join(", ")}.` : "";
  };

  async function run(row, args, said = "") {
    const fn = handlers[row.calls];
    if (typeof fn !== "function") { note("none", row.intent); return msg("ask", "That isn't available on this page.", { intent: row.intent, failed: true }); }
    try {
      const r = (await fn(args, { intent: row.intent, row, said })) || {};
      // the ledger records the tier the reply HAD: a T3 row that only asks back (or isn't switched on) called no model
      note(r.ask ? "ask" : row.tier, row.intent);
      if (r.ask) return msg("ask", r.ask, { intent: row.intent, args });
      const undo = typeof r.undo === "function" ? r.undo : null;
      return msg(row.tier, r.text || "Done.", { intent: row.intent, args, undo, ...(r.extra || {}) });
    } catch (e) {
      note(row.tier === "T3" ? "ask" : row.tier, row.intent);
      return msg(row.tier === "T3" ? "ask" : row.tier, e?.message || String(e), { intent: row.intent, args, failed: true });
    }
  }

  return {
    site,
    rows: compiled,
    get pending() { return pending; },
    reset() { pending = null; },
    parse: (text) => parse(text, compiled),
    async handle(text) {
      const s = normalise(text);
      if (pending) {
        const p = pending; pending = null;
        if (YES.test(s)) return run(p.row, p.args, p.said);
        if (NO.test(s)) { note("ask", p.row.intent); return msg("ask", "Cancelled — nothing changed.", { intent: p.row.intent }); }
      }
      const hit = parse(s, compiled);
      if (!hit) {
        if (fallback) {
          const r = await fallback(s);
          if (r) { note(r.tier || "T2", r.intent || "lookup"); return { label: TIER_LABEL[r.tier || "T2"] || null, tier: r.tier || "T2", ...r }; }
        }
        note("none", null);
        return msg("ask", `I can't do that here yet — nothing on this site covers it.${hint()}`, { unmatched: true });
      }
      const { row, args } = hit;
      if (row.tier === "ask") { note("ask", row.intent); return msg("ask", row.reply || "What should I change?", { intent: row.intent }); }
      if (row.confirm) {
        pending = { row, args, said: s };
        note("ask", row.intent);
        return msg("ask", fill(row.confirm, args), { intent: row.intent, args, confirm: true });
      }
      return run(row, args, s);
    },
    /** The confirm buttons: yes / no on the pending question. */
    async decide(yes) { return this.handle(yes ? "yes" : "no"); },
  };
}

/** The vocabulary's own examples, run through parse — what d190VocabularyExamplesPass asserts. */
export function checkExamples(file, site) {
  const compiled = compileCommands(file, site);
  const failures = [];
  for (const row of compiled) {
    if (!row.examples?.length) { failures.push({ intent: row.intent, why: "no examples" }); continue; }
    for (const ex of row.examples) {
      const hit = parse(ex.say, compiled);
      if (!hit || hit.row.intent !== row.intent) { failures.push({ intent: row.intent, say: ex.say, got: hit?.row.intent || null }); continue; }
      for (const [k, v] of Object.entries(ex.args || {})) {
        if (hit.args[k] !== v) failures.push({ intent: row.intent, say: ex.say, param: k, want: v, got: hit.args[k] });
      }
    }
  }
  return failures;
}
