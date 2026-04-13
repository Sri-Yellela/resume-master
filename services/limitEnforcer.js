// services/limitEnforcer.js
// PURPOSE: Check per-user limits before allowing metered operations.
// Returns { allowed: bool, reason: string, current: int, limit: int }
// TO CHANGE LIMIT LOGIC: edit checkLimit() below.
// TO ADD A NEW LIMITABLE OPERATION: add a case to LIMIT_MAP and call
//   checkLimit() in the relevant route.

const LIMIT_MAP = {
  resume_generate:  { daily: 'daily_resumes',     monthly: 'monthly_resumes' },
  ats_score:        { monthly: 'monthly_ats_scores' },
  job_scrape:       { daily: 'daily_job_scrapes',  monthly: 'monthly_job_scrapes' },
  pdf_export:       { monthly: 'monthly_pdf_exports' },
  apply_automation: { monthly: 'monthly_apply_runs' },
};

export function checkLimit(db, userId, eventType) {
  try {
    const limits = db.prepare('SELECT * FROM user_limits WHERE user_id = ?').get(userId);
    if (!limits) return { allowed: true };

    const map = LIMIT_MAP[eventType];
    if (!map) return { allowed: true };

    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400);
    const d = new Date();
    const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);

    // Daily limit check
    if (map.daily && limits[map.daily] != null) {
      const dailyCount = db.prepare(`
        SELECT COUNT(*) as c FROM usage_events
        WHERE user_id = ? AND event_type = ? AND created_at >= ? AND success = 1
      `).get(userId, eventType, dayStart).c;
      if (dailyCount >= limits[map.daily]) {
        return {
          allowed: false,
          reason: `Daily limit of ${limits[map.daily]} ${eventType.replace(/_/g,' ')} reached. Resets tomorrow.`,
          current: dailyCount,
          limit: limits[map.daily],
          period: 'daily',
        };
      }
    }

    // Monthly limit check
    if (map.monthly && limits[map.monthly] != null) {
      const monthlyCount = db.prepare(`
        SELECT COUNT(*) as c FROM usage_events
        WHERE user_id = ? AND event_type = ? AND created_at >= ? AND success = 1
      `).get(userId, eventType, monthStart).c;
      if (monthlyCount >= limits[map.monthly]) {
        return {
          allowed: false,
          reason: `Monthly limit of ${limits[map.monthly]} ${eventType.replace(/_/g,' ')} reached. Resets next month.`,
          current: monthlyCount,
          limit: limits[map.monthly],
          period: 'monthly',
        };
      }
    }

    // Monthly token budget
    if (limits.monthly_token_budget != null) {
      const monthlyTokens = db.prepare(`
        SELECT COALESCE(SUM(input_tokens + output_tokens +
          cache_read_tokens + cache_creation_tokens), 0) as total
        FROM usage_events WHERE user_id = ? AND created_at >= ?
      `).get(userId, monthStart).total;
      if (monthlyTokens >= limits.monthly_token_budget) {
        return {
          allowed: false,
          reason: `Monthly token budget of ${limits.monthly_token_budget.toLocaleString()} tokens reached.`,
          current: monthlyTokens,
          limit: limits.monthly_token_budget,
          period: 'monthly',
        };
      }
    }

    return { allowed: true };
  } catch (e) {
    console.warn("[limitEnforcer] checkLimit error:", e.message);
    return { allowed: true }; // fail open on errors
  }
}
