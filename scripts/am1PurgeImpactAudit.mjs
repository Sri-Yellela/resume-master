#!/usr/bin/env node
/**
 * AM1 / task R2 requirements 4-6 and R3 requirement 10 — WHAT THE PURGE ACTUALLY COST, MEASURED.
 *
 * Three questions, answered by running things rather than by reading them:
 *
 *   1. FORENSICS — what cleanup_log id 85 was, how it was reached, and whether it can fire again.
 *      Reconstructed from the log row and the 2026-08-31 backup's own scraped_at distribution.
 *
 *   2. DERIVED TABLES — the state of each one against the current 5-row board, and for each,
 *      whether it is recoverable by RE-DERIVATION (the inputs still exist) or only from the
 *      preserved corpus (it depended on the deleted text).
 *
 *   3. DIFFERENTIAL — the audit R3 requirement 10 asks for: any OTHER behaviour whose correctness
 *      depends on a table being populated. Each probe is run twice, once against the purged live
 *      database and once against the 1291-posting backup, and the answers are compared. A probe
 *      that disagrees is a behaviour the purge silently changed. That is a measurement; a grep for
 *      `SELECT ... FROM scraped_jobs` is a list of candidates.
 *
 * ⛔ READ-ONLY. Both databases are opened readonly and nothing here re-derives anything — task R2
 * requirement 6 is explicit that a derivation run against 5 fixtures would overwrite real output
 * with output computed from nothing. This reports; it does not fix.
 *
 * Usage: node scripts/am1PurgeImpactAudit.mjs
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { looksLikeLocation, resetLocationVocabulary, checkCandidateConsistency } from "../services/kb/failsafe.js";
import { getCompanyProfile } from "../services/kb/companyProfile.js";
import { getHiringSignals } from "../services/jobs/hiringSignals.js";
import { loadTermWeights } from "../services/atsTermWeights.js";
import { suggest } from "../services/jobs/searchSuggestions.js";
import { MIN_BOARD_FOR_DERIVATION } from "../services/jobs/boardSufficiency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LIVE = path.join(ROOT, "data", "resume_master.db");

function findCorpus() {
  for (const dir of [path.join(ROOT, "data", "evidence"), path.join(ROOT, "data", "backups")]) {
    if (!fs.existsSync(dir)) continue;
    const f = fs.readdirSync(dir).find(x => x.includes("2026-08-31") && x.endsWith(".db"));
    if (f) return path.join(dir, f);
  }
  return null;
}

const live = new Database(LIVE, { readonly: true });
const corpusPath = findCorpus();
const corpus = corpusPath ? new Database(corpusPath, { readonly: true }) : null;
const iso = (t) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
const rule = (s = "") => console.log("─".repeat(96) + (s ? "\n" + s : ""));

// ════════════════════════════════════════════════════════════════════════════
// 1. FORENSICS
// ════════════════════════════════════════════════════════════════════════════
rule();
console.log("R2.4 — WHAT cleanup_log id 85 WAS, AND WHETHER IT CAN FIRE AGAIN");
rule();

const ev = live.prepare("SELECT * FROM cleanup_log WHERE id = 85").get();
if (!ev) {
  console.log("cleanup_log id 85 is not in this database — nothing to reconstruct.");
} else {
  const cutoff = ev.run_at - 7 * 24 * 3600;
  console.log(`the pass          id 85, ran ${iso(ev.run_at)}`);
  console.log(`                  jobs_deleted ${ev.jobs_deleted}, orphans ${ev.orphans_cleaned}, details ${ev.details}`);
  console.log(`its cutoff        scraped_at < ${iso(cutoff)}  (run_at minus 7 days)`);

  // WHICH TRIGGER. server.js has exactly two: cron.schedule("0 3 * * *") and the app.listen
  // callback's setImmediate. 02:06:12 is neither 03:00 nor a round minute, and the passes either
  // side of it (86 at 02:50, 87 at 03:48, 88 at 16:58) are equally scattered — that is a process
  // starting, not a scheduler firing.
  const neighbours = live.prepare(
    "SELECT id, run_at, jobs_deleted FROM cleanup_log WHERE id BETWEEN 79 AND 92 ORDER BY id").all();
  const onTheHour = neighbours.filter(r => new Date(r.run_at * 1000).getUTCMinutes() === 0).length;
  console.log(`the trigger       STARTUP cleanup (server.js app.listen -> setImmediate), not the 03:00 cron.`);
  console.log(`                  ${onTheHour} of the last ${neighbours.length} passes ran on the hour; the rest are restarts.`);
  console.log(`                  Passes 79-84 all ran on 2026-08-25 and deleted 0 — nothing was 7 days old yet.`);

  if (corpus) {
    const total = corpus.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c;
    const older = corpus.prepare("SELECT COUNT(*) c FROM scraped_jobs WHERE scraped_at < ?").get(cutoff).c;
    const days = corpus.prepare(
      "SELECT date(scraped_at,'unixepoch') d, COUNT(*) c FROM scraped_jobs GROUP BY d ORDER BY c DESC").all();
    console.log(`the board then    ${total} rows, of which ${older} were older than the cutoff (${(older / total * 100).toFixed(1)}%)`);
    console.log(`arrivals          ` + days.map(d => `${d.d}: ${d.c}`).join("   "));
    console.log(`                  ${days[0].c} of ${total} arrived in ONE burst on ${days[0].d}, and nothing arrived after it.`);
  }

  console.log("");
  console.log("was it intentional?");
  console.log("  The PREDICATE was, and it was correct — not one row was expired wrongly. Deleting");
  console.log("  99.8% of the board unattended was not: there was no confirmation, no dry run and no");
  console.log("  cap, because the DELETE was the first thing in the pass that knew how big it was.");
  console.log("");
  console.log("root cause");
  console.log("  Deletion and refill share ONE point of failure. The startup pass exists to catch the");
  console.log("  window in which the server was down — which is exactly the window in which nothing");
  console.log("  was scraping either. On boot the cleanup fires from a setImmediate; the crawl is up");
  console.log("  to a day away and only if the process lives that long. A 7-day expiry is sound for a");
  console.log("  board refilled daily; bolted to a refill that stops when the process does, it empties");
  console.log("  the board in proportion to downtime.");
  console.log("");
  console.log("can it fire again?");
  console.log("  The rule can — every boot and every 03:00, and it will whenever the board goes 7 days");
  console.log("  without a crawl. The OUTCOME can no longer: services/jobs/cleanupBrake.js now counts");
  console.log("  the pass first and refuses to delete more than 50% of a board over 50 rows, retiring");
  console.log("  those rows (is_active = 0) instead. See test/cleanupBlastRadius.test.js, which");
  console.log("  reproduces this exact pass at 1291 rows and asserts all of them survive.");
}

// ════════════════════════════════════════════════════════════════════════════
// 2. DERIVED TABLES
// ════════════════════════════════════════════════════════════════════════════
rule();
console.log("R2.5 — EVERY DERIVED TABLE AGAINST THE CURRENT BOARD");
rule();

const liveBoard = live.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c;
const corpusBoard = corpus ? corpus.prepare("SELECT COUNT(*) c FROM scraped_jobs").get().c : null;
console.log(`scraped_jobs      live ${liveBoard}   corpus ${corpusBoard ?? "?"}\n`);

// `derivedFrom` is the claim being audited: what this table's rows were computed FROM. If that
// input is the deleted posting text, re-derivation cannot recover it and only the corpus can.
// `board` is the claim being audited: were these rows computed FROM the deleted posting text? A
// table's ROW COUNT cannot answer that — lca_employer_periods and company_ats_list also match their
// snapshot exactly, and for them that means nothing happened, not that they are stale. Counting
// alone would report both as casualties.
const TABLES = [
  { t: "company_technographics", board: true,  from: "scraped_jobs.skills_json, per posting" },
  { t: "company_org_units",      board: true,  from: "scraped_jobs.org_unit_raw, per posting" },
  { t: "ats_term_weights",       board: true,  from: "scraped_jobs.skills_json across the whole board" },
  { t: "company_hiring_signals", board: true,  from: "COUNT(*) over scraped_jobs per company per day" },
  { t: "job_role_map",           board: true,  from: "one row per posting — cascade-deleted with it" },
  { t: "skill_synonyms",         board: false, from: "the CORPUS, via al3 scripts that refuse a thin board" },
  { t: "company_lca_sponsorship", board: false, from: "the DOL LCA dataset — an external file" },
  { t: "lca_employer_periods",   board: false, from: "the DOL LCA dataset — an external file" },
  { t: "company_ats_list",       board: false, from: "a static list, not derived at all" },
];
const count = (db, t) => { try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return null; } };

console.log("table                      live   corpus  state");
for (const { t, board, from } of TABLES) {
  const l = count(live, t), c = corpus ? count(corpus, t) : null;
  let state;
  if (l === null) state = "absent";
  else if (c === null) state = "built after the snapshot";
  else if (l < c) state = `⛔ LOST ${c - l} rows — cascaded with the postings`;
  else if (!board) state = l === c ? "unaffected — not derived from the board" : `unaffected; grew by ${l - c}`;
  else if (l === c) state = "INTACT but STALE — describes a board that no longer exists";
  else state = `stale; grew by ${l - c} since the snapshot`;
  console.log(`${t.padEnd(26)} ${String(l ?? "-").padStart(6)}  ${String(c ?? "-").padStart(6)}  ${state}`);
  console.log(`${" ".repeat(26)}        derived from: ${from}`);
}

console.log("");
console.log("recoverable by RE-DERIVATION against the live board?  NO, for every posting-derived one.");
console.log("  Re-derivation reads scraped_jobs. With 5 fixtures it produces an answer about those 5");
console.log("  and overwrites an answer about 1291 — a second loss on top of the first, and this one");
console.log("  irreversible, because the stale table IS the surviving copy. Task R2 requirement 6.");
console.log("");
console.log("recoverable from the PRESERVED CORPUS?  Yes — all of them. The text is what they need and");
console.log(`  data/evidence/ has it. That is the whole reason R1 pinned it.`);
console.log("");
console.log("independent of the board entirely:  the LCA tables (external DOL dataset), company_ats_list");
console.log("  (static), and skill_synonyms (built from the corpus by scripts that already refuse a");
console.log(`  board under ${MIN_BOARD_FOR_DERIVATION} rows).`);

// WHO WOULD RE-DERIVE, AND WHETHER ANYTHING STOPS THEM NOW. The point of the audit is the ones
// nobody has to choose to run.
console.log("");
console.log("what would re-derive these, unprompted:");
console.log("  runHiringSignalsRollup   04:00 cron   ⛔ WAS the live risk — it upserts at window_end =");
console.log("                                        now and getHiringSignals reads the LATEST row, so");
console.log("                                        one pass makes a fixture-derived count the CURRENT");
console.log("                                        answer with the true one still underneath it.");
console.log("                                        NOW GUARDED (boardSufficiency).");
console.log("  runOrgLayerRollup        04:00 cron   harmless today — never deletes, never demotes a");
console.log("                                        confirmed unit, and all 5 fixtures have");
console.log("                                        org_unit_raw = NULL so it writes nothing. Guarded");
console.log("                                        anyway: that is a fact about today's rows.");
console.log("  computeTermWeights       manual       ⛔ worst case. Opens with DELETE FROM");
console.log("                                        ats_term_weights inside the rebuild transaction.");
console.log("                                        NOW GUARDED (assessRebuildScope).");
console.log("  reconcileCompanyLca      manual       reads DISTINCT company from the board; would");
console.log("                                        reconcile 5 companies instead of 10. Not");
console.log("                                        destructive, but its coverage figure would be.");

// ════════════════════════════════════════════════════════════════════════════
// 3. DIFFERENTIAL
// ════════════════════════════════════════════════════════════════════════════
rule();
console.log("R3.10 — WHICH BEHAVIOURS ANSWER DIFFERENTLY ON A PURGED BOARD");
rule();

if (!corpus) {
  console.log("No corpus available — the differential cannot run. This is the state R1 exists to prevent.");
} else {
  const RESUME = "EXPERIENCE\n\nStripe — Software Engineer, Payments Infrastructure, Bangalore\n2022-2025\n";

  // Each probe returns something comparable. The probe list is where the audit's judgement lives:
  // these are the read surfaces that touch scraped_jobs at READ time, plus the ones that read a
  // derived table so the two classes can be told apart in the output.
  // ⛔ TWO MEMOISATIONS HAVE TO BE DEFEATED, and both bit this harness before they were.
  //
  // failsafe.js memoises the location vocabulary, and searchSuggestions.js memoises its index by
  // roleKey ALONE — not by database. Neither is a product defect: one process serves one database.
  // But a harness that hands two databases to the same module gets the FIRST one's answer back for
  // the second, and the probes then agree for a reason that has nothing to do with the data. The
  // first run of this script reported `suggest -> 8` for a five-row board for exactly that reason.
  //
  // So the vocabulary is reset per probe, and `now` is advanced past any plausible TTL between the
  // two calls rather than left to default.
  let tick = 0;
  const bust = () => { resetLocationVocabulary(); return (tick += 86_400_000); };

  const PROBES = [
    { name: "looksLikeLocation('Bangalore')",   reads: "scraped_jobs.location (+ SEED floor)",
      run: (db) => { bust(); return looksLikeLocation(db, "Bangalore"); } },
    { name: "looksLikeLocation('Dublin')",      reads: "scraped_jobs.location (+ SEED floor)",
      run: (db) => { bust(); return looksLikeLocation(db, "Dublin"); } },
    { name: "looksLikeLocation('Payments Infra')", reads: "scraped_jobs.location (+ SEED floor)",
      run: (db) => { bust(); return looksLikeLocation(db, "Payments Infrastructure"); } },
    { name: "consistency(Stripe, résumé)",      reads: "the failsafe, end to end",
      run: (db) => { bust(); return checkCandidateConsistency(db, "Stripe", RESUME).status; } },
    { name: "suggest(title, 'soft')",           reads: "scraped_jobs titles at read time",
      run: (db) => suggest(db, { roleKey: "engineering", field: "title", q: "soft", now: bust() }).length },
    { name: "suggest(location, 'san')",         reads: "scraped_jobs locations at read time",
      run: (db) => suggest(db, { roleKey: "engineering", field: "location", q: "san", now: bust() }).length },
    { name: "loadTermWeights().size",           reads: "ats_term_weights (derived, stored)",
      run: (db) => loadTermWeights(db).weights.size },
    { name: "companyProfile(Stripe).hasData",   reads: "four derived tables",
      run: (db) => getCompanyProfile(db, "Stripe").hasData },
    { name: "companyProfile(Stripe) stack",     reads: "company_technographics (derived, stored)",
      run: (db) => getCompanyProfile(db, "Stripe").stack?.length ?? 0 },
    { name: "companyProfile(Stripe) orgUnits",  reads: "company_org_units (derived, stored)",
      run: (db) => getCompanyProfile(db, "Stripe").orgUnitsTotal ?? 0 },
    { name: "hiringSignals(Stripe).open_count", reads: "company_hiring_signals (derived, stored)",
      run: (db) => getHiringSignals(db, "Stripe")?.open_count ?? null },
  ];

  const show = (v) => v === null || v === undefined ? "-" : String(v);
  // failsafe.js warns once per vocabulary build, and resetting per probe re-arms it. The warning is
  // correct and wanted at runtime; here it would print eight times through the middle of a table.
  const quiet = (fn) => {
    const w = console.warn; console.warn = () => {};
    try { return fn(); } finally { console.warn = w; }
  };
  console.log("probe                             live (5)      corpus (1291)  verdict");
  let differ = 0;
  for (const p of PROBES) {
    let a, b;
    try { a = quiet(() => p.run(live)); } catch (e) { a = `ERR ${e.message.slice(0, 24)}`; }
    try { b = quiet(() => p.run(corpus)); } catch (e) { b = `ERR ${e.message.slice(0, 24)}`; }
    const same = show(a) === show(b);
    if (!same) differ++;
    console.log(`${p.name.padEnd(33)} ${show(a).padEnd(13)} ${show(b).padEnd(14)} ${same ? "agrees" : "⚠ DIFFERS"}`);
    console.log(`${" ".repeat(33)} reads ${p.reads}`);
  }
  resetLocationVocabulary();

  console.log("");
  console.log(`${differ} of ${PROBES.length} probes disagree.`);
  console.log("");
  console.log("reading the result");
  console.log("  A probe over a STORED derived table agrees, because the table survived the purge — that");
  console.log("  is the whole reason re-deriving it now would be the destructive act rather than the");
  console.log("  repair.");
  console.log("  A probe that reads scraped_jobs at READ TIME is where a purge changes an answer with no");
  console.log("  error and no failing test. AH4's location fix was one of these and it silently reverted;");
  console.log("  it now agrees because SEED_LOCATIONS is a floor the corpus extends rather than");
  console.log("  constitutes (landed in ac25de2).");
  console.log("  The suggestion index is the remaining one, and it is NOT the same defect: an empty");
  console.log("  suggestion list is a degraded feature, not a false claim about the world. It offers");
  console.log("  nothing rather than asserting something untrue, so it needs a corpus, not a floor.");
}

rule();
console.log("Nothing was written. Task R2 requirement 6: report first, do not re-derive.");
