// services/jobs/relevanceFilter.js
// Returns true if a job title is for a professional/white-collar role
// that requires a resume. Default: include (errs on side of inclusion).

/**
 * Title blocklist — roles that do NOT go through a resume-based hiring process.
 * Matched case-insensitively against job.title only.
 * Word-boundary anchors prevent "delivery manager" matching "delivery driver".
 */
const BLOCKLIST_PATTERNS = [

  // ── DRIVING / DELIVERY / LOGISTICS OPERATOR ──────────────────────────────
  /\bdriver\b/i,
  /\bdelivery\s*(driver|associate|person)\b/i,
  /\btruck\s*driver\b/i,
  /\bcdl\b/i,
  /\bcourier\b/i,
  /\bdispatch(er)?\b/i,
  /\bforklift\b/i,
  /\bwarehouse\s*(associate|worker|operator|picker|packer|clerk)\b/i,
  /\bpicker\s*packer\b/i,
  /\bshipping\s*(associate|clerk|handler)\b/i,
  /\bfreight\s*(handler|loader|driver)\b/i,
  /\bload(er|ing)\s*(dock)?\b/i,
  /\bchauffeur\b/i,

  // ── FOOD SERVICE / HOSPITALITY LINE ──────────────────────────────────────
  /\bline\s*cook\b/i,
  /\bprep\s*cook\b/i,
  /\bpastry\b/i,
  /\bbaker\b/i,
  /\bbarista\b/i,
  /\bbartender\b/i,
  /\bwait(er|ress|staff)\b/i,
  /\bbusp?erson\b/i,
  /\bdishwasher\b/i,
  /\bfood\s*(prep|runner|handler)\b/i,
  /\bkitchen\s*(staff|helper|assistant|hand)\b/i,
  /\bfry\s*cook\b/i,
  /\bcatering\s*(staff|assistant|worker)\b/i,
  // "server" alone would block "server engineer" — use tighter pattern
  /^server$/i,
  /\brestaurant\s*server\b/i,
  /\btable\s*server\b/i,
  // "cook" alone is too broad (e.g. "Tim Cook") — tighter:
  /\b(line|prep|short.?order|fry|cook)\s+cook\b/i,
  /^cook$/i,
  // "host" alone blocks "host engineer" — tighter:
  /\b(restaurant|dining)\s*host(ess)?\b/i,

  // ── RETAIL FLOOR / CASHIER / STOCK ───────────────────────────────────────
  /\bcashier\b/i,
  /\bstocker\b/i,
  /\bstock\s*(associate|clerk|person)\b/i,
  /\bretail\s*(associate|clerk|worker)\b/i,
  /\bstore\s*associate\b/i,
  /\bgrocery\s*(clerk|associate|stocker)\b/i,
  // "sales associate" without qualifiers
  /^sales\s*associate$/i,
  /\bretail\s*sales\s*associate\b/i,

  // ── CONSTRUCTION / TRADES / MANUAL LABOR ─────────────────────────────────
  /\bcarpenter\b/i,
  /\belectrician\b/i,
  /\bplumber\b/i,
  /\bpipefitter\b/i,
  /\bwelder\b/i,
  /\bmason\b/i,
  /\bbricklayer\b/i,
  /\bdryw?all\b/i,
  /\broofer\b/i,
  /\bhvac\s*(tech|installer|mechanic)\b/i,
  /\blandscap(er|ing)\b/i,
  /\bgroundskeep(er|ing)\b/i,
  /\blawn\s*(care|mowing)\b/i,
  /\bconstruction\s*(worker|laborer|hand|helper)\b/i,
  /\bgeneral\s*labor(er)?\b/i,
  /\bday\s*labor(er)?\b/i,
  /\btile\s*(setter|installer)\b/i,
  /\bflooring\s*installer\b/i,
  /\binsulation\s*(installer|worker)\b/i,
  /\bscaffold(er|ing)?\b/i,
  /\bcrane\s*operator\b/i,
  /\bheavy\s*(equipment|machinery)\s*operator\b/i,
  /\bdemolition\s*(worker|crew)\b/i,
  // "painter" alone blocks "software painter" — tighter:
  /\bhouse\s*painter\b/i,
  /\bcommercial\s*painter\b/i,
  /^painter$/i,

  // ── CLEANING / JANITORIAL / SANITATION ───────────────────────────────────
  /\bjanitor(ial)?\b/i,
  /\bcustodian\b/i,
  /\bhousekeep(er|ing)\b/i,
  /\bsanitation\s*(worker|technician)\b/i,
  /\blaundry\s*(attendant|worker)\b/i,
  // "cleaner" tight — "cleaner code" won't match word boundary + context
  /\b(office|building|commercial|facility)\s*cleaner\b/i,
  /^cleaner$/i,
  /\bcleaning\s*(staff|crew|associate)\b/i,
  /\bmaid\b/i,
  // "porter" can be "data porter" — tighter:
  /\bbuilding\s*porter\b/i,
  /\bhospital\s*porter\b/i,

  // ── SECURITY GUARD / PATROL ──────────────────────────────────────────────
  /\bsecurity\s*(guard|patrol|monitor)\b/i,
  /\bunarmed\s*security\b/i,
  /\barmed\s*guard\b/i,
  /\bdoorman\b/i,
  /\bbouncer\b/i,

  // ── GIG / ON-DEMAND ──────────────────────────────────────────────────────
  /\bgig\s*worker\b/i,
  /\binstacart\s*(shopper|driver)?\b/i,
  /\bdoordash\s*(driver|dasher)?\b/i,
  /\buber\s*(eats|driver)\b/i,
  /\blyft\s*driver\b/i,
  /\bpostmates\b/i,
  /\bshipt\s*shopper\b/i,

  // ── PERSONAL CARE / HOME SERVICES ────────────────────────────────────────
  /\bhome\s*(health\s*aide|care\s*aide|caregiver)\b/i,
  /\bhouseparent\b/i,
  /\bnanny\b/i,
  /\bbabysit(ter|ting)\b/i,
  /\bdog\s*(walker|groomer)\b/i,
  /\bpet\s*(sitter|groomer|grooming)\b/i,
  /\bhair\s*(dresser|stylist)\b/i,
  /\bbarber\b/i,
  /\besthet(ician|ist)\b/i,
  /\bnail\s*tech(nician)?\b/i,
  /^massage\s*therapist$/i,

  // ── AGRICULTURAL / SEASONAL ──────────────────────────────────────────────
  /\bfarm\s*(worker|hand|labor(er)?)\b/i,
  /\bharvest(er|ing)?\s*(worker|crew)\b/i,
  /\bseasonal\s*(worker|associate|help)\b/i,
  /\bgreenhouse\s*(worker|laborer)\b/i,

  // ── MOVING / PHYSICAL LABOR ──────────────────────────────────────────────
  /\bmoving\s*(crew|helper|labor(er)?)\b/i,
  /\bjunk\s*remov(al|er)\b/i,
  /^mover$/i,
];

/**
 * Allowlist — patterns that OVERRIDE the blocklist.
 * Checked first. If a title matches allowlist, it's always included
 * even if it also matches a blocklist pattern.
 * Example: "Security Engineer" matches /security guard/ blocklist →
 *   but ALSO matches allowlist → included.
 */
const ALLOWLIST_OVERRIDE_PATTERNS = [
  // Engineering / tech
  /software\s*(engineer|developer|architect)/i,
  /\b(sde|swe)\b/i,
  /\b(full.?stack|frontend|backend|front.?end|back.?end)\s*(engineer|developer)/i,
  /\bdata\s*(scientist|analyst|engineer|architect)/i,
  /\bmachine\s*learning\s*(engineer|scientist|researcher)/i,
  /\bml\s*(engineer|scientist)/i,
  /\bai\s*(engineer|researcher|scientist)/i,
  /\bplatform\s*engineer/i,
  /\bcloud\s*(engineer|architect)/i,
  /\bsite\s*reliability/i,
  /\bdevops\s*engineer/i,
  /\bsre\b/i,
  /\bsecurity\s*(engineer|analyst|architect|researcher)/i,
  /\bmobile\s*(engineer|developer)/i,
  /\bios\s*(engineer|developer)/i,
  /\bandroid\s*(engineer|developer)/i,
  /\bembedded\s*(engineer|developer|software)/i,
  /\bfirmware\s*engineer/i,
  // Product / design
  /\bproduct\s*(manager|owner|director)/i,
  /\b(ux|ui)\s*(designer|researcher|writer)/i,
  /\bproduct\s*designer/i,
  /\bux\/ui\b/i,
  // Data / analytics
  /\bbusiness\s*(analyst|intelligence)/i,
  /\banalytics\s*(engineer|manager|lead)/i,
  /\bdata\s*visualization/i,
  // Management / leadership
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bvice\s*president\b/i,
  /\b\bvp\b.*\b(engineering|product|design|data|finance|operations|marketing|sales)\b/i,
  /\bhead\s*of\b/i,
  /\bchief\s*(technology|product|data|operating|financial|marketing)\s*officer/i,
  // Finance / accounting
  /\bfinancial?\s*(analyst|advisor|manager|director|planner)/i,
  /\baccountant\b/i,
  /\bauditor\b/i,
  /\bcontroller\b/i,
  /\btreasurer\b/i,
  /\bcfo\b/i,
  /\binvestment\s*(analyst|banker|manager)/i,
  // Marketing / comms
  /\bmarketing\s*(manager|director|analyst|strategist|coordinator|specialist)/i,
  /\bgrowth\s*(hacker|manager|marketer)/i,
  /\bcontent\s*(strategist|manager|writer|director)/i,
  /\bpublic\s*relations/i,
  /\bbrand\s*(manager|strategist|director)/i,
  /\bseo\s*(specialist|manager|analyst)/i,
  /\bsocial\s*media\s*(manager|strategist|coordinator)/i,
  // Sales / biz dev
  /\bsales\s*(manager|director|executive|engineer|representative\s*enterprise)/i,
  /\baccount\s*(manager|executive|director)/i,
  /\bbusiness\s*development/i,
  /\bcustomer\s*success/i,
  /\bsolutions?\s*(architect|engineer|consultant)/i,
  /\bimplementation\s*(manager|consultant|engineer)/i,
  /\bpre.?sales\s*(engineer|consultant|architect)/i,
  // HR / recruiting
  /\brecruiter\b/i,
  /\bhuman\s*resources/i,
  /\bhr\s*(manager|specialist|director|coordinator|generalist)/i,
  /\btalent\s*(acquisition|manager|partner)/i,
  // Operations / supply chain
  /\boperations\s*(manager|director|analyst|coordinator)/i,
  /\bproject\s*(manager|coordinator|director)/i,
  /\bprogram\s*(manager|coordinator|director)/i,
  /\bsupply\s*chain\s*(manager|analyst|coordinator|director)/i,
  /\blogistics\s*(manager|analyst|coordinator|director|planner)/i,
  /\bprocurement\s*(manager|analyst|specialist)/i,
  // Legal
  /\bparalegal\b/i,
  /\battorney\b/i,
  /\blawyer\b/i,
  /\bcounsel\b/i,
  /\bcompliance\s*(officer|analyst|manager)/i,
  // Healthcare (clinical/licensed — require resumes)
  /\bclinical\b/i,
  /\bregistered\s*nurse\b/i,
  /\bnurse\s*(practitioner|manager|educator|anesthetist)/i,
  /\bphysician\b/i,
  /\bpharmacist\b/i,
  /\bradiolog/i,
  /\bspeech.?language\s*pathologist/i,
  /\boccupational\s*therapist/i,
  /\bphysical\s*therapist/i,
  /\brespiratory\s*therapist/i,
  /\bdentist\b/i,
  /\boptometrist\b/i,
  /\bpsychologist\b/i,
  /\bpsychiatrist\b/i,
  // Education
  /\bteacher\b/i,
  /\bprofessor\b/i,
  /\binstructor\b/i,
  /\bcurriculum\s*(designer|developer|specialist)/i,
  // Social / non-profit
  /\bsocial\s*worker\b/i,
  /\bcounselor\b/i,
  // Journalism / media
  /\bjournalist\b/i,
  /\bwriter\b/i,
  /\beditor\b/i,
  /\breporter\b/i,
  // Analyst / specialist / coordinator (white-collar catch-alls)
  /\banalyst\b/i,
  /\bspecialist\b/i,
  /\bcoordinator\b/i,
  /\bconsultant\b/i,
];

/**
 * isResumeRelevant(title, description) → boolean
 * Returns true if the job should appear in Resume Master's feed.
 */
function isResumeRelevant(title, _description) {
  if (!title || typeof title !== 'string') return true;
  const t = title.trim();

  // Allowlist checked FIRST — any professional keyword overrides blocklist
  for (const p of ALLOWLIST_OVERRIDE_PATTERNS) {
    if (p.test(t)) return true;
  }

  // Blocklist — exclude gig/trade/manual-labor roles
  for (const p of BLOCKLIST_PATTERNS) {
    if (p.test(t)) return false;
  }

  return true; // default: include
}

export { isResumeRelevant };
