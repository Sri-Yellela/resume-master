// ⭐ D190 P1 · TINY — the workspace's chat, acting on the document with NO model (draft's WORKLOG, owner 11-14:
// "resume master and draft both are supposed to not call for any task that is within the site's premise in terms of data
// or function"). The engine and the vocabulary are draft's (shared/assistantEngine.js, content/assistant/commands-v1.json),
// mirrored here byte-identical — draft's test/d190Assistant.test.js fails when the copies differ. The end-to-end walk in
// real Chrome is draft's scripts/d190TinyWalk.mjs (30 checks: each command, Undo, ask back, confirm, 0 requests).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const { createAssistant, checkExamples } = await import("../public/assistant/assistantEngine.js");
const COMMANDS = JSON.parse(read("public/assistant/commands-v1.json"));

test("the mirrored vocabulary parses its own examples for Tiny's site", () => {
  assert.deepEqual(checkExamples(COMMANDS, "rm"), []);
});

test("Tiny makes no request: the panel fetches only its vocabulary; the engine has no network; no model route anywhere", () => {
  const tiny = read("public/assistant/tiny.js");
  assert.deepEqual([...tiny.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]), ['"/assistant/commands-v1.json"']);
  assert.doesNotMatch(read("public/assistant/assistantEngine.js"), /\bfetch\(|XMLHttpRequest|\bimport\s/);
  const ws = read("public/workspace/workspace.js");
  const block = ws.slice(ws.indexOf("// ── ⭐ D190 · TINY"), ws.indexOf("window.__rmWorkspace = session;"));
  assert.ok(block.length > 2000, "the Tiny block is in the workspace");
  assert.doesNotMatch(block, /fetch\(|\/api\/|anthropic|\/v1\//, "no handler makes a request");
  // the T3 row is a stub in P1 — it asks back, it sends nothing
  assert.match(block, /t3: \(\) => \(\{ ask: /);
});

test("every Tiny row has a handler in the workspace, and each one calls the tool bar's own function", () => {
  const ws = read("public/workspace/workspace.js");
  for (const r of COMMANDS.commands.filter(x => (x.site === "rm" || x.site === "both") && x.tier !== "ask")) {
    assert.match(ws, new RegExp(`\\b${r.calls}: `), `${r.intent} → ${r.calls}`);
  }
  // the same functions the tool bar uses: pageOp, convert, download, goTo, setZoom, the session's undo / redo / style
  for (const fn of ["pageOp(kind, arg, done, { rethrow: true })", 'convert("compress", { limit:', "await download()", "goTo(p)", "session.styleField(f,", "session.setText(f,", "session.undo()"]) assert.ok(ws.includes(fn), fn);
});

test("the session's chat edits are ordinary, undoable edits (setText / styleField record on the undo stack)", () => {
  const s = read("src/pdf-toolkit/session.js");
  const setText = s.slice(s.indexOf("setText(f, text) {"), s.indexOf("styleField(f, p)"));
  assert.match(setText, /record\(\{ undo: \(\) => restore\(f, before\), redo: \(\) => restore\(f, after\) \}\)/);
  assert.match(s, /styleField\(f, p\) \{[^\n]*setStyle\(p\)/);
});

test("the panel sits beside the page and moves it over (a fourth column), a bottom sheet on phones; tokens only, no capsules", () => {
  const css = read("public/assistant/tiny.css");
  assert.match(css, /\.ws\[data-tiny="open"\] \.ws-body \{ grid-template-columns: 150px minmax\(0, 1fr\) 290px 320px; \}/);
  assert.doesNotMatch(css.slice(0, css.indexOf("@media (max-width: 820px)")), /position:\s*(absolute|fixed)/, "on a desktop it is in the grid, never over the page");
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.ws-tiny \{ position: fixed; left: 0; right: 0; bottom: 0;/);
  assert.doesNotMatch(css, /999px|border-radius:\s*50%/, "no capsule (D60)");
  assert.doesNotMatch(css.replace(/rgba\(0,0,0,\.5\)/g, ""), /#[0-9a-f]{3,8}\b/i, "colours from the workspace's tokens");
  const html = read("public/workspace/index.html");
  assert.match(html, /id="ws-tiny-toggle" aria-expanded="false" aria-controls="ws-tiny"/);
  assert.match(html, /href="\/assistant\/tiny\.css"/);
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
  assert.match(tiny, /onText: \(t\) => \{ input\.value = t; form\.requestSubmit\(\); \}/, "the spoken words are submitted like typed ones");
  const voice = read("public/assistant/assistantVoice.js");
  assert.match(voice, /processLocally: true/);
  assert.doesNotMatch(voice, /\bfetch\(|XMLHttpRequest/);
});
