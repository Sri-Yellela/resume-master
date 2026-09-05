#!/usr/bin/env node
/**
 * AL8 (task H) — derive label→field mappings from captured form structure.
 *
 * PLATFORM_LABEL_MAPS is hand-written for greenhouse, lever and workday; every other ATS falls
 * through to `generic`. This reads G4's `company_form_schemas` — real form STRUCTURE, labels and
 * types and required flags, never a candidate's entered values — and proposes mappings for the
 * labels the authored maps do not already cover.
 *
 * ⛔ IT PRODUCES A TABLE. NOTHING HERE RUNS AT FILL TIME, and no model is called at all — not
 * offline either. The mapping is derived by matching captured labels against the profile-key
 * vocabulary the resolver already uses, which is deterministic and reviewable. buildAnswers stays
 * deterministic; Jobo's integration terms say "No AI-generated answers" and §7 says the same.
 *
 * ⛔ NO ELIGIBILITY FIELD IS PROPOSED, EVER. services/kb/formFieldMappings.js REFUSES them, so the
 * row cannot exist to be confirmed later, and this script REPORTS each refusal rather than dropping
 * it silently — "the table has no sponsorship mapping" must be distinguishable from "the generator
 * never saw one".
 *
 * Usage:
 *   node scripts/al8FormFieldMappings.mjs --propose
 *   node scripts/al8FormFieldMappings.mjs --review
 *   node scripts/al8FormFieldMappings.mjs --confirm generic "Preferred Name"
 *   node scripts/al8FormFieldMappings.mjs --reject  generic "Referrer Name"
 *   node scripts/al8FormFieldMappings.mjs --report      # newly resolved vs still unresolvable
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPlatformLabelMap } from "../services/platformDetector.js";
import {
  recordMappingProposal, listMappingProposals, confirmMapping, rejectMapping,
  loadConfirmedMappings, mappingStats, forbiddenMapping, labelKey,
} from "../services/kb/formFieldMappings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "..", "data", "resume_master.db"));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/**
 * The vocabulary a captured label is matched against.
 *
 * Deliberately the SAME profile keys the resolver already fills, and deliberately NOT a superset:
 * proposing a key the resolver cannot fill produces a mapping that resolves to nothing, which reads
 * as coverage while adding none. Eligibility keys are absent by construction — they are not
 * candidates for a derived mapping at all.
 */
const FIELD_VOCABULARY = [
  ["first_name",   ["first name", "given name", "forename"]],
  ["last_name",    ["last name", "surname", "family name"]],
  ["full_name",    ["full name", "your name", "candidate name", "legal name", "name"]],
  ["preferred_name", ["preferred name", "nickname", "preferred first name"]],
  ["email",        ["email", "email address", "e mail"]],
  ["phone",        ["phone", "phone number", "mobile", "mobile number", "telephone", "contact number"]],
  ["linkedin_url", ["linkedin", "linkedin url", "linkedin profile"]],
  ["github_url",   ["github", "github url", "github profile"]],
  ["website_url",  ["website", "portfolio", "personal website", "portfolio url", "personal site"]],
  ["city",         ["city", "town"]],
  ["state",        ["state", "province", "region"]],
  ["country",      ["country"]],
  ["location",     ["location", "current location", "where are you based"]],
  ["address_line1", ["address", "address line 1", "street address"]],
  ["address_line2", ["address line 2", "apt", "suite", "unit"]],
  ["available_start_date", ["start date", "available start date", "earliest start date", "availability"]],
];

/** Exact match on the normalised label. Deliberately not fuzzy — see the header. */
function proposeKeyFor(label) {
  const key = labelKey(label);
  if (!key) return null;
  for (const [fieldKey, spellings] of FIELD_VOCABULARY) {
    if (spellings.some(s => labelKey(s) === key)) return fieldKey;
  }
  return null;
}

function capturedSchemas() {
  try {
    return db.prepare("SELECT apply_host, company, platform, fields_json FROM company_form_schemas").all();
  } catch { return []; }
}

function propose() {
  const schemas = capturedSchemas();
  console.log(`[al8] captured schemas: ${schemas.length}`);
  if (!schemas.length) {
    console.error(
      `\n⛔ company_form_schemas IS EMPTY — there is nothing to derive a mapping from.\n\n` +
      `   H's input is G4's capture, and no schema has ever been recorded on this database\n` +
      `   (nor in any backup). The generator is built and tested, but a table derived from zero\n` +
      `   captures would be a table of nothing presented as coverage.\n\n` +
      `   To produce input: run a capture through POST /api/apply/form-schema (users.form_schema_capture\n` +
      `   must be 1), or drive scripts/g4SchemaCapture.mjs against a real ATS page.\n`
    );
    process.exit(2);
  }

  let proposed = 0, refused = 0, alreadyAuthored = 0, noMatch = 0;
  const refusals = [];
  for (const s of schemas) {
    const platform = (s.platform || "generic").toLowerCase();
    const authored = getPlatformLabelMap(platform);
    const authoredKeys = new Set(Object.keys(authored).map(labelKey));
    let fields = [];
    try { fields = JSON.parse(s.fields_json || "[]"); } catch { continue; }

    for (const f of fields) {
      const label = f?.label;
      if (!label) continue;
      // Already covered by the hand-written map — nothing to add, and a derived duplicate would
      // only create a chance to disagree with it.
      if (authoredKeys.has(labelKey(label))) { alreadyAuthored++; continue; }

      const fieldKey = proposeKeyFor(label);
      if (!fieldKey) { noMatch++; continue; }

      const r = recordMappingProposal(db, { platform, label, fieldKey, host: s.apply_host });
      if (r.recorded) proposed++;
      else { refused++; refusals.push(`${platform} · "${label}" -> ${fieldKey}: ${r.refused}`); }
    }
  }

  console.log(`[al8] proposed ${proposed} · refused ${refused} · already authored ${alreadyAuthored} · no vocabulary match ${noMatch}`);
  if (refusals.length) {
    console.log(`\nREFUSED (reported, never silently dropped):`);
    for (const r of refusals.slice(0, 30)) console.log(`   ${r}`);
  }
  console.log(`\nstatus: ${JSON.stringify(mappingStats(db))}`);
  console.log(`NOTHING IS LIVE. The resolver reads only 'confirmed' rows.`);
}

function review() {
  const rows = listMappingProposals(db);
  if (!rows.length) { console.log("no mappings awaiting review."); return; }
  console.log(`${rows.length} awaiting review. A wrong mapping fills the wrong answer into a real`);
  console.log(`employer's form, and that cannot be recalled.\n`);
  for (const r of rows) {
    console.log(`  ${r.platform.padEnd(14)} "${r.label}" -> ${r.field_key}   ` +
                `(${r.corroboration_count} host(s), confidence ${r.confidence.toFixed(2)})`);
  }
  console.log(`\nnode scripts/al8FormFieldMappings.mjs --confirm <platform> "<label>"`);
}

/**
 * Requirement 5 — what the table newly resolves, and what is still unanswerable.
 *
 * An unresolvable REQUIRED field is valuable information: it tells the user in advance that the run
 * will hold. Reported here, and surfaced at queue time by the existing unmapped_count on the schema
 * store rather than by a second mechanism.
 */
function report() {
  const schemas = capturedSchemas();
  if (!schemas.length) { console.log("no captured schemas — nothing to report on."); return; }

  let total = 0, byAuthored = 0, byDerived = 0, unresolved = 0, unresolvedRequired = 0;
  const stillUnresolvable = [];
  for (const s of schemas) {
    const platform = (s.platform || "generic").toLowerCase();
    const authored = new Set(Object.keys(getPlatformLabelMap(platform)).map(labelKey));
    const derived = loadConfirmedMappings(db, platform);
    let fields = [];
    try { fields = JSON.parse(s.fields_json || "[]"); } catch { continue; }
    for (const f of fields) {
      if (!f?.label) continue;
      total++;
      const k = labelKey(f.label);
      if (authored.has(k)) byAuthored++;
      else if (derived[k]) byDerived++;
      else {
        unresolved++;
        if (f.required) { unresolvedRequired++; stillUnresolvable.push(`${platform} · "${f.label}"`); }
      }
    }
  }
  console.log(`fields across ${schemas.length} captured schema(s): ${total}`);
  console.log(`  resolved by the AUTHORED map : ${byAuthored}`);
  console.log(`  resolved by the DERIVED table: ${byDerived}   <- what task H added`);
  console.log(`  still unresolvable           : ${unresolved}  (${unresolvedRequired} of them REQUIRED)`);
  if (stillUnresolvable.length) {
    console.log(`\nUnresolvable REQUIRED fields — these are the runs that will hold, and knowing`);
    console.log(`in advance is the point of reporting them at queue time rather than at submit:`);
    for (const u of stillUnresolvable.slice(0, 20)) console.log(`   ${u}`);
  }
}

if (has("--propose")) propose();
else if (has("--review")) review();
else if (has("--report")) report();
else if (has("--confirm") || has("--reject")) {
  const flag = has("--confirm") ? "--confirm" : "--reject";
  const act = has("--confirm") ? confirmMapping : rejectMapping;
  const i = args.indexOf(flag);
  const [platform, label] = [args[i + 1], args[i + 2]];
  if (!platform || !label) { console.error(`usage: ${flag} <platform> "<label>"`); process.exit(1); }
  // Even a confirmation cannot bypass the boundary: the row would have been refused at proposal
  // time, and this states why rather than silently doing nothing.
  const row = db.prepare("SELECT field_key FROM form_field_mappings WHERE platform=? AND label=?")
    .get(platform.toLowerCase(), labelKey(label));
  if (row) {
    const bad = forbiddenMapping(label, row.field_key);
    if (bad) { console.error(`REFUSED: ${bad}`); process.exit(2); }
  }
  console.log(act(db, platform, label) ? `${flag} ${platform} "${label}"` : `no such proposal`);
  console.log(`status: ${JSON.stringify(mappingStats(db))}`);
} else {
  console.log("one of --propose | --review | --report | --confirm <platform> <label> | --reject <platform> <label>");
  process.exit(1);
}
db.close();
