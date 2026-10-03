// ── The site's routes (A54 + A57): accounts, credits, opt-in storage, and the tools for a person ──
//
// Two kinds of caller, kept apart:
//   · /v1/… and /mcp — service-token clients (draft, an MCP host). Unchanged: stateless, no credits
//     (draft's token is EXEMPT by decision), nothing stored. See src/http/app.js.
//   · /v1/site/… — a PERSON on resumemaster.one, signed in with a session cookie or anonymous.
//
// What a person may run (A54's "decide per tool what an anonymous visitor may run, and bound it"):
//   ATS score, format          free, unlimited, ANONYMOUS — zero model calls (owner: ATS stays free,
//                              unlimited and ungated). Bounded only against abuse: a per-IP rate and
//                              a 2 MB body.
//   PDF → text                 free, ANONYMOUS — A70 (owner, 10-02). It used to send the PDF to Sonnet
//                              and cost a credit; it now reads the PDF's own text layer
//                              (vendor/pdf-toolkit/src/pdfText.js), zero model calls, so nothing to meter.
//                              Bounded: the per-IP rate, a 15 MB body, and a per-IP DAILY ceiling
//                              (RM_PDF_TEXT_PER_DAY, default 100) — free is not unbounded. A scan (no text
//                              layer) is answered needsOcr, never charged and never sent to a model.
//                              ⛔ test/pdfTextA70.test.js fails if this route is put back behind paid().
//                              The TOKEN API's /v1/resumes/parse-pdf is unchanged (model-backed) — draft's
//                              résumé upload uses it; moving it is the owner's call (O16e).
//   generate, enhance          signed in, one credit each, DEBITED ON SUCCESS (src/accounts/credits.js).
//
// ⛔ Cross-site writes are refused: every state-changing request must carry X-RM-Client: web, which a
// form on another site cannot send without a CORS preflight this service never grants.
// ⛔ No payload is logged here either — the app's request log line is the only log.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountError, signUp, signIn, createSession, userForSession, endSession, publicUser,
  startPasswordReset, finishPasswordReset, exportAccount, deleteAccount, SESSION_DAYS,
} from "../accounts/accounts.js";
import {
  balance, ensureMonthlyGrant, checkCanAfford, debitOnSuccess, grant, refund, ledgerFor, creditConfig,
} from "../accounts/credits.js";
import { saveArtifact, listArtifacts, getArtifact, deleteArtifact, setPinned, retentionDays, MAX_PINNED_PER_USER } from "../accounts/artifacts.js";
import { listBackups, runBackup } from "../store/backups.js";
import { sendResetEmail, emailConfigured } from "../accounts/email.js";
import { generateResume } from "../generation/generate.js";
import { enhanceResume } from "../generation/enhance.js";
import { extractPdfText } from "../parsing/extractPdfText.js";
import { scoreAts, formatResume, atsOutcome } from "../tools/deterministic.js";

const COOKIE = "rm_session";
const PRIVACY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "PRIVACY.md");

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Per-key count per UTC day, in memory (one process) — the free PDF reader's ceiling (A70). */
export function createDailyLimiter({ perDay = 100, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (key) => {
    const d = Math.floor(now() / 86400000);
    const e = hits.get(key);
    if (!e || e.d !== d) { hits.set(key, { d, n: 1 }); if (hits.size > 10000) hits.clear(); return perDay > 0; }
    e.n++;
    return e.n <= perDay;
  };
}

/** A small per-key fixed-window limiter, in memory (one process). */
export function createRateLimiter({ perMinute = 30, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (key) => {
    const t = now(), w = Math.floor(t / 60000);
    const e = hits.get(key);
    if (!e || e.w !== w) { hits.set(key, { w, n: 1 }); if (hits.size > 10000) hits.clear(); return true; }
    e.n++;
    return e.n <= perMinute;
  };
}

export function siteRoutes({ store, anthropic = null, env = process.env, metering, sendEmail = sendResetEmail,
                             publicLimiter = createRateLimiter({ perMinute: Number(env.RM_PUBLIC_RATE_PER_MIN) || 30 }),
                             pdfDailyLimiter = createDailyLimiter({ perDay: env.RM_PDF_TEXT_PER_DAY != null && env.RM_PDF_TEXT_PER_DAY !== ""
                               ? Number(env.RM_PDF_TEXT_PER_DAY) : 100 }),
                             backups = null }) {
  const r = express.Router();
  const small = express.json({ limit: "2mb" });
  const big = express.json({ limit: "15mb" });
  const admins = new Set(String(env.RM_ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean));

  const fail = (res, status, error, message, extra = {}) => res.status(status).json({ error, message, ...extra });
  const needStore = (req, res, next) => (store ? next()
    : fail(res, 503, "accounts_unconfigured", "Accounts are not switched on for this deployment yet. The free tools still work."));
  const writeGuard = (req, res, next) => (req.get("x-rm-client") === "web" ? next()
    : fail(res, 403, "cross_site_refused", "This request must come from the Resume Master site."));
  const withUser = (req, _res, next) => {
    req.user = store ? userForSession(store, readCookie(req, COOKIE)) : null;
    if (req.user) ensureMonthlyGrant(store, req.user.id, { env });
    next();
  };
  const requireUser = (req, res, next) => (req.user ? next() : fail(res, 401, "signed_out", "Sign in to use this tool."));
  const setSession = (req, res, token) => {
    const secure = req.secure || env.RM_COOKIE_SECURE === "1";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
  };
  const clearSession = (res) => res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  const accountBody = (u) => ({ user: publicUser(u), balance: balance(store, u.id), monthlyGrant: creditConfig(env).monthlyGrant,
                                costs: creditConfig(env).cost, retentionDays: retentionDays(env) });
  const handle = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof AccountError) return fail(res, e.status, e.code, e.message);
      next(e);
    }
  };

  r.use(withUser);

  // The privacy statement the site links to IS docs/PRIVACY.md — served, not copied, so the page and
  // the document cannot drift apart.
  r.get("/privacy", (_req, res) => {
    res.json({ markdown: fs.readFileSync(PRIVACY_FILE, "utf8") });
  });

  // ── what this deployment offers, for the page to render honestly ──────────────────────────────
  r.get("/config", (req, res) => res.json({
    accounts: !!store, signedIn: !!req.user, passwordReset: emailConfigured(env),
    model: !!anthropic, ...(req.user ? accountBody(req.user) : {}),
  }));

  // ── accounts ──────────────────────────────────────────────────────────────────────────────────
  r.post("/account/signup", needStore, writeGuard, small, handle((req, res) => {
    const u = signUp(store, req.body || {});
    ensureMonthlyGrant(store, u.id, { env });
    setSession(req, res, createSession(store, u.id));
    res.status(201).json(accountBody(u));
  }));
  r.post("/account/signin", needStore, writeGuard, small, handle((req, res) => {
    const u = signIn(store, req.body || {});
    ensureMonthlyGrant(store, u.id, { env });
    setSession(req, res, createSession(store, u.id));
    res.json(accountBody(u));
  }));
  r.post("/account/signout", needStore, writeGuard, (req, res) => {
    endSession(store, readCookie(req, COOKIE));
    clearSession(res);
    res.json({ ok: true });
  });
  r.get("/account", needStore, requireUser, (req, res) => res.json({ ...accountBody(req.user), ledger: ledgerFor(store, req.user.id) }));
  r.get("/account/export", needStore, requireUser, (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="resume-master-account.json"');
    res.json(exportAccount(store, req.user.id));
  });
  r.delete("/account", needStore, writeGuard, requireUser, small, handle((req, res) => {
    deleteAccount(store, req.user.id, req.body?.password);
    clearSession(res);
    res.json({ ok: true, message: "Your account, its credits and every saved document are deleted." });
  }));
  r.post("/account/password-reset", needStore, writeGuard, small, handle(async (req, res) => {
    if (!emailConfigured(env)) return fail(res, 503, "email_unconfigured", "Password reset by email is not switched on yet.");
    const started = startPasswordReset(store, req.body?.email);
    if (started) {
      const base = env.RM_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      await sendEmail({ to: started.user.email, resetUrl: `${base}/#reset=${started.token}` }, { env });
    }
    // The same answer whether or not the account exists.
    res.json({ ok: true, message: "If an account uses that email, a reset link is on its way." });
  }));
  r.post("/account/password-reset/confirm", needStore, writeGuard, small, handle((req, res) => {
    finishPasswordReset(store, req.body || {});
    res.json({ ok: true, message: "Password changed. Every session was signed out — sign in with the new password." });
  }));

  // ── saved documents (opt-in) ──────────────────────────────────────────────────────────────────
  r.get("/documents", needStore, requireUser, (req, res) => res.json({ documents: listArtifacts(store, req.user.id), retentionDays: retentionDays(env), maxPinned: MAX_PINNED_PER_USER }));
  r.get("/documents/:id", needStore, requireUser, (req, res) => {
    const a = getArtifact(store, req.user.id, req.params.id);
    if (!a) return fail(res, 404, "not_found", "No such document.");
    res.json({ id: a.id, kind: a.kind, title: a.title, content: a.content, pinned: !!a.pinned, createdAt: a.created_at * 1000, expiresAt: a.pinned ? null : a.expires_at * 1000 });
  });
  r.delete("/documents/:id", needStore, writeGuard, requireUser, (req, res) => {
    if (!deleteArtifact(store, req.user.id, req.params.id)) return fail(res, 404, "not_found", "No such document.");
    res.json({ ok: true, message: "Deleted." });
  });
  // A65: a pinned document is kept until it is unpinned or deleted; unpinning restarts its clock.
  r.post("/documents/:id/pin", needStore, writeGuard, requireUser, small, (req, res) => {
    const out = setPinned(store, req.user.id, req.params.id, req.body?.pinned !== false, env);
    if (out.code === "not_found") return fail(res, 404, "not_found", "No such document.");
    if (out.code === "too_many_pinned") return fail(res, 409, "too_many_pinned", `You can keep up to ${MAX_PINNED_PER_USER} documents pinned. Unpin one first.`);
    res.json(out);
  });

  // ── admin: grant and refund (granted credits only — no purchase path exists) ──────────────────
  const requireAdmin = (req, res, next) => (req.user && admins.has(req.user.email.toLowerCase()) ? next()
    : fail(res, 403, "not_admin", "Admins only."));
  r.post("/admin/credits/grant", needStore, writeGuard, requireAdmin, small, (req, res) => {
    const u = store.prepare("SELECT * FROM users WHERE email = ?").get(String(req.body?.email || ""));
    if (!u) return fail(res, 404, "not_found", "No account with that email.");
    try { grant(store, u.id, Number(req.body?.amount), req.body?.note || `granted by ${req.user.email}`); }
    catch (e) { return fail(res, 400, "invalid_amount", e.message); }
    res.json({ ok: true, balance: balance(store, u.id) });
  });
  r.post("/admin/credits/refund", needStore, writeGuard, requireAdmin, small, (req, res) => {
    const out = refund(store, Number(req.body?.ledgerId), req.body?.note || `refunded by ${req.user.email}`);
    if (!out.ok) return fail(res, 409, out.code, out.code === "already_refunded" ? "That debit was already refunded." : "That is not a debit.");
    res.json(out);
  });
  // A65: backups of the store — draft's policy. `backups` is set only when the store is on a volume.
  const needBackups = (req, res, next) => (backups ? next()
    : fail(res, 503, "backups_unconfigured", "Backups run only when the store is on a volume."));
  r.get("/admin/backups", needStore, requireAdmin, needBackups, (req, res) => res.json(listBackups()));
  r.post("/admin/backups", needStore, writeGuard, requireAdmin, needBackups, (req, res) => {
    const out = runBackup("admin");
    if (!out) return fail(res, 507, "backup_refused", "The backup was refused — the volume has no room. See the logs.");
    res.json({ ok: true, backup: { filename: out.filename, created: out.created } });
  });

  // ── the tools ─────────────────────────────────────────────────────────────────────────────────
  // Free tools: anonymous allowed. Signed-in users may ask to keep the result (store: true).
  const limited = (req, res, next) => (publicLimiter(req.ip) ? next()
    : fail(res, 429, "rate_limited", "Too many requests from this address — wait a minute.", { retryable: true }));
  const keep = (req, kind, title, content) => {
    if (req.body?.store !== true) return null;
    if (!req.user) return { stored: false, reason: "signed_out" };
    return saveArtifact(store, req.user.id, { kind, title, content }, env);
  };

  r.post("/tools/ats", limited, writeGuard, small, (req, res, next) => {
    try {
      const out = atsOutcome(scoreAts(req.body).report);
      metering?.record(req.user ? "site-user" : "site-anon", "ats.score", [], { via: "site" });
      res.json({ ...out, saved: keep(req, "ats_report", req.body?.job?.title, out) });
    } catch (e) { next(e); }
  });
  r.post("/tools/format", limited, writeGuard, small, (req, res, next) => {
    try {
      const out = formatResume(req.body);
      metering?.record(req.user ? "site-user" : "site-anon", "resumes.format", [], { via: "site" });
      res.json({ ...out, saved: keep(req, "formatted_resume", req.body?.title, out.html) });
    } catch (e) { next(e); }
  });

  // Model-backed: signed in, one credit, debited only once the tool returned a result.
  const paid = (route, run, kind, contentOf, titleOf) => [needStore, writeGuard, requireUser, big, async (req, res, next) => {
    const can = checkCanAfford(store, req.user.id, route, env);
    if (!can.ok) {
      return fail(res, 402, "insufficient_credits",
        `This uses ${can.cost} credit${can.cost === 1 ? "" : "s"} and you have ${can.balance}. Credits are granted monthly; nothing is sold yet.`,
        { balance: can.balance, cost: can.cost });
    }
    let out;
    try { out = await run(req); }
    catch (e) {
      // Nothing debited: a failure never costs a credit. The model usage is still metered.
      metering?.record("site-user", route, e.usageSoFar || (e.usage ? [e.usage] : []), { via: "site" });
      return next(e);
    }
    metering?.record("site-user", route, out.usage, { via: "site" });
    const debit = debitOnSuccess(store, req.user.id, route, out.usage, env);
    res.json({ ...out, credits: { charged: debit.cost, balance: balance(store, req.user.id) },
               saved: keep(req, kind, titleOf(req), contentOf(out)) });
  }];
  r.post("/tools/generate", ...paid("resumes.generate", req => generateResume(anthropic, req.body || {}, { env }),
    "generated_resume", out => out.html, req => req.body?.job?.title));
  r.post("/tools/enhance", ...paid("resumes.enhance", req => enhanceResume(anthropic, req.body || {}),
    "generated_resume", out => out.text, () => "Enhanced résumé"));
  // A70: free and anonymous — see the header. ⛔ Not paid(): nothing here calls a model.
  const pdfDaily = (req, res, next) => (pdfDailyLimiter(req.ip) ? next()
    : fail(res, 429, "daily_limit", "This address has read its PDFs for today — the reader is free, with a daily ceiling. Try again tomorrow.",
           { retryable: false }));
  r.post("/tools/parse-pdf", limited, pdfDaily, writeGuard, big, async (req, res, next) => {
    try {
      const out = await extractPdfText(req.body || {});
      metering?.record(req.user ? "site-user" : "site-anon", "resumes.pdf-text", [], { via: "site" });
      if (out.needsOcr) {
        return res.json({ ...out, message: "This PDF has no text to read — it looks like a scan or a picture of a résumé. "
          + "Reading scans (OCR) is not offered. Export the résumé from Word, Google Docs or your editor as a PDF and try that." });
      }
      res.json({ ...out, saved: keep(req, "pdf_text", req.body?.title || "Text from a PDF", out.text) });
    } catch (e) { next(e); }
  });

  return r;
}
