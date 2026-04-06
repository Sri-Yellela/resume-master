// scripts/backup.js
// Run directly:  node scripts/backup.js
// Or via npm:    npm run backup
import Database from "better-sqlite3";
import fs       from "fs";
import path     from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "..", "data", "resume_master.db");
const BAK_DIR   = path.join(__dirname, "..", "data", "backups");
const MANIFEST  = path.join(BAK_DIR, "manifest.json");

fs.mkdirSync(BAK_DIR, { recursive: true });

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch { return []; }
}

function saveManifest(entries) {
  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
}

export function createBackup(label = "manual") {
  if (!fs.existsSync(DB_PATH)) {
    console.warn("[backup] No DB found at", DB_PATH);
    return null;
  }
  const ts       = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `resume_master_${ts}_${label}.db`;
  const dest     = path.join(BAK_DIR, filename);

  // fs.copyFileSync is safe, synchronous, and works regardless of connection state.
  // Do NOT use db.backup() here — it conflicts with the server's open connection.
  fs.copyFileSync(DB_PATH, dest);
  console.log(`[backup] Saved: ${dest}`);

  const manifest = loadManifest();
  manifest.unshift({
    filename, label,
    created: new Date().toISOString(),
    size: fs.statSync(dest).size,
  });
  const pruned = manifest.slice(0, 30);
  manifest.slice(30).forEach(e => {
    try { fs.unlinkSync(path.join(BAK_DIR, e.filename)); } catch {}
  });
  saveManifest(pruned);
  return { filename, path: dest, created: new Date().toISOString() };
}

export function listBackups() {
  return loadManifest();
}

export function restoreBackup(filename) {
  const src = path.join(BAK_DIR, filename);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${filename}`);

  // Safety: back up current DB before restoring
  if (fs.existsSync(DB_PATH)) {
    const safeTs   = new Date().toISOString().replace(/[:.]/g,"-");
    const safeName = `resume_master_${safeTs}_pre-restore.db`;
    fs.copyFileSync(DB_PATH, path.join(BAK_DIR, safeName));
    console.log(`[restore] Current DB backed up as ${safeName} before restore`);
  }

  fs.copyFileSync(src, DB_PATH);
  console.log(`[restore] ✓ Restored from ${filename}`);
  return { ok: true, restored: filename };
}

// ── Run as script ──────────────────────────────────────────────
// node scripts/backup.js [list|restore <filename>]
const args = process.argv.slice(2);
if (args[0] === "list") {
  const entries = listBackups();
  if (!entries.length) { console.log("No backups found."); }
  else entries.forEach((e, i) => console.log(`${i+1}. ${e.filename}  (${e.label})  ${e.created}`));
} else if (args[0] === "restore") {
  if (!args[1]) { console.error("Usage: node scripts/backup.js restore <filename>"); process.exit(1); }
  restoreBackup(args[1]);
} else {
  // Default: create a backup
  createBackup(args[0] || "manual");
}
