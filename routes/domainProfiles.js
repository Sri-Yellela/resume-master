// routes/domainProfiles.js — Domain profile CRUD + chip generation
import { Router }    from "express";
import Anthropic     from "@anthropic-ai/sdk";
import fs            from "fs";
import path          from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load registry once at startup
let _registry = null;
function getRegistry() {
  if (!_registry) {
    try {
      const p = path.join(__dirname, "..", "data", "DOMAIN_METADATA_REGISTRY.json");
      _registry = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { _registry = {}; }
  }
  return _registry;
}

export function createDomainProfilesRouter(db, anthropic) {
  const router = Router();

  // ── GET /api/domain-profiles ──────────────────────────────────
  // Returns all profiles for the authenticated user.
  router.get("/", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM domain_profiles WHERE user_id = ? ORDER BY is_active DESC, created_at ASC
    `).all(req.user.id);
    res.json(rows.map(r => ({
      ...r,
      target_titles:      JSON.parse(r.target_titles      || "[]"),
      selected_keywords:  JSON.parse(r.selected_keywords  || "[]"),
      selected_verbs:     JSON.parse(r.selected_verbs     || "[]"),
      selected_tools:     JSON.parse(r.selected_tools     || "[]"),
    })));
  });

  // ── POST /api/domain-profiles ─────────────────────────────────
  // Create a new profile. Max 4 per user. First profile is set active.
  router.post("/", (req, res) => {
    const { profile_name, role_family, domain, seniority,
            target_titles, selected_keywords, selected_verbs, selected_tools } = req.body;
    if (!profile_name || !role_family || !domain || !seniority) {
      return res.status(400).json({ error: "profile_name, role_family, domain, seniority required" });
    }
    const existing = db.prepare("SELECT COUNT(*) as c FROM domain_profiles WHERE user_id=?").get(req.user.id);
    if (existing.c >= 4) {
      return res.status(400).json({ error: "Maximum 4 profiles allowed per user" });
    }
    const isFirst = existing.c === 0 ? 1 : 0;

    const result = db.prepare(`
      INSERT INTO domain_profiles
        (user_id, profile_name, role_family, domain, seniority,
         target_titles, selected_keywords, selected_verbs, selected_tools, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, profile_name, role_family, domain, seniority,
      JSON.stringify(target_titles     || []),
      JSON.stringify(selected_keywords || []),
      JSON.stringify(selected_verbs    || []),
      JSON.stringify(selected_tools    || []),
      isFirst,
    );

    // Mark onboarding complete (first profile creation)
    db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(req.user.id);

    const row = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(result.lastInsertRowid);
    res.json({
      ...row,
      target_titles:     JSON.parse(row.target_titles     || "[]"),
      selected_keywords: JSON.parse(row.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(row.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(row.selected_tools    || "[]"),
    });
  });

  // ── PUT /api/domain-profiles/:id ──────────────────────────────
  // Update a profile. Must belong to req.user.id.
  router.put("/:id", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const allowed = ["profile_name","role_family","domain","seniority",
                     "target_titles","selected_keywords","selected_verbs","selected_tools"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: "No fields to update" });

    // JSON-encode array fields
    for (const arrKey of ["target_titles","selected_keywords","selected_verbs","selected_tools"]) {
      if (updates[arrKey] !== undefined) updates[arrKey] = JSON.stringify(updates[arrKey]);
    }

    const set  = Object.keys(updates).map(k => `${k}=?`).join(",");
    const vals = Object.values(updates);
    db.prepare(`UPDATE domain_profiles SET ${set}, updated_at=unixepoch() WHERE id=? AND user_id=?`)
      .run(...vals, req.params.id, req.user.id);

    const updated = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(req.params.id);
    res.json({
      ...updated,
      target_titles:     JSON.parse(updated.target_titles     || "[]"),
      selected_keywords: JSON.parse(updated.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(updated.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(updated.selected_tools    || "[]"),
    });
  });

  // ── DELETE /api/domain-profiles/:id ──────────────────────────
  // Delete a profile. Cannot delete if it is the only profile.
  router.delete("/:id", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const count = db.prepare("SELECT COUNT(*) as c FROM domain_profiles WHERE user_id=?").get(req.user.id).c;
    if (count <= 1) return res.status(400).json({ error: "Cannot delete your only profile" });

    db.prepare("DELETE FROM domain_profiles WHERE id=? AND user_id=?").run(req.params.id, req.user.id);

    // If deleted profile was active, activate the next one
    if (profile.is_active) {
      const next = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? ORDER BY created_at ASC LIMIT 1")
        .get(req.user.id);
      if (next) db.prepare("UPDATE domain_profiles SET is_active=1 WHERE id=?").run(next.id);
    }
    res.json({ ok: true });
  });

  // ── POST /api/domain-profiles/:id/activate ────────────────────
  // Set this profile as active; deactivate all others for this user.
  router.post("/:id/activate", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    db.prepare("UPDATE domain_profiles SET is_active=0 WHERE user_id=?").run(req.user.id);
    db.prepare("UPDATE domain_profiles SET is_active=1, updated_at=unixepoch() WHERE id=?").run(req.params.id);

    const updated = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(req.params.id);
    res.json({
      ...updated,
      target_titles:     JSON.parse(updated.target_titles     || "[]"),
      selected_keywords: JSON.parse(updated.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(updated.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(updated.selected_tools    || "[]"),
    });
  });

  // ── GET /api/domain-metadata/:domain ─────────────────────────
  // Returns chip arrays for a domain key. Public — no auth.
  router.get("/metadata/:domain", (req, res) => {
    const registry = getRegistry();
    const entry = registry[req.params.domain];
    if (!entry) return res.status(404).json({ error: "Domain not found" });
    res.json(entry);
  });

  // ── GET /api/domain-metadata (list all) ──────────────────────
  router.get("/metadata", (_req, res) => {
    const registry = getRegistry();
    // Return lightweight list (no chip arrays) for domain picker
    res.json(Object.entries(registry).map(([key, v]) => ({
      key,
      label:           v.label,
      roleFamily:      v.roleFamily,
      exampleTitles:   v.suggestedTitles.slice(0, 4),
    })));
  });

  // ── POST /api/domain-profiles/generate-chips ─────────────────
  // Haiku call: suggest additional chips beyond the base registry set.
  router.post("/generate-chips", async (req, res) => {
    const { domain, roleFamily, existingKeywords = [], existingVerbs = [], existingTools = [] } = req.body;
    if (!domain || !roleFamily) return res.status(400).json({ error: "domain and roleFamily required" });

    const prompt = `You are a resume expert. Given the domain and role family below, suggest additional resume chips that are NOT already in the existing lists.

Domain: ${domain}
Role Family: ${roleFamily}

Existing keywords (do not repeat): ${existingKeywords.join(", ")}
Existing action verbs (do not repeat): ${existingVerbs.join(", ")}
Existing tools (do not repeat): ${existingTools.join(", ")}

Return ONLY valid JSON in this exact format — no markdown, no explanation:
{
  "keywords": ["keyword1", "keyword2", ...],
  "verbs": ["Verb1", "Verb2", ...],
  "tools": ["Tool1", "Tool2", ...]
}

Rules:
- keywords: exactly 10 short phrases (2-4 words each), domain-specific, not in existing list
- verbs: exactly 5 action verbs (Title Case), not in existing list
- tools: exactly 5 software tools or platforms, not in existing list`;

    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      res.json({
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        verbs:    Array.isArray(parsed.verbs)    ? parsed.verbs    : [],
        tools:    Array.isArray(parsed.tools)    ? parsed.tools    : [],
      });
    } catch(e) {
      res.status(500).json({ error: "Chip generation failed: " + e.message });
    }
  });

  return router;
}
