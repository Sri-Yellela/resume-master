// ⛔ THE TOKEN API IS STATELESS — and since A57 (owner, 10-02) it is the ONLY part that is.
//
// Until 10-02 the whole service had no database, by decision (2026-09-26). The owner REVERSED that
// for people on resumemaster.one: accounts, a credit ledger and OPT-IN storage (draft's
// docs/CORRECTIONS_REGISTER.md records the reversal). These tests used to forbid any store; they
// now pin the narrower promise that survives it:
//   · the one storage dependency is better-sqlite3, opened ONLY by src/store/db.js;
//   · SQL runs only in src/accounts/ (and the store's own migrations) — never in the token API's
//     code (src/http/app.js, src/mcp, src/generation, src/tools, src/parsing, src/formatting);
//   · a service-token request leaves the store exactly as it found it (asserted by behaviour, with
//     a store attached, below);
//   · nothing else writes to disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const runtime = [...walk("src"), "server.js"].filter(f => f.endsWith(".js"));
const code = (f) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the one storage dependency is better-sqlite3, and only src/store/db.js imports it", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const stores = deps.filter(d => /sqlite|^pg$|postgres|mysql|mongo|redis|prisma|knex|sequelize|typeorm|drizzle|lowdb|nedb/i.test(d));
  assert.deepEqual(stores, ["better-sqlite3"], "a second storage dependency arrived — see the header of this file");
  const importers = runtime.filter(f => /from "better-sqlite3"|require\("better-sqlite3"\)/.test(code(f)));
  assert.deepEqual(importers.map(f => f.replace(/\\/g, "/")), ["src/store/db.js"]);
});

test("SQL runs only in src/accounts/ and the store; nothing else writes to disk", () => {
  assert.ok(runtime.length >= 10, `scanned ${runtime.length} files`);
  for (const f of runtime) {
    const posix = f.replace(/\\/g, "/");
    const src = code(f);
    if (posix !== "src/store/db.js") {
      assert.doesNotMatch(src, /\b(writeFile|appendFile|createWriteStream|mkdirSync|writeFileSync|appendFileSync|mkdtemp)\b/,
        `${f} writes to disk`);
    }
    const sqlAllowed = posix.startsWith("src/accounts/") || posix === "src/store/db.js" || posix === "src/http/siteRoutes.js";
    if (!sqlAllowed) {
      assert.doesNotMatch(src, /\.prepare\(|\.exec\(\s*`|new Database\(|localStorage/, `${f} touches a store`);
    }
  }
  // The token API's own code never sees the store beyond handing it to the site's router.
  const app = code("src/http/app.js");
  assert.equal((app.match(/\bstore\b/g) || []).length, 2, "app.js names `store` only to accept it and pass it to siteRoutes");
  for (const dir of ["src/mcp", "src/generation", "src/tools", "src/parsing", "src/formatting", "src/model"]) {
    for (const f of walk(dir).filter(x => x.endsWith(".js"))) {
      assert.doesNotMatch(code(f), /\bstore\b|accounts\//, `${f} reaches the store`);
    }
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
