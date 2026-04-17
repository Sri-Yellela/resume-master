import bcrypt from "bcryptjs";
import crypto from "crypto";

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "password must be at least 8 characters";
  }
  return null;
}

export function hashPassword(password) {
  const error = validatePassword(password);
  if (error) throw new Error(error);
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, passwordHash) {
  if (typeof password !== "string" || typeof passwordHash !== "string") return false;
  return bcrypt.compareSync(password, passwordHash);
}

export function hashResetSecret(secret, pepper) {
  return crypto
    .createHmac("sha256", pepper)
    .update(String(secret))
    .digest("hex");
}
