/**
 * Delivering the pipeline health alerts to somebody, instead of to an admin route nobody opens.
 *
 * ⛔ THE GAP THIS CLOSES IS NOT DETECTION. `GET /api/admin/db/pipeline-health` already catches
 * every failure this pipeline has had, and describes them precisely — on 2026-09-18 it was
 * simultaneously reporting an Anthropic credit outage, Jobo's HTTP 402 wallet, two sources fetching
 * rows and writing none, and three companies that had not produced a row in 234 hours. One of its
 * alerts even names its own history:
 *
 *     "the last 2 enrichment runs wrote nothing — this is the shape that ran for three days
 *      undetected"
 *
 * It was right, it was current, and it had been sitting behind a route that nothing polls. Five
 * days of a dead API key passed with the monitor calling it correctly the whole time. Detection
 * without delivery is a diary.
 *
 * ── ⛔ THE HARD PART IS NOT SENDING, IT IS NOT SENDING ────────────────────────────────────────────
 *
 * These alerts are mostly STANDING conditions. workday and smartrecruiters have no companies
 * configured and will say so every night until somebody configures them. Sending the same six
 * criticals daily produces the one outcome this whole codebase keeps rediscovering: an alarm nobody
 * reads, which is worse than no alarm because it looks like coverage.
 *
 * So delivery is EDGE-TRIGGERED. The fingerprint is `severity|kind|subject` — deliberately NOT the
 * detail, because details carry counts and ages ("no row seen in 234h") that change every single
 * night and would re-fire a standing alert forever. A message goes out when the SET changes:
 * something new appeared, or something cleared. A steady state is silent.
 *
 * Both directions matter. "jobo: recovered" is as much the point as "jobo: failing" — an alert that
 * only ever fires in one direction leaves you unable to tell fixed from forgotten.
 */
"use strict";

import { getSetting, setSetting } from "../appSettings.js";

/** Where the last delivered alert set is remembered, so a standing condition stays quiet. */
export const ALERT_STATE_KEY = "pipeline_alerts_last_delivered";

/** Identity of an alert for change detection: what it is ABOUT, never its current numbers. */
export const fingerprint = (a) => `${a.severity}|${a.kind}|${a.subject}`;

/**
 * Compare the current alert set against the last delivered one.
 * @returns {{ appeared: object[], cleared: string[], changed: boolean, current: string[] }}
 */
export function diffAlerts(current, previousKeys = []) {
  const prev = new Set(previousKeys);
  const currentKeys = current.map(fingerprint);
  const seen = new Set(currentKeys);
  return {
    appeared: current.filter(a => !prev.has(fingerprint(a))),
    cleared: previousKeys.filter(k => !seen.has(k)),
    changed: currentKeys.some(k => !prev.has(k)) || previousKeys.some(k => !seen.has(k)),
    current: currentKeys,
  };
}

/** One human line per alert, short enough for a notification row and a chat message alike. */
export function formatMessage({ appeared, cleared }) {
  const lines = [];
  for (const a of appeared) {
    lines.push(`${a.severity === "critical" ? "🔴" : "🟠"} ${a.kind}/${a.subject}: ${a.detail}`);
  }
  for (const k of cleared) {
    const [, kind, subject] = k.split("|");
    lines.push(`✅ RECOVERED — ${kind}/${subject}`);
  }
  return lines.join("\n");
}

/**
 * Check the alerts and deliver only what changed.
 *
 * Never throws: a monitor that can take the cron down with it is worse than one that misses a
 * night. Every failure path returns a reason instead.
 *
 * @param {object} deps
 * @param {() => {alerts: object[]}} deps.readHealth  the SAME computation the admin route serves,
 *        passed in rather than re-derived — a second alert implementation is the defect this
 *        codebase has repaired three times this week.
 * @param {(userId:number, type:string, message:string, payload:object) => void} deps.notify
 * @param {string|null} [deps.webhookUrl]
 * @returns {Promise<{delivered: boolean, reason: string, appeared: number, cleared: number}>}
 */
export async function deliverPipelineAlerts(db, {
  readHealth, notify, webhookUrl = null, log = console, now = Math.floor(Date.now() / 1000),
} = {}) {
  let health;
  try {
    health = readHealth();
  } catch (e) {
    log.error?.(`[alerts] could not read pipeline health: ${e.message}`);
    return { delivered: false, reason: `health read failed: ${e.message}`, appeared: 0, cleared: 0 };
  }
  const alerts = Array.isArray(health?.alerts) ? health.alerts : [];

  let previous = [];
  try {
    const raw = getSetting(db, ALERT_STATE_KEY);
    if (raw) previous = JSON.parse(raw).keys ?? [];
  } catch { previous = []; }   // an unreadable state means "deliver", not "crash"

  const diff = diffAlerts(alerts, previous);
  if (!diff.changed) {
    return { delivered: false, reason: "no change since last delivery", appeared: 0, cleared: 0 };
  }

  const message = formatMessage(diff);
  const summary = `Pipeline: ${diff.appeared.length} new alert(s), ${diff.cleared.length} recovered`;

  // ⛔ THE STATE IS WRITTEN EVEN IF A CHANNEL FAILS, and that is a deliberate trade. The
  // alternative — retry until something succeeds — turns a broken webhook into the same message
  // every night, which is the failure mode this whole module exists to avoid. A missed edge is
  // recoverable by opening the dashboard; a nightly repeat trains you to ignore it.
  try {
    setSetting(db, ALERT_STATE_KEY, JSON.stringify({ keys: diff.current, at: now }));
  } catch (e) {
    log.warn?.(`[alerts] could not persist alert state (${e.message}) — the next run may repeat this`);
  }

  // Channel 1: the in-app notification the product already has. Always attempted.
  try {
    notify?.(summary, message, { appeared: diff.appeared, cleared: diff.cleared });
  } catch (e) {
    log.warn?.(`[alerts] in-app notification failed: ${e.message}`);
  }

  // Channel 2: an outbound webhook, only if one is configured. Slack and Discord both accept
  // `{ text }`; anything else receives the structured body beside it and can read either.
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${summary}*\n${message}`, summary, alerts: diff.appeared, cleared: diff.cleared }),
      });
      if (!res.ok) log.warn?.(`[alerts] webhook returned HTTP ${res.status}`);
    } catch (e) {
      log.warn?.(`[alerts] webhook POST failed: ${e.message}`);
    }
  }

  log.log?.(`[alerts] ${summary}\n${message}`);
  return { delivered: true, reason: "changed", appeared: diff.appeared.length, cleared: diff.cleared.length };
}
