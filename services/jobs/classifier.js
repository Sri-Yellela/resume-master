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
  { role: 'software_engineer', patterns: [
    /software engineer/i, /software development engineer/i,
    /\bsde\b/i, /\bswe\b/i,
    /\bfull.?stack/i,
    /front.?end\s+(developer|engineer)/i, /back.?end\s+(developer|engineer)/i,
    /web\s+(developer|engineer)/i,
    /javascript\s+(developer|engineer)/i, /react\s+(developer|engineer)/i,
    /node\.?js\s+(developer|engineer)/i,
    /application\s+(developer|engineer)/i,
    /software\s+development/i,
    /\bprogrammer\b/i, /\bsoftware\s+dev\b/i,
    /backend/i, /frontend/i, /web dev/i,
    /systems\s+(software|engineer)/i, /staff\s+engineer/i, /principal\s+engineer/i,
    /embedded\s+(engineer|developer|software)/i,
    /firmware\s+engineer/i,
  ]},
  { role: 'data_scientist', patterns: [
    /data scientist/i, /applied\s+scientist/i, /research\s+scientist/i,
    /machine learning/i, /\bml\s+engineer/i, /machine\s+learning\s+engineer/i,
    /\bnlp\s+engineer/i, /computer\s+vision\s+engineer/i,
    /\bai\s+researcher/i, /\bai\b.*engineer/i,
    /quantitative\s+(analyst|researcher)/i, /\bquant\b/i,
    /data\s+analyst/i, /business\s+intelligence/i,
    /\bbi\s+developer/i,
    /\bml\b/i,
  ]},
  { role: 'data_engineer', patterns: [
    /data engineer/i, /\betl\s+(developer|engineer)/i,
    /data\s+infrastructure/i, /data\s+platform/i, /data\s+warehouse/i,
    /analytics\s+engineer/i,
    /\bspark\b.*engineer/i, /\bkafka\b.*engineer/i,
    /etl/i, /dbt/i,
  ]},
  { role: 'devops', patterns: [
    /devops/i, /\bsre\b/i, /site\s+reliability/i,
    /platform\s+engineer/i, /cloud\s+(engineer|architect)/i,
    /infrastructure\s+engineer/i, /\bdevsecops\b/i,
    /release\s+engineer/i, /build\s+engineer/i,
    /reliability/i, /infrastructure/i,
  ]},
  { role: 'product_manager', patterns: [
    /product manager/i, /product\s+owner/i,
    /associate\s+product\s+manager/i, /group\s+product\s+manager/i,
    /director.*product/i, /\bapm\b.*product/i,
    /technical\s+program\s+manager/i,
    /\bpm\b/i,
  ]},
  { role: 'designer', patterns: [
    /designer/i, /user\s+experience/i, /user\s+interface/i,
    /visual\s+designer/i, /interaction\s+designer/i,
    /\bux\s+researcher/i, /product\s+designer/i,
    /\bui\/ux\b/i, /\bux\/ui\b/i,
    /ux/i, /product design/i,
  ]},
  { role: 'mobile_engineer', patterns: [
    /\bios\s+(developer|engineer)/i, /\bandroid\s+(developer|engineer)/i,
    /react\s+native/i, /flutter\s+(developer|engineer)/i,
    /mobile\s+(developer|engineer)/i,
    /swift\s+(developer|engineer)/i, /kotlin\s+(developer|engineer)/i,
    /ios/i, /android/i, /mobile/i, /flutter/i,
  ]},
  { role: 'security', patterns: [
    /security/i, /information\s+security/i, /\binfosec\b/i,
    /penetration\s+test/i, /\bpentest/i,
    /security\s+analyst/i, /security\s+architect/i,
    /\bsoc\s+analyst/i, /application\s+security/i,
    /appsec/i, /devsecops/i,
  ]},
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

// Title-only blocklist: prevents non-tech titles from matching SWE patterns.
// Tested against job.title only (not description) to avoid false negatives.
const SWE_TITLE_BLOCKLIST = [
  /\b(civil|structural|mechanical|aerospace|electrical|chemical|environmental|geological|mining|manufacturing|process|industrial)\s+(systems?\s+)?engineer/i,
  /\bpre.?sales\b/i,
  /\bsales\s+engineer/i,
  /\bfield\s+(service\s+)?engineer/i,
];

function classify(job) {
  const text = `${job.title || ''} ${job.description || ''} ${job.company || ''}`;
  const title = job.title || '';

  let seniority = 'mid'; // default
  for (const { level, patterns } of SENIORITY_PATTERNS) {
    if (patterns.some(p => p.test(text))) { seniority = level; break; }
  }

  let role = 'other';
  for (const { role: r, patterns } of ROLE_PATTERNS) {
    if (patterns.some(p => p.test(text))) { role = r; break; }
  }

  // Blocklist: demote clearly non-tech roles that may have matched SWE patterns
  if (role === 'software_engineer' && SWE_TITLE_BLOCKLIST.some(p => p.test(title))) {
    role = 'other';
  }

  let domain = 'general';
  for (const { domain: d, patterns } of DOMAIN_PATTERNS) {
    if (patterns.some(p => p.test(text))) { domain = d; break; }
  }

  return { bucket_role: role, bucket_seniority: seniority, bucket_domain: domain };
}

export { classify };
