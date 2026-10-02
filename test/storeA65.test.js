// A65 (owner's note under draft WORKLOG A57): the store on the volume, draft's backup policy against
// it, pinning against the 90-day expiry, and a save refused — not attempted — when the volume is low.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, resolveStorePath, STORE_FILE } from "../src/store/db.js";
import {
  saveArtifact, listArtifacts, setPinned, purgeExpired, volumeRoomFor, MAX_PINNED_PER_USER,
} from "../src/accounts/artifacts.js";
import { configureStoreBackups, createBackup, listBackups, verifyBackups, msUntilNextRun, runBackup } from "../src/store/backups.js";
import { verifyManifest } from "../vendor/sqlite-backup/scripts/checksums.mjs";
import { createApp } from "../src/http/app.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

const user = (db, email = "a@example.org") =>
  db.prepare("INSERT INTO users (email, password_hash) VALUES (?, 'x')").run(email).lastInsertRowid;
const doc = (db, uid, title = "t") => saveArtifact(db, uid, { kind: "formatted_resume", title, content: "<p>x</p>" }, {});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rm-a65-"));

test("the store opens on the Railway volume; RM_DB_PATH stays an override; neither means no store", () => {
  assert.equal(resolveStorePath({}), null);
  assert.equal(resolveStorePath({ RAILWAY_VOLUME_MOUNT_PATH: "/data" }), path.join("/data", STORE_FILE));
  assert.equal(resolveStorePath({ RAILWAY_VOLUME_MOUNT_PATH: "/data", RM_DB_PATH: "/x/y.db" }), "/x/y.db");
});

test("migrations are recorded in schema_migrations (the table draft's verify reads), 004 adds pins", () => {
  const db = openStore(":memory:");
  const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").pluck().all();
  assert.deepEqual(ids, ["001_accounts", "002_credit_ledger", "003_artifacts", "004_artifact_pins"]);
  assert.ok(db.prepare("PRAGMA table_info(artifacts)").all().some(c => c.name === "pinned"));
});

test("expiry skips a pinned document; unpinning restarts its clock rather than deleting it", () => {
  const db = openStore(":memory:");
  const uid = user(db);
  const a = doc(db, uid, "pinned"), b = doc(db, uid, "loose");
  assert.equal(setPinned(db, uid, a.id, true, {}).ok, true);
  db.prepare("UPDATE artifacts SET expires_at = 1").run();            // both long past expiry
  assert.equal(purgeExpired(db), 1, "only the unpinned one goes");
  const left = listArtifacts(db, uid);
  assert.deepEqual(left.map(d => d.title), ["pinned"]);
  assert.equal(left[0].pinned, true);
  assert.equal(left[0].expiresAt, null, "a pinned document shows no expiry");
  void b;

  const un = setPinned(db, uid, a.id, false, { RM_ARTIFACT_RETENTION_DAYS: "90" });
  assert.equal(un.ok, true);
  assert.ok(un.document.expiresAt > Date.now() + 89 * 86400_000, "the clock restarts: 90 days from now");
  assert.equal(purgeExpired(db), 0, "an unpin never silently deletes");
});

test("pins are capped per user, and only your own document can be pinned", () => {
  const db = openStore(":memory:");
  const uid = user(db), other = user(db, "b@example.org");
  for (let i = 0; i < MAX_PINNED_PER_USER; i++) assert.equal(setPinned(db, uid, doc(db, uid).id, true, {}).ok, true);
  assert.deepEqual(setPinned(db, uid, doc(db, uid).id, true, {}), { ok: false, code: "too_many_pinned" });
  assert.deepEqual(setPinned(db, other, 1, true, {}), { ok: false, code: "not_found" });
});

test("a save is REFUSED when the volume is low — the reserve keeps room for the database and its backups", () => {
  const dir = tmp();
  try {
    const db = openStore(path.join(dir, "s.db"));
    const uid = user(db);
    const GB = 1024 ** 3;
    const statfs = (free) => () => ({ bsize: 4096, blocks: GB / 4096, bavail: free / 4096 });
    assert.equal(volumeRoomFor(db, 1000, { statfs: statfs(0.5 * GB) }).ok, true);
    const low = volumeRoomFor(db, 1000, { statfs: statfs(0.1 * GB) });   // under 15 % of 1 GB
    assert.equal(low.ok, false);
    assert.deepEqual(saveArtifact(db, uid, { kind: "pdf_text", title: "t", content: "x" }, {}, { statfs: statfs(0.1 * GB) }),
      { stored: false, reason: "storage_full" });
    assert.equal(db.prepare("SELECT COUNT(*) FROM artifacts").pluck().get(), 0, "nothing was attempted");
    assert.equal(volumeRoomFor(openStore(":memory:"), 1e12).ok, true, "an in-memory store is never refused");
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("draft's backup policy runs against the store: a checkpointed copy, listed, verified at the current schema", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "resume-master.db");
    const db = openStore(file);
    user(db);
    const cfg = configureStoreBackups(file);
    assert.equal(cfg.backupDir, path.join(dir, "backups"));
    const r = createBackup("test");
    assert.match(r.filename, /^resume-master_.+_test\.db$/);
    assert.equal(listBackups()[0].walCheckpointed, true);
    const [v] = verifyBackups();
    assert.equal(v.integrity, "ok");
    assert.equal(v.schema, "004_artifact_pins");
    const copy = openStore(path.join(dir, "backups", r.filename));
    assert.equal(copy.prepare("SELECT COUNT(*) FROM users").pluck().get(), 1, "the copy holds the data");
    copy.close(); db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a scheduled backup that fails is logged, never thrown; the schedule is 02:00 UTC", () => {
  const dir = tmp();
  try {
    configureStoreBackups(path.join(dir, "absent.db"));
    const lines = [];
    const log = { log: l => lines.push(l), error: l => lines.push(l) };
    assert.equal(runBackup("auto-daily", log), null, "no database: no backup, no throw");
    assert.equal(JSON.parse(lines[0]).ok, false);
    assert.equal(msUntilNextRun(new Date("2026-10-02T01:00:00Z")), 3600_000);
    assert.equal(msUntilNextRun(new Date("2026-10-02T02:00:00Z")), 86400_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the vendored @draft/sqlite-backup matches its checksums — a hand edit here fails", () => {
  assert.deepEqual(verifyManifest(), []);
});

test("routes: pin and unpin a document; admin backups answer 503 without a volume", async () => {
  const store = openStore(":memory:");
  const app = createApp({ log: () => {}, store, env: { RM_ADMIN_EMAILS: "boss@example.org" } });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", "x-rm-client": "web", ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  };
  try {
    await call("POST", "/v1/site/account/signup", { email: "boss@example.org", password: "long enough pw" });
    const kept = await (await call("POST", "/v1/site/tools/format", { html: "<p>JANE DOE</p>", store: true, title: "Mine" })).json();
    const pin = await call("POST", `/v1/site/documents/${kept.saved.id}/pin`, { pinned: true });
    assert.equal(pin.status, 200);
    assert.equal((await pin.json()).document.pinned, true);
    const list = await (await call("GET", "/v1/site/documents")).json();
    assert.equal(list.documents[0].expiresAt, null);
    assert.equal(list.maxPinned, MAX_PINNED_PER_USER);
    assert.equal((await call("POST", "/v1/site/documents/999/pin", { pinned: true })).status, 404);
    const unpin = await (await call("POST", `/v1/site/documents/${kept.saved.id}/pin`, { pinned: false })).json();
    assert.equal(unpin.document.pinned, false);
    assert.equal((await call("GET", "/v1/site/admin/backups")).status, 503);
    assert.equal((await (await call("POST", "/v1/site/admin/backups")).json()).error, "backups_unconfigured");
  } finally { await new Promise(r => server.close(r)); }
});
