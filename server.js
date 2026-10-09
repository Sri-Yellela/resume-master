// Resume Master — stateless résumé tools. See README.md and docs/API.md.
import fs from "node:fs";
import { createAnthropicClient } from "./src/model/anthropicCall.js";
import { createApp } from "./src/http/app.js";
import { loadAllPrompts } from "./src/generation/promptAssembler.js";
import { parseClientTokens } from "./src/http/auth.js";
import { createMetering, parseLimits, parseFreeLimits, parseAnonymousPolicy, createAnonymousLimiter } from "./src/http/metering.js";
import { openStore, resolveStorePath } from "./src/store/db.js";
import { configureStoreBackups, scheduleDailyBackups } from "./src/store/backups.js";
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
// D70 Phase 3: the SDK's automatic retries are capped at one (MODEL_MAX_RETRIES, src/model/anthropicCall.js).
const anthropic = createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });

// Throws on a malformed entry: a typo that silently dropped a client would read, from the caller's
// side, exactly like a revoked token. Zero clients is allowed and FAILS CLOSED (503 auth_unconfigured).
const clients = parseClientTokens(process.env.RESUME_MASTER_CLIENT_TOKENS);

// A57/A65: the store is OPTIONAL. It opens on the Railway volume (RAILWAY_VOLUME_MOUNT_PATH), or at
// RM_DB_PATH when that override is set. With neither, the service runs as before and every account
// route answers 503 accounts_unconfigured — a deploy with no volume can never create accounts that
// vanish at the next restart. With a store, draft's backup policy runs against it daily (never at boot).
const storePath = resolveStorePath(process.env);
const store = storePath ? openStore(storePath) : null;
if (store) {
  purgeExpired(store);
  setInterval(() => { try { purgeExpired(store); } catch { /* next hour */ } }, 3600_000).unref();
  configureStoreBackups(storePath);
  scheduleDailyBackups();
}

const port = Number(process.env.PORT) || 3100;
// A55: per-client daily limits on model-backed calls — OFF unless RM_LIMITS_PER_DAY is set.
const limits = parseLimits(process.env.RM_LIMITS_PER_DAY);
// D21: per-client daily caps on the FREE routes and MCP tool calls — OFF unless RM_FREE_LIMITS_PER_DAY is set.
const freeLimits = parseFreeLimits(process.env.RM_FREE_LIMITS_PER_DAY);
// D21: anonymous /mcp — ON only when RM_MCP_ANONYMOUS sets all three caps; a partial value refuses to boot.
const anonymousPolicy = parseAnonymousPolicy(process.env.RM_MCP_ANONYMOUS);
const anonymous = createAnonymousLimiter(anonymousPolicy);
const metering = createMetering({ log: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })), limits, freeLimits });
createApp({ anthropic, version, clients, store, metering, anonymous, siteOptions: { backups: !!store } }).listen(port, () => {
  // Client IDS only — never a hash, never a token.
  console.log(JSON.stringify({ t: new Date().toISOString(), boot: "listening", port, model: !!anthropic,
    clients: [...clients.keys()], accounts: !!store, backups: store ? "daily 02:00 UTC" : "off", limits: metering.limitsEnabled ? Object.fromEntries(limits) : "off",
    freeLimits: metering.freeLimitsEnabled ? Object.fromEntries(freeLimits) : "off", mcpAnonymous: anonymousPolicy ?? "off" }));
});
