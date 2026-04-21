import crypto from "crypto";
import { inferWorkType } from "./jobNormalization.js";

function cleanText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normaliseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function slugify(value) {
  return cleanText(value, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function importedJobDedupeKey(sourceKey, rawJob = {}) {
  const externalJobId = cleanText(rawJob.externalJobId || rawJob.jobId || rawJob.listingId || rawJob.id, 255);
  if (externalJobId) return `${sourceKey}:${externalJobId}`;

  const canonicalUrl = normaliseUrl(rawJob.jobUrl || rawJob.url || rawJob.applyUrl || rawJob.externalUrl || "");
  if (canonicalUrl) return `${sourceKey}:${canonicalUrl.toLowerCase()}`;

  const title = slugify(rawJob.title || rawJob.role);
  const company = slugify(rawJob.company);
  const location = slugify(rawJob.location);
  return `${sourceKey}:fallback:${hashValue([title, company, location].join("|"))}`;
}

export function normaliseImportedJob(sourceKey, rawJob = {}) {
  const title = cleanText(rawJob.title || rawJob.role, 255);
  if (!title) return null;

  const jobUrl = normaliseUrl(rawJob.jobUrl || rawJob.url || rawJob.externalUrl || rawJob.applyUrl || "");
  const applyUrl = normaliseUrl(rawJob.applyUrl || rawJob.jobUrl || rawJob.url || "");
  const company = cleanText(rawJob.company, 255) || "Unknown company";
  const location = cleanText(rawJob.location, 255) || null;
  const description = String(rawJob.description || rawJob.descriptionText || "").trim().slice(0, 20000) || null;
  const sourcePlatform = cleanText(rawJob.sourcePlatform || "linkedin", 40).toLowerCase();
  const workType = cleanText(rawJob.workType || inferWorkType([location, title, description].filter(Boolean).join(" ")) || "", 40) || null;
  const employmentType = cleanText(rawJob.employmentType || "full-time", 40).toLowerCase();
  const postedAt = cleanText(rawJob.postedAt || rawJob.postedDate || "", 80) || null;
  const compensation = cleanText(rawJob.compensation || rawJob.salary || "", 255) || null;
  const companyIconUrl = normaliseUrl(rawJob.companyIconUrl || rawJob.logoUrl || "");
  const externalJobId = cleanText(rawJob.externalJobId || rawJob.jobId || rawJob.listingId || rawJob.id, 255) || null;
  const dedupeKey = importedJobDedupeKey(sourceKey, rawJob);

  return {
    sourceKey,
    sourcePlatform,
    externalJobId,
    dedupeKey,
    title,
    company,
    location,
    jobUrl,
    applyUrl,
    workType,
    employmentType,
    postedAt,
    compensation,
    description,
    companyIconUrl,
    payloadJson: JSON.stringify(rawJob),
  };
}

export function publicImportedJob(row) {
  return {
    id: row.id,
    jobId: `imported:${row.id}`,
    importedJobId: row.id,
    boardSource: row.source_key,
    sourceKey: row.source_key,
    source: row.source_label,
    sourcePlatform: row.source_platform,
    externalJobId: row.external_job_id,
    company: row.company,
    title: row.title,
    location: row.location,
    url: row.job_url,
    applyUrl: row.apply_url,
    workType: row.work_type,
    employmentType: row.employment_type,
    compensation: row.compensation,
    postedAt: row.posted_at,
    description: row.description,
    companyIconUrl: row.company_icon_url,
    visited: !!row.visited,
    starred: !!row.starred,
    disliked: !!row.disliked,
    alreadyApplied: !!row.applied,
    importedAt: row.last_imported_at,
    importCount: row.import_count,
  };
}
