// Unified ingest-time job classifier.
// Classifies once, returns a single canonical verdict that is stored on the row.
// Downstream consumers read the stored verdict; nothing re-derives at query time.

import { detectCollar, STRONG_WHITE_ANCHORS } from './collarClassifier.js';
import { classifyTitle, INGEST_CONFIDENCE_THRESHOLD } from './jobTaxonomy.js';

// ── Seniority ─────────────────────────────────────────────────────────────────
const SENIORITY_LEVELS = [
  { level: 'intern',   re: /\b(intern|internship|co.?op)\b/i },
  { level: 'entry',    re: /\b(junior|jr|entry.?level|graduate|new.?grad)\b/i },
  { level: 'senior',   re: /\b(senior|sr|principal|staff)\b/i },
  { level: 'manager',  re: /\b(manager|director|head\s+of|vp\b|chief)\b/i },
];

function detectSeniority(title, description) {
  const text = `${title || ''} ${(description || '').slice(0, 200)}`;
  for (const { level, re } of SENIORITY_LEVELS) {
    if (re.test(text)) return level;
  }
  return 'mid';
}

// ── Domain ────────────────────────────────────────────────────────────────────
const DOMAIN_PATTERNS = [
  { domain: 'fintech',    re: /\b(fintech|payments?|banking|insurance)\b/i },
  { domain: 'healthtech', re: /\b(health|medical|clinical|biotech)\b/i },
  { domain: 'edtech',     re: /\b(education|edtech|learning|school|university)\b/i },
  { domain: 'ai_ml',      re: /\b(artificial intelligence|machine learning|llm|gpt)\b/i },
  { domain: 'devtools',   re: /\b(developer tools?|devtools|developer experience|api.?first)\b/i },
  { domain: 'saas',       re: /\b(saas|b2b|enterprise software|cloud platform)\b/i },
  { domain: 'ecommerce',  re: /\b(e.?commerce|marketplace|retail|shopify)\b/i },
  { domain: 'climate',    re: /\b(climate|clean ?energy|sustainability|renewable)\b/i },
];

function detectDomain(title, description, company) {
  const text = `${title || ''} ${(description || '').slice(0, 400)} ${company || ''}`;
  for (const { domain, re } of DOMAIN_PATTERNS) {
    if (re.test(text)) return domain;
  }
  return 'general';
}

// ── classifyJob ────────────────────────────────────────────────────────────────
//
// Returns:
//   { collar, roleKey, domain, seniority, confidence, matchedBy }
//
// roleKey values:
//   <family key>  — confidently bucketed white-collar job (store in job_role_map)
//   'general'     — white-collar but not confidently bucketed (pool in general board)
//   null          — eject: either blue-collar OR white-ish with no signal at all
//
// Callers use collar + roleKey to decide what to do:
//   collar === 'blue'             → log to rejected_jobs, DELETE from scraped_jobs
//   collar === 'white', roleKey === null → drop (no insert)
//   collar === 'white', roleKey          → insert / upsert with the stored verdict
export function classifyJob(title, description, company) {
  const collar = detectCollar(title, description);

  if (collar === 'blue') {
    return {
      collar:     'blue',
      roleKey:    null,
      domain:     null,
      seniority:  null,
      confidence: 0,
      matchedBy:  'blue_collar',
    };
  }

  // White-collar path — classify into role family.
  const { roleKey: raw, confidence, matchedBy } = classifyTitle(title, description);

  const seniority = detectSeniority(title, description);
  const domain    = detectDomain(title, description, company);

  let roleKey;
  if (confidence >= INGEST_CONFIDENCE_THRESHOLD) {
    // High confidence: use whatever classifyTitle returned (could be 'unclassified'
    // only if threshold is ever reached with no_signal — practically impossible, but
    // guard it anyway).
    roleKey = (raw === 'unclassified') ? 'general' : raw;
  } else if (STRONG_WHITE_ANCHORS.some(p => p.test((title || '').toLowerCase()))) {
    // Policy #2: white-collar signal is clear but role family is ambiguous → 'general'.
    // Must be rare; tight SIGNALS means most white-collar titles are already bucketed.
    roleKey = 'general';
  } else {
    // No confident bucket AND no strong white-collar signal → drop.
    roleKey = null;
  }

  return { collar: 'white', roleKey, domain, seniority, confidence, matchedBy };
}
