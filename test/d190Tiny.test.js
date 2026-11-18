// ⭐ D190 P1 · TINY — the workspace's chat, acting on the document with NO model (draft's WORKLOG, owner 11-14:
// "resume master and draft both are supposed to not call for any task that is within the site's premise in terms of data
// or function"). The engine and the vocabulary are draft's (shared/assistantEngine.js, content/assistant/commands-v1.json),
// mirrored here byte-identical — draft's test/d190Assistant.test.js fails when the copies differ. The end-to-end walk in
// real Chrome is draft's scripts/d190TinyWalk.mjs (each command, Undo, ask back, confirm, the floating bubble, 0 requests).
// ⭐ 46n (owner 11-15: "make tiny a floating bot on the site rather than a panel button. give it a cute logo animal … answer
// faqs … the same for resume master too"): Tiny is a fox bubble fixed at the bottom-right of EVERY page (tiny-boot.js), not a
// fourth column behind a top-bar button; off the workspace it opens the site's tools and answers FAQs (faq-rm.json).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const { createAssistant, checkExamples } = await import("../public/assistant/assistantEngine.js");
const { PLACES, placeHref, faqAnswer } = await import("../public/assistant/tinySite.js");
const COMMANDS = JSON.parse(read("public/assistant/commands-v1.json"));
const FAQ = JSON.parse(read("public/assistant/faq-rm.json"));

test("the mirrored vocabulary parses its own examples for Tiny's site", () => {
  assert.deepEqual(checkExamples(COMMANDS, "rm"), []);
});

test("Tiny makes no model request: the bot fetches only its vocabulary and its FAQ (both static files here); the engine and the site module have no network; no model route anywhere", () => {
  const tiny = read("public/assistant/tiny.js");
  assert.deepEqual([...tiny.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]), ['"/assistant/commands-v1.json"', '"/assistant/faq-rm.json"']);
  assert.doesNotMatch(tiny, /XMLHttpRequest|\/api\/|\/v1\/|anthropic|sendBeacon|WebSocket/i);
  assert.doesNotMatch(read("public/assistant/assistantEngine.js"), /\bfetch\(|XMLHttpRequest|\bimport\s/);
  assert.doesNotMatch(read("public/assistant/tinySite.js"), /\bfetch\(|XMLHttpRequest|^\s*import\s|\bimport\(|document\.|window\./m, "the site module is pure");
  const boot = read("public/assistant/tiny-boot.js");
  assert.doesNotMatch(boot, /\bfetch\(|XMLHttpRequest/);
  assert.match(boot, /await import\("\/assistant\/tiny\.js"\)/);
  const ws = read("public/workspace/workspace.js");
  const block = ws.slice(ws.indexOf("// ── ⭐ D190 · TINY"), ws.indexOf("window.__rmWorkspace = session;"));
  assert.ok(block.length > 2000, "the Tiny block is in the workspace");
  assert.doesNotMatch(block, /fetch\(|\/api\/|anthropic|\/v1\//, "no handler makes a request");
  // the T3 row is a stub in P1 — it asks back, it sends nothing
  assert.match(block, /t3: \(\) => \(\{ ask: /);
});

test("every Tiny row has a handler — the document's in the workspace, the site's own (help, open a place) in tiny.js — and each document one calls the tool bar's own function", () => {
  const ws = read("public/workspace/workspace.js");
  const tiny = read("public/assistant/tiny.js");
  const site = tiny.slice(tiny.indexOf("const site = {"), tiny.indexOf("const elsewhere ="));
  assert.ok(site.length > 200, "tiny.js has the site's handlers");
  for (const r of COMMANDS.commands.filter(x => (x.site === "rm" || x.site === "both") && x.tier !== "ask")) {
    const re = new RegExp(`\\b${r.calls}: `);
    assert.ok(re.test(ws) || re.test(site), `${r.intent} → ${r.calls}`);
  }
  assert.match(site, /openPlace: \(a\) => \{/);
  // the same functions the tool bar uses: pageOp, convert, download, goTo, setZoom, the session's undo / redo / style
  for (const fn of ["pageOp(kind, arg, done, { rethrow: true })", 'convert("compress", { limit:', "await download()", "goTo(p)", "session.styleField(f,", "session.setText(f,", "session.undo()"]) assert.ok(ws.includes(fn), fn);
});

test("the session's chat edits are ordinary, undoable edits (setText / styleField record on the undo stack)", () => {
  const s = read("src/pdf-toolkit/session.js");
  const setText = s.slice(s.indexOf("setText(f, text) {"), s.indexOf("styleField(f, p)"));
  assert.match(setText, /record\(\{ undo: \(\) => restore\(f, before\), redo: \(\) => restore\(f, after\) \}\)/);
  assert.match(s, /styleField\(f, p\) \{[^\n]*setStyle\(p\)/);
});

test("46n · Tiny FLOATS: a fox bubble fixed at the bottom-right opening a card over the page (no column, no top-bar button), a bottom sheet on phones; tokens only; round only where it is a perfect circle", () => {
  const css = read("public/assistant/tiny.css");
  assert.match(css, /\.tiny-root \{[^}]*position: fixed; right: 20px; bottom: 20px;/);
  assert.doesNotMatch(css, /grid-template-columns: 150px minmax\(0, 1fr\) 290px 320px|data-tiny="open"|\.ws-body/, "the fourth column is gone");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.tiny-root\[data-open="true"\] \{ left: 0; right: 0; bottom: 0;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.tiny-card \{ width: 100%; height: 72vh;/);
  // D60: no capsule — 50% only on a rule whose width equals its height (the bubble, the face)
  assert.doesNotMatch(css, /999px/, "no capsule (D60)");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /border-radius:\s*50%/.test(m[2]));
  assert.deepEqual(rules.map(m => m[1].trim()), [".tiny-launch", ".tiny-face"]);
  for (const [, sel, body] of rules) {
    const w = body.match(/(?:^|[;\s])width: (\d+)px/)?.[1], h = body.match(/(?:^|[;\s])height: (\d+)px/)?.[1];
    assert.ok(w && w === h, `${sel.trim()} is a perfect circle (${w} × ${h})`);
  }
  // colours from the page's tokens (the workspace's or the site's) — only shadows are literal, and no hex at all
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "colours from the tokens");
  assert.match(css, /--t-card: var\(--card, var\(--glass-strong\)\);/);
  assert.match(css, /--t-line: var\(--line, var\(--glass-edge\)\);/);
  const html = read("public/workspace/index.html");
  assert.doesNotMatch(html, /ws-tiny-toggle/, "no top-bar Tiny button on the workspace");
  assert.match(html, /href="\/assistant\/tiny\.css"/);
  assert.doesNotMatch(html, /tiny-boot\.js/, "the workspace mounts Tiny itself, with the document's handlers");
  assert.match(read("public/workspace/workspace.js"), /m\.mountTiny\(\{ handlers, onDocument: true \}\)/);
  const tiny = read("public/assistant/tiny.js");
  assert.match(tiny, /class: "tiny-launch", "data-tiny-launch": ""/);
  assert.match(tiny, /launcher\.innerHTML = tinySvg\(\{ size: 44 \}\)/, "the bubble is the fox");
});

test("the engine routes: T1 runs, an ambiguous request asks back, delete asks first, a T3 row never fires by itself", async () => {
  const ran = [];
  const handlers = new Proxy({}, { get: (_, k) => (a) => { ran.push([k, a]); return { text: String(k) }; } });
  const bot = createAssistant({ commands: COMMANDS, site: "rm", handlers });
  assert.equal((await bot.handle("make the header bold")).tier, "T1");
  assert.equal((await bot.handle("fix this")).tier, "ask");
  const d = await bot.handle("delete page 2");
  assert.ok(d.confirm);
  assert.equal(ran.filter(([k]) => k === "deletePage").length, 0);
  assert.equal((await bot.handle("what's the capital of France?")).tier, "ask");
  assert.ok(!ran.some(([k]) => k === "t3"));
});

test("D190 P2 / P4 · Tiny checks the document for what an ATS may trip on, and takes a spoken command through the same engine", () => {
  const ws = read("public/workspace/workspace.js");
  assert.match(ws, /atsWarnings: \(\) => \{/);
  const tiny = read("public/assistant/tiny.js");
  assert.match(tiny, /import \{ voiceSupported, listenOnce, voiceNote, VOICE_ERRORS \} from "\/assistant\/assistantVoice\.js"/);
  assert.match(tiny, /onText: \(t\) => \{ input\.value = ""; say\(t\); \}/, "the spoken words go through the same say() as typed ones");
  const voice = read("public/assistant/assistantVoice.js");
  assert.match(voice, /processLocally: true/);
  assert.doesNotMatch(voice, /\bfetch\(|XMLHttpRequest/);
});

// ── 46n · the floating bot on every page, its FAQ and its fox ──

test("46n · faqAnswer: a question finds its FAQ entry by keywords (no model); nothing matching gives null", () => {
  const id = (q) => faqAnswer(FAQ.entries, q)?.id ?? null;
  assert.equal(id("is my file uploaded to a server?"), "upload");
  assert.equal(id("Is it free?"), "free");
  assert.equal(id("how do I make my PDF smaller, it's 9 MB"), "compress");
  assert.equal(id("How do I sign a PDF?"), "sign");
  assert.equal(id("can I join two PDFs together"), "merge");
  assert.equal(id("my pdf is a scanned picture"), "ocr");
  assert.equal(id("can I highlight a line?"), "annotate");
  assert.equal(id("what can you do, tiny?"), "tiny");
  assert.equal(id("what's the weather in Boston"), null);
  assert.equal(id(""), null);
  assert.equal(faqAnswer(undefined, "free"), null);
  // whole words for short keywords: "mb" does not fire inside "tumble"; a long keyword matches inside a word ("uploaded")
  assert.equal(faqAnswer([{ id: "x", keywords: ["mb"] }], "tumble dryer"), null);
  assert.equal(faqAnswer([{ id: "x", keywords: ["upload"] }], "re-uploading")?.id, "x");
  // tiny.js answers from it as the engine's fallback, with the entry's page as a link
  const tiny = read("public/assistant/tiny.js");
  assert.match(tiny, /import \{ PLACES, faqAnswer, placeHref \} from "\/assistant\/tinySite\.js";/);
  assert.match(tiny, /fallback: async \(text\) => \{ const e = faqAnswer\(faq\.entries, text\); return e \? \{ tier: "T2", intent: "faq", text: e\.a, links: e\.href \?/);
});

test("46n · every FAQ entry is whole (q, a, keywords) and its href is a real page or route on this site", () => {
  assert.ok(FAQ.entries.length >= 10);
  const ids = new Set();
  for (const e of FAQ.entries) {
    assert.ok(e.id && !ids.has(e.id), `unique id ${e.id}`); ids.add(e.id);
    assert.ok(e.q && e.a && Array.isArray(e.keywords) && e.keywords.length, e.id);
    if (e.href != null) assert.ok(realRoute(e.href), `${e.id} → ${e.href} is a real page`);
  }
});

/** A site path → is it a real page here (a public file / folder index, or a server route this site renders)? */
function realRoute(href) {
  const p = href.split(/[?#]/)[0];
  if (p === "/privacy") return fs.existsSync(path.join(ROOT, "public", "privacy.html")) && /r\.get\("\/privacy"/.test(read("src/http/siteRoutes.js"));
  const f = path.join(ROOT, "public", p.endsWith("/") ? `${p}index.html` : p);
  return fs.existsSync(f);
}

test("46n · every place Tiny opens is a real page, and the words people use find it", () => {
  for (const [k, href] of Object.entries(PLACES)) assert.ok(realRoute(href), `${k} → ${href}`);
  assert.deepEqual(placeHref("the compress tool"), { key: "compress", href: "/pdf/compress-pdf/" });
  assert.deepEqual(placeHref("my documents"), { key: "documents", href: "/" });
  assert.deepEqual(placeHref("the workspace"), { key: "workspace", href: "/workspace/" });
  assert.deepEqual(placeHref("sign pdf page"), { key: "sign pdf", href: "/pdf/sign-pdf/" });
  assert.deepEqual(placeHref("merge pdf"), { key: "merge pdf", href: "/pdf/merge-pdf/" });
  assert.equal(placeHref("the moon"), null);
  assert.equal(placeHref(""), null);
  // the workspace modes the places name (?mode=annotate / convert) are modes the workspace reads from its address
  const ws = read("public/workspace/workspace.js");
  for (const m of new Set(Object.values(PLACES).map(h => h.match(/\?mode=(\w+)/)?.[1]).filter(Boolean))) assert.ok(ws.includes(`"${m}"`), `workspace knows mode ${m}`);
});

test("46n · every page of the site loads Tiny exactly once (tiny-boot.js) — and the workspace mounts it itself instead", () => {
  const pages = ["public/index.html", "public/privacy.html", "public/editor/index.html", "public/pdf/index.html",
    ...fs.readdirSync(path.join(ROOT, "public", "pdf"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => `public/pdf/${d.name}/index.html`)];
  assert.ok(pages.length >= 20, `${pages.length} pages`);
  const tag = '<script type="module" src="/assistant/tiny-boot.js"></script>';
  for (const p of pages) assert.equal(read(p).split(tag).length - 1, 1, `${p} loads tiny-boot.js once`);
  // every HTML page under public/ is either one of those or the workspace
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r); else if (e.name.endsWith(".html")) all.push(r); } };
  walk("public");
  assert.deepEqual(all.filter(p => !pages.includes(p)).sort(), ["public/workspace/index.html"]);
  // the boot script skips the workspace (data-ws) and a second mount
  assert.match(read("public/assistant/tiny-boot.js"), /if \(!document\.querySelector\("\[data-ws\]"\) && !document\.querySelector\("\[data-tiny-root\]"\)\)/);
  assert.match(read("public/workspace/index.html"), /data-ws/);
});

test("46n · the site generator's page template carries tiny-boot.js, so a rebuilt page keeps Tiny", async () => {
  const { renderHub, renderToolPage, PDF_PAGES } = await import("../scripts/site/buildSite.mjs");
  const tag = '<script type="module" src="/assistant/tiny-boot.js"></script>';
  assert.equal(renderHub().split(tag).length - 1, 1);
  for (const p of PDF_PAGES) assert.equal(renderToolPage(p).split(tag).length - 1, 1, p.slug);
});

test("46n · Tiny's fox is draft's: public/assistant/tinyMascot.js is byte-identical to draft's shared/tinyMascot.js (when draft sits beside this repo)", async (t) => {
  const mine = read("public/assistant/tinyMascot.js");
  const draft = path.resolve(ROOT, "..", "draft", "shared", "tinyMascot.js");
  if (!fs.existsSync(draft)) { t.skip("draft is not checked out beside resume-master"); return; }
  assert.equal(mine, fs.readFileSync(draft, "utf8").replace(/\r\n/g, "\n"), "re-mirror shared/tinyMascot.js from draft");
  const { tinySvg, TINY_NAME } = await import("../public/assistant/tinyMascot.js");
  // 46v (draft owner 11-18: "change to their respective short logos ... drop 'tiny'"), changed on purpose: the mirror now
  // draws draft's "/d" and is named draft; THIS site's assistant wears its own short logo (the RM card) and name in tiny.js.
  assert.equal(TINY_NAME, "draft");
  assert.match(tinySvg({ size: 44 }), /^<svg [^>]*width="44" height="44" aria-hidden="true"/);
  assert.match(tinySvg({ title: "Tiny <fox>" }), /role="img"[^>]*><title>Tiny fox<\/title>/);
  const own = read("public/assistant/tiny.js");
  assert.doesNotMatch(own, /from "\/assistant\/tinyMascot\.js"/, "this site draws its own short logo, not draft's");
  assert.match(own, /const TINY_NAME = "Resume Master";/);
  assert.match(own, />RM<\/text>/, "the RM card of favicon.svg");
});
