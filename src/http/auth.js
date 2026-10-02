// Per-client service tokens. Decided 2026-09-27.
//
// ⛔ EVERY CALLER HOLDS A TOKEN EXACTLY AS A THIRD PARTY WOULD — including draft, whose owner owns
// this service too. No shared cookie, no shared SESSION_SECRET, no copy of draft's environment.
// A seamless internal path would quietly turn two products back into one, and the API would be
// tested as an internal call wearing HTTP instead of as the API it is sold as.
//
// WHY NOT draft's token table. draft's extension and mobile tokens are sessionLess rows in draft's
// database, looked up per request. This service has no database, so the same SHAPE — a bearer
// secret, one per audience, revocable independently — is kept, and the storage is not:
//
//   · A token is `rmk_<clientId>.<secret>`, where <secret> is 32 random bytes, base64url.
//   · The service stores only sha256(token), in RESUME_MASTER_CLIENT_TOKENS:
//         "draft:<sha256hex>,acme:<sha256hex>"
//     A leaked environment therefore yields no usable token.
//   · REVOKE: delete the entry and restart. ROTATE: add the new hash beside the old one (a client may
//     hold several), move the caller over, then delete the old one — no window with no valid token.
//   · The token is minted by scripts/mintClientToken.mjs, printed once, and stored by the CALLER
//     in its own environment (draft: RESUME_MASTER_TOKEN). It is never logged here.
import crypto from "node:crypto";

export const CLIENT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const TOKEN_RE = /^rmk_([a-z][a-z0-9-]{1,31})\.([A-Za-z0-9_-]{43})$/;

export const hashToken = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

export function mintToken(clientId) {
  if (!CLIENT_ID_RE.test(clientId)) throw new Error(`client id must match ${CLIENT_ID_RE}`);
  const token = `rmk_${clientId}.${crypto.randomBytes(32).toString("base64url")}`;
  return { token, entry: `${clientId}:${hashToken(token)}` };
}

/**
 * Parses RESUME_MASTER_CLIENT_TOKENS into Map<clientId, Buffer[]>. A malformed entry THROWS at
 * boot: a typo that silently dropped a client would look, from the caller's side, like a revoked
 * token — and a service that boots with a broken key list is worse than one that refuses to boot.
 */
export function parseClientTokens(raw) {
  const clients = new Map();
  for (const part of String(raw || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z][a-z0-9-]{1,31}):([0-9a-f]{64})$/.exec(part);
    if (!m) throw new Error(`RESUME_MASTER_CLIENT_TOKENS: malformed entry near "${part.slice(0, 12)}…" — expected clientId:sha256hex`);
    if (!clients.has(m[1])) clients.set(m[1], []);
    clients.get(m[1]).push(Buffer.from(m[2], "hex"));
  }
  return clients;
}

/** Returns the client id the bearer token belongs to, or null. Constant-time over the hash. */
export function authenticate(clients, authorization) {
  const bearer = /^Bearer (\S+)$/.exec(String(authorization || ""));
  const m = bearer && TOKEN_RE.exec(bearer[1]);
  if (!m) return null;
  const hashes = clients.get(m[1]);
  if (!hashes?.length) return null;
  const presented = Buffer.from(hashToken(bearer[1]), "hex");
  let ok = false;
  for (const h of hashes) ok = crypto.timingSafeEqual(presented, h) || ok;   // no early exit
  return ok ? m[1] : null;
}

/** Express middleware. `clients` null/empty = no client configured: FAIL CLOSED, and say why. */
export function requireClient(clients) {
  return (req, res, next) => {
    if (!clients || clients.size === 0) {
      return res.status(503).json({ error: "auth_unconfigured", retryable: false,
        message: "no client tokens are configured on this service" });
    }
    const id = authenticate(clients, req.headers.authorization);
    // A55: a stranger must be able to act on this. It says what to send and how a token is got —
    // never which part of a presented token was wrong.
    if (!id) return res.status(401).json({ error: "unauthenticated", retryable: false,
      message: "Send Authorization: Bearer rmk_<client>.<secret>. API tokens are issued by the operator on request — " +
        "there is no self-serve API sign-up yet. The free tools (ATS check, formatting) need no token on the site, resumemaster.one." });
    req.client = { id };
    next();
  };
}
