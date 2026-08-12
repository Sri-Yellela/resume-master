// TASK A1 driver — drives autoApply against scripts/fakeAts.js ONLY (localhost:4599).
// Diagnostic: reports what the form ACTUALLY received. Never asserts on status alone.
import { autoApply } from "./services/applyAutomation.js";

const BASE = "http://localhost:4599";
const RESUME = process.env.A1_RESUME;

// Representative profile as a real user's would be. Trap conditions, both realistic:
//  - `work_authorization` present, no separate `sponsorship` answer
//  - a short `name` key alongside full_name
const BASE_MAP = {
  first_name: "Ada",
  last_name: "Lovelace",
  full_name: "Ada Lovelace",
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+1 555 0100",
  linkedin: "https://www.linkedin.com/in/adalovelace",
  website: "https://ada.dev",
  location: "Boston, MA",
  city: "Boston",
  state: "MA",
  years_experience: "8",
  start_date: "2026-09-01",
  org: "Analytical Engines Ltd",
  current_company: "Analytical Engines Ltd",
};

// Keyed to labels the harness actually renders, so the form can reach submit.
const COMPLETION = {
  "Are you legally authorized to work in the country of employment?": "Yes",
  "How did you hear about us?": "Your engineering blog",
  "Are you authorized to work without sponsorship?": "yes",
};

function payload({ workAuth = "Yes", complete = false, dropShortName = false } = {}) {
  const field_map = { ...BASE_MAP, work_authorization: workAuth };
  if (dropShortName) delete field_map.name;
  return { field_map, handler_map: {}, custom_answers: complete ? { ...COMPLETION } : {} };
}

const reset = () => fetch(`${BASE}/_reset`, { method: "POST" }).then(r => r.json());
const subs  = () => fetch(`${BASE}/_submissions`).then(r => r.json());

const WATCH = [
  "job_application[requires_sponsorship]", "job_application[legally_authorized]",
  "job_application[legal_name]", "job_application[preferred_name]", "job_application[referrer_name]",
  "job_application[hear_about_us]", "job_application[start_date]", "job_application[years_experience]",
  "cards[authorized_to_work]", "name", "start_date", "_systemfield_name", "_systemfield_location",
];

async function run(label, url, pay) {
  await reset();
  const res = await autoApply(url, pay, { mode: "full", jobId: label, resumePath: RESUME });
  const s = await subs();
  console.log("\n" + "=".repeat(80));
  console.log(`RUN ${label} -> ${url}`);
  console.log(`status=${res.status} reason=${res.reasonCode || "-"} filled=${res.fieldsFilled} submissions=${s.count}`);
  if (res.missingRequired) console.log("missingRequired:", JSON.stringify([...new Set(res.missingRequired)]));
  if (res.error) console.log("error:", res.error);
  for (const rec of s.submissions) {
    console.log(`-- RECORDED (${rec.provider}) --`);
    const f = rec.fields || {};
    for (const k of WATCH) if (k in f) console.log(`   ${k} = ${JSON.stringify(f[k])}`);
    const extra = Object.keys(f).filter(k => !WATCH.includes(k));
    if (extra.length) console.log(`   (other: ${extra.map(k => `${k}=${JSON.stringify(f[k])}`).join(", ")})`);
  }
  return { label, res, count: s.count };
}

const out = [];
out.push(await run("G1_minimal",        `${BASE}/greenhouse`, payload({ workAuth: "Authorized to work in the US" })));
out.push(await run("G2_status_value",   `${BASE}/greenhouse`, payload({ workAuth: "Authorized to work in the US", complete: true })));
out.push(await run("G3_yesno_value",    `${BASE}/greenhouse`, payload({ workAuth: "Yes", complete: true })));
out.push(await run("G4_repeat_of_G3",   `${BASE}/greenhouse`, payload({ workAuth: "Yes", complete: true })));
out.push(await run("G5_no_short_name",  `${BASE}/greenhouse`, payload({ workAuth: "Yes", complete: true, dropShortName: true })));
out.push(await run("L1_lever",          `${BASE}/lever`,      payload({ workAuth: "Yes", complete: true })));
out.push(await run("A1_ashby",          `${BASE}/ashby`,      payload({ workAuth: "Yes", complete: true })));

console.log("\n" + "#".repeat(80));
console.log("SUMMARY");
for (const o of out) console.log(`  ${o.label.padEnd(18)} ${String(o.res.status).padEnd(22)} submissions=${o.count}`);
process.exit(0);
