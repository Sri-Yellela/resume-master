import crypto from "crypto";
import { hashPassword, hashResetSecret, validatePassword } from "./authSecurity.js";

const RESET_TTL_SECONDS = 15 * 60;

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

export function createPasswordReset(db, user, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? RESET_TTL_SECONDS;
  const pepper = options.pepper;
  if (!db || !user?.id || !pepper) throw new Error("password reset setup is incomplete");

  const token = crypto.randomBytes(32).toString("base64url");
  const otp = makeOtp();
  const tokenHash = hashResetSecret(token, pepper);
  const otpHash = hashResetSecret(otp, pepper);
  const expiresAt = now + ttlSeconds;

  const insert = db.transaction(() => {
    db.prepare(`
      UPDATE password_reset_tokens
      SET used_at = ?
      WHERE user_id = ? AND used_at IS NULL
    `).run(now, user.id);

    const result = db.prepare(`
      INSERT INTO password_reset_tokens
        (user_id, email, token_hash, otp_hash, expires_at, requested_at, request_ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      normaliseEmail(user.email),
      tokenHash,
      otpHash,
      expiresAt,
      now,
      options.requestIp || null,
      options.userAgent || null,
    );
    return result.lastInsertRowid;
  });

  const id = insert();
  return { id, token, otp, expiresAt };
}

export function consumePasswordReset(db, { token, otp, password }, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const pepper = options.pepper;
  if (!db || !pepper) return { ok: false, error: "password reset setup is incomplete" };
  if (!token || !otp) return { ok: false, error: "Invalid or expired reset code" };

  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, error: passwordError };

  const tokenHash = hashResetSecret(token, pepper);
  const otpHash = hashResetSecret(otp, pepper);
  const row = db.prepare(`
    SELECT id, user_id, expires_at, used_at
    FROM password_reset_tokens
    WHERE token_hash = ? AND otp_hash = ?
  `).get(tokenHash, otpHash);

  if (!row || row.used_at || row.expires_at <= now) {
    return { ok: false, error: "Invalid or expired reset code" };
  }

  const passwordHash = hashPassword(password);
  const update = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(now, row.id);
    db.prepare(`
      UPDATE password_reset_tokens
      SET used_at = ?
      WHERE user_id = ? AND used_at IS NULL
    `).run(now, row.user_id);
  });

  update();
  return { ok: true, userId: row.user_id };
}

export function findUserForPasswordReset(db, email) {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  return db.prepare(`
    SELECT u.id, u.username, up.email
    FROM user_profile up
    JOIN users u ON u.id = up.user_id
    WHERE LOWER(up.email) = ?
    LIMIT 1
  `).get(normalised);
}

export { RESET_TTL_SECONDS };
