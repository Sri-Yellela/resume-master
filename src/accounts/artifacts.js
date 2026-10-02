// ── Opt-in storage (A57): a signed-in user's documents, ONLY when they ask, per document ────────
//
// "On the user's demand" stays literal (owner, 10-02): a tool stores its OUTPUT — the generated or
// formatted résumé, the text read from a PDF — only when the request carries `store: true` from a
// signed-in user. The INPUT (the résumé or PDF they sent) is never stored. A delete deletes: the row
// goes, and the store runs with secure_delete so the freed pages are zeroed.
//
// A65 (owner's note under WORKLOG A57) — RETENTION AND SPACE, decided before the store holds anything:
//   · a document EXPIRES after RM_ARTIFACT_RETENTION_DAYS (90) UNLESS THE USER PINS IT; a pinned one
//     is kept until it is unpinned or deleted. Pins are capped per user (MAX_PINNED_PER_USER) so a
//     pin cannot become unbounded storage.
//   · "size it for PDFs, not rows": what is stored is text/HTML (a PDF is printed by the browser and
//     never stored), each capped at 2 MB, 200 per user — and a save is REFUSED, not attempted, when
//     the volume is low, so the live database and its backups keep their room (draft failed once
//     with ENOSPC at 481/500 MB).
import fs from "node:fs";
import path from "node:path";

const now = () => Math.floor(Date.now() / 1000);
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_USER = 200;
export const MAX_PINNED_PER_USER = 20;
export const KINDS = Object.freeze(["generated_resume", "formatted_resume", "pdf_text", "ats_report"]);

export function retentionDays(env = process.env) {
  const n = Number(env?.RM_ARTIFACT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 90;
}

/**
 * Is there room on the store's volume for `bytes` more, keeping a reserve free? The reserve is the
 * larger of 64 MB and 15 % of the volume — room for the live database, its WAL and the next backup's
 * checkpoint. An in-memory store (tests) always has room. `statfs` is injectable for tests.
 */
export function volumeRoomFor(db, bytes, { statfs = fs.statfsSync } = {}) {
  const file = db?.name;
  if (!file || file === ":memory:") return { ok: true };
  let s;
  try { s = statfs(path.dirname(path.resolve(file))); } catch { return { ok: true }; }   // cannot tell: do not block on it
  const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
  const reserve = Math.max(64 * 1024 * 1024, Math.floor(total * 0.15));
  return free - bytes >= reserve ? { ok: true } : { ok: false, free, total, reserve };
}

export function saveArtifact(db, userId, { kind, title, content }, env = process.env, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown artifact kind ${kind}`);
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) return { stored: false, reason: "too_large" };
  const count = db.prepare("SELECT COUNT(*) FROM artifacts WHERE user_id = ?").pluck().get(userId);
  if (count >= MAX_ARTIFACTS_PER_USER) return { stored: false, reason: "too_many" };
  if (!volumeRoomFor(db, bytes, opts).ok) return { stored: false, reason: "storage_full" };
  const expires = now() + retentionDays(env) * 86400;
  const id = db.prepare("INSERT INTO artifacts (user_id, kind, title, content, bytes, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, kind, title ? String(title).slice(0, 200) : null, text, bytes, expires).lastInsertRowid;
  return { stored: true, id, expiresAt: expires * 1000 };
}

const publicDoc = (a) => ({ id: a.id, kind: a.kind, title: a.title, bytes: a.bytes, pinned: !!a.pinned,
                            createdAt: a.created_at * 1000, expiresAt: a.pinned ? null : a.expires_at * 1000 });

export function listArtifacts(db, userId) {
  return db.prepare("SELECT id, kind, title, bytes, pinned, created_at, expires_at FROM artifacts WHERE user_id = ? ORDER BY id DESC")
    .all(userId).map(publicDoc);
}

export function getArtifact(db, userId, id) {
  return db.prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ?").get(Number(id), userId) || null;
}

export function deleteArtifact(db, userId, id) {
  return db.prepare("DELETE FROM artifacts WHERE id = ? AND user_id = ?").run(Number(id), userId).changes;
}

/**
 * Pin (keep until unpinned) or unpin. Unpinning restarts the clock: the document then expires
 * `retentionDays` from now, never immediately — an unpin must not silently delete.
 */
export function setPinned(db, userId, id, pinned, env = process.env) {
  const a = getArtifact(db, userId, id);
  if (!a) return { ok: false, code: "not_found" };
  if (pinned && !a.pinned) {
    const n = db.prepare("SELECT COUNT(*) FROM artifacts WHERE user_id = ? AND pinned = 1").pluck().get(userId);
    if (n >= MAX_PINNED_PER_USER) return { ok: false, code: "too_many_pinned" };
  }
  db.prepare("UPDATE artifacts SET pinned = ?, expires_at = CASE WHEN ? = 1 THEN expires_at ELSE ? END WHERE id = ?")
    .run(pinned ? 1 : 0, pinned ? 1 : 0, now() + retentionDays(env) * 86400, a.id);
  return { ok: true, document: publicDoc(getArtifact(db, userId, id)) };
}

/** Expired, UNPINNED documents are deleted — boot, and hourly. */
export function purgeExpired(db) {
  return db.prepare("DELETE FROM artifacts WHERE pinned = 0 AND expires_at <= ?").run(now()).changes;
}
