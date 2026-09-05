// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
// services/platformDetector.js — ATS platform detection + per-platform selectors
"use strict";

const URL_ATS_MAP = [
  { pattern: "greenhouse.io",      platform: "greenhouse" },
  { pattern: "boards.greenhouse",  platform: "greenhouse" },
  { pattern: "jobs.lever.co",      platform: "lever" },
  { pattern: "lever.co",           platform: "lever" },
  { pattern: "myworkdayjobs.com",  platform: "workday" },
  { pattern: "workday.com",        platform: "workday" },
  { pattern: "icims.com",          platform: "icims" },
  { pattern: "jobs.icims.com",     platform: "icims" },
  { pattern: "linkedin.com",       platform: "linkedin" },
  { pattern: "taleo.net",          platform: "taleo" },
  { pattern: "ashbyhq.com",        platform: "ashby" },
  { pattern: "ashby.com",          platform: "ashby" },
  { pattern: "jobvite.com",        platform: "jobvite" },
  { pattern: "smartrecruiters.com",platform: "smartrecruiters" },
  { pattern: "workable.com",       platform: "workable" },
  { pattern: "bamboohr.com",       platform: "bamboohr" },
];

const PLATFORM_LABEL_MAPS = {
  greenhouse: {
    "First Name": "first_name", "Last Name":  "last_name",
    "Email":      "email",      "Phone":      "phone",
    "LinkedIn":   "linkedin_url","GitHub":    "github_url",
    "Website":    "website_url", "City":      "city",
    "State":      "state",      "Zip":        "zip",
    "Location":   "location",
    "Sponsorship": "requires_sponsorship", "Work Authorization": "work_authorization",
    "Clearance": "clearance_level", "Years of Experience": "years_experience",
  },
  lever: {
    "Full name":      "full_name", "Email address": "email",
    "Phone":          "phone",     "LinkedIn":      "linkedin_url",
    "GitHub":         "github_url","Location":      "location",
    "Work authorization": "work_authorization", "Sponsorship": "requires_sponsorship",
    "Clearance": "clearance_level", "Years of experience": "years_experience",
  },
  workday: {
    "First Name":      "first_name",    "Last Name":    "last_name",
    "Email":           "email",          "Phone Number": "phone",
    "Address Line 1":  "address_line1", "Address Line 2":"address_line2",
    "City":            "city",           "State":        "state",
    "Postal Code":     "zip",            "LinkedIn URL": "linkedin_url",
    "Work Authorization": "work_authorization", "Sponsorship": "requires_sponsorship",
    "Security Clearance": "clearance_level", "Years of Experience": "years_experience",
  },
  generic: {
    "First Name": "first_name", "Last Name": "last_name",
    "Full Name": "full_name", "Name": "full_name",
    "Email": "email", "Email Address": "email",
    "Phone": "phone", "Mobile": "phone",
    "LinkedIn": "linkedin_url", "GitHub": "github_url",
    "Website": "website_url", "Location": "location",
    "City": "city", "State": "state", "Zip": "zip", "Postal": "zip",
    "Work Authorization": "work_authorization", "Authorized to Work": "work_authorization",
    "Sponsorship": "requires_sponsorship", "Visa": "visa_type",
    "Clearance": "clearance_level", "Years of Experience": "years_experience",
  },
  icims: {
    "First Name": "first_name", "Last Name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "City":       "city",       "State":     "state",
    "Zip":        "zip",
  },
  linkedin: {
    "First name":          "first_name", "Last name":    "last_name",
    "Email address":       "email",      "Mobile phone number": "phone",
    "City":                "city",       "LinkedIn profile URL":"linkedin_url",
  },
  taleo: {
    "First Name": "first_name", "Last Name":  "last_name",
    "Email":      "email",      "Phone":      "phone",
    "Address":    "address_line1","City":     "city",
    "State":      "state",      "Zip Code":   "zip",
  },
  ashby: {
    "First Name": "first_name", "Last Name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "LinkedIn":   "linkedin_url","Location": "location",
  },
  jobvite: {
    "First Name": "first_name", "Last Name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "City":       "city",       "State":     "state",
  },
  smartrecruiters: {
    "First Name": "first_name", "Last Name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "City":       "city",       "Postal Code": "zip",
  },
  workable: {
    "First name": "first_name", "Last name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "City":       "city",
  },
  bamboohr: {
    "First Name": "first_name", "Last Name": "last_name",
    "Email":      "email",      "Phone":     "phone",
    "City":       "city",       "State":     "state",
  },
};

export function detectPlatformFromUrl(url) {
  if (!url) return "generic";
  const lower = url.toLowerCase();
  for (const { pattern, platform } of URL_ATS_MAP) {
    if (lower.includes(pattern)) return platform;
  }
  return "generic";
}

export async function detectPlatformFromPage(page) {
  try {
    const content = await page.content();
    const lower = content.toLowerCase();
    if (lower.includes("greenhouse") || lower.includes("grnh.se")) return "greenhouse";
    if (lower.includes("lever.co") || lower.includes("lever-apply")) return "lever";
    if (lower.includes("workday") || lower.includes("myworkdayjobs")) return "workday";
    if (lower.includes("icims")) return "icims";
    if (lower.includes("taleo")) return "taleo";
    if (lower.includes("ashby") || lower.includes("ashbyhq")) return "ashby";
    if (lower.includes("jobvite")) return "jobvite";
    if (lower.includes("smartrecruiters")) return "smartrecruiters";
    if (lower.includes("workable")) return "workable";
    if (lower.includes("bamboohr")) return "bamboohr";
  } catch {}
  return "generic";
}

/**
 * A provider's label map EXTENDS the generic one rather than replacing it.
 *
 * Audited across all 12 providers: the non-generic maps carry 5–15 entries against generic's 22, and
 * NONE of them had a plain "Name" — so on ashby (whose only name control is `_systemfield_name`
 * labelled "Name") and on greenhouse ("Legal Name"), the candidate's name resolved by a fuzzy guess
 * or not at all, purely because the provider map shadowed generic instead of adding to it. The same
 * shadowing hid Location, LinkedIn, Work Authorization and Sponsorship on eight providers.
 *
 * Provider entries come FIRST so a provider-specific spelling ("Email address" on lever, "Phone
 * Number" on workday) is tried before the generic one, and a provider value wins on a key collision.
 * Note the map keys are NEEDLES searched inside a form's label, so a longer provider spelling cannot
 * match a shorter label — which is why the generic fallback matters rather than being redundant.
 */
export const getPlatformLabelMap = (platform, derived = null) => {
  const base = PLATFORM_LABEL_MAPS.generic || {};
  const specific = PLATFORM_LABEL_MAPS[platform];
  const authored = (!specific || specific === base)
    ? { ...base }
    : {
        ...specific,
        ...Object.fromEntries(Object.entries(base).filter(([label]) => !(label in specific))),
      };

  // ── TASK H: DERIVED MAPPINGS FILL GAPS. THEY NEVER OVERRIDE. ────────────────────────────────
  //
  // `derived` is the CONFIRMED half of form_field_mappings, learned from real captured form
  // structure (services/kb/formFieldMappings.js). It is merged UNDER the hand-written entries, so
  // an authored label always wins a collision.
  //
  // That direction is the safety property, not a preference. The authored maps are where the
  // eligibility labels live — "Sponsorship", "Work Authorization", "Clearance", "Years of
  // Experience" — and they are there because those answers must resolve by an EXACT, reviewed
  // mapping or not at all. If a derived entry could shadow one, a table built from labels scraped
  // off employer forms would be deciding how an attestation is answered. It cannot: the derived
  // table refuses to store those keys at all, and this merge order means that even if one existed
  // it could not take effect.
  if (!derived) return authored;
  return {
    ...Object.fromEntries(Object.entries(derived).filter(([label]) => !(label in authored))),
    ...authored,
  };
};
export const usesIframe = (platform) =>
  platform === "workday" || platform === "icims" || platform === "taleo";
