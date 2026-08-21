/**
 * Bring-your-own-job import: a user hands the app a URL, or raw text/HTML, and it lands in the
 * SAME global scraped_jobs pool everything else feeds — same dedup (reconcileFingerprint), same
 * enrichment queue, same board. See routes/importJob.js for the HTTP surface.
 *
 * Three extraction paths, tried in this order for a given input:
 *   1. Known-ATS URL reuse — the URL matches a pattern for one of the 7 already-integrated ATS
 *      sources; refetch that company's full listing via the source's own already-working
 *      fetchCompanyJobs() and find the matching posting. Preferred when available: it's the
 *      SAME clean, structured data a real crawl would get, not an LLM's best guess off rendered
 *      HTML. Deliberately does NOT try to derive every ATS's URL shape from scratch where that
     * would require guessing (see detectKnownAtsMatch's comments on Workday/Workable below) —
 *      guessing a request shape wrong is exactly what went wrong with the provider-eval Jobo
 *      adapter earlier in this project; an honest "can't parse this one, fall through" beats a
 *      wrong guess.
 *   2. Client-provided text/html, or (if neither given and the URL isn't login-walled) a
 *      server-side fetch of the URL — either way, one Haiku call extracts a normalizeJob()-
 *      shaped posting from raw text.
 *   3. LinkedIn (or another login-walled host) with no fallback text/html at all → no fetch is
 *      attempted; the caller gets a structured "capture it client-side instead" response.
 *
 * IMPORTANT: a known-ATS-matched import keeps `source` as the REAL ats type (e.g. 'greenhouse'),
 * not 'import' — this is deliberate, not a shortcut. computeReqUid() (schema.js) namespaces its
 * requisition id by `source`; if this import used 'import' as that namespace, a LATER real
 * crawl of the same company (which computes its req_uid with source='greenhouse') would never
 * match this row by req_uid, and Task 3.1's selectMatch() treats two different non-null req_uids
 * as genuinely distinct sibling reqs — i.e. the import and the real crawl would permanently
 * duplicate as two board rows instead of reconciling into one. Only the generic/text path (no
 * real ATS identity, no req_id) is tagged source:'import'.
 */

import axios from 'axios';
import crypto from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { normalizeJob } from './schema.js';
import { stripResumeHtml } from '../resumeFormatter.js';
import { classifyJob } from './classifyJob.js';
import { reconcileFingerprint, upsertCanonicalJob, fingerprintJob, SOURCE_LABELS } from './aggregator.js';
import { runEnrichment } from './enrichJob.js';
import { mapJobRow } from './mapJobRow.js';
import { MODEL_HAIKU } from '../../shared/anthropicModels.js';
import { callModel, SYSTEM_USER_ID } from '../modelCall.js';

import { fetchCompanyJobs as fetchGreenhouseJobs }      from './sources/greenhouse.js';
import { fetchCompanyJobs as fetchLeverJobs }           from './sources/lever.js';
import { fetchCompanyJobs as fetchAshbyJobs }           from './sources/ashby.js';
import { fetchCompanyJobs as fetchSmartRecruitersJobs } from './sources/smartrecruiters.js';
import { fetchCompanyJobs as fetchWorkableJobs }        from './sources/workable.js';
import { fetchCompanyJobs as fetchRecruiteeJobs }       from './sources/recruitee.js';
import { fetchCompanyJobs as fetchWorkdayJobs }         from './sources/workday.js';

class ImportInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportInputError';
  }
}

// Model IDs come from shared/anthropicModels.js so a bump cannot land in only some files.
const IMPORT_MODEL_ID = MODEL_HAIKU;
const LOGIN_WALLED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

// "global-if-fresh": re-importing the exact same URL within this window reuses the existing
// row as-is instead of re-fetching/re-extracting — reconcileFingerprint already collapses
// re-imports to one row, but without this it still re-does a fetch (or an LLM call) every time.
const REIMPORT_FRESHNESS_SECONDS = 24 * 60 * 60;

const ATS_FETCHERS = {
  greenhouse:      fetchGreenhouseJobs,
  lever:           fetchLeverJobs,
  ashby:           fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  workable:        fetchWorkableJobs,
  recruitee:       fetchRecruiteeJobs,
  workday:         fetchWorkdayJobs,
};

// ── URL detection (pure — no db/network) ───────────────────────────────────────────────────
// Each matcher only fires on ITS OWN host and only returns a match when the slug/id are
// actually present in the URL path — an unparseable URL under a known host returns null
// (falls through to the generic path) rather than guessing.
const ATS_URL_MATCHERS = [
  {
    type: 'greenhouse',
    hostTest: h => /(^|\.)greenhouse\.io$/i.test(h),
    parse: (pathname) => {
      const m = pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
      return m ? { slug: m[1], externalId: m[2] } : null;
    },
  },
  {
    type: 'lever',
    hostTest: h => h.toLowerCase() === 'jobs.lever.co',
    parse: (pathname) => {
      const m = pathname.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
      return m ? { slug: m[1], externalId: m[2] } : null;
    },
  },
  {
    type: 'ashby',
    hostTest: h => h.toLowerCase() === 'jobs.ashbyhq.com',
    parse: (pathname) => {
      const m = pathname.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
      return m ? { slug: m[1], externalId: m[2] } : null;
    },
  },
  {
    type: 'smartrecruiters',
    hostTest: h => h.toLowerCase() === 'jobs.smartrecruiters.com',
    parse: (pathname) => {
      const m = pathname.match(/^\/([^/]+)\/(\d+)-/);
      return m ? { slug: m[1], externalId: m[2] } : null;
    },
  },
  {
    // Only the apply.workable.com/{slug}/j/{shortcode} form carries the account slug this
    // source needs. The jobs.workable.com/view/{shortcode} form does not include it anywhere
    // in the URL — that form intentionally falls through to the generic path below rather than
    // guessing a slug that isn't there.
    type: 'workable',
    hostTest: h => h.toLowerCase() === 'apply.workable.com',
    parse: (pathname) => {
      const m = pathname.match(/^\/([^/]+)\/j\/([a-z0-9]+)/i);
      return m ? { slug: m[1], externalId: m[2] } : null;
    },
  },
  {
    type: 'recruitee',
    hostTest: h => /\.recruitee\.com$/i.test(h),
    // The slug is the subdomain; Recruitee's public offer URLs don't carry the numeric id
    // normalizeRecruiteeJob() uses, only a title slug — matching happens by URL equality
    // against the fetched list's own `url` field (see findMatchingPosting), not by id.
    parse: (_pathname, hostname) => {
      const slug = hostname.split('.')[0];
      return slug ? { slug, externalId: null } : null;
    },
  },
];

// Workday's tenant + wd# live in the hostname, but the `site` segment workday.js's slug
// convention needs (wdNumber|tenant|site) is not reliably recoverable from an arbitrary pasted
// URL (locale prefixes, varying path depth) — so a Workday match ALWAYS requires an existing
// company_ats_list row to supply the already-verified `site`; no guessing.
const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com$/i;

function detectKnownAtsMatch(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  const hostname = parsed.hostname.toLowerCase();

  for (const matcher of ATS_URL_MATCHERS) {
    if (matcher.hostTest(hostname)) {
      const result = matcher.parse(parsed.pathname, hostname);
      return result ? { type: matcher.type, ...result } : null;
    }
  }

  const wdMatch = hostname.match(WORKDAY_HOST_RE);
  if (wdMatch) {
    return { type: 'workday', tenant: wdMatch[1].toLowerCase(), wdNumber: wdMatch[2], externalId: null };
  }

  return null;
}

function isLoginWalled(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return LOGIN_WALLED_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── SSRF guard (generic-fetch path only — known-ATS paths only ever hit our own hardcoded
// vendor API base URLs with a regex-validated slug, never an attacker-controlled host) ────────
const PRIVATE_IPV4_RANGES = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateOrLoopbackIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return PRIVATE_IPV4_RANGES.some(r => r.test(ip));
}

// Resolves the hostname BEFORE fetching (not after) so a DNS-rebinding attempt to an internal
// address is caught, not just a literal http://127.0.0.1 in the input.
async function assertFetchable(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new ImportInputError('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new ImportInputError('Only http(s) URLs can be imported');
  }
  let address;
  try {
    ({ address } = await dnsLookup(parsed.hostname));
  } catch {
    throw new ImportInputError(`Could not resolve host: ${parsed.hostname}`);
  }
  if (isPrivateOrLoopbackIp(address)) {
    throw new ImportInputError('This URL resolves to a private/internal address and cannot be imported');
  }
  return parsed;
}

function titleCaseSlug(slug) {
  const words = String(slug || '').split(/[-_]+/).filter(Boolean);
  if (!words.length) return 'Unknown Company';
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function resolveCompanyName(db, atsType, slug) {
  const row = db.prepare(
    'SELECT company FROM company_ats_list WHERE ats_type = ? AND ats_slug = ?'
  ).get(atsType, slug);
  return row?.company || titleCaseSlug(slug);
}

// Workday's ats_slug is the composite "wdNumber|tenant|site" workday.js already knows how to
// use — find the row whose tenant+wd# match what we parsed from the URL and reuse its site.
function resolveWorkdaySlug(db, tenant, wdNumber) {
  const rows = db.prepare("SELECT company, ats_slug FROM company_ats_list WHERE ats_type = 'workday'").all();
  for (const row of rows) {
    const [rowWdNumber, rowTenant] = String(row.ats_slug || '').split('|');
    if (rowTenant?.toLowerCase() === tenant && rowWdNumber === wdNumber) {
      return { atsSlug: row.ats_slug, companyName: row.company };
    }
  }
  return null;
}

function normalizeUrlForMatch(u) {
  try {
    const parsed = new URL(u);
    return (parsed.hostname + parsed.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return String(u || '').toLowerCase().replace(/\/+$/, '');
  }
}

// jobs here are already-normalized (fetchCompanyJobs returns normalizeJob()-shaped objects) —
// match by URL equality first (works for every source, since normalizeJob always sets a real
// url), falling back to the parsed req_id when the URL match misses.
function findMatchingPosting(jobs, { url, externalId }) {
  const targetUrl = url ? normalizeUrlForMatch(url) : null;
  if (targetUrl) {
    const byUrl = jobs.find(j => normalizeUrlForMatch(j.url) === targetUrl);
    if (byUrl) return byUrl;
  }
  if (externalId) {
    const byId = jobs.find(j => j.req_id === String(externalId));
    if (byId) return byId;
  }
  return null;
}

async function fetchKnownAtsJob(db, match, url) {
  let atsSlug, companyName;

  if (match.type === 'workday') {
    const resolved = resolveWorkdaySlug(db, match.tenant, match.wdNumber);
    if (!resolved) return null; // can't derive `site` — caller falls back to generic
    atsSlug = resolved.atsSlug;
    companyName = resolved.companyName;
  } else {
    atsSlug = match.slug;
    companyName = resolveCompanyName(db, match.type, match.slug);
  }

  const fetcher = ATS_FETCHERS[match.type];
  const jobs = await fetcher(atsSlug, companyName, []); // [] = no title filter, list everything
  return findMatchingPosting(jobs, { url, externalId: match.externalId });
}

async function fetchGenericPosting(url) {
  await assertFetchable(url);
  const response = await axios.get(url, {
    timeout: 10000,
    maxContentLength: 3 * 1024 * 1024, // 3MB cap
    maxRedirects: 5,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResumeMasterImportBot/1.0)' },
  });
  return stripResumeHtml(String(response.data || ''));
}

function buildExtractionPrompt(text, url) {
  return `Extract a single job posting's structured fields from the text below. Only state what
the text actually says — if a field isn't present, use null. Never invent or infer a value that
isn't actually written.

${url ? `Source URL: ${url}\n` : ''}Posting text:
${text.slice(0, 6000)}

Reply ONLY with valid JSON matching this exact schema. No markdown fences, no explanation:
{
  "title": "<job title, or null if not determinable>",
  "company": "<employer name, or null if not determinable>",
  "location": "<city/state/country, or 'Remote', or null>",
  "description": "<the job description text, cleaned up, or null>",
  "salaryMin": <number or null>,
  "salaryMax": <number or null>,
  "salaryCurrency": "<ISO 4217 e.g. USD, or null>",
  "remote": <true, false, or null>,
  "postedAt": "<ISO8601 date if explicitly stated, or null>"
}`;
}

async function extractJobFromContent(anthropic, { url, text, db = null }) {
  if (!anthropic) throw new ImportInputError('Job extraction requires an AI client, which is not configured on this server');
  if (!text || !text.trim()) throw new ImportInputError('No text to extract a job from');

  const msg = await callModel({
    // User-initiated import, but this helper has no user in scope; the system sentinel keeps the
    // spend visible rather than dropping it.
    anthropic, db, purpose: "import_job", userId: SYSTEM_USER_ID,
    model: IMPORT_MODEL_ID,
    max_tokens: 800,
    messages: [{ role: 'user', content: buildExtractionPrompt(text, url) }],
  });
  const raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ImportInputError('Could not parse a job from this content'); }

  if (!parsed.title || !parsed.company) {
    throw new ImportInputError('Could not extract a job title/company from this content');
  }

  return normalizeJob({
    id:              crypto.randomUUID(),
    req_id:          null, // no genuine per-posting identifier available — fingerprint-only dedup
    title:           parsed.title,
    company:         parsed.company,
    location:        parsed.location || null,
    url:             url || `import:${crypto.randomUUID()}`,
    source:          'import',
    description:     parsed.description || text.slice(0, 3000) || null,
    salary_min:      typeof parsed.salaryMin === 'number' ? parsed.salaryMin : null,
    salary_max:      typeof parsed.salaryMax === 'number' ? parsed.salaryMax : null,
    salary_currency: parsed.salaryCurrency || null,
    remote:          typeof parsed.remote === 'boolean' ? parsed.remote : null,
    posted_at:       parsed.postedAt || null,
  });
}

/**
 * Attaches an imported job to the person who imported it.
 *
 * Without this an import vanished from its owner's point of view: the row lands in the GLOBAL
 * scraped_jobs pool, so whether the importer ever saw it again depended on their profile filters
 * happening to match the classification — while every OTHER user with a matching profile got it
 * on their board. Starring it makes the import behave the way a user expects ("I added this job,
 * so it's in my saved jobs"), and it is the same mechanism the star button already writes, so it
 * needs no new surface to be visible.
 *
 * Uses scraped_jobs.job_id as the user_jobs key, matching what the board actually reads back
 * (server.js's per-row interaction lookup). Note the legacy /api/job-interaction endpoint keys
 * the SAME column by url instead — a pre-existing inconsistency, deliberately not "fixed" here
 * because changing it would silently orphan existing rows.
 *
 * Never throws: failing to star must not fail the import itself.
 */
function attachImportToUser(db, userId, jobId) {
  if (!userId || !jobId) return;
  try {
    const activeProfile = db.prepare(
      'SELECT id FROM domain_profiles WHERE user_id = ? AND is_active = 1 LIMIT 1'
    ).get(userId);
    db.prepare(`
      INSERT INTO user_jobs (user_id, job_id, domain_profile_id, starred, updated_at)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(user_id, job_id) DO UPDATE SET
        starred    = 1,
        updated_at = unixepoch()
    `).run(userId, jobId, activeProfile?.id || null);
  } catch (err) {
    console.warn(`[importJob] Could not attach import to user ${userId}:`, err.message);
  }
}

/**
 * @param {{url?: string, text?: string, html?: string}} input
 * @param {{db: import('better-sqlite3').Database, anthropic: import('@anthropic-ai/sdk').default|null,
 *          userId?: number|null, force?: boolean}} ctx
 *   force skips the freshness short-circuit and re-fetches even a row imported moments ago. For
 *   BACKFILLS after the extractor changes: when a source starts reading a field it previously
 *   dropped, every existing row is stale in a way `updated_at` cannot express, and without this
 *   the re-import silently returns the old row and the fix appears not to work. Not exposed over
 *   HTTP — routes/importJob.js never passes it, so a client cannot use it to force repeated
 *   outbound fetches.
 */
async function importJob({ url, text, html } = {}, { db, anthropic, userId = null, force = false }) {
  if (!url && !text && !html) {
    throw new ImportInputError('Provide at least one of url, text, or html');
  }

  if (url && !force) {
    const existing = db.prepare(
      'SELECT * FROM scraped_jobs WHERE url = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(url);
    const ageSeconds = existing ? Math.floor(Date.now() / 1000) - (existing.updated_at || 0) : Infinity;
    if (existing && ageSeconds < REIMPORT_FRESHNESS_SECONDS) {
      // Still attach on the fast path. The freshness short-circuit exists to avoid re-fetching,
      // but a SECOND user importing the same URL within the window is a real import for them —
      // skipping this would silently return someone else's row without adding it to their board.
      attachImportToUser(db, userId, existing.job_id);
      return { job: mapJobRow(existing) };
    }
  }

  const providedText = text || (html ? stripResumeHtml(html) : null);

  // Login-walled with nothing else to work with → ask the client to capture it instead.
  // If text/html WAS also provided (the extension's own capture, or a manual paste alongside
  // the link), that's exactly the fallback this message describes — use it, don't refuse.
  if (url && isLoginWalled(url) && !providedText) {
    return {
      needsClientCapture: true,
      reason: 'login_walled',
      message: 'Open this job and capture it with the Resume Master extension, or paste the job text.',
    };
  }

  let normalizedJob = null;

  if (url && !isLoginWalled(url)) {
    const match = detectKnownAtsMatch(url);
    if (match) {
      try {
        normalizedJob = await fetchKnownAtsJob(db, match, url);
      } catch (err) {
        console.warn(`[importJob] Known-ATS reuse failed for ${match.type}: ${err.message}`);
      }
    }
  }

  if (!normalizedJob && providedText) {
    normalizedJob = await extractJobFromContent(anthropic, { url: url || null, text: providedText, db });
  } else if (!normalizedJob && url && !isLoginWalled(url)) {
    const fetchedText = await fetchGenericPosting(url);
    normalizedJob = await extractJobFromContent(anthropic, { url, text: fetchedText, db });
  }

  if (!normalizedJob) {
    throw new ImportInputError('Could not extract a job from the given input');
  }

  // Informational tagging only — never gates. Every OTHER write path (cacheJobs, cacheJoboFeed)
  // ejects blue-collar / drops unclassifiable postings; an explicit user import must never
  // silently vanish (approved decision), so classifyJob() here only feeds bucket_role/collar.
  const verdict = classifyJob(
    normalizedJob.title || '', normalizedJob.description || '', normalizedJob.company || ''
  );

  const jobForDedup = { ...normalizedJob, company_icon_url: normalizedJob.thumbnail || null };
  const dedup = reconcileFingerprint(db, jobForDedup);

  let finalJobId;
  if (dedup.action === 'insert_canonical') {
    const canonical = dedup.job;
    const now = Math.floor(Date.now() / 1000);
    upsertCanonicalJob(db, {
      jobId: normalizedJob.id,
      canonical, verdict, dedup, now,
      contentHash: fingerprintJob(canonical),
      searchQuery: 'import',
      sourceLabel: SOURCE_LABELS[canonical.source] || SOURCE_LABELS.import,
      matchedBy: canonical.source === 'import' ? 'import_extract' : 'import_ats_reuse',
    });
    finalJobId = normalizedJob.id;
  } else {
    finalJobId = dedup.intoJobId; // folded into an existing (equal-or-higher priority) row
  }

  // Deliberately after the fold branch: when an import collapses into an existing canonical row
  // the user still imported it, so the row they get back is the one that must be starred.
  attachImportToUser(db, userId, finalJobId);

  setImmediate(() => {
    // recordRun:false — this pass is triggered by a user importing one URL, not by the cron.
    // Logging it would interleave dozens of incidental passes with the scheduled pipeline's
    // history and push the real runs out of the monitor's recent-runs view. The enrichment
    // itself still happens and still shows up in coverage.
    runEnrichment(db, anthropic, { recordRun: false })
      .catch(e => console.warn('[importJob] Background enrichment failed:', e.message));
  });

  // Read back BEFORE reporting success, and say so out loud if the row is not there.
  //
  // This endpoint's whole contract is "your job is now in the pool". Every branch above assumes its
  // write landed: insert_canonical trusts upsertCanonicalJob, and the fold branch trusts that
  // dedup.intoJobId still names a live row. Neither is checked, and without this the failure mode is
  // a TypeError deep inside mapJobRow that the route turns into a generic 502 — indistinguishable
  // from a network problem, and no clue in the log that a write silently did nothing. That is the
  // defect class this codebase has been bitten by repeatedly (Jobo logging "sync complete — 0 jobs
  // cached" while unconfigured; enrichment stamping rows complete while writing nothing), so the
  // import must not be the next one. A missing row is an internal failure, not bad user input —
  // hence Error, which the route maps to 502, and not ImportInputError.
  const row = db.prepare('SELECT * FROM scraped_jobs WHERE job_id = ?').get(finalJobId);
  if (!row) {
    console.error(
      `[importJob] WRITE DID NOT PERSIST — no scraped_jobs row for job_id=${finalJobId} ` +
      `(action=${dedup.action}, source=${normalizedJob.source}, url=${normalizedJob.url}). ` +
      `Reporting failure rather than returning success for a write that did not happen.`
    );
    throw new Error(`Import wrote no row for job_id ${finalJobId}`);
  }

  // An import that persists but is unreachable on the importer's own board is the SAME lie in a
  // quieter form — it is exactly what happened to the reported Quora posting, twice. job_role_map is
  // the binding constraint: /api/jobs joins it with an INNER JOIN on the profile's role_key, so a row
  // with no bucket is invisible to every board under every filter, ?curate=off included. Cheap to
  // check, and it turns a silent disappearance into a logged one.
  const hasBucket = db.prepare('SELECT 1 FROM job_role_map WHERE job_id = ? LIMIT 1').get(finalJobId);
  if (!hasBucket) {
    console.error(
      `[importJob] UNREACHABLE IMPORT — job_id=${finalJobId} persisted with no job_role_map row, ` +
      `so it cannot appear on any board. upsertCanonicalJob's ROLE_KEY_FALLBACK should make this ` +
      `impossible; if it is logged, that guard has regressed.`
    );
  }

  return { job: mapJobRow(row) };
}

export {
  importJob, ImportInputError, detectKnownAtsMatch, isLoginWalled,
  isPrivateOrLoopbackIp, findMatchingPosting,
};
