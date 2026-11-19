// @draft/ats-scorer — CLAIM PLAUSIBILITY: "does this add up?" (draft's WORKLOG D192 (4d), owner 11-14: "the ATS engine should be
// able to say if something adds up, referring back to the technographics … flag anything that doesn't line up").
//
// Pure. No database, no network, no model, no embedding. For each experience entry on a résumé, the bullets are checked against
// what the CALLER knows about that employer (its stack from its own postings, its industry, the kinds of roles it posts, its
// size) and against when a technology first existed. The caller resolves an entry's employer to its record (draft: its company
// tables; the tools service: draft's public company-stack) — this file only compares.
//
//   experienceEntries(text) → [{ header, parts, title, start, end, bullets }]
//   checkPlausibility({ entries, companyFor, vocabulary, asOf }) → [{ employer, header, status, confirmed, flags }]
//
// THE RULES (each a lookup):
//   (i)   tech: a technology a bullet names is CONFIRMED when the employer's known stack has it; NEUTRAL when the stack has another
//         of the same purpose, or the employer has no stack on record (never flag the unknown); UNLIKELY only when the stack is
//         known (≥ STACK_MIN technologies) and neither it nor anything of its purpose is in it.
//   (ii)  domain: a bullet that describes work of a kind (sales incentives, payroll, patient care …) is UNLIKELY when the
//         employer's postings are known (≥ DOMAIN_MIN classified) and none is in a family that does that work, and its industry
//         does not name it either.
//   (iii) role: "led a team of 12" under an intern / junior title, or at a company with fewer than twice that many people, is UNLIKELY.
//   (iv)  timeline: a technology named in a role that ended before it first existed is UNLIKELY.
// ⛔ A flag is a WARNING, never a rejection, and never changes a score — the scores are computed elsewhere and never read this.
// Each flag carries a stable `key` (kind · employer · the bullet · the technology) so a person's dismissal survives a re-score.

import { ECOSYSTEMS, ecosystemOf, techMentionedIn, ALL_ECOSYSTEM_TECH } from "./contextual.js";

export const PLAUSIBILITY_VERSION = "1.0.0";
export const STACK_MIN = 3, DOMAIN_MIN = 10;

// ── the experience section, as entries ──────────────────────────────────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const POINT = `(?:${MONTH}\\s+(\\d{4})|(\\d{1,2})\\s*/\\s*(\\d{4})|(\\d{4}))`;
const RANGE = new RegExp(`(?<![\\d/])${POINT}\\s*(?:-|–|—|to|until|through)\\s*(?:${POINT}|(present|current|now|today|ongoing))(?![\\d/])`, "i");
const EXPERIENCE_HEADING = /^\s*(?:professional\s+|work\s+|relevant\s+)?(?:experience|employment(?:\s+history)?|work\s+history|career\s+history)\s*:?\s*$/i;
const OTHER_HEADING = /^\s*(?:summary|profile|objective|about|education|(?:technical\s+)?skills|core\s+competencies|projects?|certifications?|publications?|awards?|volunteer\w*|interests|languages|references|coursework)\s*:?\s*$/i;
const BULLET = /^\s*(?:[-•*·▪◦‣–]|\d+[.)])\s+/;
const ROLE_WORD = /\b(engineer|developer|manager|analyst|designer|scientist|director|lead|specialist|consultant|associate|coordinator|architect|administrator|officer|accountant|technician|intern|head|vp|president|founder|recruiter|researcher|representative|executive|assistant|nurse|teacher)\b/i;

const yearOf = (monthName, year, monthNum, yearOfNum, yearOnly) => Number(year || yearOfNum || yearOnly) || null;

/** The résumé's experience entries: a header line (title / employer), its dates, its bullets. Pure. */
export function experienceEntries(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inExp = false, saw = false;
  const body = [];
  for (const l of lines) {
    if (l.length <= 60 && EXPERIENCE_HEADING.test(l)) { inExp = true; saw = true; continue; }
    if (l.length <= 60 && OTHER_HEADING.test(l)) { inExp = false; continue; }
    if (inExp) body.push(l);
  }
  const src = saw ? body : lines;
  const out = [];
  let cur = null;
  for (const raw of src) {
    const line = raw.trim();
    if (!line) continue;
    if (BULLET.test(line)) { if (cur) cur.bullets.push(line.replace(BULLET, "").trim()); continue; }
    const m = RANGE.exec(line);
    const rest = m ? line.replace(m[0], "").replace(/[\s|·,–—-]+$/, "").replace(/^[\s|·,–—-]+/, "").trim() : line;
    if (m && !rest && cur && cur.start == null) {           // a date line under its header
      cur.start = yearOf(m[1], m[2], m[3], m[4], m[5]);
      cur.end = m[11] ? null : yearOf(m[6], m[7], m[8], m[9], m[10]);
      cur.ongoing = !!m[11];
      continue;
    }
    if (line.length > 140) { if (cur) cur.bullets.push(line); continue; }   // a paragraph, not a header
    cur = { header: rest || line, parts: [], title: null, start: null, end: null, ongoing: false, bullets: [] };
    if (m) { cur.start = yearOf(m[1], m[2], m[3], m[4], m[5]); cur.end = m[11] ? null : yearOf(m[6], m[7], m[8], m[9], m[10]); cur.ongoing = !!m[11]; }
    const parts = cur.header.split(/\s+[—–-]\s+|\s+at\s+|\s*,\s*|\s*\|\s*|\s+@\s+/).map(p => p.trim()).filter(p => p && p.length <= 80);
    cur.title = parts.find(p => ROLE_WORD.test(p)) || null;
    cur.parts = parts.filter(p => p !== cur.title);
    if (!cur.parts.length && parts.length) cur.parts = parts;
    out.push(cur);
  }
  return out.filter(e => e.bullets.length);
}

// ── what each check knows ───────────────────────────────────────────────────────────────────────────────────────────
// (ii) work of a kind, and the role families (draft's taxonomy category ids) that do it
export const DOMAIN_WORK = Object.freeze([
  { id: "sales", words: "sales", re: /\b(sales (?:incentive|quota|pipeline|team|compensation|targets?)|incentive compensation|commission plans?|quota attainment|account executives?|deal desk)\b/i, families: ["sales-cs", "business-finance"] },
  { id: "marketing", words: "marketing", re: /\b(marketing campaigns?|paid (?:search|social) campaigns?|demand generation|email marketing|brand campaigns?)\b/i, families: ["marketing"] },
  { id: "accounting", words: "accounting", re: /\b(general ledger|accounts (?:payable|receivable)|month-end close|financial statements|tax returns|payroll processing)\b/i, families: ["business-finance", "people-hr"] },
  { id: "recruiting", words: "recruiting", re: /\b(talent acquisition|benefits administration|recruited \d+ (?:hires|engineers|candidates)|full-cycle recruiting)\b/i, families: ["people-hr"] },
  { id: "legal", words: "legal work", re: /\b(litigation|legal counsel|patent filings|contract negotiations? for)\b/i, families: ["legal"] },
  { id: "clinical", words: "patient care", re: /\b(patient care|clinical trials?|bedside|nursing care)\b/i, families: ["healthcare", "biomedical"] },
  { id: "construction", words: "construction", re: /\b(construction sites?|job ?sites?|site superintendent)\b/i, families: ["civil-construction", "project-program-management"] },
]);
// (iii) a team size a bullet claims
const TEAM = /\b(?:led|managed|supervised|ran|built and led|grew)\s+(?:a\s+)?(?:team|group|org(?:anization)?|department)\s+of\s+(\d{1,4})\b|\bmanag(?:ed|ing)\s+(\d{1,4})\s+(?:engineers|people|reports|direct reports|staff|employees)\b/i;
const JUNIOR = /\b(intern|internship|junior|jr\.?|trainee|apprentice|graduate|entry[- ]level|co-?op)\b/i;
// (iv) the year a technology first existed (public release); a technology not here is never timeline-checked
export const TECH_FIRST_YEAR = Object.freeze({
  "GPT-4": 2023, "ChatGPT": 2022, "OpenAI API": 2020, "LangChain": 2022, "LlamaIndex": 2022, "vLLM": 2023, "Hugging Face": 2016,
  "Kubernetes": 2014, "Docker": 2013, "Terraform": 2014, "Pulumi": 2018, "Helm": 2016, "Argo CD": 2018, "Istio": 2017,
  "React": 2013, "React Native": 2015, "Next.js": 2016, "Vue": 2014, "Svelte": 2016, "Angular": 2016, "SwiftUI": 2019,
  "Jetpack Compose": 2021, "Flutter": 2017, "TypeScript": 2012, "Swift": 2014, "Kotlin": 2016, "Rust": 2015, "Go": 2009,
  "Dart": 2011, "Elixir": 2012, "GraphQL": 2015, "gRPC": 2016, "FastAPI": 2018, "Tailwind CSS": 2017, "Vite": 2020,
  "Snowflake": 2014, "dbt": 2016, "Databricks": 2013, "Apache Airflow": 2015, "Apache Kafka": 2011, "Apache Spark": 2014,
  "Apache Flink": 2014, "ClickHouse": 2016, "BigQuery": 2011, "Redshift": 2013, "DynamoDB": 2012, "PyTorch": 2016,
  "TensorFlow": 2015, "JAX": 2018, "Keras": 2015, "XGBoost": 2014, "MLflow": 2018, "Kubeflow": 2018, "SageMaker": 2017,
  "Vertex AI": 2021, "Ray": 2017, "ONNX": 2017, "GitHub Actions": 2019, "Supabase": 2020, "Vercel": 2015, "Cypress": 2017, "Playwright": 2020,
});

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (kind, employer, bullet, tech = "") => `${kind}|${norm(employer).slice(0, 60)}|${norm(bullet).slice(0, 120)}|${norm(tech)}`;
const poss = (name) => (/s$/i.test(String(name)) ? `${name}'` : `${name}'s`);
const shareWords = (n, of) => (Number.isFinite(n) && Number.isFinite(of) && of > 0 ? `${n} of ${of}` : "");

/**
 * company (from the caller, per entry, or null when it has no record):
 *   { name, stack: [{ tech, postings }] | techStack: [{ name, postingShare }], ofPostings, industry, families: { [categoryId]: n },
 *     classified, employees }
 */
function stackOf(company) {
  if (!company) return { list: [], of: 0 };
  if (Array.isArray(company.techStack)) return { list: company.techStack.filter(t => t?.name).map(t => ({ tech: t.name, share: t.postingShare })), of: null };
  if (Array.isArray(company.stack)) return { list: company.stack.filter(t => t?.tech).map(t => ({ tech: t.tech, postings: t.postings })), of: company.ofPostings ?? null };
  return { list: [], of: 0 };
}

export function checkPlausibility({ entries = [], companyFor = () => null, vocabulary = [], asOf = new Date().getFullYear() } = {}) {
  const asOfYear = typeof asOf === "number" && asOf < 3000 ? asOf : new Date(asOf).getFullYear();
  const vocab = [...new Set([...ALL_ECOSYSTEM_TECH, ...Object.keys(TECH_FIRST_YEAR), ...vocabulary])];
  return entries.map(entry => {
    const company = (() => { try { return companyFor(entry) || null; } catch { return null; } })();
    const employer = company?.name || entry.parts?.[0] || entry.header;
    const confirmed = [], flags = [];
    const stack = stackOf(company);
    const inStack = new Map(stack.list.map(t => [t.tech.toLowerCase(), t]));
    const families = new Set(stack.list.map(t => ecosystemOf(t.tech)).filter(Boolean));
    const endYear = entry.ongoing || entry.end == null ? (entry.start != null ? asOfYear : null) : entry.end;
    const junior = JUNIOR.test(entry.title || entry.header || "");
    for (const bullet of entry.bullets || []) {
      // (i) tech
      for (const tech of techMentionedIn(bullet, [...vocab, ...stack.list.map(t => t.tech)])) {
        const hit = inStack.get(tech.toLowerCase());
        if (hit) {
          const evidence = hit.postings != null ? shareWords(hit.postings, stack.of) : Number.isFinite(hit.share) ? `${Math.round(hit.share * 100)}%` : "";
          if (!confirmed.some(c => c.tech === tech)) confirmed.push({ tech, evidence });
        } else if (stack.list.length >= STACK_MIN && !(ecosystemOf(tech) && families.has(ecosystemOf(tech)))
          && !(TECH_FIRST_YEAR[tech] && endYear != null && endYear < TECH_FIRST_YEAR[tech])) {   // the timeline flag below says it better
          const fam = ecosystemOf(tech);
          flags.push({ kind: "tech", tech, bullet, key: keyOf("tech", employer, bullet, tech),
            reason: `You list ${tech} at ${employer}, but its postings never mention it${fam ? ` or anything like it` : ""} — check this` });
        }
        // (iv) timeline
        const first = TECH_FIRST_YEAR[tech];
        if (first && endYear != null && endYear < first) {
          flags.push({ kind: "timeline", tech, bullet, key: keyOf("timeline", employer, bullet, tech),
            reason: `${tech} came out in ${first}, after this role ended (${endYear})` });
        }
      }
      // (ii) domain
      const classified = Number(company?.classified) || Object.values(company?.families || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      if (company && classified >= DOMAIN_MIN) {
        for (const d of DOMAIN_WORK) {
          if (!d.re.test(bullet)) continue;
          const posts = d.families.some(f => (company.families || {})[f] > 0);
          const industrySays = new RegExp(`\\b${d.id}\\b|\\b${d.words}\\b`, "i").test(String(company.industry || ""));
          if (!posts && !industrySays) flags.push({ kind: "domain", bullet, key: keyOf("domain", employer, bullet, d.id),
            reason: `This bullet describes ${d.words}, but ${poss(employer)} ${classified} postings are in other kinds of work — does it describe real work you did here?` });
        }
      }
      // (iii) role
      const t = TEAM.exec(bullet);
      const n = t ? Number(t[1] || t[2]) : 0;
      if (n >= 5 && junior) flags.push({ kind: "role", bullet, key: keyOf("role", employer, bullet),
        reason: `Leading ${n} people is unusual for ${entry.title ? `a ${entry.title.toLowerCase()} role` : "this title"}` });
      else if (n >= 5 && Number(company?.employees) > 0 && n > Number(company.employees) / 2) flags.push({ kind: "role", bullet, key: keyOf("role", employer, bullet),
        reason: `Leading ${n} people at ${employer}, which has about ${company.employees} — check this` });
    }
    const status = !company ? (flags.length ? "flags" : "no_data") : flags.length ? "flags" : "all_confirmed";
    return { employer, header: entry.header, start: entry.start, end: entry.ongoing ? null : entry.end, known: !!company, status, confirmed, flags };
  });
}
