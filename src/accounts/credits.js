// ── The credit ledger (A57) — balance, debit on SUCCESS, refund, grant. Economics left blank. ───
//
// Owner, 10-02: build the ledger, leave the ECONOMICS blank. No price, no packs, no purchase path —
// credits are GRANTED only (a free monthly grant, and an admin grant), so nothing here makes the
// owner a trader. ⛔ ATS scoring and formatting are free and never touch this file; the gate is only
// on model-backed tools. ⛔ draft's service token is EXEMPT: credits apply to signed-in site users
// (session routes), never to an rmk_ client.
//
// ⛔ DEBIT ON SUCCESS, NEVER ON ATTEMPT. The balance is checked before the call (so a user with none
// is told before anything is spent), but the debit row is written only after the tool returned a
// result. An exhausted model balance, a withheld résumé (claim guard), a rejected PDF — none costs a
// credit. A refund exists for the case a person decides after the fact (admin, once per debit).
//
// ⚠ Every debit records what it was for (route) and what it cost in tokens, so the history can be
// re-priced if the price per call ever changes.
export function creditConfig(env = process.env) {
  const n = (k, d) => { const v = Number(env?.[k]); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d; };
  return {
    monthlyGrant: n("RM_MONTHLY_GRANT", 10),
    cost: {
      "resumes.generate": n("RM_COST_GENERATE", 1),
      "resumes.enhance": n("RM_COST_ENHANCE", 1),
      "resumes.parse-pdf": n("RM_COST_PARSE_PDF", 1),
    },
  };
}

export const period = (t = new Date()) => t.toISOString().slice(0, 7);   // "YYYY-MM", UTC

export function balance(db, userId) {
  return db.prepare("SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ?").pluck().get(userId);
}

/** The free monthly grant, once per user per calendar month (UTC). Idempotent by a unique index. */
export function ensureMonthlyGrant(db, userId, { env = process.env, when = new Date() } = {}) {
  const { monthlyGrant } = creditConfig(env);
  if (!monthlyGrant) return false;
  return db.prepare(`
    INSERT OR IGNORE INTO credit_ledger (user_id, delta, reason, period, note)
    VALUES (?, ?, 'monthly_grant', ?, 'free monthly grant')
  `).run(userId, monthlyGrant, period(when)).changes > 0;
}

/** Refused before any spend when the balance cannot cover the call. */
export function checkCanAfford(db, userId, route, env = process.env) {
  const cost = creditConfig(env).cost[route] ?? 1;
  const bal = balance(db, userId);
  return { ok: bal >= cost, cost, balance: bal };
}

/** Called ONLY after the tool returned. `usage` is the model call records the tool returned. */
export function debitOnSuccess(db, userId, route, usage = [], env = process.env) {
  const cost = creditConfig(env).cost[route] ?? 1;
  const sum = (k) => usage.reduce((n, u) => n + (Number(u?.[k]) || 0), 0);
  const id = db.prepare(`
    INSERT INTO credit_ledger (user_id, delta, reason, route, model_calls, input_tokens, output_tokens,
                               cache_read_input_tokens, cache_creation_input_tokens)
    VALUES (?, ?, 'debit', ?, ?, ?, ?, ?, ?)
  `).run(userId, -cost, route, usage.length, sum("input_tokens"), sum("output_tokens"),
         sum("cache_read_input_tokens"), sum("cache_creation_input_tokens")).lastInsertRowid;
  return { id, cost };
}

export function grant(db, userId, amount, note = "admin grant") {
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10000) throw new Error("amount must be a positive integer up to 10000");
  return db.prepare("INSERT INTO credit_ledger (user_id, delta, reason, note) VALUES (?, ?, 'admin_grant', ?)")
    .run(userId, amount, String(note).slice(0, 200)).lastInsertRowid;
}

/** Give one debit back, once. */
export function refund(db, debitId, note = "refund") {
  const d = db.prepare("SELECT * FROM credit_ledger WHERE id = ? AND reason = 'debit'").get(debitId);
  if (!d) return { ok: false, code: "not_a_debit" };
  try {
    const id = db.prepare("INSERT INTO credit_ledger (user_id, delta, reason, route, ref, note) VALUES (?, ?, 'refund', ?, ?, ?)")
      .run(d.user_id, -d.delta, d.route, d.id, String(note).slice(0, 200)).lastInsertRowid;
    return { ok: true, id, amount: -d.delta };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return { ok: false, code: "already_refunded" };
    throw e;
  }
}

export function ledgerFor(db, userId, limit = 50) {
  return db.prepare("SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit)
    .map(r => ({ id: r.id, delta: r.delta, reason: r.reason, route: r.route, period: r.period, note: r.note,
                 modelCalls: r.model_calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
                 at: r.created_at * 1000 }));
}

