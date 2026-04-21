// ============================================================
// services/jobClassifier.js — Modular job profile-classification engine
// ============================================================
// Canonical source of truth for profile-family assignment logic.
//
// Used by:
//   - server.js: roleKeyForProfile(), roleTitleSql() expanded cases
//   - routes/adminDb.js: roleKeyForTitle() admin suggestion
//   - migration 046: repair misassigned existing jobs
//   - test/jobClassifier.test.js
//
// Classification principles:
//   1. Specialty domain anchors are STRONG signals → override broad fallback
//   2. Broad/shared skills (Python, SQL, cloud, APIs) are WEAK signals only
//   3. Low-confidence results → "unclassified", not silent SWE fallback
//   4. Software Engineering is NOT the catch-all for ambiguous technical jobs
//
// HOW TO EXTEND:
//   - Add new role keys to SIGNALS below
//   - Add new strongAnchors to pull titles decisively into a family
//   - Add new exclusions to prevent over-capture in broad families
//   - Add new SQL patterns to ROLE_TITLE_SQL_FILTER for query-time filtering
// ============================================================

// ── Signal registry ──────────────────────────────────────────
// strongAnchors: multi-word title phrases that decisively place a job in this family.
//   Each hit adds STRONG_WEIGHT (3) to the score.
//   Keep these specific — avoid single words.
// weakSignals:   single words that provide weak supporting evidence.
//   Each hit adds WEAK_WEIGHT (1). Never decisive alone.
// exclusions:    title substrings that disqualify this role key even if anchors match.
//   Critical for preventing SWE from absorbing specialty roles.

const STRONG_WEIGHT             = 3;
const WEAK_WEIGHT               = 1;
const DESCRIPTION_ANCHOR_WEIGHT = 2;   // domain tool/concept hits in description body
const CONFIDENCE_STRONG_ONLY_THRESHOLD = 3;  // score must reach at least this via strong anchors
export const INGEST_CONFIDENCE_THRESHOLD = 0.75; // min confidence to assign role at ingest time

const SIGNALS = {
  engineering_embedded_firmware: {
    strongAnchors: [
      "firmware engineer",
      "firmware developer",
      "firmware architect",
      "firmware validation",
      "embedded software engineer",
      "embedded systems engineer",
      "embedded developer",
      "embedded software developer",
      "embedded linux engineer",
      "device driver engineer",
      "device driver developer",
      "kernel engineer",
      "kernel developer",
      "bsp engineer",
      "bsp developer",
      "silicon validation engineer",
      "silicon debug engineer",
      "post-silicon engineer",
      "hardware debug engineer",
      "bootloader engineer",
      "rtos engineer",
      "uefi engineer",
      "uefi developer",
      "bios engineer",
      "bios developer",
      "soc bringup engineer",
      "board bringup engineer",
      "chip bringup engineer",
      "hardware bring-up engineer",
    ],
    weakSignals: [
      "firmware", "embedded", "bsp", "rtos", "jtag", "lauterbach",
      "trace32", "openocd", "silicon", "bring-up", "bringup",
      "uefi", "bios", "i2c", "spi", "uart", "pcie",
    ],
    descriptionAnchors: [
      "trace32", "lauterbach", "jtag", "openocd", "arm cortex",
      "yocto", "buildroot", "freertos", "zephyr", "cmsis",
      "hal driver", "dma controller", "interrupt handler", "interrupt service",
      "register map", "logic analyzer", "oscilloscope", "schematic review",
      "pcie driver", "device tree", "kernel module", "u-boot",
    ],
    exclusions: [],
  },

  data: {
    strongAnchors: [
      "machine learning engineer",
      "ml engineer",
      "ai engineer",
      "artificial intelligence engineer",
      "data scientist",
      "senior data scientist",
      "staff data scientist",
      "principal data scientist",
      "data engineer",
      "senior data engineer",
      "staff data engineer",
      "analytics engineer",
      "bi engineer",
      "business intelligence engineer",
      "nlp engineer",
      "computer vision engineer",
      "research scientist",
      "applied scientist",
      "quantitative researcher",
      "quantitative analyst",
      "quant analyst",
      "llm engineer",
      "generative ai engineer",
      "genai engineer",
      "mlops engineer",
      "ml platform engineer",
      "data analyst",
      "senior data analyst",
      "bi analyst",
      "business intelligence analyst",
      "data analytics manager",
      "machine learning researcher",
      "ai researcher",
      "deep learning engineer",
      "recommendation systems engineer",
    ],
    weakSignals: [
      "data", "analytics", "analyst", "ml", "llm",
      "intelligence", "scientist", "quantitative", "modeling",
    ],
    descriptionAnchors: [
      "dbt", "bigquery", "snowflake", "databricks", "apache spark",
      "feature store", "feature engineering", "embedding", "vector database",
      "airflow", "mlflow", "kubeflow", "vertex ai", "sagemaker",
      "tableau", "power bi", "looker", "redshift", "a/b testing",
      "model training", "model deployment", "model evaluation",
      "data pipeline", "data warehouse", "data lakehouse",
    ],
    exclusions: [],
  },

  pm: {
    strongAnchors: [
      "product manager",
      "senior product manager",
      "staff product manager",
      "principal product manager",
      "group product manager",
      "technical product manager",
      "project manager",
      "senior project manager",
      "technical project manager",
      "program manager",
      "senior program manager",
      "technical program manager",
      "staff program manager",
      "scrum master",
      "product owner",
      "agile coach",
      "delivery manager",
      "release manager",
      "product lead",
      "product director",
      "program director",
      "project director",
      "director of product",
      "director of program",
      "director of project",
      "vp of product",
      "head of product",
    ],
    weakSignals: [
      "product", "project", "program", "manager", "delivery",
      "agile", "scrum", "coordinator", "pmo",
    ],
    descriptionAnchors: [
      "roadmap", "sprint planning", "stakeholder alignment", "stakeholder management",
      "okr", "backlog", "go-to-market", "user story", "release planning",
      "agile ceremony", "product spec", "product strategy", "prd",
      "feature prioritization", "product vision", "product requirements",
      "cross-functional", "product lifecycle",
    ],
    exclusions: [
      "product designer",
      "product design",
    ],
  },

  engineering: {
    strongAnchors: [
      "software engineer",
      "senior software engineer",
      "staff software engineer",
      "principal software engineer",
      "software developer",
      "senior software developer",
      "backend engineer",
      "senior backend engineer",
      "staff backend engineer",
      "frontend engineer",
      "senior frontend engineer",
      "full stack engineer",
      "fullstack engineer",
      "full-stack engineer",
      "full stack developer",
      "fullstack developer",
      "site reliability engineer",
      "devops engineer",
      "platform engineer",
      "infrastructure engineer",
      "cloud engineer",
      "mobile engineer",
      "ios engineer",
      "android engineer",
      "web developer",
      "web engineer",
      "api engineer",
      "solutions architect",
      "solution architect",
      "security engineer",
      "application engineer",
      "software development engineer",
      "software architect",
      "tech lead",
      "technical lead",
    ],
    weakSignals: [
      "engineer", "developer", "programmer", "software",
      "backend", "frontend", "platform", "infrastructure",
      "cloud", "architect",
    ],
    descriptionAnchors: [
      "rest api", "microservice", "ci/cd", "kubernetes", "terraform",
      "docker", "graphql", "unit test", "integration test", "code review",
      "system design", "pull request", "containerization", "service mesh",
      "api gateway", "distributed system", "event-driven", "message queue",
    ],
    exclusions: [
      // firmware/embedded specialty — must NOT fall into generic SWE
      "firmware", "embedded", "bsp", "silicon validation", "post-silicon",
      "post silicon", "bootloader", "rtos", "uefi", "device driver",
      "hardware debug", "soc bring", "board bring", "chip bring",
      // data/AI specialty — must NOT fall into generic SWE
      "machine learning", "ml engineer", "ai engineer",
      "artificial intelligence", "llm", "genai", "generative ai",
      "data scientist", "data engineer", "analytics engineer",
      // pm titles — must NOT fall into generic SWE
      "project manager", "program manager", "product manager",
      "scrum master", "project coordinator",
    ],
  },

  hr: {
    strongAnchors: [
      "recruiter",
      "senior recruiter",
      "technical recruiter",
      "corporate recruiter",
      "talent acquisition",
      "talent acquisition manager",
      "talent acquisition specialist",
      "talent acquisition partner",
      "talent partner",
      "hr business partner",
      "hrbp",
      "hr generalist",
      "human resources manager",
      "human resources director",
      "human resources specialist",
      "human resources coordinator",
      "hr manager",
      "hr director",
      "hr coordinator",
      "hr specialist",
      "hr analyst",
      "compensation analyst",
      "compensation manager",
      "total rewards",
      "total rewards manager",
      "learning and development",
      "learning & development",
      "l&d manager",
      "l&d specialist",
      "people operations",
      "people ops",
      "people manager",
      "recruiting coordinator",
      "sourcing specialist",
      "sourcing manager",
      "chief people officer",
      "workforce manager",
      "employee relations",
    ],
    weakSignals: [
      "hr", "recruiter", "talent", "people", "workforce",
      "compensation", "benefits", "onboarding",
    ],
    descriptionAnchors: [
      "workday", "greenhouse", "applicant tracking", "ats",
      "headcount", "performance review", "hris", "offer letter",
      "org design", "compensation band", "succession planning",
      "benefits administration", "employee engagement", "people analytics",
      "workforce planning", "talent pipeline",
    ],
    exclusions: [],
  },

  finance: {
    strongAnchors: [
      "financial analyst",
      "senior financial analyst",
      "investment banking analyst",
      "investment banker",
      "fp&a analyst",
      "fpa analyst",
      "financial planning analyst",
      "treasury analyst",
      "treasury manager",
      "credit analyst",
      "credit risk analyst",
      "risk analyst",
      "financial risk analyst",
      "controller",
      "financial controller",
      "comptroller",
      "cfo",
      "chief financial officer",
      "auditor",
      "external auditor",
      "internal auditor",
      "tax analyst",
      "tax manager",
      "tax director",
      "portfolio manager",
      "asset manager",
      "financial reporting analyst",
      "revenue analyst",
      "underwriter",
      "loan officer",
      "mortgage analyst",
      "actuary",
      "actuarial analyst",
      "chartered financial analyst",
      "equity research analyst",
      "budget analyst",
    ],
    weakSignals: [
      "finance", "financial", "accounting", "accountant",
      "banking", "investment", "revenue", "budget",
    ],
    descriptionAnchors: [
      "dcf", "discounted cash flow", "valuation", "p&l", "profit and loss",
      "balance sheet", "financial model", "bloomberg", "financial statement",
      "gaap", "ifrs", "variance analysis", "earnings", "capital allocation",
      "three-statement model", "lbo", "merger model", "sensitivity analysis",
    ],
    exclusions: [],
  },

  design: {
    strongAnchors: [
      "ux designer",
      "ui designer",
      "ux/ui designer",
      "ui/ux designer",
      "product designer",
      "senior product designer",
      "staff product designer",
      "graphic designer",
      "visual designer",
      "interaction designer",
      "ux researcher",
      "user researcher",
      "design researcher",
      "user experience designer",
      "user experience researcher",
      "motion designer",
      "creative director",
      "design director",
      "design lead",
      "brand designer",
      "brand strategist",
      "digital designer",
      "content designer",
      "service designer",
    ],
    weakSignals: [
      "design", "designer", "creative", "ux", "ui", "visual",
      "experience", "prototype", "wireframe",
    ],
    descriptionAnchors: [
      "figma", "sketch", "invision", "framer", "prototyping",
      "user flow", "usability testing", "design system", "wireframe",
      "accessibility", "design token", "component library", "storybook",
      "user journey", "information architecture", "heuristic evaluation",
    ],
    exclusions: [],
  },

  marketing: {
    strongAnchors: [
      "marketing manager",
      "senior marketing manager",
      "marketing director",
      "vp of marketing",
      "head of marketing",
      "seo specialist",
      "seo manager",
      "sem manager",
      "growth marketing manager",
      "growth marketer",
      "demand generation manager",
      "demand gen manager",
      "brand manager",
      "senior brand manager",
      "content marketing manager",
      "content strategist",
      "content manager",
      "social media manager",
      "social media specialist",
      "product marketing manager",
      "product marketer",
      "email marketing manager",
      "digital marketing manager",
      "marketing analyst",
      "performance marketing manager",
      "paid media manager",
      "marketing operations manager",
      "field marketing manager",
      "channel marketing manager",
    ],
    weakSignals: [
      "marketing", "growth", "brand", "content", "seo", "sem",
      "digital", "campaign", "advertising",
    ],
    descriptionAnchors: [
      "hubspot", "salesforce", "google ads", "meta ads", "conversion rate",
      "content calendar", "email campaign", "brand identity", "customer acquisition",
      "demand generation", "attribution", "utm tracking", "ab testing",
      "marketing qualified lead", "mql", "sql funnel",
    ],
    exclusions: [],
  },

  legal: {
    strongAnchors: [
      "attorney",
      "associate attorney",
      "senior attorney",
      "partner attorney",
      "counsel",
      "in-house counsel",
      "corporate counsel",
      "general counsel",
      "legal counsel",
      "paralegal",
      "senior paralegal",
      "compliance officer",
      "compliance manager",
      "compliance director",
      "chief compliance officer",
      "legal director",
      "legal analyst",
      "legal manager",
      "regulatory affairs specialist",
      "regulatory affairs manager",
      "patent attorney",
      "ip attorney",
      "ip counsel",
      "litigation attorney",
      "employment attorney",
    ],
    weakSignals: [
      "legal", "compliance", "attorney", "regulatory", "counsel",
      "paralegal", "litigation", "patent",
    ],
    descriptionAnchors: [
      "contract review", "contract negotiation", "due diligence",
      "term sheet", "intellectual property", "sec filing", "gdpr",
      "indemnification", "regulatory compliance", "legal brief",
      "deposition", "discovery", "trademark", "copyright", "licensing agreement",
    ],
    exclusions: [],
  },

  operations: {
    strongAnchors: [
      "operations manager",
      "senior operations manager",
      "operations director",
      "supply chain manager",
      "supply chain analyst",
      "supply chain director",
      "logistics manager",
      "logistics coordinator",
      "logistics analyst",
      "procurement manager",
      "procurement analyst",
      "procurement specialist",
      "manufacturing engineer",
      "industrial engineer",
      "quality engineer",
      "quality assurance manager",
      "quality manager",
      "fulfillment manager",
      "warehouse manager",
      "inventory manager",
      "vendor manager",
      "scm analyst",
      "distribution manager",
      "supply planning manager",
    ],
    weakSignals: [
      "operations", "ops", "supply", "logistics", "procurement",
      "manufacturing", "inventory", "warehouse", "vendor",
    ],
    descriptionAnchors: [
      "erp", "sap", "lean manufacturing", "six sigma", "vendor negotiation",
      "kpi dashboard", "inventory optimization", "s&op", "sales and operations",
      "logistics network", "3pl", "last mile", "demand planning",
      "purchase order", "rfq", "supplier management", "bom",
    ],
    exclusions: [],
  },

  healthcare: {
    strongAnchors: [
      "registered nurse",
      "nurse practitioner",
      "physician assistant",
      "pharmacist",
      "clinical pharmacist",
      "physical therapist",
      "occupational therapist",
      "medical assistant",
      "clinical nurse specialist",
      "radiologist",
      "radiology technician",
      "medical director",
      "clinical director",
      "chief medical officer",
      "healthcare administrator",
      "hospital administrator",
      "patient care coordinator",
      "clinical research coordinator",
      "clinical coordinator",
      "healthcare analyst",
      "physician",
      "surgeon",
      "dentist",
      "speech therapist",
    ],
    weakSignals: [
      "clinical", "medical", "health", "nurse", "patient",
      "hospital", "care", "therapy", "therapeutic",
    ],
    descriptionAnchors: [
      "emr", "ehr", "epic", "cerner", "hipaa",
      "patient assessment", "clinical trial", "icd code", "icd-10",
      "medication management", "care coordination", "patient outcomes",
      "clinical protocol", "bedside", "vital signs", "nursing assessment",
    ],
    exclusions: [],
  },
};

// ── Title classification ──────────────────────────────────────
// Scores each role family against the given title (and optionally description).
// Returns { roleKey, confidence, matchedBy } where:
//   roleKey   — best-matching role key or "unclassified"
//   confidence— 0–1 float (< 0.5 = low confidence, use with caution)
//   matchedBy — "strong_anchor" | "strong_anchor+desc" | "desc_anchor_only"
//             | "ambiguous" | "weak_only" | "no_signal"
//
// Scoring tiers:
//   strongAnchors      = STRONG_WEIGHT (3) — multi-word title phrase, decisive
//   descriptionAnchors = DESCRIPTION_ANCHOR_WEIGHT (2) — domain tool/concept in desc body
//   weakSignals        = WEAK_WEIGHT (1) — single-word broad hint, never decisive alone
//
// Used by: adminDb.js roleKeyForTitle(), migration 046 repair, classifyForIngest()
//
// IMPORTANT: Only trust results with confidence >= 0.7 for automated reclassification.
// Low-confidence results should be flagged for manual review, not silently assigned.
export function classifyTitle(title, description = "") {
  const t = (title       || "").toLowerCase().trim();
  const d = (description || "").slice(0, 600).toLowerCase();

  const scores  = {};
  const details = {};

  for (const [roleKey, signals] of Object.entries(SIGNALS)) {
    const { strongAnchors, descriptionAnchors = [], weakSignals, exclusions } = signals;

    // Exclusion check — any hit immediately disqualifies this role key for this title
    if (exclusions.some(ex => t.includes(ex))) {
      scores[roleKey]  = -Infinity;
      details[roleKey] = "excluded";
      continue;
    }

    let score      = 0;
    let strongHits = 0;
    let descHits   = 0;
    let weakHits   = 0;

    for (const anchor of strongAnchors) {
      if (t.includes(anchor)) { score += STRONG_WEIGHT; strongHits++; }
    }
    // Description-level domain anchors — only checked against description body
    for (const anchor of descriptionAnchors) {
      if (d.includes(anchor)) { score += DESCRIPTION_ANCHOR_WEIGHT; descHits++; }
    }
    for (const weak of weakSignals) {
      // Weak signals checked against title and first 600 chars of description
      if (t.includes(weak) || d.includes(weak)) { score += WEAK_WEIGHT; weakHits++; }
    }

    scores[roleKey]  = score;
    details[roleKey] = { strongHits, descHits, weakHits };
  }

  const ranked = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);

  if (ranked.length === 0) {
    return { roleKey: "unclassified", confidence: 0, matchedBy: "no_signal" };
  }

  // Title strong anchors always take precedence over description-only signals.
  // A desc-heavy role should NOT outrank a role where the title explicitly names it.
  const titleStrongCandidates = ranked.filter(
    ([k]) => (details[k]?.strongHits ?? 0) >= 1
  );

  if (titleStrongCandidates.length === 0) {
    // No title strong anchor at all — desc anchors or weak signals only
    const [fallbackKey] = ranked[0];
    const fallbackDesc  = details[fallbackKey]?.descHits ?? 0;
    if (fallbackDesc >= 2) {
      // Moderate confidence for strong description evidence; below ingest threshold
      return { roleKey: fallbackKey, confidence: 0.60, matchedBy: "desc_anchor_only" };
    }
    return { roleKey: fallbackKey, confidence: 0.35, matchedBy: "weak_only" };
  }

  // Use the highest-scored candidate that has a strong TITLE anchor
  const [topKey, topScore]  = titleStrongCandidates[0];
  const [, secondScore = 0] = titleStrongCandidates[1] || [];
  const topDescHits = details[topKey]?.descHits ?? 0;

  // Two title-strong candidates that are close in score — ambiguous
  if (titleStrongCandidates.length >= 2 && topScore - secondScore < STRONG_WEIGHT) {
    return { roleKey: topKey, confidence: 0.55, matchedBy: "ambiguous" };
  }

  // Single winning title-strong candidate
  const baseConf = Math.min(0.97, 0.72 + topScore * 0.025);
  // Description anchors provide a small additional boost (up to +0.07)
  const descBoost = Math.min(0.07, topDescHits * 0.025);
  const confidence = Math.min(0.97, baseConf + descBoost);
  const matchedBy  = topDescHits >= 1 ? "strong_anchor+desc" : "strong_anchor";
  return { roleKey: topKey, confidence, matchedBy };
}

// ── Profile → role key mapping ────────────────────────────────
// Maps a domain_profile row to the canonical role_key used in job_role_map.
//
// Rules:
//   engineering + engineering_embedded_firmware domain → isolated firmware key
//   All other profiles → role_family (or domain as fallback)
//
// IMPORTANT: engineering_embedded_firmware is the ONLY engineering sub-domain
// with a strict, non-overlapping title set. engineering_systems_low_level and
// engineering_specialist intentionally stay on the shared "engineering" key
// because their title sets overlap too much with SWE to warrant separate buckets.
//
// To add a new isolated sub-domain key:
//   1. Add a new case here
//   2. Add a new case in roleTitleSql() in server.js
//   3. Add a repair migration to back-fill existing jobs
export function getRoleKeyForProfile(profile) {
  const family = String(profile?.role_family || "").trim().toLowerCase();
  const domain = String(profile?.domain      || "").trim().toLowerCase();

  // Only sub-domain with a fully separate job_role_map key
  if (family === "engineering" && domain === "engineering_embedded_firmware") {
    return "engineering_embedded_firmware";
  }

  return family || domain || "general";
}

// ── SQL include/exclude pattern sets ─────────────────────────
// These are used by roleTitleSql() in server.js to build the query-time
// title filter for each role key.  Exported so tests can verify coverage
// without reading server.js source text.
//
// format: { includes: string[], excludes: string[] }
// Each string is a raw SQL LIKE pattern (including % wildcards).
export const ROLE_TITLE_SQL = {
  engineering: {
    includes: [
      "%engineer%", "%developer%", "%software%", "%programmer%",
      "%devops%", "%sre%", "%architect%", "%backend%", "%frontend%",
      "%fullstack%", "%full stack%", "%platform%", "%infrastructure%",
      "%cloud%", "%systems%", "%security%",
    ],
    excludes: [
      // firmware/embedded specialty
      "%firmware%", "%embedded%", "%device driver%", "%bsp%",
      "%silicon validation%", "%post-silicon%", "%post silicon%",
      "%soc bring%", "%board bring%", "%chip bring%",
      "%bootloader%", "%rtos%", "% bios %", "bios %", "%uefi%",
      // data/AI specialty
      "%machine learning%", "%ml engineer%", "%ai engineer%",
      "%artificial intelligence%", "%llm%", "%genai%", "%generative ai%",
      "%data scientist%", "%data engineer%", "%analytics engineer%",
      // PM specialty
      "%project manager%", "%program manager%", "%product manager%",
      "%project coordinator%", "%scrum master%", "%pmo%",
    ],
  },

  engineering_embedded_firmware: {
    includes: [
      "%firmware%", "%embedded%", "%device driver%", "%bsp%",
      "%silicon validation%", "%post-silicon%", "%post silicon%",
      "%soc bring%", "%board bring%", "%chip bring%",
      "%bootloader%", "%rtos%", "% bios %", "bios %", "%uefi%",
      "%hardware debug%", "%debug tools%",
    ],
    excludes: [],
  },

  pm: {
    includes: [
      "%product manager%", "%project manager%", "%program manager%",
      "%scrum master%", "%product owner%", "%agile%",
      "%delivery manager%", "%release manager%",
      "%project coordinator%", "%program coordinator%",
      "%project director%", "%program director%",
      "%product director%", "%product lead%",
      "% manager%", "%coordinator%", "%director%", "%pmo%",
    ],
    excludes: [
      // design roles that contain "product"
      "%product designer%", "%product design%",
      // non-PM directors
      "%art director%", "%creative director%", "%design director%",
      "%finance director%", "%hr director%", "%sales director%",
      "%marketing director%",
    ],
  },

  data: {
    includes: [
      "%data scientist%", "%data engineer%", "%analytics engineer%",
      "%machine learning%", "%ml engineer%", "%ai engineer%",
      "%artificial intelligence%", "%llm%", "%genai%", "%generative ai%",
      "%business intelligence%", "%nlp engineer%", "%quantitative%",
      "%data analyst%", "%bi analyst%", "%bi engineer%",
      "%research scientist%", "%applied scientist%", "%scientist%",
      "% analyst%", "%data%", "%analytics%",
    ],
    excludes: [],
  },

  hr: {
    includes: [
      "%recruiter%", "%talent acquisition%", "%human resources%",
      "%hrbp%", "%hr business%", "%hr manager%", "%hr director%",
      "%hr generalist%", "%hr specialist%", "%hr analyst%",
      "%hr coordinator%", "%people ops%", "%people operations%",
      "%compensation%", "% hr %", "hr %",
      "%learning and development%", "%learning & development%",
      "%workforce%", "%employee relations%", "%total rewards%",
    ],
    excludes: [],
  },

  finance: {
    includes: [
      "%financial analyst%", "%investment bank%", "%fp&a%", "%fpa%",
      "%treasury%", "%credit analyst%", "%risk analyst%",
      "%controller%", "%cfo%", "%auditor%",
      "%tax analyst%", "%tax manager%", "%portfolio manager%",
      "%asset manager%", "%underwriter%", "%loan officer%",
      "%actuary%", "%equity research%", "%budget analyst%",
      "%revenue analyst%", "%financial report%",
      "% finance%", "%financial%", "%accounting%",
    ],
    excludes: [],
  },

  design: {
    includes: [
      "%ux designer%", "%ui designer%", "%ux/ui%", "%ui/ux%",
      "%product designer%", "%graphic designer%", "%visual designer%",
      "%interaction designer%", "%ux researcher%", "%user researcher%",
      "%design researcher%", "%motion designer%", "%creative director%",
      "%design director%", "%design lead%", "%brand designer%",
      "%content designer%", "%service designer%",
    ],
    excludes: [],
  },

  marketing: {
    includes: [
      "%marketing manager%", "%marketing director%", "%marketing analyst%",
      "%seo%", "%sem%", "%growth market%", "%demand gen%",
      "%brand manager%", "%content market%", "%content strategist%",
      "%social media manager%", "%product marketing%", "%pmm%",
      "%email marketing%", "%digital marketing%",
      "%performance marketing%", "%paid media%",
    ],
    excludes: [],
  },

  legal: {
    includes: [
      "%attorney%", "%counsel%", "%paralegal%", "%compliance officer%",
      "%compliance manager%", "%legal director%", "%legal analyst%",
      "%regulatory affairs%", "%patent attorney%", "%ip attorney%",
      "%ip counsel%", "%litigation%", "% legal %", "legal %",
    ],
    excludes: [],
  },

  operations: {
    includes: [
      "%operations manager%", "%supply chain%", "%logistics manager%",
      "%logistics coordinator%", "%procurement manager%",
      "%procurement analyst%", "%manufacturing engineer%",
      "%industrial engineer%", "%quality engineer%",
      "%quality manager%", "%fulfillment manager%",
      "%warehouse manager%", "%inventory manager%",
      "%vendor manager%", "%scm analyst%",
    ],
    excludes: [],
  },

  healthcare: {
    includes: [
      "%registered nurse%", "%nurse practitioner%", "%physician assistant%",
      "%pharmacist%", "%physical therapist%", "%occupational therapist%",
      "%medical assistant%", "%clinical nurse%", "%radiolog%",
      "%medical director%", "%clinical director%",
      "%healthcare administrator%", "%hospital administrator%",
      "%patient care%", "%clinical research%", "%clinical coordinator%",
    ],
    excludes: [],
  },
};

// ── Conservative ingest-time classification ───────────────────
// Calls classifyTitle() and returns the result only if confidence
// meets or exceeds INGEST_CONFIDENCE_THRESHOLD (0.75).
// Returns null when confidence is insufficient — the caller must
// leave the job unclassified rather than force-assigning it.
//
// Used by: server.js scrape ingest flow for jobs without a domainProfile
export function classifyForIngest(title, description = "") {
  const result = classifyTitle(title, description);
  if (result.confidence >= INGEST_CONFIDENCE_THRESHOLD) return result;
  return null;
}

// ── Query-time title SQL filter ───────────────────────────────
// Builds a SQL fragment that includes/excludes job titles for a given role key.
// Pure function — no DB or Express dependencies.
// Used by: /api/jobs, /api/jobs/poll, /api/scrape DB-first count, /api/jobs/facets
//
// Must stay in sync with ROLE_TITLE_SQL patterns above.
export function roleTitleSql(column, roleKey) {
  if (roleKey === "engineering") return `((
    LOWER(${column}) LIKE '%engineer%'
    OR LOWER(${column}) LIKE '%developer%'
    OR LOWER(${column}) LIKE '%software%'
    OR LOWER(${column}) LIKE '%programmer%'
    OR LOWER(${column}) LIKE '%devops%'
    OR LOWER(${column}) LIKE '%sre%'
    OR LOWER(${column}) LIKE '%architect%'
    OR LOWER(${column}) LIKE '%backend%'
    OR LOWER(${column}) LIKE '%frontend%'
    OR LOWER(${column}) LIKE '%fullstack%'
    OR LOWER(${column}) LIKE '%full stack%'
    OR LOWER(${column}) LIKE '%platform%'
    OR LOWER(${column}) LIKE '%infrastructure%'
    OR LOWER(${column}) LIKE '%cloud%'
    OR LOWER(${column}) LIKE '%systems%'
    OR LOWER(${column}) LIKE '%security%'
  )
    AND LOWER(${column}) NOT LIKE '%firmware%'
    AND LOWER(${column}) NOT LIKE '%embedded%'
    AND LOWER(${column}) NOT LIKE '%device driver%'
    AND LOWER(${column}) NOT LIKE '%bsp%'
    AND LOWER(${column}) NOT LIKE '%silicon validation%'
    AND LOWER(${column}) NOT LIKE '%post-silicon%'
    AND LOWER(${column}) NOT LIKE '%post silicon%'
    AND LOWER(${column}) NOT LIKE '%soc bring%'
    AND LOWER(${column}) NOT LIKE '%board bring%'
    AND LOWER(${column}) NOT LIKE '%chip bring%'
    AND LOWER(${column}) NOT LIKE '%bootloader%'
    AND LOWER(${column}) NOT LIKE '%rtos%'
    AND LOWER(${column}) NOT LIKE '% bios %'
    AND LOWER(${column}) NOT LIKE 'bios %'
    AND LOWER(${column}) NOT LIKE '%uefi%'
    AND LOWER(${column}) NOT LIKE '%machine learning%'
    AND LOWER(${column}) NOT LIKE '%ml engineer%'
    AND LOWER(${column}) NOT LIKE '%ai engineer%'
    AND LOWER(${column}) NOT LIKE '%artificial intelligence%'
    AND LOWER(${column}) NOT LIKE '%llm%'
    AND LOWER(${column}) NOT LIKE '%genai%'
    AND LOWER(${column}) NOT LIKE '%generative ai%'
    AND LOWER(${column}) NOT LIKE '%data scientist%'
    AND LOWER(${column}) NOT LIKE '%data engineer%'
    AND LOWER(${column}) NOT LIKE '%analytics engineer%'
    AND LOWER(${column}) NOT LIKE '%project manager%'
    AND LOWER(${column}) NOT LIKE '%program manager%'
    AND LOWER(${column}) NOT LIKE '%product manager%'
    AND LOWER(${column}) NOT LIKE '%project coordinator%'
    AND LOWER(${column}) NOT LIKE '%scrum master%'
    AND LOWER(${column}) NOT LIKE '%pmo%'
  )`;
  if (roleKey === "engineering_embedded_firmware") return `(
    LOWER(${column}) LIKE '%firmware%'
    OR LOWER(${column}) LIKE '%embedded%'
    OR LOWER(${column}) LIKE '%device driver%'
    OR LOWER(${column}) LIKE '%bsp%'
    OR LOWER(${column}) LIKE '%silicon validation%'
    OR LOWER(${column}) LIKE '%post-silicon%'
    OR LOWER(${column}) LIKE '%post silicon%'
    OR LOWER(${column}) LIKE '%soc bring%'
    OR LOWER(${column}) LIKE '%board bring%'
    OR LOWER(${column}) LIKE '%chip bring%'
    OR LOWER(${column}) LIKE '%bootloader%'
    OR LOWER(${column}) LIKE '%rtos%'
    OR LOWER(${column}) LIKE '% bios %'
    OR LOWER(${column}) LIKE 'bios %'
    OR LOWER(${column}) LIKE '%uefi%'
    OR LOWER(${column}) LIKE '%hardware debug%'
    OR LOWER(${column}) LIKE '%debug tools%'
  )`;
  if (roleKey === "pm") return `((
    LOWER(${column}) LIKE '%product manager%'
    OR LOWER(${column}) LIKE '%project manager%'
    OR LOWER(${column}) LIKE '%program manager%'
    OR LOWER(${column}) LIKE '%scrum master%'
    OR LOWER(${column}) LIKE '%product owner%'
    OR LOWER(${column}) LIKE '%delivery manager%'
    OR LOWER(${column}) LIKE '%release manager%'
    OR LOWER(${column}) LIKE '%agile%'
    OR LOWER(${column}) LIKE '%pmo%'
    OR LOWER(${column}) LIKE '%product lead%'
    OR LOWER(${column}) LIKE '%project coordinator%'
    OR LOWER(${column}) LIKE '%program coordinator%'
    OR LOWER(${column}) LIKE '% manager%'
    OR LOWER(${column}) LIKE '%coordinator%'
    OR LOWER(${column}) LIKE '%director%'
    OR LOWER(${column}) LIKE '%project%'
    OR LOWER(${column}) LIKE '%program%'
    OR LOWER(${column}) LIKE '%product%'
    OR LOWER(${column}) LIKE '%delivery%'
  )
    AND LOWER(${column}) NOT LIKE '%product designer%'
    AND LOWER(${column}) NOT LIKE '%product design%'
    AND LOWER(${column}) NOT LIKE '%art director%'
    AND LOWER(${column}) NOT LIKE '%creative director%'
    AND LOWER(${column}) NOT LIKE '%design director%'
    AND LOWER(${column}) NOT LIKE '%finance director%'
    AND LOWER(${column}) NOT LIKE '%hr director%'
    AND LOWER(${column}) NOT LIKE '%sales director%'
    AND LOWER(${column}) NOT LIKE '%marketing director%'
  )`;
  if (roleKey === "data") return `(
    LOWER(${column}) LIKE '%data scientist%'
    OR LOWER(${column}) LIKE '%data engineer%'
    OR LOWER(${column}) LIKE '%analytics engineer%'
    OR LOWER(${column}) LIKE '%machine learning%'
    OR LOWER(${column}) LIKE '%ml engineer%'
    OR LOWER(${column}) LIKE '%ai engineer%'
    OR LOWER(${column}) LIKE '%artificial intelligence%'
    OR LOWER(${column}) LIKE '%llm%'
    OR LOWER(${column}) LIKE '%genai%'
    OR LOWER(${column}) LIKE '%generative ai%'
    OR LOWER(${column}) LIKE '%business intelligence%'
    OR LOWER(${column}) LIKE '%nlp engineer%'
    OR LOWER(${column}) LIKE '%quantitative%'
    OR LOWER(${column}) LIKE '%data analyst%'
    OR LOWER(${column}) LIKE '%bi analyst%'
    OR LOWER(${column}) LIKE '%research scientist%'
    OR LOWER(${column}) LIKE '%applied scientist%'
    OR LOWER(${column}) LIKE '% analyst%'
    OR LOWER(${column}) LIKE '%analytics%'
    OR LOWER(${column}) LIKE '%scientist%'
    OR LOWER(${column}) LIKE '%data%'
  )`;
  if (roleKey === "hr") return `(
    LOWER(${column}) LIKE '%recruiter%'
    OR LOWER(${column}) LIKE '%talent acquisition%'
    OR LOWER(${column}) LIKE '%human resources%'
    OR LOWER(${column}) LIKE '%hrbp%'
    OR LOWER(${column}) LIKE '%hr business%'
    OR LOWER(${column}) LIKE '%hr manager%'
    OR LOWER(${column}) LIKE '%hr director%'
    OR LOWER(${column}) LIKE '%hr generalist%'
    OR LOWER(${column}) LIKE '%hr specialist%'
    OR LOWER(${column}) LIKE '%hr analyst%'
    OR LOWER(${column}) LIKE '%hr coordinator%'
    OR LOWER(${column}) LIKE '%people ops%'
    OR LOWER(${column}) LIKE '%people operations%'
    OR LOWER(${column}) LIKE '%compensation%'
    OR LOWER(${column}) LIKE '% hr %'
    OR LOWER(${column}) LIKE 'hr %'
    OR LOWER(${column}) LIKE '%learning and development%'
    OR LOWER(${column}) LIKE '%learning & development%'
    OR LOWER(${column}) LIKE '%workforce%'
    OR LOWER(${column}) LIKE '%employee relations%'
    OR LOWER(${column}) LIKE '%total rewards%'
  )`;
  if (roleKey === "finance") return `(
    LOWER(${column}) LIKE '%financial analyst%'
    OR LOWER(${column}) LIKE '%investment bank%'
    OR LOWER(${column}) LIKE '%fp&a%'
    OR LOWER(${column}) LIKE '%treasury%'
    OR LOWER(${column}) LIKE '%credit analyst%'
    OR LOWER(${column}) LIKE '%risk analyst%'
    OR LOWER(${column}) LIKE '%controller%'
    OR LOWER(${column}) LIKE '%cfo%'
    OR LOWER(${column}) LIKE '%auditor%'
    OR LOWER(${column}) LIKE '%tax analyst%'
    OR LOWER(${column}) LIKE '%tax manager%'
    OR LOWER(${column}) LIKE '%portfolio manager%'
    OR LOWER(${column}) LIKE '%asset manager%'
    OR LOWER(${column}) LIKE '%underwriter%'
    OR LOWER(${column}) LIKE '%loan officer%'
    OR LOWER(${column}) LIKE '%actuary%'
    OR LOWER(${column}) LIKE '%equity research%'
    OR LOWER(${column}) LIKE '%budget analyst%'
    OR LOWER(${column}) LIKE '%revenue analyst%'
    OR LOWER(${column}) LIKE '% finance%'
    OR LOWER(${column}) LIKE '%financial%'
    OR LOWER(${column}) LIKE '%accounting%'
  )`;
  if (roleKey === "design") return `(
    LOWER(${column}) LIKE '%ux designer%'
    OR LOWER(${column}) LIKE '%ui designer%'
    OR LOWER(${column}) LIKE '%ux/ui%'
    OR LOWER(${column}) LIKE '%ui/ux%'
    OR LOWER(${column}) LIKE '%product designer%'
    OR LOWER(${column}) LIKE '%graphic designer%'
    OR LOWER(${column}) LIKE '%visual designer%'
    OR LOWER(${column}) LIKE '%interaction designer%'
    OR LOWER(${column}) LIKE '%ux researcher%'
    OR LOWER(${column}) LIKE '%user researcher%'
    OR LOWER(${column}) LIKE '%design researcher%'
    OR LOWER(${column}) LIKE '%motion designer%'
    OR LOWER(${column}) LIKE '%creative director%'
    OR LOWER(${column}) LIKE '%design director%'
    OR LOWER(${column}) LIKE '%design lead%'
    OR LOWER(${column}) LIKE '%brand designer%'
    OR LOWER(${column}) LIKE '%content designer%'
    OR LOWER(${column}) LIKE '%service designer%'
  )`;
  if (roleKey === "marketing") return `(
    LOWER(${column}) LIKE '%marketing manager%'
    OR LOWER(${column}) LIKE '%marketing director%'
    OR LOWER(${column}) LIKE '%marketing analyst%'
    OR LOWER(${column}) LIKE '%seo%'
    OR LOWER(${column}) LIKE '%sem%'
    OR LOWER(${column}) LIKE '%growth market%'
    OR LOWER(${column}) LIKE '%demand gen%'
    OR LOWER(${column}) LIKE '%brand manager%'
    OR LOWER(${column}) LIKE '%content market%'
    OR LOWER(${column}) LIKE '%content strategist%'
    OR LOWER(${column}) LIKE '%social media manager%'
    OR LOWER(${column}) LIKE '%product marketing%'
    OR LOWER(${column}) LIKE '%email marketing%'
    OR LOWER(${column}) LIKE '%digital marketing%'
    OR LOWER(${column}) LIKE '%performance marketing%'
    OR LOWER(${column}) LIKE '%paid media%'
  )`;
  if (roleKey === "legal") return `(
    LOWER(${column}) LIKE '%attorney%'
    OR LOWER(${column}) LIKE '%counsel%'
    OR LOWER(${column}) LIKE '%paralegal%'
    OR LOWER(${column}) LIKE '%compliance officer%'
    OR LOWER(${column}) LIKE '%compliance manager%'
    OR LOWER(${column}) LIKE '%legal director%'
    OR LOWER(${column}) LIKE '%legal analyst%'
    OR LOWER(${column}) LIKE '%regulatory affairs%'
    OR LOWER(${column}) LIKE '%patent attorney%'
    OR LOWER(${column}) LIKE '%ip attorney%'
    OR LOWER(${column}) LIKE '%ip counsel%'
    OR LOWER(${column}) LIKE '%litigation%'
    OR LOWER(${column}) LIKE '% legal %'
    OR LOWER(${column}) LIKE 'legal %'
  )`;
  if (roleKey === "operations") return `(
    LOWER(${column}) LIKE '%operations manager%'
    OR LOWER(${column}) LIKE '%supply chain%'
    OR LOWER(${column}) LIKE '%logistics manager%'
    OR LOWER(${column}) LIKE '%logistics coordinator%'
    OR LOWER(${column}) LIKE '%procurement manager%'
    OR LOWER(${column}) LIKE '%procurement analyst%'
    OR LOWER(${column}) LIKE '%manufacturing engineer%'
    OR LOWER(${column}) LIKE '%industrial engineer%'
    OR LOWER(${column}) LIKE '%quality engineer%'
    OR LOWER(${column}) LIKE '%quality manager%'
    OR LOWER(${column}) LIKE '%fulfillment manager%'
    OR LOWER(${column}) LIKE '%warehouse manager%'
    OR LOWER(${column}) LIKE '%inventory manager%'
    OR LOWER(${column}) LIKE '%vendor manager%'
    OR LOWER(${column}) LIKE '%scm analyst%'
  )`;
  if (roleKey === "healthcare") return `(
    LOWER(${column}) LIKE '%registered nurse%'
    OR LOWER(${column}) LIKE '%nurse practitioner%'
    OR LOWER(${column}) LIKE '%physician assistant%'
    OR LOWER(${column}) LIKE '%pharmacist%'
    OR LOWER(${column}) LIKE '%physical therapist%'
    OR LOWER(${column}) LIKE '%occupational therapist%'
    OR LOWER(${column}) LIKE '%medical assistant%'
    OR LOWER(${column}) LIKE '%clinical nurse%'
    OR LOWER(${column}) LIKE '%radiolog%'
    OR LOWER(${column}) LIKE '%medical director%'
    OR LOWER(${column}) LIKE '%clinical director%'
    OR LOWER(${column}) LIKE '%healthcare administrator%'
    OR LOWER(${column}) LIKE '%hospital administrator%'
    OR LOWER(${column}) LIKE '%patient care%'
    OR LOWER(${column}) LIKE '%clinical research%'
    OR LOWER(${column}) LIKE '%clinical coordinator%'
  )`;
  return "1 = 1";
}

// ── Role key → family/domain reverse map ─────────────────────
// Returns the canonical { role_family, domain } for a role_key so
// callers can insert into job_role_map without hard-coding these.
//
// Note: engineering_embedded_firmware is the only sub-domain key;
// all other keys map role_family = domain = the key itself.
export function getRoleFamilyDomainForKey(roleKey) {
  if (roleKey === "engineering_embedded_firmware") {
    return { role_family: "engineering", domain: "engineering_embedded_firmware" };
  }
  if (roleKey === "engineering") {
    return { role_family: "engineering", domain: "it_digital" };
  }
  // For all other families the domain defaults to the key itself
  return { role_family: roleKey, domain: roleKey };
}
