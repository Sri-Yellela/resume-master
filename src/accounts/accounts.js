// ── Accounts (A57): sign-up, sign-in, sessions, password reset, export, delete ─────────────────
//
// SEPARATE ACCOUNTS, NO SSO (owner, 10-02): a Resume Master account is not a draft account, and
// nothing here reads draft's users. That keeps "not linked" true and needs no cross-service
// identity; SSO can be added later without undoing anything.
//
// Passwords: scrypt (node:crypto), per-user salt, constant-time verify. Sessions: a random 32-byte
// token in an HttpOnly cookie; only its sha256 is stored, so a leaked database yields no session.
import crypto from "node:crypto";

export class AccountError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
const RESET_MINUTES = 30;
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const now = () => Math.floor(Date.now() / 1000);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = crypto.scryptSync(String(password), Buffer.from(salt, "base64url"), want.length,
    { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(want, got);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
function checkCredentials(email, password) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) throw new AccountError(400, "invalid_email", "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 10 || password.length > 200)
    throw new AccountError(400, "weak_password", "Use a password of at least 10 characters.");
}

export function publicUser(u) {
  return u ? { id: u.id, email: u.email, createdAt: u.created_at * 1000 } : null;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (sid_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, now() + SESSION_DAYS * 86400);
  return token;
}

export function userForSession(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid_hash = ? AND s.expires_at > ?
  `).get(sha256(token), now()) || null;
}

export function endSession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE sid_hash = ?").run(sha256(token));
}

export function signUp(db, { email, password }) {
  checkCredentials(email, password);
  try {
    const id = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email.trim(), hashPassword(password)).lastInsertRowid;
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new AccountError(409, "email_taken", "An account with that email already exists. Sign in instead.");
    throw e;
  }
}

export function signIn(db, { email, password }) {
  const u = typeof email === "string" ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) : null;
  // The same answer for "no such account" and "wrong password" — the form must not reveal which
  // emails have accounts.
  if (!u || !verifyPassword(password, u.password_hash)) throw new AccountError(401, "invalid_credentials", "That email and password do not match.");
  return u;
}

/** A reset token for `email`, or null when there is no such account (the caller answers the same). */
export function startPasswordReset(db, email) {
  const u = typeof email === "string" ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) : null;
  if (!u) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), u.id, now() + RESET_MINUTES * 60);
  return { token, user: u };
}

export function finishPasswordReset(db, { token, password }) {
  if (typeof password !== "string" || password.length < 10) throw new AccountError(400, "weak_password", "Use a password of at least 10 characters.");
  const row = token ? db.prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(sha256(token)) : null;
  if (!row || row.used_at || row.expires_at < now()) throw new AccountError(400, "invalid_reset", "This reset link has expired or was already used. Ask for a new one.");
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = unixepoch() WHERE id = ?").run(hashPassword(password), row.user_id);
    db.prepare("UPDATE password_resets SET used_at = unixepoch() WHERE token_hash = ?").run(row.token_hash);
    // Every session ends: a reset is what someone does when they think another person has the password.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  })();
}

/** Everything held about this user — the access path GDPR requires. */
export function exportAccount(db, userId) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return {
    user: publicUser(u),
    ledger: db.prepare("SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id").all(userId),
    artifacts: db.prepare("SELECT id, kind, title, content, bytes, created_at, expires_at FROM artifacts WHERE user_id = ? ORDER BY id").all(userId),
  };
}

/** Delete the account and everything held for it (sessions, ledger, documents cascade). */
export function deleteAccount(db, userId, password) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!u || !verifyPassword(password, u.password_hash)) throw new AccountError(401, "invalid_credentials", "Enter your password to delete the account.");
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}
