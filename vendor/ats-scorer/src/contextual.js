// @draft/ats-scorer — the CONTEXTUAL score (D192 (4), owner 11-14: "check the contextual relevance match between the jd and
// the resume along with the tech stack compatibility for the score and list the similarities and dissimilarities besides
// just plainly matching skill against skill … as usual no ai").
//
// Pure. No database, no network, no model, no embedding: every input is an argument and every part is arithmetic over
// tokens and ids. The caller (draft, the tools service) reads its own tables — the posting's and the résumé's taxonomy
// placement, the company's stack with its evidence — and passes them in, as with term weights and synonyms.
//
//   scoreContextual({ skillMatch, posting, resume, company, weights })  → the v2 `contextual` block (ATS contract 2.0.0)
//
// The four parts (D192 (4c)), each shown on its own so a person sees WHY:
//   skill_match            the existing score (scoreAtsLocally's `score`), UNCHANGED — this block never alters it
//   role_fit               (4a i)  the posting's subcategory + level vs the résumé's placement; the penalty is the taxonomy
//                                  distance (same sub · same category · other category) plus the level gap; (4a iii) a
//                                  shared domain lifts it, a different domain never lowers it (people change domains)
//   responsibility_overlap (4a ii) the posting's responsibility lines as short phrases, each matched against the résumé's
//                                  lines by TOKEN OVERLAP — the share of phrases a résumé line covers
//   tech_stack             (4b)    the company's stack from its own postings, each technology weighted by its share of
//                                  those postings: an exact match earns it, a same-purpose match (ecosystem) earns half,
//                                  a gap earns nothing, the résumé's extras are neutral; no stack → "no_data"
// A part with no data is left out and the weights of the others are rescaled to sum to 1 — the score then rests on what
// is known (D192 (4b): "the score rests on (4a) + the existing skill match").

export const CONTEXTUAL_CONTRACT = "2.0.0";
export const DEFAULT_CONTEXTUAL_WEIGHTS = Object.freeze({ skill_match: 0.5, role_fit: 0.2, responsibility_overlap: 0.15, tech_stack: 0.15 });
const PARTS = Object.keys(DEFAULT_CONTEXTUAL_WEIGHTS);

// ── role fit ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The ladder both readings map onto: a posting's level_read (entry · early · mid · senior) and a résumé's seniority
// (junior · mid · senior · executive). Words outside it are unknown, never a guess.
export const LEVEL_LADDER = Object.freeze({ intern: 0, entry: 0, early: 1, junior: 1, mid: 2, senior: 3, staff: 4, lead: 4, principal: 4, executive: 5 });
export const ROLE_SAME_SUB = 100, ROLE_ALSO_FITS = 85, ROLE_SAME_CATEGORY = 65, ROLE_OTHER_CATEGORY = 20;
// The level gap's cost, by steps. Under-levelled (the posting asks more than the résumé shows) costs the full step;
// over-levelled costs half — a senior can do a mid job, the screen just asks why.
export const LEVEL_STEP_COST = Object.freeze([0, 10, 25, 40, 50, 55]);
export const DOMAIN_LIFT = 10;

const levelStep = (l) => (l == null ? null : (LEVEL_LADDER[String(l).toLowerCase().trim()] ?? null));

export function roleFit(posting = {}, resume = {}) {
  const p = posting || {}, r = resume || {};
  if (!p.category || !r.category) return { score: null, status: "no_data", reason: !p.category ? "posting_not_placed" : "resume_not_placed" };
  let base, relation;
  if (p.subcategory && p.subcategory === r.subcategory) { base = ROLE_SAME_SUB; relation = "same_role"; }
  else if (p.subcategory && r.also?.subcategory === p.subcategory) { base = ROLE_ALSO_FITS; relation = "also_fits"; }
  else if (p.category === r.category) { base = ROLE_SAME_CATEGORY; relation = "same_family"; }
  else { base = ROLE_OTHER_CATEGORY; relation = "other_family"; }
  const ps = levelStep(p.level), rs = levelStep(r.level);
  let levelGap = null, levelCost = 0;
  if (ps != null && rs != null) {
    levelGap = ps - rs;                                   // > 0: the posting asks more than the résumé shows
    const steps = Math.min(LEVEL_STEP_COST.length - 1, Math.abs(levelGap));
    levelCost = levelGap > 0 ? LEVEL_STEP_COST[steps] : Math.round(LEVEL_STEP_COST[steps] / 2);
  }
  return {
    score: Math.max(0, base - levelCost), status: "ok", relation,
    posting: { category: p.category, subcategory: p.subcategory || null, level: p.level || null },
    resume: { category: r.category, subcategory: r.subcategory || null, level: r.level || null },
    level_gap: levelGap,
  };
}

// ── domain signals (4a iii) ──────────────────────────────────────────────────────────────────────────────────────────
// Industry words a posting names and a résumé may share. A match lifts role fit; a difference is listed, never a penalty.
export const DOMAIN_SIGNALS = Object.freeze({
  fintech: ["fintech", "financial technology", "financial services", "payments", "payment processing", "banking", "lending", "pci", "pci dss", "trading", "brokerage", "kyc", "aml", "card issuing"],
  healthcare: ["healthcare", "health care", "hipaa", "ehr", "emr", "clinical", "patient", "hl7", "fhir", "medical device"],
  insurance: ["insurance", "insurtech", "underwriting", "claims processing", "actuarial"],
  ecommerce: ["e-commerce", "ecommerce", "retail", "marketplace", "checkout", "merchandising"],
  adtech: ["adtech", "ad tech", "advertising", "programmatic", "ad serving", "attribution"],
  security: ["cybersecurity", "security operations", "soc 2", "threat detection", "zero trust", "siem"],
  government: ["fedramp", "government", "public sector", "federal", "dod", "itar"],
  education: ["edtech", "education", "learning management", "k-12", "higher education"],
  gaming: ["gaming", "game studio", "game engine", "multiplayer"],
  logistics: ["logistics", "supply chain", "warehouse management", "fleet", "freight"],
  energy: ["energy", "utilities", "renewable", "oil and gas", "grid"],
  media: ["streaming video", "media", "publishing", "content delivery"],
  automotive: ["automotive", "autonomous vehicles", "adas", "electric vehicle"],
});

const lowerText = (t) => ` ${String(t || "").toLowerCase().replace(/[^a-z0-9+#.\- ]+/g, " ").replace(/\s+/g, " ")} `;
const hasWord = (low, w) => low.includes(` ${w} `);

export function domainsIn(text) {
  const low = lowerText(text);
  const out = [];
  for (const [domain, words] of Object.entries(DOMAIN_SIGNALS)) {
    const hits = words.filter(w => hasWord(low, w));
    if (hits.length) out.push({ domain, terms: hits });
  }
  return out;
}

// ── responsibility overlap (4a ii) ───────────────────────────────────────────────────────────────────────────────────
export const MAX_PHRASES = 12, PHRASE_TOKENS = 6, PHRASE_MIN_TOKENS = 2, PHRASE_COVER = 0.5, CORE_TOKENS = 4;
// A phrase's CORE is what the line is about — the words after its leading verb ("Build | payment infrastructure that moves
// money"): a résumé says "Built", "Led", "Ran", and an irregular past tense never stems to the posting's verb.
const STOP = new Set(("a an and or the of to in on for with by at as from into across our your their its this that these those " +
  "we you they it is are be will can able who which what when where while using use via per all any each other more most " +
  "new including include such like etc help work working strong well within also both day company role through " +
  "ensure responsible responsibilities opportunity looking join plus").split(" "));
const RESP_HEAD = /^\s*(responsibilities|key responsibilities|what you('| wi)ll do|what you will do|the role|in this role|your role|day[- ]to[- ]day|you will|what you'll be doing|about the role|duties)\b/i;
const OTHER_HEAD = /^\s*(requirements|qualifications|minimum qualifications|preferred qualifications|what you('| wi)ll bring|about you|who you are|benefits|perks|compensation|about us|nice to have|bonus points|skills)\b/i;
const BULLET = /^\s*(?:[-•*·▪◦‣–]|\d+[.)])\s+/;

const stem = (w) => w.replace(/(ings?|ed|es|s)$/, "").replace(/e$/, "");
export function contentTokens(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9+#. ]+/g, " ").split(/\s+/)
    .map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem).filter(Boolean);
}

/** The posting's responsibility lines as short phrases: [{ text, tokens }] — at most MAX_PHRASES, each once. */
export function responsibilityPhrases(postingText) {
  const lines = String(postingText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let inResp = false;
  const inSection = [], bullets = [];
  for (const line of lines) {
    if (RESP_HEAD.test(line) && line.length < 60) { inResp = true; continue; }
    if (OTHER_HEAD.test(line) && line.length < 60) { inResp = false; continue; }
    if (BULLET.test(line)) (inResp ? inSection : bullets).push(line.replace(BULLET, ""));
    else if (inResp) inSection.push(...line.split(/(?<=[.;])\s+/));
  }
  const pool = inSection.length ? inSection : bullets;
  const out = [], seen = new Set();
  for (const raw of pool) {
    const tokens = contentTokens(raw).slice(0, PHRASE_TOKENS);
    if (tokens.length < 3) continue;
    const key = tokens.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const core = tokens.length >= 4 ? tokens.slice(1, 1 + CORE_TOKENS) : tokens;
    out.push({ text: raw.split(/\s+/).slice(0, 9).join(" ").replace(/[,.;:]+$/, ""), tokens, core });
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

export function responsibilityOverlap(postingText, resumeText) {
  const phrases = responsibilityPhrases(postingText);
  if (!phrases.length) return { score: null, status: "no_data", reason: "no_responsibility_lines", matched: [], missing: [] };
  const lines = String(resumeText || "").split(/\r?\n/).map(l => new Set(contentTokens(l))).filter(s => s.size);
  const matched = [], missing = [];
  for (const p of phrases) {
    let best = 0;
    for (const set of lines) {
      const hit = p.core.filter(t => set.has(t)).length;
      if (hit > best) best = hit;
    }
    const cover = best / p.core.length;
    (best >= PHRASE_MIN_TOKENS && cover >= PHRASE_COVER ? matched : missing).push(p.text);
  }
  return { score: Math.round(100 * matched.length / phrases.length), status: "ok", phrases: phrases.length, matched, missing };
}

// ── tech-stack compatibility (4b) ────────────────────────────────────────────────────────────────────────────────────
// Same purpose = an ecosystem match (Airflow ↔ Prefect: both orchestrate). A technology in no family matches only itself.
export const ECOSYSTEMS = Object.freeze({
  orchestration: ["Apache Airflow", "Prefect", "Dagster", "Luigi", "Argo Workflows", "Kubeflow"],
  messaging: ["Apache Kafka", "RabbitMQ", "Amazon SQS", "Google Pub/Sub", "Amazon Kinesis", "Apache Pulsar", "NATS"],
  relational: ["PostgreSQL", "MySQL", "SQL Server", "Oracle Database", "SQLite", "MariaDB", "CockroachDB"],
  document_store: ["MongoDB", "DynamoDB", "Cassandra", "Couchbase", "Firestore"],
  cache: ["Redis", "Memcached"],
  warehouse: ["Snowflake", "BigQuery", "Redshift", "Databricks", "ClickHouse", "Azure Synapse"],
  processing: ["Apache Spark", "Hadoop", "Apache Flink", "Apache Beam", "dbt"],
  search: ["Elasticsearch", "Solr", "Algolia"],
  bi: ["Tableau", "Power BI", "Looker", "Metabase", "Superset"],
  cloud: ["AWS", "Google Cloud", "Azure"],
  serverless: ["AWS Lambda", "Google Cloud Functions", "Azure Functions", "Cloudflare", "Vercel"],
  containers: ["Kubernetes", "Docker", "Helm", "Amazon ECS", "Nomad", "OpenShift", "Istio"],
  infrastructure_as_code: ["Terraform", "Pulumi", "AWS CloudFormation", "Ansible", "Chef", "Puppet"],
  ci_cd: ["Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "Argo CD", "Buildkite", "Travis CI"],
  observability: ["Datadog", "Prometheus", "Grafana", "New Relic", "Splunk", "Sentry"],
  frontend: ["React", "Vue", "Angular", "Svelte", "Next.js"],
  web_backend: ["Django", "Flask", "FastAPI", "Express", "Spring", "Ruby on Rails", "Laravel", ".NET", "Node.js"],
  mobile_cross: ["React Native", "Flutter"],
  ml_frameworks: ["PyTorch", "TensorFlow", "JAX", "Keras", "scikit-learn", "XGBoost"],
  ml_platform: ["MLflow", "SageMaker", "Vertex AI", "Kubeflow"],
  llm_tooling: ["LangChain", "LlamaIndex", "Hugging Face", "OpenAI API", "vLLM"],
  jvm: ["Java", "Kotlin", "Scala"],
  javascript: ["JavaScript", "TypeScript"],
  api_styles: ["GraphQL", "gRPC"],
  testing: ["Selenium", "Cypress", "Playwright", "Jest", "pytest"],
  build: ["Bazel", "Gradle", "Maven", "Webpack", "Vite"],
  cad: ["AutoCAD", "SolidWorks", "CATIA", "Creo", "Revit"],
  project_tools: ["Jira", "Asana", "Smartsheet", "Microsoft Project", "Primavera P6"],
});
export const ECOSYSTEM_CREDIT = 0.5;
const key = (t) => String(t || "").toLowerCase().trim();
const FAMILY_OF = new Map(Object.entries(ECOSYSTEMS).flatMap(([fam, list]) => list.map(t => [key(t), fam])));
export const ecosystemOf = (tech) => FAMILY_OF.get(key(tech)) || null;

/**
 * company: { stack: [{ tech, postings }], ofPostings } — the company's technologies with the postings naming each, and its
 * postings in the same window (draft: services/companies/companyTech.js stackFor). resumeTech: the résumé's technologies.
 */
/**
 * The contract's request shape (D192 (3), owner 11-14): company.techStack = [{ name, category, postingShare }] — the share of
 * the company's postings naming it (0–1). draft fills it from its own tables; the tools service standing alone fills it from
 * draft's public GET /api/public/company-stack. Either way this function reads only what it is given.
 * Normalised here to { tech, postings, of } with `of` = 1000 so the share arithmetic is the same as the counted form.
 */
export function normaliseTechStack(company) {
  if (!company) return { stack: [], ofPostings: 0, categoryOf: new Map() };
  const categoryOf = new Map();
  if (Array.isArray(company.techStack)) {
    const stack = company.techStack.filter(x => x && x.name && Number(x.postingShare) > 0).map(x => {
      if (x.category) categoryOf.set(key(x.name), String(x.category));
      return { tech: String(x.name), postings: Math.round(Math.min(1, Number(x.postingShare)) * 1000) };
    }).filter(x => x.postings > 0);
    return { stack, ofPostings: 1000, categoryOf, shares: true };
  }
  return { stack: Array.isArray(company.stack) ? company.stack : [], ofPostings: company.ofPostings, categoryOf };
}

export function techStackFit(company, resumeTech = []) {
  const norm = normaliseTechStack(company);
  const stack = norm.stack.filter(x => x && x.tech && Number(x.postings) > 0);
  if (!stack.length) return { score: null, status: "no_data", reason: "no_company_stack", exact: [], ecosystem: [], gaps: [] };
  // The purpose family: this package's ECOSYSTEMS first; a caller's `category` only for a technology the package has no family
  // for (draft's groups — "data", "devops" — are coarser than a purpose and would match Kafka with Tableau).
  const famOf = (t) => FAMILY_OF.get(key(t)) || (norm.categoryOf.get(key(t)) ? `caller:${norm.categoryOf.get(key(t))}` : null);
  const of = Math.max(Number(norm.ofPostings) || 0, ...stack.map(x => Number(x.postings)));
  const mine = new Map((resumeTech || []).map(t => [key(t), String(t)]));
  const myFamilies = new Map();
  for (const [k, name] of mine) { const f = FAMILY_OF.get(k); if (f && !myFamilies.has(f)) myFamilies.set(f, name); }
  let earned = 0, total = 0;
  const exact = [], ecosystem = [], gaps = [];
  for (const x of stack) {
    const w = Number(x.postings) / of;
    total += w;
    const share = norm.shares ? { share: Math.round(w * 100) / 100 } : { postings: Number(x.postings), of };
    if (mine.has(key(x.tech))) { earned += w; exact.push({ tech: x.tech, ...share }); continue; }
    const fam = famOf(x.tech);
    if (fam && myFamilies.has(fam)) { earned += w * ECOSYSTEM_CREDIT; ecosystem.push({ yours: myFamilies.get(fam), theirs: x.tech, family: fam, ...share }); continue; }
    gaps.push({ tech: x.tech, ...share });
  }
  return { score: Math.round(100 * earned / total), status: "ok", of, exact, ecosystem, gaps };
}

/**
 * The technologies a résumé's text names, out of `names` (the company's stack and every ECOSYSTEMS member): whole word, any
 * case, and "Apache Kafka" also as "Kafka". For a caller with no vocabulary of its own (the tools service standing alone); draft
 * sends `resume.tech` from its own (shared/techVocabulary.js).
 */
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function techMentionedIn(text, names = []) {
  const t = ` ${String(text || "")} `;
  const out = [];
  for (const name of new Set(names.map(String).filter(Boolean))) {
    const forms = [name, name.replace(/^(Apache|Amazon|Google|Microsoft|AWS)\s+/, "")].filter((f, i, a) => f.length > 1 && a.indexOf(f) === i);
    // A short name ("Go", "JAX", "dbt") matches only as written — "go" and "jax" are words.
    if (forms.some(f => new RegExp(`(^|[^A-Za-z0-9+#])${escRe(f)}(?![A-Za-z0-9+#])`, f.length > 3 ? "i" : "").test(t))) out.push(name);
  }
  return out;
}
export const ALL_ECOSYSTEM_TECH = Object.freeze([...new Set(Object.values(ECOSYSTEMS).flat())]);

// ── the weights ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Weights from the caller (Admin → Ops): unknown keys refused, negatives refused, any subset allowed (the rest default). */
export function resolveContextualWeights(input) {
  if (input == null) return { ...DEFAULT_CONTEXTUAL_WEIGHTS };
  if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("contextual weights must be an object of part → weight");
  const out = { ...DEFAULT_CONTEXTUAL_WEIGHTS };
  for (const [k, v] of Object.entries(input)) {
    if (!PARTS.includes(k)) throw new TypeError(`unknown contextual part "${k}" (parts: ${PARTS.join(", ")})`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new TypeError(`contextual weight "${k}" must be a number ≥ 0`);
    out[k] = v;
  }
  if (!PARTS.some(k => out[k] > 0)) throw new TypeError("at least one contextual weight must be above 0");
  return out;
}

// ── the block ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const MAX_LISTED = 8;

/**
 * @param {object} a
 * @param {number|null} a.skillMatch   scoreAtsLocally's score (null when it declined)
 * @param {string[]}    [a.skillsBoth] the report's tier1_matched (listed as "skills you both have")
 * @param {{ text?, category?, subcategory?, level? }} a.posting
 * @param {{ text?, category?, subcategory?, level?, also?, tech? }} a.resume
 * @param {{ stack, ofPostings }|null} [a.company]
 * @param {object} [a.weights]
 */
export function scoreContextual({ skillMatch = null, skillsBoth = [], posting = {}, resume = {}, company = null, weights = null } = {}) {
  const w = resolveContextualWeights(weights);
  const role = roleFit(posting, resume);
  // company.industry (the company record's, when the caller has one) counts as the posting's own words.
  const postingDomains = domainsIn(`${posting?.text || ""}
${company?.industry || ""}`), resumeDomains = domainsIn(resume?.text);
  const sharedDomains = postingDomains.filter(d => resumeDomains.some(x => x.domain === d.domain)).map(d => d.domain);
  if (role.status === "ok" && sharedDomains.length) { role.score = Math.min(100, role.score + DOMAIN_LIFT); role.domain_lift = DOMAIN_LIFT; }
  const resp = responsibilityOverlap(posting?.text, resume?.text);
  const stackNames = normaliseTechStack(company).stack.map(x => x.tech);
  const resumeTech = Array.isArray(resume?.tech) ? resume.tech : techMentionedIn(resume?.text, [...stackNames, ...ALL_ECOSYSTEM_TECH]);
  const tech = techStackFit(company, resumeTech);
  const skill = typeof skillMatch === "number" && Number.isFinite(skillMatch)
    ? { score: Math.round(skillMatch), status: "ok" } : { score: null, status: "no_data", reason: "skill_match_declined" };

  const parts = { skill_match: skill, role_fit: role, responsibility_overlap: resp, tech_stack: tech };
  const used = PARTS.filter(k => parts[k].score != null && w[k] > 0);
  const sum = used.reduce((s, k) => s + w[k], 0);
  for (const k of PARTS) parts[k].weight = used.includes(k) ? Math.round(1000 * w[k] / sum) / 1000 : 0;
  // The skill match leads: without it there is no contextual score either (the scorer declined for want of signal).
  const score = skill.score == null || !sum ? null : Math.round(used.reduce((s, k) => s + parts[k].score * w[k], 0) / sum);

  const similarities = {
    skills: (skillsBoth || []).slice(0, MAX_LISTED),
    ecosystem: tech.ecosystem.slice(0, MAX_LISTED).map(({ yours, theirs, family }) => ({ yours, theirs, family })),
    stack: tech.exact.slice(0, MAX_LISTED).map(x => x.tech),
    domains: sharedDomains,
    role: role.status === "ok" && (role.relation === "same_role" || role.relation === "also_fits") && !role.level_gap ? [role.relation] : [],
    responsibilities: resp.matched.slice(0, MAX_LISTED),
  };
  const dissimilarities = [];
  for (const { tech: name, ...share } of tech.gaps.slice(0, MAX_LISTED)) dissimilarities.push({ kind: "stack_gap", tech: name, ...share, action: "learn", penalty: true });
  for (const m of resp.missing.slice(0, 4)) dissimilarities.push({ kind: "responsibility", phrase: m, action: "evidence", penalty: true });
  if (role.status === "ok" && role.relation !== "same_role" && role.relation !== "also_fits") {
    dissimilarities.push({ kind: "role", relation: role.relation, posting: role.posting.subcategory, resume: role.resume.subcategory, penalty: true });
  }
  if (role.status === "ok" && role.level_gap) dissimilarities.push({ kind: "level", posting: role.posting.level, resume: role.resume.level, gap: role.level_gap, penalty: true });
  for (const d of postingDomains.filter(d => !sharedDomains.includes(d.domain))) {
    dissimilarities.push({ kind: "domain", theirs: d.domain, yours: resumeDomains.map(x => x.domain), terms: d.terms.slice(0, 3), penalty: false });
  }
  return { contract: CONTEXTUAL_CONTRACT, score, weights: w, parts, similarities, dissimilarities };
}
