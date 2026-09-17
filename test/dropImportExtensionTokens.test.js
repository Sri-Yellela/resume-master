// AH-2 — DROPPING CREDENTIAL-SHAPED RESIDUE OF A DELETED FEATURE.
//
// The extension token copy/paste flow was removed in c818b9c. SQLite does not drop a table when
// its CREATE statement leaves the source, so production kept `import_extension_tokens`: 3 rows of
// token hashes bound to users(id) that no code could expire, consume or rotate, because the code
// that did was deleted. Filed by task T, restated by AH-2, never done.
//
// It is not merely clutter. Stale credential material with no expiry path is the kind of thing
// that is fine right up until it is not, and nothing in the running system would ever notice.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { at } from "../test-support/sourceAnchors.js";

const SERVER = fs.readFileSync("server.js", "utf8");
const RUNNER = fs.readFileSync("scripts/migrations.js", "utf8");
const MIG_ID = '"106_drop_import_extension_tokens"';

test("migration 106 is byte-identical in both runners", () => {
  const a = SERVER.slice(at(SERVER, MIG_ID, 0, "server 106"), at(SERVER, "},", at(SERVER, MIG_ID, 0, "s"), "end"));
  const b = RUNNER.slice(at(RUNNER, MIG_ID, 0, "runner 106"), at(RUNNER, "},", at(RUNNER, MIG_ID, 0, "r"), "end"));
  assert.equal(a, b, "the two migration paths must not diverge");
});

test("the migration actually drops the table, and is a no-op where it never existed", () => {
  // Executed FROM THE FILE rather than retyped here, so the test cannot pass against a migration
  // that says something else.
  const block = SERVER.slice(at(SERVER, MIG_ID, 0, "mig"), at(SERVER, "},", at(SERVER, MIG_ID, 0, "m"), "end"));
  const sql = block.match(/sql:\s*`([\s\S]*?)`/)[1];
  assert.match(sql, /DROP TABLE IF EXISTS import_extension_tokens;/);

  // Case 1: a database that HAS the table, like production.
  const withTable = new Database(":memory:");
  withTable.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  withTable.exec(`CREATE TABLE import_extension_tokens (
                    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), token_hash TEXT)`);
  withTable.prepare("INSERT INTO users (id) VALUES (1)").run();
  withTable.prepare("INSERT INTO import_extension_tokens (user_id, token_hash) VALUES (1,'deadbeef')").run();
  assert.equal(withTable.prepare("SELECT COUNT(*) n FROM import_extension_tokens").get().n, 1);
  withTable.exec(sql);
  assert.equal(
    withTable.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='import_extension_tokens'").get().n, 0,
    "the table must be gone");
  withTable.close();

  // Case 2: a local checkout that never ran the removed feature. IF EXISTS is why this is a no-op
  // rather than a boot failure — the table is PRODUCTION-ONLY.
  const without = new Database(":memory:");
  assert.doesNotThrow(() => without.exec(sql), "must not fail where the table never existed");
  without.close();
});

test("nothing in the codebase still reads the table", () => {
  // If a reference reappears, the drop becomes a runtime error rather than a cleanup. Docs and
  // the schema-diff harness are excluded: both talk ABOUT the table, neither queries it.
  const skip = [/^docs[\\/]/, /^scripts[\\/]am3ProdSchemaDiff\.mjs$/, /^test[\\/]dropImportExtensionTokens\.test\.js$/,
                /^server\.js$/, /^scripts[\\/]migrations\.js$/];
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`.replace(/^\.\//, "");
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", "data"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(js|jsx|mjs)$/.test(e.name)) {
        const rel = p.replace(/\//g, "\\");
        if (skip.some(r => r.test(rel) || r.test(p))) continue;
        if (fs.readFileSync(p, "utf8").includes("import_extension_tokens")) hits.push(p);
      }
    }
  };
  walk(".");
  assert.deepEqual(hits, [], "a live reference to a dropped table is a runtime error waiting to happen");
});

test("the schema-diff harness now treats the table as DRIFT, not as a known difference", () => {
  // It used to carry an explanation for why production legitimately had this table. Left as-is,
  // it would keep waving through the one signal that the migration did not run.
  const diff = fs.readFileSync("scripts/am3ProdSchemaDiff.mjs", "utf8");
  const start = at(diff, "import_extension_tokens:", 0, "note");
  const note = diff.slice(start, start + 420);
  assert.match(note, /SHOULD NO LONGER EXIST|REAL DRIFT/,
    "the note must now say the table is unexpected, not explain why it is fine");
  assert.match(note, /migration 106/);
});
