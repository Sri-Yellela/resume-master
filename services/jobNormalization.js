// ============================================================
// services/jobNormalization.js — Pure job item normalization helpers
// ============================================================
// Extracted from server.js Phase 1 modularization.
// All functions are pure (no DB or Express dependencies).
//
// Used by: server.js scrape ingest pipeline
// ============================================================

import crypto from "crypto";

export const NON_FULLTIME_TERMS = [
  "intern","internship","co-op","coop","contract","contractor",
  "temporary","temp","part-time","part time","freelance","seasonal",
];

export function inferWorkType(text = "") {
  const t = text.toLowerCase();
  if (t.includes("remote")) return "Remote";
  if (t.includes("hybrid")) return "Hybrid";
  return "Onsite";
}

export function jobHash(job) {
  const key = `${(job.company||"").toLowerCase().trim()}|${(job.title||"").toLowerCase().trim()}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

// Maps a single HarvestAPI LinkedIn item to our internal schema.
// Real LinkedIn job IDs are used as primary keys (INSERT OR IGNORE — first write wins).
export function normaliseItem(raw) {
  const company =
    raw.company?.name ||
    raw.companyName   ||
    raw.employer?.name ||
    "";

  const title = raw.title || raw.jobTitle || "";

  const description =
    raw.description?.text ||
    raw.descriptionText   ||
    (typeof raw.description === "string" ? raw.description : "") ||
    "";

  const descriptionHtml =
    raw.description?.html ||
    raw.descriptionHtml   ||
    null;

  const location =
    (typeof raw.location === "string" ? raw.location : "") ||
    (raw.location?.city && raw.location?.state
      ? `${raw.location.city}, ${raw.location.state}`
      : raw.location?.city || raw.location?.state || "") ||
    "United States";

  let workTypeHint = "";
  if (raw.workplaceType)                                              workTypeHint = String(raw.workplaceType).toLowerCase();
  else if (Array.isArray(raw.workplaceTypes) && raw.workplaceTypes.length) workTypeHint = raw.workplaceTypes[0].toLowerCase();
  else if (raw.remoteAllowed)                                         workTypeHint = "remote";

  const applyUrl =
    raw.applyMethod?.companyApplyUrl ||
    raw.applyUrl      ||
    raw.apply_url     ||
    raw.jobPostingUrl ||
    null;

  const url = raw.linkedinUrl || raw.url || raw.jobUrl || null;

  const postedAt =
    raw.listingDate ||
    raw.listedAt    ||
    raw.postedAt    ||
    raw.datePosted  ||
    null;

  const EMP_TYPE_MAP = {
    "full_time":  "full-time",
    "part_time":  "part-time",
    "full-time":  "full-time",
    "part-time":  "part-time",
    "contract":   "contract",
    "internship": "internship",
    "temporary":  "temporary",
    "temp":       "temporary",
    "other":      "full-time",
  };
  const rawJobType = (
    raw.contractType   ||
    raw.employmentType ||
    raw.jobType        ||
    ""
  ).toLowerCase().replace(/\s+/g, "_");
  const jobType = EMP_TYPE_MAP[rawJobType] || (rawJobType ? "full-time" : "");

  // Salary — HarvestAPI nested object, or fall back to text compensation fields
  let salaryMin      = raw.salary?.min      ?? null;
  let salaryMax      = raw.salary?.max      ?? null;
  let salaryCurrency = raw.salary?.currency || null;
  if (salaryMin == null) {
    const salText = raw.compensationText || raw.compensation || raw.salaryRange || "";
    if (typeof salText === "string" && salText.trim()) {
      // Match patterns like "$80K–$120K", "$80,000 - $120,000", "80000-120000"
      const salRe = /\$?([\d,]+)\s*[Kk]?\s*[-–to]+\s*\$?([\d,]+)\s*[Kk]?/;
      const salM  = salText.replace(/,/g,"").match(salRe);
      if (salM) {
        const lo = parseFloat(salM[1]);
        const hi = parseFloat(salM[2]);
        const isK = /[Kk]/.test(salText);
        salaryMin = isK ? lo * 1000 : lo;
        salaryMax = isK ? hi * 1000 : hi;
        const curM = salText.match(/\b(USD|CAD|GBP|EUR|AUD)\b/i);
        if (curM) salaryCurrency = curM[1].toUpperCase();
      } else {
        // Single value: "$120K/yr", "$120,000"
        const singRe = /\$?([\d,]+)\s*[Kk]?/;
        const singM  = salText.replace(/,/g,"").match(singRe);
        if (singM) {
          const n = parseFloat(singM[1]);
          const v = /[Kk]/.test(salText) ? n * 1000 : n;
          if (v > 10000) { salaryMin = v; salaryMax = v; }
        }
      }
    }
  }

  // Applicant count
  const applicantCount = raw.applicants ?? raw.applies ?? raw.applicantCount ?? null;

  // Company logo (use from HarvestAPI if available, otherwise clearbit fallback later)
  const companyLogoUrl = raw.company?.logo || raw.companyLogo || null;

  // Real LinkedIn job ID (string)
  const jobId = raw.id != null ? String(raw.id) : (raw.jobId != null ? String(raw.jobId) : null);

  return {
    _source: "LinkedIn",
    jobId,
    company,
    title,
    description,
    descriptionHtml,
    location,
    workTypeHint,
    applyUrl,
    url,
    postedAt,
    jobType,
    salaryMin,
    salaryMax,
    salaryCurrency,
    applicantCount,
    companyLogoUrl,
  };
}

export function isFullTimeNorm(item) {
  const text = [item.title, item.jobType, item.description].join(" ").toLowerCase();
  return !NON_FULLTIME_TERMS.some(t => text.includes(t));
}

export function isEmploymentTypeWanted(item, wantedTypes) {
  // If 3+ types selected, keep everything
  if (wantedTypes.length >= 3) return true;

  const text = [item.title, item.jobType, item.description].join(" ").toLowerCase();

  const signals = {
    "full-time":  ["full-time", "full time", "permanent"],
    "contract":   ["contract", "contractor", "freelance", "temp", "temporary"],
    "internship": ["intern", "internship", "co-op", "coop"],
  };

  // No type signal in text — assume full-time (most roles don't say it explicitly)
  const hasAnySignal = Object.values(signals).flat().some(s => text.includes(s));
  if (!hasAnySignal) return wantedTypes.includes("full-time");

  // Check if any wanted type's signals match
  return wantedTypes.some(type => signals[type]?.some(s => text.includes(s)));
}

export function parseYearsExperience(description = "") {
  const patterns = [
    { re:/(\d+)\s*\+\s*years?\s+(?:of\s+)?experience/i,                              type:"plus"  },
    { re:/(\d+)\s*[-–]\s*(\d+)\s*years?\s+(?:of\s+)?experience/i,                   type:"range" },
    { re:/(\d+)\s*to\s*(\d+)\s*years?\s+(?:of\s+)?(?:\w+\s+)?experience/i,          type:"range" },
    { re:/minimum\s+(\d+)\s*years?/i,                                                type:"min"   },
    { re:/at\s+least\s+(\d+)\s*years?/i,                                             type:"min"   },
    { re:/(\d+)\s*or\s*more\s*years?(?:\s+of)?/i,                                   type:"plus"  },
    { re:/(\d+)\s*years?\s+(?:of\s+)?(?:professional|hands-on|industry)\s+experience/i, type:"exact" },
    { re:/(\d+)\s*years?\s+(?:of\s+)?(?:relevant\s+)?experience/i,                  type:"exact" },
  ];
  for (const { re, type } of patterns) {
    const m = description.match(re);
    if (m) {
      if (type === "range") return { min: Number(m[1]), max: Number(m[2]), raw: m[0] };
      if (type === "plus")  return { min: Number(m[1]), max: null,         raw: m[0] };
      return { min: Number(m[1]), max: Number(m[1]), raw: m[0] };
    }
  }
  return { min: null, max: null, raw: null };
}

export function ghostJobScoreNorm(item) {
  let score = 0;
  const desc = item.description.toLowerCase();
  const url  = (item.url || "").toLowerCase();
  if (!url || url === "#")                                                score += 3;
  if (url.includes("linkedin.com/jobs/view") && !url.includes("apply")) score += 1;
  if (desc.length < 150)                                                 score += 2;
  if (!item.company || item.company === "Unknown")                       score += 2;
  if (item.title.toLowerCase().includes("multiple") ||
      item.title.toLowerCase().includes("various"))                      score += 2;
  return score;
}

export function isReposted(job) {
  return ((job.title||"")+" "+(job.description||"")).toLowerCase().includes("reposted");
}
