import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * TASK AH1 — the guard on every /api route, enumerated, so a new one cannot skip it.
 *
 * WHY A MANIFEST AND NOT A SET OF SPOT CHECKS
 * scripts/ah1SessionIdentity.mjs proves cross-user access is denied on the endpoints IT NAMES.
 * That is the strong evidence, and it is also the weakness: a route added next month is not in its
 * list, so it is not checked, and nothing says so. FE-3 applied user scoping per endpoint for
 * tracked searches; whether that was universal or one-off was an open question in this task
 * precisely because no artefact recorded the answer for the whole surface.
 *
 * So this test enumerates every /api route from source and requires each one to appear in exactly
 * one of the three lists below. Add a route without classifying it and this test fails naming it.
 * That is the point: the failure is the design review.
 *
 * WHAT IT CAN AND CANNOT SEE
 * It reads guards, not behaviour — it cannot tell you a handler scoped its query correctly. The
 * harness does that. What this catches is the two mistakes a reviewer misses by eye: a route
 * mounted with NO guard at all, and a route whose guard is weaker than its siblings'.
 */

const SERVER = fs.readFileSync("server.js", "utf8");

// ── PUBLIC: reachable with no credential, deliberately ───────────────────────────────────────
// Every entry here is a decision. A route joins this list only if an unauthenticated stranger
// SHOULD be able to call it.
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/auth/me",                       // reports authenticated:false rather than 401 by design
  "POST /api/auth/login",
  "POST /api/auth/register",
  "POST /api/auth/logout",                  // signing out must work even with a half-dead credential
  "GET /api/auth/oauth/status",
  "POST /api/auth/provider/:provider",
  "POST /api/auth/password-reset/request",
  "POST /api/auth/password-reset/confirm",
  "GET /api/domain-metadata",
  "GET /api/domain-metadata/:key",
  "POST /api/contact",
  // The landing page's job feed. Deliberately anonymous: scraped_jobs is a GLOBAL pool of public
  // postings with no user column, the query is capped at 20 rows a page, and the page it feeds is
  // reachable without an account. Nothing user-scoped is in scope for it to leak.
  "GET /api/jobs/generic",
  // Standalone tool pages: a separate, deliberately anonymous surface with its own
  // standalone_users table and its own rate limiting. Not the signed-in application.
  "POST /api/standalone/auth/google",
  "POST /api/standalone/auth/email-otp/send",
  "POST /api/standalone/auth/phone-otp/send",
  "POST /api/standalone/auth/otp/verify",
  "GET /api/standalone/auth/me",
  "POST /api/standalone/auth/logout",
  "POST /api/standalone/ats",
  "POST /api/standalone/generate",
  "POST /api/standalone/apply",
]);

// ── ADMIN: requires an admin session ─────────────────────────────────────────────────────────
const ADMIN = new Set([
  "GET /api/admin/backups",
  "POST /api/admin/backups",
  "POST /api/admin/backups/restore",
  "GET /api/admin/users",
  "POST /api/admin/users",
  "DELETE /api/admin/users/:id",
  "PATCH /api/admin/users/:id/password",
  "PATCH /api/admin/users/:id/plan",
  "GET /api/admin/users/:id/profile",
  "GET /api/admin/users/:id/applications",
  "GET /api/admin/upgrade-requests",
  "PATCH /api/admin/upgrade-requests/:id/grant",
  "GET /api/admin/domain-profile-requests",
  "PATCH /api/admin/domain-profile-requests/:id/status",
  "GET /api/admin/contact-messages",
  "PATCH /api/admin/contact-messages/:id/read",
  "POST /api/company-kb/:company/org-units/:orgUnit/confirm",
]);

// ── AUTHENTICATED: requires a signed-in session, any role ────────────────────────────────────
const AUTHENTICATED = new Set([
  "GET /api/auth/extension-token",
  "POST /api/auth/revoke-extension-token",
  "GET /api/auth/active-profile",
  "PATCH /api/auth/complete-profile",
  "GET /api/sync/events",
  "GET /api/notifications",
  "PATCH /api/notifications/read-all",
  "PATCH /api/notifications/:id/read",
  "GET /api/dock-preferences",
  "PUT /api/dock-preferences",
  "PATCH /api/settings/apply-mode",
  "PATCH /api/settings/apify-token",
  "DELETE /api/settings/apify-token",
  "GET /api/settings",
  "GET /api/integrations/status",
  "PATCH /api/integrations/apify-token",
  "DELETE /api/integrations/apify-token",
  "POST /api/integrations/:provider",
  "DELETE /api/integrations/:provider",
  "GET /api/plans",
  "POST /api/plans/request-upgrade",
  "GET /api/profile",
  "POST /api/profile",
  "PATCH /api/profile/skills",
  "GET /api/autofill",
  "GET /api/extension/autofill",
  "GET /api/company/:company",
  "POST /api/company/:company/consistency-check",
  "GET /api/categories",
  "GET /api/jobs",
  "GET /api/jobs/facets",
  "GET /api/jobs/suggest",
  "GET /api/jobs/pending",
  "GET /api/jobs/poll",
  "POST /api/jobs/search",
  "PATCH /api/jobs/interact",
  "PATCH /api/jobs/:id/visited",
  "PATCH /api/jobs/:id/starred",
  "PATCH /api/jobs/:id/disliked",
  "GET /api/jobs/:id/recruiter",
  "POST /api/jobs/:id/keywords",
  "POST /api/scrape",
  "POST /api/smart-search",
  "GET /api/base-resume",
  "POST /api/base-resume",
  "GET /api/base-resume/enhance-status",
  "POST /api/base-resume/enhance",
  "PATCH /api/base-resume/adopt-enhanced",
  "GET /api/domain-profiles/:id/enhance-status",
  "POST /api/domain-profiles/:id/enhance",
  "PATCH /api/domain-profiles/:id/adopt-enhanced",
  "GET /api/simple-apply/profile",
  "POST /api/simple-apply/profile/refresh",
  "POST /api/parse-pdf",
  "POST /api/generate",
  "POST /api/export-pdf",
  "GET /api/export/excel",
  "GET /api/history",
  "GET /api/resumes",
  "GET /api/resumes/:jobId",
  "DELETE /api/resumes/:jobId",
  "GET /api/resumes/:jobId/versions",
  "GET /api/resumes/:jobId/pdf",
  "POST /api/resumes/:jobId/html",
  "POST /api/resumes/:jobId/keep",
  "GET /api/applications",
  "POST /api/applications",
  "PATCH /api/applications/:jobId",
  "DELETE /api/applications/:jobId",
  "POST /api/cover-letter/generate",
  "GET /api/debug/verify-isolation",
  // Mounted routers, guarded at the mount
  "POST /api/import/job",
  "GET /api/company-kb/:company/org-units",
  "GET /api/company-kb/:company/form-schemas",
  "GET /api/company-kb/:company/lca",
  "GET /api/company-kb/:company/hiring-signals",
  "GET /api/domain-profiles/",
  "POST /api/domain-profiles/",
  "POST /api/domain-profiles/requests",
  "PUT /api/domain-profiles/:id",
  "DELETE /api/domain-profiles/:id",
  "POST /api/domain-profiles/:id/activate",
  "GET /api/domain-profiles/:id/base-resume",
  "POST /api/domain-profiles/:id/base-resume",
  "GET /api/domain-profiles/:id/signals",
  "POST /api/domain-profiles/:id/signals/refresh",
  "PUT /api/domain-profiles/:id/signals",
  "GET /api/domain-profiles/:id/suggestions",
  "PUT /api/domain-profiles/:id/suggestions",
  "POST /api/domain-profiles/:id/suggestions",
  "POST /api/domain-profiles/:id/claims",
  "GET /api/domain-profiles/:id/enhancement-history",
  "GET /api/domain-profiles/:id/tracked-search",
  "PUT /api/domain-profiles/:id/tracked-search",
  "GET /api/domain-profiles/metadata/:domain",
  "GET /api/domain-profiles/metadata",
  "POST /api/domain-profiles/generate-chips",
  // routes/apply.js — every one of these is mounted with requireAuth
  "POST /api/apply",
  "GET /api/apply/status/:jobId",
  "GET /api/apply/applications",
  "GET /api/apply/readiness",
  "POST /api/apply/runs",
  "GET /api/apply/runs",
  "GET /api/apply/runs/:runId",
  "GET /api/apply/review",
  "GET /api/apply/run-jobs/:runJobId/review",
  "GET /api/apply/run-jobs/:runJobId/resume",
  "GET /api/apply/run-jobs/:runJobId/screenshot",
  "POST /api/apply/run-jobs/:runJobId/abort",
  "DELETE /api/apply/run-jobs/:runJobId",
  "GET /api/apply/history",
  "GET /api/apply/history/months/:month",
  "GET /api/apply/gate-packets",
  "POST /api/apply/gate-packets/:packetId/token",
  "POST /api/apply/gate-packets/:packetId/reopen",
  "POST /api/apply/gate-packet/exchange",
  "GET /api/apply/form-schema",
  "POST /api/apply/form-schema",
  "GET /api/apply/form-schema/consent",
  "POST /api/apply/form-schema/consent",
  "POST /api/apply/gate-review",
  "GET /api/apply/pending",
  "POST /api/apply/approve",
  "POST /api/apply/reject",
  "GET /api/apply/questions",
  "POST /api/apply/answers",
  "POST /api/apply/close/:jobId",
  "POST /api/apply/session/save",
  "GET /api/apply/session/:domain",
]);

// Routers whose every route is admin-gated INSIDE the router rather than at the mount. Enumerating
// their individual paths here would duplicate two large files; what matters is the invariant that
// not one route in them is reachable without requireAdmin, which is asserted directly below.
const INTERNALLY_ADMIN_GATED = {
  "routes/admin.js": "/api/admin/analytics",
  "routes/adminDb.js": "/api/admin/db",
};

// ── enumeration ──────────────────────────────────────────────────────────────────────────────
const METHODS = "get|post|put|patch|delete";

// app.get("/api/...", guard, handler) — server.js and routes/apply.js, which takes `app`.
function directRoutes(source) {
  const found = [];
  const re = new RegExp(`\\bapp\\.(${METHODS})\\(\\s*"(/api/[^"]*)"\\s*(,\\s*[A-Za-z_$][\\w$]*)?`, "g");
  for (const m of source.matchAll(re)) {
    found.push({ method: m[1].toUpperCase(), path: m[2], guard: (m[3] || "").replace(/[,\s]/g, "") || null });
  }
  return found;
}

// router.get("/sub", guard, handler) inside a router file, composed with its mount prefix.
function routerRoutes(source, prefix) {
  const found = [];
  const re = new RegExp(`\\brouter\\.(${METHODS})\\(\\s*"([^"]*)"\\s*(,\\s*[A-Za-z_$][\\w$]*)?`, "g");
  for (const m of source.matchAll(re)) {
    found.push({
      method: m[1].toUpperCase(),
      path: prefix + m[2],
      guard: (m[3] || "").replace(/[,\s]/g, "") || null,
    });
  }
  return found;
}

// app.use("/prefix", requireAuth, createXRouter(...)) — the guard applied at the mount.
function mountGuards(source) {
  const guards = new Map();
  const re = /\bapp\.use\(\s*"(\/api\/[^"]*)"\s*,\s*([A-Za-z_$][\w$]*)\s*,/g;
  for (const m of source.matchAll(re)) guards.set(m[1], m[2]);
  return guards;
}

function collect() {
  const mounts = mountGuards(SERVER);
  // A route's third argument is only a GUARD if it is one of these. `router.post("/job", async (...`
  // captures "async", and treating that as a guard would let an unguarded route look guarded — and,
  // worse, would suppress the mount-level fallback below. Normalise first, then fall back.
  const KNOWN = new Set(["requireAuth", "requireAdmin"]);
  const named = (g) => (KNOWN.has(g) ? g : null);
  const routes = [
    ...directRoutes(SERVER),
    ...directRoutes(fs.readFileSync("routes/apply.js", "utf8")),
    // account.js is mounted with app.use(createAccountRouter({...})) at the ROOT, so its routes
    // already carry their full /api path and their own per-route guard.
    ...routerRoutes(fs.readFileSync("routes/account.js", "utf8"), ""),
    ...routerRoutes(fs.readFileSync("routes/domainProfiles.js", "utf8"), "/api/domain-profiles")
      .map(r => ({ ...r, guard: named(r.guard) || mounts.get("/api/domain-profiles") })),
    ...routerRoutes(fs.readFileSync("routes/importJob.js", "utf8"), "/api/import")
      .map(r => ({ ...r, guard: named(r.guard) || mounts.get("/api/import") })),
    ...routerRoutes(fs.readFileSync("routes/companyKb.js", "utf8"), "/api/company-kb")
      .map(r => ({ ...r, guard: named(r.guard) || mounts.get("/api/company-kb") })),
  ];
  return routes.map(r => ({ ...r, guard: named(r.guard) }));
}

test("every /api route is classified — a new endpoint fails this test until it is", () => {
  const routes = collect();
  // A floor, not a target. If the enumeration regexes ever stop matching, `unclassified` goes empty
  // and every assertion below passes vacuously — which is the failure mode this guards.
  assert.ok(routes.length > 160, `only found ${routes.length} routes — the enumeration itself broke`);

  const classified = new Set([...PUBLIC, ...ADMIN, ...AUTHENTICATED]);
  const unclassified = [...new Set(routes.map(r => `${r.method} ${r.path}`))]
    .filter(key => !classified.has(key))
    .sort();

  assert.deepEqual(unclassified, [],
    "These /api routes are not in PUBLIC, ADMIN or AUTHENTICATED in this file. Decide which each " +
    "one is and add it. If it belongs in PUBLIC, say why in a comment — an unauthenticated route " +
    "is a decision, not a default:\n  " + unclassified.join("\n  "));
});

test("no route is classified that does not exist — the manifest cannot rot", () => {
  const live = new Set(collect().map(r => `${r.method} ${r.path}`));
  // Mounted-router entries whose prefix the enumeration composes are all live; a stale entry here
  // means a route was deleted and its classification left behind, which quietly weakens the first
  // test by shrinking what it can catch.
  const stale = [...new Set([...PUBLIC, ...ADMIN, ...AUTHENTICATED])].filter(k => !live.has(k)).sort();
  assert.deepEqual(stale, [], "Classified but no longer defined:\n  " + stale.join("\n  "));
});

test("every route classified AUTHENTICATED or ADMIN actually carries a guard", () => {
  const unguarded = collect()
    .filter(r => {
      const key = `${r.method} ${r.path}`;
      return (AUTHENTICATED.has(key) || ADMIN.has(key)) && !r.guard;
    })
    .map(r => `${r.method} ${r.path}`)
    .sort();
  assert.deepEqual(unguarded, [],
    "Classified as needing a session, but mounted with no requireAuth/requireAdmin:\n  " + unguarded.join("\n  "));
});

test("every route classified ADMIN is gated by requireAdmin, not merely requireAuth", () => {
  const weak = collect()
    .filter(r => ADMIN.has(`${r.method} ${r.path}`) && r.guard !== "requireAdmin")
    .map(r => `${r.method} ${r.path} (guard: ${r.guard})`)
    .sort();
  assert.deepEqual(weak, [], "Admin routes gated by something weaker than requireAdmin:\n  " + weak.join("\n  "));
});

test("every route classified PUBLIC really is mounted without a guard", () => {
  // The mirror of the test above, and the more important direction: a route sitting in PUBLIC that
  // has since gained requireAuth is harmless, but this catches the reverse mistake of moving a
  // route into PUBLIC by accident while it still needs a session.
  const guarded = collect()
    .filter(r => PUBLIC.has(`${r.method} ${r.path}`) && r.guard)
    .map(r => `${r.method} ${r.path} (${r.guard})`)
    .sort();
  assert.deepEqual(guarded, [],
    "In PUBLIC but guarded — move it to AUTHENTICATED/ADMIN so the manifest tells the truth:\n  " + guarded.join("\n  "));
});

test("the two internally-gated admin routers gate EVERY route with requireAdmin", () => {
  for (const [file, prefix] of Object.entries(INTERNALLY_ADMIN_GATED)) {
    const source = fs.readFileSync(file, "utf8");
    const routes = [...source.matchAll(new RegExp(`\\brouter\\.(${METHODS})\\(\\s*"([^"]*)"\\s*(,\\s*[A-Za-z_$][\\w$]*)?`, "g"))];
    assert.ok(routes.length > 5, `${file}: enumeration found only ${routes.length} routes`);
    const ungated = routes
      .filter(m => (m[3] || "").replace(/[,\s]/g, "") !== "requireAdmin")
      .map(m => `${m[1].toUpperCase()} ${prefix}${m[2]}`);
    assert.deepEqual(ungated, [], `${file} has routes not gated by requireAdmin:\n  ` + ungated.join("\n  "));
    // And the guard it uses must actually check isAdmin rather than merely existing.
    assert.match(source, /function requireAdmin[\s\S]{0,300}?isAdmin/);
  }
});

test("every authenticated route taking an id from the request derives the owner from the session", () => {
  // The shape this catches: `app.get("/api/jobs/:id/recruiter", requireAuth, (_req, res) => {` —
  // a handler that names its request `_req` to say it does not read it, on a route whose whole
  // input is an id supplied by the caller. Ownership then cannot be checked, because the only
  // thing that could establish it (req.user) was never consulted.
  const sources = {
    "server.js": SERVER,
    "routes/apply.js": fs.readFileSync("routes/apply.js", "utf8"),
    "routes/account.js": fs.readFileSync("routes/account.js", "utf8"),
    "routes/domainProfiles.js": fs.readFileSync("routes/domainProfiles.js", "utf8"),
  };
  const offenders = [];
  for (const [file, source] of Object.entries(sources)) {
    const re = new RegExp(`\\b(?:app|router)\\.(${METHODS})\\(\\s*"([^"]*:[^"]*)"([\\s\\S]{0,1400}?)\\n(?=(?:app|router|function|const)\\b|\\s{0,2}\\}\\);\\n)`, "g");
    for (const m of source.matchAll(re)) {
      const [, method, routePath, body] = m;
      // Ownership can be established directly (req.user) or by delegating to a helper that takes
      // the session and resolves the owned row — ownedRunJob(id, req.user.id) and the
      // enhance-status/enhance/adopt trio, all of which read req.user internally.
      if (!/req\.user|ownedRunJob|ownedProfile|getResumeRouteProfile|sendEnhanceStatus|enhanceProfileResume|adoptEnhancedProfileResume|requireAdmin/.test(body)) {
        offenders.push(`${file}: ${method.toUpperCase()} ${routePath}`);
      }
    }
  }
  // Known and reviewed: these take an id but own nothing user-scoped, so there is nothing to scope.
  const REVIEWED = new Set([
    "server.js: GET /api/domain-metadata/:key",                    // a static registry file
    "server.js: POST /api/auth/provider/:provider",                // pre-auth, by definition
    "routes/apply.js: GET /api/apply/session/:domain",             // returns {exists:false}, a stub
    "routes/domainProfiles.js: GET /metadata/:domain",             // the same static registry
    // Company KB, addressed by company NAME. company_* tables are a shared knowledge base with no
    // user column, so there is no owner to scope to; every signed-in user sees the same answer.
    "server.js: GET /api/company/:company",
    "server.js: POST /api/company/:company/consistency-check",
    // Stubs. Each responds with a fixed body and reads nothing at all: the recruiter surface is
    // {comingSoon:true}, and server-side PDF export is a 503 pointing at client-side print.
    "server.js: GET /api/jobs/:id/recruiter",
    "server.js: GET /api/resumes/:jobId/pdf",
  ]);
  const real = offenders.filter(o => !REVIEWED.has(o)).sort();
  assert.deepEqual(real, [],
    "These routes take an id from the caller and never read req.user, so they cannot be scoping to " +
    "the authenticated user:\n  " + real.join("\n  "));
});
