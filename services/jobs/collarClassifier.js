// Detects whether a job title is blue-collar (eject) or white-collar (keep).
//
// Two-signal approach (fixes the broken precedence in relevanceFilter.js):
//   1. Test title against BLUE_COLLAR_ANCHORS (word-boundary regex).
//   2. If no blue anchor → 'white' (default-include).
//   3. If blue anchor present, test title for STRONG_WHITE_ANCHORS.
//      Strong white anchor present → 'white' (e.g. "Warehouse Operations Analyst").
//      No strong white anchor       → 'blue' (e.g. "Warehouse Manager").
//
// Policy #1 (supervisory blue-collar): generic white-collar nouns like
// "manager" / "supervisor" do NOT rescue a blue-collar title. Only a strong
// role anchor (engineer, analyst, scientist, designer, attorney …) does.

// ── Blue-collar anchor patterns ─────────────────────────────────────────────
// Seeded from BLOCKLIST_PATTERNS in relevanceFilter.js, tightened to compound
// phrases where needed to avoid false positives.
// Policy #1 supervisory titles are included explicitly.
export const BLUE_COLLAR_ANCHORS = [

  // ── Driving / delivery / logistics operator ──────────────────────────────
  /\bdriver\b/i,
  /\bcdl\b/i,
  /\bcourier\b/i,
  /\bforklift\b/i,
  /\bdispatch(er)?\b/i,
  /\bchauffeur\b/i,
  /\bfreight\s*(handler|loader|driver)\b/i,
  /\bload(er|ing)\s*(dock)?\b/i,

  // ── Warehouse worker level ────────────────────────────────────────────────
  // "Warehouse" alone is NOT a blue anchor — "Warehouse Operations Analyst" is white.
  // Only explicit worker-level compounds trigger the gate.
  /\bwarehouse\s*(associate|worker|operator|picker|packer|clerk)\b/i,
  /\bpicker\s*packer\b/i,
  /\bshipping\s*(associate|clerk|handler)\b/i,

  // ── Warehouse supervisory — Policy #1 ────────────────────────────────────
  /\bwarehouse\s*(manager|supervisor|lead|foreman)\b/i,
  /\bdistribution\s*center\s*(manager|supervisor|director)\b/i,

  // ── Food service / hospitality ────────────────────────────────────────────
  /\bline\s*cook\b/i,
  /\bprep\s*cook\b/i,
  /\bfry\s*cook\b/i,
  /^cook$/i,
  /\bbarista\b/i,
  /\bbartender\b/i,
  /\bwait(er|ress|staff)\b/i,
  /\bbusp?erson\b/i,
  /\bdishwasher\b/i,
  /\bfood\s*(prep|runner|handler)\b/i,
  /\bkitchen\s*(staff|helper|assistant|hand)\b/i,
  /\bcatering\s*(staff|assistant|worker)\b/i,
  /^server$/i,
  /\brestaurant\s*server\b/i,
  /\b(restaurant|dining)\s*host(ess)?\b/i,

  // ── Restaurant / kitchen supervisory — Policy #1 ─────────────────────────
  /\brestaurant\s*(manager|supervisor)\b/i,
  /\bkitchen\s*manager\b/i,

  // ── Retail floor / cashier / stock ───────────────────────────────────────
  /\bcashier\b/i,
  /\bstocker\b/i,
  /\bstock\s*(associate|clerk|person)\b/i,
  /\bretail\s*(associate|clerk|worker)\b/i,
  /\bstore\s*associate\b/i,
  /\bgrocery\s*(clerk|associate|stocker)\b/i,
  /^sales\s*associate$/i,
  /\bretail\s*sales\s*associate\b/i,

  // ── Store supervisory — Policy #1 ────────────────────────────────────────
  /\bstore\s*manager\b/i,

  // ── Construction / trades / manual labor ─────────────────────────────────
  /\bcarpenter\b/i,
  /\belectrician\b/i,
  /\bplumber\b/i,
  /\bpipefitter\b/i,
  /\bwelder\b/i,
  /\bmason\b/i,
  /\bbricklayer\b/i,
  /\bdryw?all\b/i,
  /\broofer\b/i,
  /\bhvac\s*(tech|technician|installer|mechanic)\b/i,
  /\blandscap(er|ing)\b/i,
  /\bgroundskeep(er|ing)\b/i,
  /\bconstruction\s*(worker|laborer|hand|helper)\b/i,
  /\bgeneral\s*labor(er)?\b/i,
  /\bday\s*labor(er)?\b/i,
  /\bheavy\s*(equipment|machinery)\s*operator\b/i,
  /\bcrane\s*operator\b/i,
  /\bscaffold(er|ing)?\b/i,
  /\bdemolition\s*(worker|crew)\b/i,
  /\binsulation\s*(installer|worker)\b/i,
  /\btile\s*(setter|installer)\b/i,
  /\bflooring\s*installer\b/i,
  /^painter$/i,
  /\bhouse\s*painter\b/i,
  /\bcommercial\s*painter\b/i,

  // ── Construction supervisory — Policy #1 ─────────────────────────────────
  /\bconstruction\s*(superintendent|foreman)\b/i,
  /\bsite\s*superintendent\b/i,
  /\bplant\s*manager\b/i,    // manufacturing floor plant manager

  // ── Cleaning / janitorial / sanitation ───────────────────────────────────
  /\bjanitor(ial)?\b/i,
  /\bcustodian\b/i,
  /\bhousekeep(er|ing)\b/i,
  /\bsanitation\s*(worker|technician)\b/i,
  /\blaundry\s*(attendant|worker)\b/i,
  /^cleaner$/i,
  /\b(office|building|commercial|facility)\s*cleaner\b/i,
  /\bcleaning\s*(staff|crew|associate)\b/i,
  /\bmaid\b/i,
  /\bbuilding\s*porter\b/i,

  // ── Security guard / patrol ───────────────────────────────────────────────
  // "security engineer/analyst" are white — use compound "security guard" pattern.
  /\bsecurity\s*(guard|patrol|monitor|officer)\b/i,
  /\bunarmed\s*security\b/i,
  /\barmed\s*guard\b/i,
  /\bdoorman\b/i,
  /\bbouncer\b/i,

  // ── Personal care / home services ────────────────────────────────────────
  /\bhome\s*(health\s*aide|care\s*aide|caregiver)\b/i,
  /\bnanny\b/i,
  /\bbabysit(ter|ting)\b/i,
  /\bdog\s*(walker|groomer)\b/i,
  /\bpet\s*(sitter|groomer|grooming)\b/i,
  /\bhair\s*(dresser|stylist)\b/i,
  /\bbarber\b/i,
  /\besthet(ician|ist)\b/i,
  /\bnail\s*tech(nician)?\b/i,
  /^massage\s*therapist$/i,

  // ── Agricultural / seasonal ───────────────────────────────────────────────
  /\bfarm\s*(worker|hand|labor(er)?)\b/i,
  /\bharvest(er|ing)?\s*(worker|crew)\b/i,
  /\bseasonal\s*(worker|associate|help)\b/i,

  // ── Moving / gig / on-demand ──────────────────────────────────────────────
  /\bmoving\s*(crew|helper|labor(er)?)\b/i,
  /^mover$/i,
  /\bgig\s*worker\b/i,
  /\binstacart\s*(shopper|driver)?\b/i,
  /\bdoordash\s*(driver|dasher)?\b/i,
  /\buber\s*(eats|driver)\b/i,
  /\blyft\s*driver\b/i,
];

// ── Strong white-collar anchor patterns ──────────────────────────────────────
// A title containing one of these is treated as white-collar even when a blue
// anchor also fires. Policy: generic nouns (manager, supervisor, coordinator)
// do NOT appear here — only strong role anchors do.
export const STRONG_WHITE_ANCHORS = [
  /\bengineer(ing)?\b/i,
  /\banalyst\b/i,
  /\bscientist\b/i,
  /\bdesigner\b/i,
  /\battorney\b/i,
  /\baccountant\b/i,
  /\bcounsel\b/i,
  /\barchitect\b/i,
  /\bdeveloper\b/i,
  /\bprogrammer\b/i,
  /\bresearcher\b/i,
  /\bconsultant\b/i,
  /\bstrategist\b/i,
  /\brecruiter\b/i,
  /\bauditor\b/i,
  /\bunderwriter\b/i,
  /\bactuary\b/i,
  /\bphysician\b/i,
  /\bpharmacist\b/i,
  /\bparalegal\b/i,
];

// ── detectCollar ──────────────────────────────────────────────────────────────
// Returns 'blue' or 'white' for a job title.
// description is checked only as weak corroboration when the title itself
// contains a blue anchor but no strong white anchor.
export function detectCollar(title, description = '') {
  const t = (title       || '').toLowerCase();
  const d = (description || '').slice(0, 600).toLowerCase();

  const hasBlueTitle = BLUE_COLLAR_ANCHORS.some(p => p.test(t));

  // No blue signal in title — default white.
  if (!hasBlueTitle) return 'white';

  // Blue anchor fired; a strong white-collar role anchor overrides it.
  if (STRONG_WHITE_ANCHORS.some(p => p.test(t))) return 'white';

  // Title is definitively blue. Description cannot rescue it — per Policy #1,
  // a generic noun like "manager" in the description is not a strong override.
  return 'blue';
}
