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
    "Website":    "github_url", "City":       "city",
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
    "Website": "github_url", "Location": "location",
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

export const getPlatformLabelMap = (platform) => PLATFORM_LABEL_MAPS[platform] || {};
export const usesIframe = (platform) =>
  platform === "workday" || platform === "icims" || platform === "taleo";
