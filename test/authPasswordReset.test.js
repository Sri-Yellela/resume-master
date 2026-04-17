import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../services/authSecurity.js";
import {
  createPasswordReset,
  consumePasswordReset,
  findUserForPasswordReset,
} from "../services/passwordResetService.js";

function setupDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE user_profile (
      user_id INTEGER PRIMARY KEY,
      email TEXT
    );
    CREATE TABLE password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      otp_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      requested_at INTEGER NOT NULL,
      request_ip TEXT,
      user_agent TEXT
    );
  `);
  db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(1, "casey", hashPassword("SecretCase1"));
  db.prepare("INSERT INTO user_profile VALUES (?, ?)").run(1, "Casey@example.com");
  return db;
}

test("password verification is case-sensitive", () => {
  const hash = hashPassword("CorrectHorse1");
  assert.equal(verifyPassword("CorrectHorse1", hash), true);
  assert.equal(verifyPassword("correcthorse1", hash), false);
  assert.equal(verifyPassword("CORRECTHORSE1", hash), false);
});

test("password reset consumes a matching token and OTP once", () => {
  const db = setupDb();
  const user = findUserForPasswordReset(db, "casey@example.com");
  const reset = createPasswordReset(db, user, { pepper: "test-secret", now: 100 });

  const result = consumePasswordReset(db, {
    token: reset.token,
    otp: reset.otp,
    password: "NewSecret1",
  }, { pepper: "test-secret", now: 120 });

  assert.equal(result.ok, true);
  const row = db.prepare("SELECT password_hash FROM users WHERE id=1").get();
  assert.equal(verifyPassword("NewSecret1", row.password_hash), true);
  assert.equal(verifyPassword("newsecret1", row.password_hash), false);

  const reused = consumePasswordReset(db, {
    token: reset.token,
    otp: reset.otp,
    password: "AnotherSecret1",
  }, { pepper: "test-secret", now: 121 });
  assert.equal(reused.ok, false);
});

test("password reset rejects expired and wrong-code attempts", () => {
  const db = setupDb();
  const user = findUserForPasswordReset(db, "CASEY@example.com");
  const reset = createPasswordReset(db, user, { pepper: "test-secret", now: 100, ttlSeconds: 10 });

  const wrongOtp = consumePasswordReset(db, {
    token: reset.token,
    otp: "000000",
    password: "NewSecret1",
  }, { pepper: "test-secret", now: 105 });
  assert.equal(wrongOtp.ok, false);

  const expired = consumePasswordReset(db, {
    token: reset.token,
    otp: reset.otp,
    password: "NewSecret1",
  }, { pepper: "test-secret", now: 111 });
  assert.equal(expired.ok, false);

  const row = db.prepare("SELECT password_hash FROM users WHERE id=1").get();
  assert.equal(verifyPassword("SecretCase1", row.password_hash), true);
});
