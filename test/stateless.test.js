// ⛔ STATELESS — NO DATABASE. Input in, output back, nothing persisted. That is what keeps the
// privacy story "processes, does not retain" true, and it is a decision (2026-09-26), not a gap:
// add storage only when this service has its own direct customers, and then change docs/API.md
// in the same commit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const runtime = [...walk("src"), "server.js"].filter(f => f.endsWith(".js"));
const code = (f) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no database or cache dependency is declared", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const stores = deps.filter(d => /sqlite|^pg$|postgres|mysql|mongo|redis|prisma|knex|sequelize|typeorm|drizzle|lowdb|nedb/i.test(d));
  assert.deepEqual(stores, [], "a storage dependency arrived — see the header of this file");
});

test("no runtime code writes to disk or opens a store", () => {
  assert.ok(runtime.length >= 10, `scanned ${runtime.length} files`);
  for (const f of runtime) {
    const src = code(f);
    assert.doesNotMatch(src, /\b(writeFile|appendFile|createWriteStream|mkdirSync|writeFileSync|appendFileSync|mkdtemp)\b/,
      `${f} writes to disk`);
    assert.doesNotMatch(src, /better-sqlite3|new Database\(|\.prepare\(|sqlite3|localStorage/, `${f} opens a store`);
  }
});

// String text is removed before matching and only the EXPRESSIONS inside a template literal are
// kept, so the boot line `[prompt] Layer 1 loaded (${n} chars)` — a label and a length — does not
// read as logging a prompt. A guard that cries wolf on a label gets deleted.
const expressionsOnly = (src) => src
  .replace(/`(?:[^`\\]|\\.)*`/g, t => (t.match(/\$\{[^}]*\}/g) || []).join(" "))
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

test("no runtime code logs a request body, a prompt or a model response", () => {
  for (const f of runtime) {
    const src = expressionsOnly(code(f));
    for (const call of src.match(/console\.(log|info|warn|error|debug)\([^;]*/g) || []) {
      assert.doesNotMatch(call, /\b(req\.body|body|html|formattedHtml|resumeText|baseResumeText|runtimeInputs|prompt|systemBlocks|messages|message\.content|textOf)\b/,
        `${f} logs content: ${call.slice(0, 120)}`);
    }
  }
});
