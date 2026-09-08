/**
 * Repair path for scraped_jobs.company_icon_url when the logo PROVIDER changes (TASK X).
 *
 * The stored value is an absolute URL to a third party, which makes it the most brittle derived
 * column on the table: nothing about a job changes when a provider retires its API, so every row
 * keeps a confident-looking address that resolves to nothing. Clearbit shut
 * `logo.clearbit.com` down and **1290 of 1296 rows** went on pointing at it — the board issued a
 * failing image request per card, per render, for as long as nobody looked.
 *
 * Same shape, and the same remedy, as backfillAutomationTier: a stored derived value needs a way
 * to be re-derived on demand, through the SAME function the writers use. Two entry points, one
 * implementation:
 *   - server.js calls this at boot in the default (retired-host-only) mode, so an existing
 *     database is repaired on the next start rather than waiting for a re-crawl. It is a no-op
 *     once no row carries a retired host.
 *   - scripts/recomputeCompanyLogos.js calls it with { all: true } — the admin action for when
 *     the domain TABLE changed and existing rows should be re-resolved.
 *
 * WHAT COUNTS AS A ROW TO FIX. Not "not the current host" — that would clobber `company_icon_url`
 * values that came from a FEED (LinkedIn's and serpapi's carry their own CDN logo, and those are
 * better than anything this table can derive). Only URLs matching a host this module has itself
 * produced, current or retired, are rewritten. A feed URL is left exactly as it is.
 *
 * OFFLINE ON PURPOSE. No HEAD request, no network. This runs at boot, and a boot path that waits
 * on a third party is a boot path that hangs when that third party is the thing that broke. A row
 * whose new URL 404s falls back to the lettered tile in CompanyIcon, which is the same outcome as
 * a null and costs one cached 404 rather than a blocked startup.
 */
"use strict";

import { getKnownLogoUrl, isKnownLogoUrlHost } from "../../shared/companyLogos.js";

/**
 * Hosts this module has produced in the past and no longer does. A row pointing at one of these
 * is ours to rewrite; anything else in the column came from a feed and is left alone.
 *
 * Kept as an explicit list rather than "anything that is not the current host" so that retiring
 * the NEXT provider is an append here, and so that the reason each entry exists stays written
 * down next to it.
 */
const RETIRED_LOGO_HOSTS = [
  // Clearbit shut the free Logo API down; `logo.clearbit.com` has no A record at all while
  // `clearbit.com` still resolves, so there is no status code that reports it — the request never
  // reaches a server. Confirmed against Google and Cloudflare DoH: NOERROR, empty answer, SOA
  // from Clearbit's own Route53 nameserver.
  "https://logo.clearbit.com/",
  // Never stored deliberately: server.js's fetchCompanyIcon fell through to this whenever the
  // Clearbit HEAD failed, which — once the DNS went — was every call. Swept up here because it
  // sends the user's browsing to a third party the privacy policy does not name.
  "https://www.google.com/s2/favicons",
];

function isRetiredLogoUrl(url) {
  return typeof url === "string" && RETIRED_LOGO_HOSTS.some(h => url.startsWith(h));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ all?: boolean }} [opts]  all:true re-resolves every row this module owns; default
 *                                   touches only rows pointing at a RETIRED host.
 * @returns {{ scanned: number, updated: number, cleared: number, kept: number }}
 */
function backfillCompanyLogos(db, { all = false } = {}) {
  const rows = db.prepare(`
    SELECT job_id, company, company_icon_url
    FROM scraped_jobs
    WHERE company_icon_url IS NOT NULL
  `).all();

  const update = db.prepare("UPDATE scraped_jobs SET company_icon_url = ? WHERE job_id = ?");
  let updated = 0, cleared = 0, kept = 0;

  // One transaction: a half-applied rewrite leaves the board loading two providers at once, which
  // is harder to notice than a failure.
  const run = db.transaction(() => {
    for (const r of rows) {
      const ours = isRetiredLogoUrl(r.company_icon_url) ||
                   (all && isKnownLogoUrlHost(r.company_icon_url));
      if (!ours) { kept++; continue; }  // a feed's own logo — not this module's to touch

      // NULL, not a guessed URL, when the table does not know the company. getKnownLogoUrl
      // already refuses slug guesses; writing one here would trade a dead address for a wrong one.
      const next = getKnownLogoUrl(r.company);
      if (next === r.company_icon_url) continue;
      update.run(next, r.job_id);
      if (next === null) cleared++; else updated++;
    }
  });
  run();

  return { scanned: rows.length, updated, cleared, kept };
}

export { backfillCompanyLogos, isRetiredLogoUrl, RETIRED_LOGO_HOSTS };
