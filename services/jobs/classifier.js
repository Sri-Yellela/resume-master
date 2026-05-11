// Classifies a job into role/seniority/domain buckets
// Used by aggregator after fetching, before caching

const SENIORITY_PATTERNS = [
  { level: 'intern',    patterns: [/intern/i, /internship/i, /co.?op/i] },
  { level: 'entry',     patterns: [/junior/i, /entry.?level/i, /\bjr\b/i, /graduate/i, /new.?grad/i] },
  { level: 'mid',       patterns: [/mid.?level/i, /\bii\b/i, /\b2\b.*engineer/i] },
  { level: 'senior',    patterns: [/senior/i, /\bsr\b/i, /\biii\b/i] },
  { level: 'staff',     patterns: [/staff/i, /tech.?lead/i, /lead\s/i, /principal/i] },
  { level: 'manager',   patterns: [/manager/i, /director/i, /head of/i, /vp of/i, /chief/i] },
];

const ROLE_PATTERNS = [
  { role: 'software_engineer',  patterns: [/software engineer/i, /swe/i, /\bfull.?stack/i, /backend/i, /frontend/i, /web dev/i] },
  { role: 'data_scientist',     patterns: [/data scientist/i, /machine learning/i, /\bml\b/i, /\bai\b.*engineer/i] },
  { role: 'data_engineer',      patterns: [/data engineer/i, /etl/i, /analytics engineer/i, /dbt/i] },
  { role: 'devops',             patterns: [/devops/i, /platform engineer/i, /sre/i, /reliability/i, /infrastructure/i] },
  { role: 'product_manager',    patterns: [/product manager/i, /\bpm\b/i, /product owner/i] },
  { role: 'designer',           patterns: [/designer/i, /ux/i, /ui\/ux/i, /product design/i] },
  { role: 'mobile_engineer',    patterns: [/ios/i, /android/i, /mobile/i, /react native/i, /flutter/i] },
  { role: 'security',           patterns: [/security/i, /appsec/i, /devsecops/i, /penetration/i] },
];

const DOMAIN_PATTERNS = [
  { domain: 'fintech',     patterns: [/fintech/i, /payments?/i, /banking/i, /insurance/i] },
  { domain: 'healthtech',  patterns: [/health/i, /medical/i, /clinical/i, /biotech/i] },
  { domain: 'edtech',      patterns: [/education/i, /edtech/i, /learning/i, /school/i, /university/i] },
  { domain: 'ai_ml',       patterns: [/artificial intelligence/i, /machine learning/i, /\bllm\b/i, /\bgpt\b/i] },
  { domain: 'devtools',    patterns: [/developer tools?/i, /devtools/i, /developer experience/i, /api.?first/i] },
  { domain: 'saas',        patterns: [/saas/i, /b2b/i, /enterprise software/i, /cloud platform/i] },
  { domain: 'ecommerce',   patterns: [/e.?commerce/i, /marketplace/i, /retail/i, /shopify/i] },
];

function classify(job) {
  const text = `${job.title || ''} ${job.description || ''} ${job.company || ''}`;

  let seniority = 'mid'; // default
  for (const { level, patterns } of SENIORITY_PATTERNS) {
    if (patterns.some(p => p.test(text))) { seniority = level; break; }
  }

  let role = 'other';
  for (const { role: r, patterns } of ROLE_PATTERNS) {
    if (patterns.some(p => p.test(text))) { role = r; break; }
  }

  let domain = 'general';
  for (const { domain: d, patterns } of DOMAIN_PATTERNS) {
    if (patterns.some(p => p.test(text))) { domain = d; break; }
  }

  return { bucket_role: role, bucket_seniority: seniority, bucket_domain: domain };
}

export { classify };
