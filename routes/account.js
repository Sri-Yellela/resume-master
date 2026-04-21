import { Router } from "express";

const DEFAULT_DOCK_ITEMS = ["profile_switcher", "notifications", "quick_actions", "settings", "user_avatar"];

function saveIntegrationSecret(encryptSecret, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (!text || text === "{}") return { enc: null, iv: null, tag: null };
  return encryptSecret(text);
}

export function createAccountRouter({
  db,
  requireAuth,
  emitToUser,
  syncClients,
  buildAutofillPayload,
  requireModeEntitlement,
  normalisePlanTier,
  allowedModesForTier,
  canUseGenerate,
  canUseAPlusResume,
  nextPlan,
  getAutomationReadiness,
  oauthReadiness,
  probeBrowserAvailability,
  encryptSecret,
  INTEGRATION_PROVIDERS,
  publicIntegrationRow,
  providerColumnFor,
  INDUSTRY_CATEGORIES,
}) {
  const router = Router();

  router.patch("/api/auth/complete-profile", requireAuth, (req, res) => {
    db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(req.user.id);
    res.json({ ok: true });
  });

  router.get("/api/sync/events", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const userId = req.user.id;
    if (!syncClients.has(userId)) syncClients.set(userId, new Set());
    syncClients.get(userId).add(res);
    res.write('data: {"type":"connected"}\n\n');

    const heartbeat = setInterval(() => {
      try { res.write('data: {"type":"heartbeat"}\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 30000);

    req.on("close", () => {
      clearInterval(heartbeat);
      syncClients.get(userId)?.delete(res);
    });
  });

  router.get("/api/notifications", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT id, type, message, payload, read, created_at
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.user.id);
    const unreadCount = rows.filter(r => !r.read).length;
    res.json({ notifications: rows, unreadCount });
  });

  router.patch("/api/notifications/read-all", requireAuth, (req, res) => {
    db.prepare("UPDATE notifications SET read=1 WHERE user_id=?").run(req.user.id);
    res.json({ ok: true });
  });

  router.patch("/api/notifications/:id/read", requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    const row = db.prepare("SELECT id FROM notifications WHERE id=? AND user_id=?").get(id, req.user.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    db.prepare("UPDATE notifications SET read=1 WHERE id=?").run(id);
    res.json({ ok: true });
  });

  router.get("/api/dock-preferences", requireAuth, (req, res) => {
    const row = db.prepare("SELECT items_json, dock_enabled FROM dock_preferences WHERE user_id=?").get(req.user.id);
    if (!row) return res.json({ itemsOrder: DEFAULT_DOCK_ITEMS, dockEnabled: true });
    let itemsOrder;
    try { itemsOrder = JSON.parse(row.items_json); } catch { itemsOrder = DEFAULT_DOCK_ITEMS; }
    res.json({ itemsOrder, dockEnabled: !!row.dock_enabled });
  });

  router.put("/api/dock-preferences", requireAuth, (req, res) => {
    const VALID_KEYS = new Set(["profile_switcher", "notifications", "quick_actions", "settings", "user_avatar"]);
    let { itemsOrder, dockEnabled } = req.body;
    if (!Array.isArray(itemsOrder)) return res.status(400).json({ error: "itemsOrder must be array" });
    if (!itemsOrder.every(k => VALID_KEYS.has(k))) return res.status(400).json({ error: "Invalid item key" });
    itemsOrder = itemsOrder.filter(k => k !== "user_avatar");
    itemsOrder.push("user_avatar");
    if (!itemsOrder.includes("settings")) itemsOrder.splice(itemsOrder.length - 1, 0, "settings");
    db.prepare(`
      INSERT INTO dock_preferences (user_id, items_json, dock_enabled, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(user_id) DO UPDATE SET items_json=excluded.items_json,
        dock_enabled=excluded.dock_enabled, updated_at=excluded.updated_at
    `).run(req.user.id, JSON.stringify(itemsOrder), dockEnabled ? 1 : 0);
    res.json({ itemsOrder, dockEnabled: !!dockEnabled });
  });

  router.patch("/api/settings/apply-mode", requireAuth, (req, res) => {
    res.status(410).json({
      error: "Plans control tool access. The jobs console is shared for every user.",
    });
  });

  router.patch("/api/settings/apify-token", requireAuth, (req, res) => {
    const token = (req.body.token || "").trim() || null;
    db.prepare("UPDATE users SET apify_token=? WHERE id=?").run(token, req.user.id);
    res.json({ ok: true });
  });

  router.delete("/api/settings/apify-token", requireAuth, (req, res) => {
    db.prepare("UPDATE users SET apify_token=NULL WHERE id=?").run(req.user.id);
    res.json({ ok: true });
  });

  router.get("/api/settings", requireAuth, (req, res) => {
    const u = db.prepare("SELECT apply_mode,plan_tier,apify_token FROM users WHERE id=?").get(req.user.id);
    const planTier = normalisePlanTier(u?.plan_tier);
    res.json({
      applyMode: u?.apply_mode,
      planTier,
      allowedModes: allowedModesForTier(planTier),
      capabilities: {
        canUseGenerate: canUseGenerate(planTier),
        canUseAPlusResume: canUseAPlusResume(planTier),
      },
      hasApifyToken: !!u?.apify_token,
    });
  });

  router.get("/api/integrations/status", requireAuth, async (req, res) => {
    const browserStatus = await probeBrowserAvailability();
    res.json({
      ...getAutomationReadiness(db, req.user.id),
      oauth: oauthReadiness(req),
      browser: {
        available: browserStatus.available,
        reasonCode: browserStatus.reasonCode,
        source: browserStatus.source,
        requiredFor: ["apply_automation", "pdf_export"],
      },
    });
  });

  router.patch("/api/integrations/apify-token", requireAuth, (req, res) => {
    const token = (req.body.token || "").trim() || null;
    db.prepare("UPDATE users SET apify_token=? WHERE id=?").run(token, req.user.id);
    res.json({ ok: true, apify: getAutomationReadiness(db, req.user.id).apify, oauth: oauthReadiness(req) });
  });

  router.delete("/api/integrations/apify-token", requireAuth, (req, res) => {
    db.prepare("UPDATE users SET apify_token=NULL WHERE id=?").run(req.user.id);
    res.json({ ok: true, apify: getAutomationReadiness(db, req.user.id).apify, oauth: oauthReadiness(req) });
  });

  router.post("/api/integrations/:provider", requireAuth, (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!INTEGRATION_PROVIDERS.has(provider)) return res.status(400).json({ error: "Unsupported integration provider" });
    const accountEmail = String(req.body?.accountEmail || req.body?.email || "").trim() || null;
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(s => String(s || "").trim()).filter(Boolean) : [];
    const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};
    const providerUserId = String(req.body?.providerUserId || "").trim() || null;
    const status = ["connected", "missing_permissions", "expired"].includes(req.body?.status) ? req.body.status : "connected";
    const expiresAt = Number.isFinite(Number(req.body?.expiresAt)) ? Number(req.body.expiresAt) : null;
    const secret = req.body?.sessionState || req.body?.cookies || req.body?.token || null;
    const encrypted = saveIntegrationSecret(encryptSecret, secret);
    db.prepare(`
      INSERT INTO user_integrations
        (user_id, provider, account_email, status, scopes_json, metadata_json,
         provider_user_id, secret_enc, iv, auth_tag, expires_at, last_checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(user_id, provider) DO UPDATE SET
        account_email=excluded.account_email,
        status=excluded.status,
        scopes_json=excluded.scopes_json,
        metadata_json=excluded.metadata_json,
        provider_user_id=COALESCE(excluded.provider_user_id, user_integrations.provider_user_id),
        secret_enc=COALESCE(excluded.secret_enc, user_integrations.secret_enc),
        iv=COALESCE(excluded.iv, user_integrations.iv),
        auth_tag=COALESCE(excluded.auth_tag, user_integrations.auth_tag),
        expires_at=excluded.expires_at,
        last_checked_at=excluded.last_checked_at,
        updated_at=excluded.updated_at
    `).run(
      req.user.id, provider, accountEmail, status, JSON.stringify(scopes), JSON.stringify(metadata),
      providerUserId, encrypted.enc, encrypted.iv, encrypted.tag, expiresAt,
    );
    const row = db.prepare("SELECT * FROM user_integrations WHERE user_id=? AND provider=?").get(req.user.id, provider);
    res.json({
      ok: true,
      provider,
      integration: publicIntegrationRow(row),
      readiness: { ...getAutomationReadiness(db, req.user.id), oauth: oauthReadiness(req) },
    });
  });

  router.delete("/api/integrations/:provider", requireAuth, (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!INTEGRATION_PROVIDERS.has(provider)) return res.status(400).json({ error: "Unsupported integration provider" });
    db.prepare("DELETE FROM user_integrations WHERE user_id=? AND provider=?").run(req.user.id, provider);
    if (provider === "google" || provider === "linkedin") {
      db.prepare(`UPDATE users SET ${providerColumnFor(provider)}=NULL WHERE id=?`).run(req.user.id);
    }
    res.json({ ok: true, provider, readiness: { ...getAutomationReadiness(db, req.user.id), oauth: oauthReadiness(req) } });
  });

  router.get("/api/plans", requireAuth, (req, res) => {
    const row = db.prepare("SELECT plan_tier, apply_mode FROM users WHERE id=?").get(req.user.id);
    const planTier = normalisePlanTier(row?.plan_tier);
    const changeOptions = ["BASIC", "PLUS", "PRO"].filter(tier => tier !== planTier);
    const pending = db.prepare(`
      SELECT * FROM plan_upgrade_requests
      WHERE user_id=? AND status='pending'
      ORDER BY requested_at DESC LIMIT 1
    `).get(req.user.id);
    res.json({
      planTier,
      applyMode: row?.apply_mode,
      allowedModes: allowedModesForTier(planTier),
      capabilities: {
        canUseGenerate: canUseGenerate(planTier),
        canUseAPlusResume: canUseAPlusResume(planTier),
      },
      nextPlan: nextPlan(planTier),
      changeOptions,
      pendingRequest: pending || null,
    });
  });

  router.post("/api/plans/request-upgrade", requireAuth, (req, res) => {
    const row = db.prepare("SELECT plan_tier FROM users WHERE id=?").get(req.user.id);
    const current = normalisePlanTier(row?.plan_tier);
    const requested = normalisePlanTier(req.body?.requestedTier || nextPlan(current));
    if (requested === current) return res.status(400).json({ error: "Already on this plan" });
    const pending = db.prepare(`
      SELECT * FROM plan_upgrade_requests
      WHERE user_id=? AND status='pending'
      ORDER BY requested_at DESC LIMIT 1
    `).get(req.user.id);
    if (pending) return res.status(409).json({ error: "Plan change request already pending", pendingRequest: pending });
    try {
      db.prepare(`
        INSERT INTO plan_upgrade_requests (user_id, requested_tier, notes)
        VALUES (?, ?, ?)
      `).run(req.user.id, requested, req.body?.notes || null);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    emitToUser(req.user.id, { type: "plan_request_submitted", requestedTier: requested });
    res.json({ ok: true, requestedTier: requested });
  });

  router.get("/api/profile", requireAuth, (req, res) => {
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    res.json(db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {});
  });

  router.post("/api/profile", requireAuth, (req, res) => {
    const f = req.body;
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    db.prepare(`UPDATE user_profile SET
      full_name=?,email=?,phone=?,linkedin_url=?,github_url=?,location=?,
      address_line1=?,address_line2=?,city=?,state=?,zip=?,country=?,
      gender=?,ethnicity=?,veteran_status=?,disability_status=?,
      requires_sponsorship=?,has_clearance=?,clearance_level=?,
      visa_type=?,work_auth=?,updated_at=unixepoch() WHERE user_id=?`
    ).run(
      f.full_name || null, f.email || null, f.phone || null, f.linkedin_url || null, f.github_url || null, f.location || null,
      f.address_line1 || null, f.address_line2 || null, f.city || null, f.state || null, f.zip || null, f.country || "United States",
      f.gender || null, f.ethnicity || null, f.veteran_status || null, f.disability_status || null,
      f.requires_sponsorship ? 1 : 0, f.has_clearance ? 1 : 0, f.clearance_level || null,
      f.visa_type || null, f.work_auth || null, req.user.id
    );
    res.json({ ok: true });
  });

  router.get("/api/autofill", requireAuth, (req, res) => {
    if (!requireModeEntitlement(req, res)) return;
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {};
    res.json(buildAutofillPayload(profile, req.user.applyMode));
  });

  router.get("/api/extension/autofill", requireAuth, (req, res) => {
    if (!requireModeEntitlement(req, res)) return;
    db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").run(req.user.id);
    const profile = db.prepare("SELECT * FROM user_profile WHERE user_id=?").get(req.user.id) || {};
    res.json({ ok: true, mode: req.user.applyMode, ...buildAutofillPayload(profile, req.user.applyMode) });
  });

  router.get("/api/categories", requireAuth, (_req, res) => res.json(INDUSTRY_CATEGORIES));

  return router;
}
