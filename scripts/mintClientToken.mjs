#!/usr/bin/env node
// Mint a service token for one client.
//
//   node scripts/mintClientToken.mjs draft
//
// Prints two things, ONCE:
//   1. the TOKEN — goes into the CALLER's environment (draft: RESUME_MASTER_TOKEN) and nowhere else
//   2. the ENTRY — `clientId:sha256hex`, appended to this service's RESUME_MASTER_CLIENT_TOKENS
//
// This service never sees the token again; it cannot re-display one. Lost token = mint a new one,
// add its entry, move the caller over, delete the old entry. Revoke = delete the entry and restart.
import { mintToken } from "../src/http/auth.js";

const clientId = process.argv[2];
if (!clientId) {
  console.error("usage: node scripts/mintClientToken.mjs <clientId>   e.g. draft");
  process.exit(2);
}
const { token, entry } = mintToken(clientId);
console.log(`token (caller's env only, shown once):\n  ${token}\n`);
console.log(`entry (append to RESUME_MASTER_CLIENT_TOKENS, comma-separated):\n  ${entry}`);
