// ── Opt-in storage (A57): a signed-in user's documents, ONLY when they ask, per document ────────
//
// "On the user's demand" stays literal (owner, 10-02): a tool stores its OUTPUT — the generated or
// formatted résumé, the text read from a PDF — only when the request carries `store: true` from a
// signed-in user. The INPUT (the résumé or PDF they sent) is never stored. Every document has an
// expiry (RM_ARTIFACT_RETENTION_DAYS, default 90) and a delete that deletes: the row goes, and the
// store runs with secure_delete so the freed pages are zeroed.
const now = () => Math.floor(Date.now() / 1000);
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_USER = 200;
export const KINDS = Object.freeze(["generated_resume", "formatted_resume", "pdf_text", "ats_report"]);

export function retentionDays(env = process.env) {
  const n = Number(env?.RM_ARTIFACT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 90;
}

export function saveArtifact(db, userId, { kind, title, content }, env = process.env) {
  if (!KINDS.includes(kind)) throw new Error(`unknown artifact kind ${kind}`);
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) return { stored: false, reason: "too_large" };
  const count = db.prepare("SELECT COUNT(*) FROM artifacts WHERE user_id = ?").pluck().get(userId);
  if (count >= MAX_ARTIFACTS_PER_USER) return { stored: false, reason: "too_many" };
  const expires = now() + retentionDays(env) * 86400;
  const id = db.prepare("INSERT INTO artifacts (user_id, kind, title, content, bytes, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, kind, title ? String(title).slice(0, 200) : null, text, bytes, expires).lastInsertRowid;
  return { stored: true, id, expiresAt: expires * 1000 };
}

export function listArtifacts(db, userId) {
  return db.prepare("SELECT id, kind, title, bytes, created_at, expires_at FROM artifacts WHERE user_id = ? ORDER BY id DESC")
    .all(userId).map(a => ({ id: a.id, kind: a.kind, title: a.title, bytes: a.bytes,
                             createdAt: a.created_at * 1000, expiresAt: a.expires_at * 1000 }));
}

export function getArtifact(db, userId, id) {
  return db.prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ?").get(Number(id), userId) || null;
}

export function deleteArtifact(db, userId, id) {
  return db.prepare("DELETE FROM artifacts WHERE id = ? AND user_id = ?").run(Number(id), userId).changes;
}

/** Expired documents are deleted — boot, and hourly. */
export function purgeExpired(db) {
  return db.prepare("DELETE FROM artifacts WHERE expires_at <= ?").run(now()).changes;
}
