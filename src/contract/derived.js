// The DERIVED half of the contract: shapes produced by EXECUTING the code that builds them.
//
// Each has one chokepoint every response passes through — scoreAtsLocally for the ATS report, the
// model path for a usage record, the claim guard for a violation — so running it is the honest way
// to learn its shape. A regex agrees with the source's text; execution agrees with its behaviour.
//
// ⛔ A DERIVED SHAPE IS ONLY AS WIDE AS ITS SCENARIOS. A field that can be null but is never null in
// any scenario below would be declared non-null. So every scenario exists to hit a VARIANT, and is
// named for it; the envelope harness then checks real responses against the result, which is what
// catches a variant these missed.
import { scoreAtsLocally, buildRuntimeAtsBasis } from "@draft/ats-scorer";
import { callAnthropic } from "../model/anthropicCall.js";
import { checkResumeClaims } from "../integrity/resumeClaimGuard.js";
import { infer } from "./schema.js";

const SKILLS = ["Python", "Kubernetes", "Kafka", "Terraform", "AWS", "PostgreSQL"];
const job = (over = {}) => ({
  title: "Backend Engineer", company: "Acme",
  description: "Python, Kubernetes, Kafka, Terraform, AWS and PostgreSQL. Requires 5 years of experience.",
  skills_json: JSON.stringify(SKILLS.map(skill => ({ skill, type: "hard" }))), ...over,
});
const basis = (over = {}) => buildRuntimeAtsBasis({
  resumeText: "Python Kubernetes Kafka engineer. Built distributed systems on AWS.",
  signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: 4, structuredFacts: {} },
  domainProfile: { seniority: "mid" }, ...over,
});

export const ATS_SCENARIOS = {
  "scorable, unweighted": () => scoreAtsLocally({ job: job(), runtimeBasis: basis() }),
  "weighted": () => scoreAtsLocally({ job: job(), runtimeBasis: basis(),
    termWeights: new Map([["python", 2], ["kafka", 0.5], ["terraform", 3]]) }),
  "declined — too little signal": () => scoreAtsLocally({ job: { title: "Role", company: "X", description: "Join us." }, runtimeBasis: basis() }),
  "seniority cap applied": () => scoreAtsLocally({ job: job({ title: "Backend Engineer Intern" }),
    runtimeBasis: basis({ domainProfile: { seniority: "senior" } }) }),
  "no years stated on either side": () => scoreAtsLocally({ job: job({ description: "Python, Kubernetes, Kafka, Terraform and AWS." }),
    runtimeBasis: buildRuntimeAtsBasis({ resumeText: "Python Kubernetes", signalProfile: {}, domainProfile: {} }) }),
  "claims present": () => scoreAtsLocally({ job: job(), runtimeBasis: basis({ claims: { skills: ["Terraform"], actionVerbs: ["Led"] } }) }),
  "hard-constraint miss": () => scoreAtsLocally({ job: job({ description: job().description + " Active security clearance required." }), runtimeBasis: basis() }),
  "synonym match": () => scoreAtsLocally({ job: job(), runtimeBasis: basis(), synonyms: new Map([["terraform", ["pulumi"]]]) }),
  // Without this one, five arrays were never observed non-empty and their item type was unknown.
  "competencies, verbs and generic language": () => scoreAtsLocally({
    job: job({ description: job().description + " You will design, build, deploy and manage services, lead " +
      "projects, and coordinate across teams. We value collaboration, problem solving, communication and ownership.",
      skills_json: JSON.stringify([...SKILLS.map(skill => ({ skill, type: "hard" })),
        { skill: "Collaboration", type: "soft" }, { skill: "Communication", type: "soft" }, { skill: "Ownership", type: "soft" }]) }),
    runtimeBasis: buildRuntimeAtsBasis({ resumeText: "Designed and built Python services. Deployed on AWS. Strong collaboration.",
      signalProfile: { skills: ["Python"], titles: [], keywords: [], yearsExperience: 4, structuredFacts: {} },
      domainProfile: { seniority: "mid", selected_verbs: JSON.stringify(["Designed", "Built", "Deployed"]) } }) }),
};

/** Paths of arrays whose item type was never observed — a scenario gap, not a shape. */
export function unknownItemPaths(schema, path = "$") {
  const out = [];
  if (schema.items && Object.keys(schema.items).length === 0) out.push(path + "[]");
  if (schema.items) out.push(...unknownItemPaths(schema.items, path + "[]"));
  for (const [k, v] of Object.entries(schema.properties || {})) out.push(...unknownItemPaths(v, `${path}.${k}`));
  return out;
}

const fakeClient = (outcome) => ({ messages: { create: async () => {
  if (outcome instanceof Error) throw outcome;
  return { content: [{ type: "text", text: "x" }], usage: outcome };
} } });

export async function usageSamples() {
  const out = [];
  const full = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 6704, cache_read_input_tokens: 0 };
  out.push((await callAnthropic(fakeClient(full), { purpose: "p", model: "m", max_tokens: 1, messages: [] })).usage);
  // An upstream usage block missing the cache fields must still yield numbers, never absent keys.
  out.push((await callAnthropic(fakeClient({ input_tokens: 1, output_tokens: 1 }), { purpose: "p", model: "m", max_tokens: 1, messages: [] })).usage);
  try { await callAnthropic(fakeClient(new Error("overloaded_error")), { purpose: "p", model: "m", max_tokens: 1, messages: [] }); }
  catch (e) { out.push(e.usage); }
  return out;
}

const BASE = "JANE DOE\nSUMMARY\nSoftware Engineer with 4 years.\nEXPERIENCE\nStripe — Software Engineer";
const doc = (summary, role = "Software Engineer") => `<html><body><div class="header"><div class="name">JANE</div></div>` +
  `<div class="section-title">SUMMARY</div><p>${summary}</p><div class="section-title">EXPERIENCE</div>` +
  `<div class="entry"><div class="entry-org">Stripe</div><div class="entry-role">${role}</div></div></body></html>`;
export const CLAIM_SCENARIOS = {
  "honest": { html: doc("Engineer with 4 years.") },
  "years over the profile": { html: doc("Engineer with 9 years.") },
  "years under the profile, in the summary": { html: doc("Engineer with 2 years.") },
  "seniority above the declaration": { html: doc("Engineer with 4 years.", "Staff Software Engineer") },
  "no summary — header is the headline": { html: `<html><body><div class="header"><div class="name">JANE</div><div class="tagline">Software Engineer</div></div><div class="section-title">EXPERIENCE</div><div class="entry"><div class="entry-org">Stripe</div></div></body></html>` },
  "no profile years, no seniority": { html: doc("Engineer with 4 years."), years: null, seniority: null },
};

function claimResults() {
  return Object.values(CLAIM_SCENARIOS).map(s => checkResumeClaims({
    html: s.html, profile: { years_of_experience: "years" in s ? s.years : 4 },
    baseResumeText: BASE, domainProfile: { seniority: "seniority" in s ? s.seniority : "mid" },
  }));
}

/** Map<schemaName, { schema, source, scenarios }> — every derived shape, freshly executed. */
export async function deriveSchemas() {
  const ats = Object.values(ATS_SCENARIOS).map(f => f());
  const usage = await usageSamples();
  const claims = claimResults();
  const note = (source, n) => `DERIVED BY EXECUTING ${source} over ${n} scenarios. Do not hand-edit — ` +
    `regenerate with \`node scripts/generateContract.mjs\`.`;
  return {
    AtsReport: { ...infer(ats), description: note("@draft/ats-scorer scoreAtsLocally", ats.length) +
      " No band is included: bands are each product's presentation decision." },
    UsageRecord: { ...infer(usage), description: note("src/model/anthropicCall.js callAnthropic", usage.length) +
      " Counts, never content. Returned for every model call, failed calls included." },
    ClaimViolation: { ...infer(claims.flatMap(r => r.violations)), description: note("the claim guard (checkResumeClaims)", claims.length) +
      " `claimed`/`allowed` are numbers for a years violation and strings for a seniority one." },
    ClaimInspection: { ...infer(claims.map(r => r.checked.inspected)), description: note("the claim guard", claims.length) +
      " What the guard READ. documentChars > 0 on every returned document: the guard refuses to pass one it did not read." },
  };
}
