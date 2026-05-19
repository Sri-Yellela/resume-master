// Classifies a job into role/seniority/domain buckets.
// Used by aggregator after fetching, before caching.

const SENIORITY_PATTERNS = [
  { level: 'intern',   patterns: [/intern/i, /internship/i, /co.?op/i] },
  { level: 'entry',    patterns: [/junior/i, /entry.?level/i, /\bjr\b/i, /graduate/i, /new.?grad/i] },
  { level: 'mid',      patterns: [/mid.?level/i, /\bii\b/i, /\b2\b.*engineer/i] },
  { level: 'senior',   patterns: [/senior/i, /\bsr\b/i, /\biii\b/i] },
  { level: 'staff',    patterns: [/staff/i, /tech.?lead/i, /lead\s/i, /principal/i] },
  { level: 'manager',  patterns: [/manager/i, /director/i, /head of/i, /vp of/i, /chief/i] },
];

// Checked in order — more specific buckets first so broad patterns don't win early.
// Order: security → mobile → data_engineer → data_scientist → software_engineer
//        → devops → product_manager → designer
//        → operations → marketing → sales_biz_dev → finance → hr_recruiting → other
const ROLE_PATTERNS = [

  // ── SECURITY ── (before SWE — "Security Engineer" must not fall through to SWE)
  { role: 'security', patterns: [
    /application\s+security/i, /\bappsec\b/i,
    /penetration\s+test/i, /\bpentest\b/i,
    /\bsoc\s+analyst/i,
    /security\s+(engineer|analyst|architect|researcher)/i,
    /information\s+security/i, /\binfosec\b/i,
    /\bdevsecops\b/i, /\bcybersecurity\b/i,
    /\bsecurity\b/i,    // broad — last within bucket
  ]},

  // ── MOBILE ── (before SWE & devops — "iOS Platform Engineer" must not land in devops)
  { role: 'mobile_engineer', patterns: [
    /\bios\s+(developer|engineer)/i, /\bandroid\s+(developer|engineer)/i,
    /react\s+native/i,
    /flutter\s+(developer|engineer)/i,
    /mobile\s+(developer|engineer|software)/i,
    /swift\s+(developer|engineer)/i,
    /kotlin\s+(developer|engineer)/i,
    // broader single-word patterns after compound ones
    /\bios\b/i, /\bandroid\b/i, /\bflutter\b/i,
    /\bmobile\b/i,
  ]},

  // ── DATA ENGINEER ── (before data_scientist — "Analytics Engineer" → data_engineer)
  { role: 'data_engineer', patterns: [
    /data\s+engineer/i,
    /\betl\s+(developer|engineer)/i,
    /analytics\s+engineer/i,
    /data\s+(infrastructure|platform|warehouse)/i,
    /data\s+architect/i, /database\s+architect/i, /analytics\s+architect/i,  // NEW
    /\bspark\b.*engineer/i, /\bkafka\b.*engineer/i,
    /\betl\b/i, /\bdbt\b/i,
  ]},

  // ── DATA SCIENTIST ──
  { role: 'data_scientist', patterns: [
    /data\s+scientist/i,
    /applied\s+scientist/i, /research\s+scientist/i,
    /machine\s+learning/i,
    /\bml\s+engineer/i, /machine\s+learning\s+engineer/i,
    /\bnlp\s+engineer/i, /computer\s+vision\s+engineer/i,
    /\bai\s+researcher/i, /\bai\b.*engineer/i,
    /quantitative\s+(analyst|researcher)/i, /\bquant\b/i,
    /data\s+analyst/i,
    /business\s+intelligence/i, /\bbi\s+developer/i,
    /\bml\b/i,
  ]},

  // ── SOFTWARE ENGINEER ── (broad — after specialized tech buckets)
  { role: 'software_engineer', patterns: [
    /software\s+engineer/i, /software\s+development\s+engineer/i,
    /\bsde\b/i, /\bswe\b/i,
    /\bfull.?stack/i,
    /front.?end\s+(developer|engineer)/i, /back.?end\s+(developer|engineer)/i,
    /web\s+(developer|engineer)/i,
    /javascript\s+(developer|engineer)/i, /react\s+(developer|engineer)/i,
    /node\.?js\s+(developer|engineer)/i,
    /application\s+(developer|engineer)/i,
    /research\s+engineer/i,       // NEW: Research Engineer → SWE
    /\bengineering\s+manager\b/i, // NEW: Engineering Manager → SWE family
    /software\s+development/i,
    /\bprogrammer\b/i, /\bsoftware\s+dev\b/i,
    /\bbackend\b/i, /\bfrontend\b/i, /\bweb\s+dev\b/i,
    /systems\s+(software|engineer)/i,
    /staff\s+engineer/i, /principal\s+engineer/i,
    /embedded\s+(engineer|developer|software)/i,
    /firmware\s+engineer/i,
  ]},

  // ── DEVOPS ── (AFTER mobile & SWE — tightened patterns prevent false positives)
  { role: 'devops', patterns: [
    /\bdevops\b/i, /\bdevsecops\b/i,
    /\bsre\b/i, /site\s+reliability/i,
    /\bplatform\s+engineer/i,
    /cloud\s+(engineer|architect)/i,
    // FIXED: require adjacent noun — prevents "iOS Engineer...Infrastructure" → devops
    /\binfrastructure\s+(engineer|architect|platform|ops)\b/i,
    /release\s+engineer/i, /build\s+engineer/i,
    // REMOVED: bare /reliability/i and /infrastructure/i (caused TPM & iOS false positives)
  ]},

  // ── PRODUCT MANAGER ──
  { role: 'product_manager', patterns: [
    /\bproduct\s+manager\b/i, /\bproduct\s+owner\b/i,
    /associate\s+product\s+manager/i,
    /group\s+product\s+manager/i,
    /director.*product/i,
    /\bapm\b/i,   // NEW: Associate Product Manager abbreviation
    /\bpm\b/i,    // standalone PM abbreviation
    // technical_program_manager REMOVED — goes to operations bucket
  ]},

  // ── DESIGNER ──
  { role: 'designer', patterns: [
    /\bdesigner\b/i, /user\s+experience/i, /user\s+interface/i,
    /visual\s+designer/i, /interaction\s+designer/i,
    /\bux\s+researcher/i, /product\s+designer/i,
    /\bui\/ux\b/i, /\bux\/ui\b/i,
    // FIXED: /ux/i → /\bux\b/i — prevents "Luxembourg" / "Luxe" false positives
    /\bux\b/i,
    /product\s+design/i,
  ]},

  // ══ NEW PROFESSIONAL BUCKETS ═══════════════════════════════════════════════

  // ── OPERATIONS ── (Program Managers, Project Managers, Ops Managers, BAs)
  { role: 'operations', patterns: [
    /\btechnical\s+program\s+manager\b/i,   // TPM → operations (not product)
    /\bprogram\s+manager\b/i,
    /\bproject\s+manager\b/i, /\bproject\s+coordinator\b/i,
    /(?<!people\s)\boperations\s+(manager|director|analyst|coordinator)\b/i,
    /\bbusiness\s+(analyst|operations)\b/i,
    /\bchief\s+of\s+staff\b/i,
    /\bstrategy\s+(analyst|manager|associate|consultant)\b/i,
    /\bcorporate\s+strategy\b/i,
    /\bimplementation\s+(manager|consultant|specialist)\b/i,
    /\bprocess\s+(improvement|excellence|manager)\b/i,
    /\bscrum\s+master\b/i,
    /\bagile\s+(coach|lead|delivery)\b/i,
    /\bchange\s+management\b/i,
    /\bpmo\b/i,
  ]},

  // ── MARKETING ──
  { role: 'marketing', patterns: [
    /\bmarketing\s+(manager|director|analyst|coordinator|specialist|lead|associate)\b/i,
    /\bgrowth\s+(manager|hacker|lead|marketer|analyst)\b/i,
    /\bdemand\s+gen(eration)?\b/i,
    /\bperformance\s+marketing\b/i,
    /\bseo\s+(specialist|manager|analyst|strategist)\b/i,
    /\bsem\s+(specialist|manager)\b/i,
    /\bcontent\s+(strategist|manager|marketer|writer|creator|lead)\b/i,
    /\bcopywriter\b/i,
    /\bbrand\s+(manager|strategist|director)\b/i,
    /\bproduct\s+marketing\s+(manager|lead|director)\b/i,
    /\bfield\s+marketing\b/i,
    /\bcommunity\s+(manager|growth|lead)\b/i,
    /\bsocial\s+media\s+(manager|strategist|coordinator)\b/i,
    /\bemail\s+marketing\b/i,
    /\bmarketing\s+operations\b/i,
    /\blifecycle\s+marketing\b/i,
    /\bpublic\s+relations\b/i,
    /\bpr\s+(manager|specialist|director)\b/i,
    /\bcommunications\s+(manager|director|specialist)\b/i,
  ]},

  // ── SALES / BIZ DEV ──
  { role: 'sales_biz_dev', patterns: [
    /\baccount\s+(executive|manager|director)\b/i,
    /\bbusiness\s+development\b/i,
    /\bbdr\b/i, /\bsdr\b/i,
    /\binside\s+sales\b/i, /\boutside\s+sales\b/i,
    /\bsales\s+(manager|director|executive|lead|associate|representative|engineer)\b/i,
    /\bsolutions?\s+(engineer|consultant|architect)\b/i,
    /\bcustomer\s+success\b/i,
    /\bclient\s+(success|relations|services|partner)\b/i,
    /\brevenue\s+operations\b/i, /\brevops\b/i,
    /\bpartnerships?\s+(manager|lead|director)\b/i,
    /\bstrategic\s+(alliances|partnerships)\b/i,
    /\bchannel\s+(manager|sales|partner)\b/i,
    /\benterprise\s+(account|sales)\b/i,
    /\brenewals?\s+(manager|specialist)\b/i,
    /\bpre.?sales\b/i,
  ]},

  // ── FINANCE ──
  { role: 'finance', patterns: [
    /\bfinancial\s+(analyst|manager|director|controller|advisor|consultant)\b/i,
    /\bfinance\s+(manager|director|analyst|partner|associate|lead)\b/i,
    /\bfp&?a\b/i, /\bfinancial\s+planning\b/i,
    /\baccountant\b/i,
    /\baccounting\s+(manager|analyst|specialist)\b/i,
    /\bcontroller\b/i, /\baudit(or)?\b/i,
    /\btax\s+(analyst|manager|director|associate|accountant)\b/i,
    /\btreasury\b/i,
    /\binvestment\s+(analyst|banker|associate)\b/i,
    /\bequity\s+research\b/i,
    /\brisk\s+(analyst|manager|officer)\b/i,
    /\bcredit\s+(analyst|manager)\b/i,
    /\bunderwriter\b/i,
    /\bpayroll\s+(specialist|manager)\b/i,
    /\bcfo\b/i, /\bfinancial\s+reporting\b/i,
  ]},

  // ── HR / RECRUITING ──
  { role: 'hr_recruiting', patterns: [
    /\bhuman\s+resources\b/i,
    /\bhr\s+(manager|director|analyst|coordinator|business\s+partner|generalist|specialist)\b/i,
    /\bhrbp\b/i,
    /\bpeople\s+(operations|ops|partner|manager|analyst)\b/i,
    /\btalent\s+(acquisition|management|development|partner)\b/i,
    /\brecruiter\b/i, /\btechnical\s+recruiter\b/i,
    /\bheadhunter\b/i,
    /\bstaffing\s+(manager|specialist|coordinator)\b/i,
    /\bcompensation\s+(analyst|manager)\b/i,
    /\bbenefits\s+(analyst|manager|administrator)\b/i,
    /\blearning\s+(and\s+)?development\b/i,
    /\bl&d\b/i,
    /\bdei\s+(manager|lead|director)\b/i,
    /\bworkforce\s+planning\b/i,
    /\bemployee\s+(experience|relations|engagement)\b/i,
  ]},
];

const DOMAIN_PATTERNS = [
  { domain: 'fintech',    patterns: [/fintech/i, /payments?/i, /banking/i, /insurance/i] },
  { domain: 'healthtech', patterns: [/health/i, /medical/i, /clinical/i, /biotech/i] },
  { domain: 'edtech',     patterns: [/education/i, /edtech/i, /learning/i, /school/i, /university/i] },
  { domain: 'ai_ml',      patterns: [/artificial intelligence/i, /machine learning/i, /\bllm\b/i, /\bgpt\b/i] },
  { domain: 'devtools',   patterns: [/developer tools?/i, /devtools/i, /developer experience/i, /api.?first/i] },
  { domain: 'saas',       patterns: [/saas/i, /b2b/i, /enterprise software/i, /cloud platform/i] },
  { domain: 'ecommerce',  patterns: [/e.?commerce/i, /marketplace/i, /retail/i, /shopify/i] },
];

// Title-only blocklist: demotes non-tech roles that may have matched SWE via description.
const SWE_TITLE_BLOCKLIST = [
  /\b(civil|structural|mechanical|aerospace|electrical|chemical|environmental|geological|mining|manufacturing|process|industrial)\s+(systems?\s+)?engineer/i,
  /\bfield\s+(service\s+)?engineer/i,
  // pre-sales and sales engineer left in to prevent SWE match via tech descriptions;
  // clean titles are caught by sales_biz_dev bucket before reaching SWE
  /\bpre.?sales\b/i,
  /\bsales\s+engineer\b/i,
];

function classify(job) {
  const text  = `${job.title || ''} ${job.description || ''} ${job.company || ''}`;
  const title = job.title || '';

  let seniority = 'mid';
  for (const { level, patterns } of SENIORITY_PATTERNS) {
    if (patterns.some(p => p.test(text))) { seniority = level; break; }
  }

  let role = 'other';
  for (const { role: r, patterns } of ROLE_PATTERNS) {
    if (patterns.some(p => p.test(text))) { role = r; break; }
  }

  // Demote titles that matched SWE via description but aren't engineering roles
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
