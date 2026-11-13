// ⛔ draft A186 (46g) · the running service's backups are SQLite's online backup — never a copy on the one thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/store/db.js";
import { configureStoreBackups, runBackupAsync, listBackups } from "../src/store/backups.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("a186: runBackupAsync takes a consistent online backup of the live store while it keeps writing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-a186-"));
  let db = null;
  try {
    const file = path.join(dir, "rm.db");
    db = openStore(file);
    configureStoreBackups(file);
    db.exec("CREATE TABLE IF NOT EXISTS t46 (id INTEGER PRIMARY KEY, body TEXT)");
    const ins = db.prepare("INSERT INTO t46 (body) VALUES (?)");
    db.transaction(() => { for (let i = 0; i < 20000; i++) ins.run("x".repeat(500) + i); })();
    let wrote = 0, last = Date.now(), maxGap = 0;
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ins.run("during"); wrote++; }, 5);
    const lines = [];
    const r = await runBackupAsync("t46", { log: l => lines.push(l), error: l => lines.push(l) }, db);
    clearInterval(tick);
    assert.ok(r?.filename, lines.join("\n"));
    assert.ok(wrote > 0 && maxGap < 250, `the store kept writing (${wrote}) and the loop ran (longest pause ${maxGap} ms)`);
    assert.equal(JSON.parse(lines[0]).method, "vacuum-into-worker");   // draft A196 (46j, changed on purpose): off the thread
    const copy = openStore(path.join(dir, "backups", r.filename));
    assert.ok(copy.prepare("SELECT COUNT(*) FROM t46").pluck().get() >= 20000);
    copy.close();
    assert.equal(listBackups()[0].method, "vacuum-into-worker");
  } finally { try { db?.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("a186: the daily timer and Admin's backup pass the store's own connection", () => {
  assert.match(read("server.js"), /scheduleDailyBackups\(console, store\);/);
  const routes = read("src/http/siteRoutes.js");
  assert.match(routes, /r\.post\("\/admin\/backups", needStore, writeGuard, requireAdmin, needBackups, async \(req, res\) => \{\n    const out = await runBackupAsync\("admin", console, store\);/);
  assert.match(read("src/store/backups.js"), /runBackupAsync\("auto-daily", log, db\)/);
});
