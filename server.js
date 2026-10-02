// Resume Master — stateless résumé tools. See README.md and docs/API.md.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./src/http/app.js";
import { loadAllPrompts } from "./src/generation/promptAssembler.js";
import { parseClientTokens } from "./src/http/auth.js";
import { openStore } from "./src/store/db.js";
import { purgeExpired } from "./src/accounts/artifacts.js";

loadAllPrompts();

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const scorer = JSON.parse(fs.readFileSync(new URL("./vendor/ats-scorer/package.json", import.meta.url), "utf8"));
const version = {
  version: pkg.version,
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
  scorer: `${scorer.name}@${scorer.version}`,
  llmFormat: process.env.RESUME_MASTER_LLM_FORMAT === "1",
};

// No key is a supported state: the deterministic routes still serve, and model routes answer
// 503 model_unconfigured with retryable:false rather than pretending to be flaky.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Throws on a malformed entry: a typo that silently dropped a client would read, from the caller's
// side, exactly like a revoked token. Zero clients is allowed and FAILS CLOSED (503 auth_unconfigured).
const clients = parseClientTokens(process.env.RESUME_MASTER_CLIENT_TOKENS);

// A57: the store is OPTIONAL and explicit. Without RM_DB_PATH (a path on a persistent volume) the
// service runs as before and every account route answers 503 accounts_unconfigured — so a deploy
// with no volume can never create accounts that vanish at the next restart.
const store = process.env.RM_DB_PATH ? openStore(process.env.RM_DB_PATH) : null;
if (store) {
  purgeExpired(store);
  setInterval(() => { try { purgeExpired(store); } catch { /* next hour */ } }, 3600_000).unref();
}

const port = Number(process.env.PORT) || 3100;
createApp({ anthropic, version, clients, store }).listen(port, () => {
  // Client IDS only — never a hash, never a token.
  console.log(JSON.stringify({ t: new Date().toISOString(), boot: "listening", port, model: !!anthropic,
    clients: [...clients.keys()], accounts: !!store }));
});
