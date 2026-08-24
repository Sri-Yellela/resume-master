#!/usr/bin/env node
/**
 * AF5 — the semi campaign report.
 * ============================================================================================
 * AF5 asks for a specific record per run, and a specific summary per ATS. This produces both from
 * what the runs actually persisted, so the campaign's output is read off the database rather than
 * reconstructed from memory afterwards.
 *
 * Per run:  fields discovered, fields filled, provenance per field, anything the human corrected,
 *           terminal status, and the gate verdict.
 * Per ATS:  discovery reliability, gate holds needing a verdict, and which questions recurred often
 *           enough to belong in AF1's custom-answer store.
 *
 * WHAT THIS CANNOT DECIDE, AND SAYS SO
 * "Whether the gate verdict was CORRECT" is not in the database. A false gate looks identical to a
 * true one from the inside — that is exactly what made AE1 undiagnosable — so every gate hold is
 * printed with its evidence and left marked `verdict: YOURS`. A tool that guessed here would be
 * reporting the same false confidence the campaign exists to measure.
 *
 * Usage:
 *   node scripts/af5CampaignReport.mjs                    # last 30 days
 *   node scripts/af5CampaignReport.mjs --days 7
 *   node scripts/af5CampaignReport.mjs --user 15
 *   node scripts/af5CampaignReport.mjs --json
 */
import Database from 'better-sqlite3';
import { readAnswerStore, effectiveCustomAnswers } from '../services/customAnswers.js';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DAYS = Number(argOf('--days', 30));
const USER = argOf('--user', null);
const AS_JSON = argv.includes('--json');
const DB_PATH = process.env.RESUME_MASTER_DB || 'data/resume_master.db';

const db = new Database(DB_PATH, { readonly: true });

const has = (table, col) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
  catch { return false; }
};
// The two AF5 columns are optional at read time for the same reason they are guarded at write time:
// a database that predates migration 088 should produce a degraded report, not a crash.
const HAS_DISCOVERED = has('apply_run_jobs', 'fields_discovered');
const HAS_CORRECTIONS = has('apply_run_jobs', 'corrections_json');

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Gate reasons, and the ones that are a CLAIM ABOUT THE EMPLOYER'S PAGE rather than about us. Only
// these can be false in the AE1 sense — a captcha that was not there, a login wall that was not one.
const GATE_REASONS = new Set(['captcha_required', 'login_required']);

const rows = db.prepare(`
  SELECT rj.id, rj.job_id, rj.status, rj.reason_code, rj.reason_detail,
         rj.answers_json, rj.open_questions_json, rj.screenshot_path,
         rj.submit_verified, rj.submit_evidence, rj.created_at, rj.finished_at,
         ${HAS_DISCOVERED ? 'rj.fields_discovered' : 'NULL AS fields_discovered'},
         ${HAS_CORRECTIONS ? 'rj.corrections_json' : 'NULL AS corrections_json'},
         r.mode, r.user_id,
         sj.title, sj.company, sj.source, sj.apply_url, sj.url
  FROM apply_run_jobs rj
  JOIN apply_runs r ON r.id = rj.run_id
  LEFT JOIN scraped_jobs sj ON sj.job_id = rj.job_id
  WHERE r.mode = 'semi'
    AND rj.created_at >= unixepoch() - ${DAYS} * 86400
    ${USER ? 'AND r.user_id = ' + Number(USER) : ''}
  ORDER BY rj.created_at
`).all();

// ── Per-run records ──────────────────────────────────────────────────────────
const runs = rows.map(r => {
  const answers = parse(r.answers_json, []);
  const filled = answers.filter(a => !a.skipped && a.value !== null && a.value !== undefined && a.value !== '');
  const byProvenance = {};
  for (const a of filled) byProvenance[a.provenance || 'unknown'] = (byProvenance[a.provenance || 'unknown'] || 0) + 1;
  const corrections = parse(r.corrections_json, []);
  const open = parse(r.open_questions_json, []);
  return {
    runJobId: r.id, jobId: r.job_id, company: r.company ?? '(posting gone)', title: r.title ?? '',
    ats: r.source || 'unknown',
    at: r.created_at ? new Date(r.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
    status: r.status, reasonCode: r.reason_code ?? null,
    fieldsDiscovered: r.fields_discovered ?? null,
    fieldsFilled: filled.length,
    provenance: byProvenance,
    // Each correction is a resolver defect or a missing custom answer. The provenance is the lead.
    corrections: corrections.map(c => ({
      field: c.field, was: c.was, now: c.now, provenance: c.provenance, confidence: c.confidence,
    })),
    openQuestions: open.map(q => q.question).filter(Boolean),
    gate: GATE_REASONS.has(r.reason_code) ? { reason: r.reason_code, detail: r.reason_detail ?? null,
      screenshot: r.screenshot_path ?? null, verdict: 'YOURS' } : null,
    submitVerified: r.submit_verified === 1 ? true : r.submit_verified === 0 ? false : null,
  };
});

// ── Per-ATS aggregates ───────────────────────────────────────────────────────
const byAts = new Map();
for (const run of runs) {
  if (!byAts.has(run.ats)) byAts.set(run.ats, []);
  byAts.get(run.ats).push(run);
}

const atsReports = [...byAts.entries()].map(([ats, list]) => {
  const withDiscovery = list.filter(r => Number.isFinite(r.fieldsDiscovered) && r.fieldsDiscovered > 0);
  const foundNothing = list.filter(r => r.fieldsDiscovered === 0).length;
  const unknownDiscovery = list.filter(r => !Number.isFinite(r.fieldsDiscovered)).length;
  const totalDiscovered = withDiscovery.reduce((n, r) => n + r.fieldsDiscovered, 0);
  const totalFilled = withDiscovery.reduce((n, r) => n + r.fieldsFilled, 0);

  const corrections = list.flatMap(r => r.corrections);
  const correctionsByProvenance = {};
  for (const c of corrections) {
    const k = c.provenance || 'unknown';
    correctionsByProvenance[k] = (correctionsByProvenance[k] || 0) + 1;
  }
  const gateHolds = list.filter(r => r.gate);

  return {
    ats,
    runs: list.length,
    distinctJobs: new Set(list.map(r => r.jobId)).size,
    distinctCompanies: new Set(list.map(r => r.company)).size,
    // Discovery reliability: of the controls the page HAD, how many did the resolver answer.
    discovery: {
      runsMeasured: withDiscovery.length,
      fieldsDiscovered: totalDiscovered,
      fieldsFilled: totalFilled,
      fillRate: totalDiscovered ? +(totalFilled / totalDiscovered).toFixed(3) : null,
      runsThatFoundNothing: foundNothing,
      runsWithNoMeasurement: unknownDiscovery,
    },
    corrections: {
      total: corrections.length,
      runsWithAny: list.filter(r => r.corrections.length).length,
      byProvenance: correctionsByProvenance,
    },
    // Cannot be computed here — see the header. Reported as work outstanding.
    gates: { holds: gateHolds.length, verdictsOutstanding: gateHolds.length },
    statuses: list.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
  };
});

// ── Questions that belong in AF1's store ─────────────────────────────────────
// Counted across the campaign and checked against what the store can ALREADY answer for that
// employer, so a question that recurs but is already covered is not proposed again.
const questionCounts = new Map();
for (const run of runs) {
  const profile = db.prepare('SELECT * FROM user_profile WHERE user_id=?')
    .get(rows.find(r => r.id === run.runJobId)?.user_id);
  const resolved = effectiveCustomAnswers(readAnswerStore(profile || {}), run.company);
  for (const q of run.openQuestions) {
    const key = q.trim().toLowerCase();
    if (!key) continue;
    if (!questionCounts.has(key)) {
      questionCounts.set(key, { question: q, count: 0, companies: new Set(), atsList: new Set(), answered: true });
    }
    const e = questionCounts.get(key);
    e.count++;
    e.companies.add(run.company);
    e.atsList.add(run.ats);
    if (!Object.prototype.hasOwnProperty.call(resolved, q)) e.answered = false;
  }
}
const storeCandidates = [...questionCounts.values()]
  .filter(e => !e.answered)
  .map(e => ({
    question: e.question, seen: e.count,
    companies: [...e.companies], ats: [...e.atsList],
    // A question asked by more than one employer generalises, so it wants a template or a plain
    // entry. One asked by a single employer may only ever need a per-company override.
    suggestion: e.companies.size > 1 ? 'store it once — it recurs across employers'
                                     : 'one employer so far — a per-company override may be enough',
  }))
  .sort((a, b) => b.seen - a.seen);

if (AS_JSON) {
  console.log(JSON.stringify({ days: DAYS, runs, atsReports, storeCandidates }, null, 2));
  process.exit(0);
}

// ── Output ───────────────────────────────────────────────────────────────────
const line = (n = 96) => console.log('='.repeat(n));
line();
console.log(`AF5 semi campaign — last ${DAYS} day(s)${USER ? `, user ${USER}` : ''}`);
line();
if (!HAS_DISCOVERED || !HAS_CORRECTIONS) {
  console.log('DEGRADED: migration 088 has not been applied to this database.');
  if (!HAS_DISCOVERED) console.log('  fields_discovered missing — discovery reliability cannot be computed.');
  if (!HAS_CORRECTIONS) console.log('  corrections_json missing — hand corrections were never recorded.');
  console.log('');
}
if (runs.length === 0) {
  console.log('No semi runs in this window. The campaign has not started.');
  console.log(`\nAF5's bar: 10 runs per ATS across 10 DISTINCT jobs, real employers, chosen on merit.`);
  process.exit(0);
}

console.log(`\n${runs.length} semi run(s) across ${byAts.size} ATS(es)\n`);

for (const run of runs) {
  console.log(`── ${run.at}  ${run.company} — ${run.title}  [${run.ats}]`);
  const disc = Number.isFinite(run.fieldsDiscovered) ? run.fieldsDiscovered : '?';
  console.log(`   discovered ${disc}  filled ${run.fieldsFilled}  status ${run.status}` +
    `${run.reasonCode ? '/' + run.reasonCode : ''}`);
  const prov = Object.entries(run.provenance).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join('  ');
  if (prov) console.log(`   provenance  ${prov}`);
  if (run.corrections.length) {
    console.log(`   CORRECTED ${run.corrections.length} field(s) — each one a resolver defect or a missing answer:`);
    for (const c of run.corrections) {
      console.log(`     "${c.field}"  ${JSON.stringify(c.was)} -> ${JSON.stringify(c.now)}` +
        `  (${c.provenance}${c.confidence != null ? ' @' + c.confidence : ''})`);
    }
  } else {
    console.log(`   corrected   none recorded`);
  }
  if (run.openQuestions.length) {
    console.log(`   left to you ${run.openQuestions.length}: ${run.openQuestions.slice(0, 4).join(' | ')}`);
  }
  if (run.gate) {
    console.log(`   GATE ${run.gate.reason} — verdict is YOURS. Was the challenge really there?`);
    if (run.gate.screenshot) console.log(`     evidence: ${run.gate.screenshot}`);
  }
  console.log('');
}

line();
console.log('PER ATS');
line();
for (const a of atsReports) {
  console.log(`\n${a.ats}`);
  console.log(`  runs ${a.runs}/10 required   distinct jobs ${a.distinctJobs}/10 required   companies ${a.distinctCompanies}`);
  const d = a.discovery;
  console.log(`  discovery   ${d.fieldsFilled}/${d.fieldsDiscovered} fields answered` +
    `${d.fillRate !== null ? ` (${(d.fillRate * 100).toFixed(1)}%)` : ''}` +
    ` over ${d.runsMeasured} measured run(s)`);
  if (d.runsThatFoundNothing) console.log(`              ${d.runsThatFoundNothing} run(s) DISCOVERED NOTHING — a discovery failure, not a fill failure`);
  if (d.runsWithNoMeasurement) console.log(`              ${d.runsWithNoMeasurement} run(s) predate the fields_discovered column`);
  console.log(`  corrections ${a.corrections.total} across ${a.corrections.runsWithAny} run(s)`);
  for (const [p, n] of Object.entries(a.corrections.byProvenance).sort((x, y) => y[1] - x[1])) {
    console.log(`              ${p}: ${n}   <- ${p === 'label_fuzzy' ? 'a guess the human had to fix' : 'an EXACT path got it wrong, which is worse'}`);
  }
  console.log(`  gate holds  ${a.gates.holds}  (${a.gates.verdictsOutstanding} awaiting your verdict)`);
  console.log(`  false-gate rate: NOT COMPUTABLE from the database — AF5 requires this to be zero,`);
  console.log(`                   and only you can say whether each hold above was real.`);
  console.log(`  statuses    ${Object.entries(a.statuses).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  const short = [];
  if (a.runs < 10) short.push(`${10 - a.runs} more run(s)`);
  if (a.distinctJobs < 10) short.push(`${10 - a.distinctJobs} more distinct job(s)`);
  if (short.length) console.log(`  SHORT OF THE BAR: needs ${short.join(' and ')}`);
}

line();
console.log('QUESTIONS THAT BELONG IN THE CUSTOM-ANSWER STORE (AF1)');
line();
if (storeCandidates.length === 0) {
  console.log('None outstanding — every question these runs held on already resolves from the store.');
} else {
  for (const c of storeCandidates) {
    console.log(`\n  "${c.question}"`);
    console.log(`    seen ${c.seen}x across ${c.companies.length} company(ies) on ${c.ats.join(', ')}`);
    console.log(`    ${c.suggestion}`);
  }
}
console.log('');
