/**
 * services/atsTermWeights.js — corpus-derived term weights for the local ATS scorer.
 *
 * WHAT THIS FIXES
 * The scorer counted every term the same. Matching `python` was worth exactly what matching
 * `systems` was worth, so a posting could be "matched" on filler and score the same as one matched
 * on the thing the job is actually about. Weighting terms by how rare they are in our own corpus is
 * the standard fix (TF-IDF), and we have the corpus: 1289 postings carrying skills_json.
 *
 * THE REASON THIS IS NOT PLAIN IDF — READ BEFORE CHANGING THE FLOOR
 * skills_json is written by an LLM (services/jobs/enrichJob.js), not chosen from a fixed list, so
 * the corpus vocabulary is open-ended and its tail is phrasing, not skills. Measured on the live
 * board:
 *
 *     6123 distinct normalised terms
 *       appearing in exactly 1 posting : 4279  (69.9%)
 *       appearing in <= 3 postings     : 5373  (87.8%)
 *
 * and the singletons read `passion for mission`, `japanese fluency`, `receptivenes to feedback`,
 * `ability to work with diverse team`. Plain IDF gives every one of those the MAXIMUM weight,
 * because it cannot tell a rare skill from a rare way of saying an ordinary thing. That is the
 * opposite of the intent and it would make the score worse, not better.
 *
 * So there is a DOCUMENT-FREQUENCY FLOOR. A term seen in fewer than MIN_DF postings is not treated
 * as high-signal; it is given NEUTRAL weight. It still counts — a genuinely rare skill should not be
 * silently dropped from the denominator, because then a posting made entirely of rare terms would
 * score on nothing at all — but it cannot outweigh a term we have actually observed enough times to
 * have an opinion about. Weight is EARNED by evidence, and one sighting is not evidence.
 *
 * WEIGHTS AGE, AND A STALE WEIGHT TABLE THAT DOES NOT SAY SO IS THE REPEATED DEFECT SHAPE HERE.
 * Every row carries computed_at and the corpus size it was built from. `loadTermWeights` returns
 * them, `weightsAreStale` judges them, and the scorer degrades to unweighted rather than scoring
 * against weights from a corpus that no longer resembles the board.
 */

// One-way dependency, deliberately. localAtsScorer must NOT import this module back: the scorer
// takes a prepared weight Map as an argument and never touches the database, which is what keeps it
// pure, deterministic and testable without a DB. Loading is the caller's job.
import { roleFamilyForTitle } from "./searchQueryBuilder.js";
import { normaliseAtsTerm } from "./localAtsScorer.js";

/**
 * A term must appear in at least this many postings before its rarity is believed.
 * Set from the measured tail above: at 5, ~88% of distinct terms fall below the floor and are
 * neutral, which is the honest answer for a vocabulary an LLM invents per posting.
 */
export const MIN_DF = 5;

/** Neutral weight. A term with no earned opinion counts exactly once. */
export const NEUTRAL_WEIGHT = 1.0;

/** Bounds. A ubiquitous term is damped, never zeroed — "python" on a Python job still means something. */
export const MIN_WEIGHT = 0.35;
export const MAX_WEIGHT = 2.0;

/**
 * A family whose corpus is smaller than this cannot support its own weights and falls back to the
 * global table. Below it, document frequency is measuring the sample, not the language.
 */
export const MIN_FAMILY_POSTINGS = 60;

/** The pseudo-family holding weights computed over every posting regardless of role. */
export const GLOBAL_FAMILY = "__global__";

/** Weights older than this are refused. The corpus turns over as the board is re-scraped. */
export const MAX_WEIGHT_AGE_DAYS = 45;

/**
 * Rarity -> weight, once the floor is cleared.
 *
 * ln(N/df) normalised by ln(N/MIN_DF) puts a term seen exactly MIN_DF times at 1.0 and a term in
 * every posting at 0, then scales into [MIN_WEIGHT, MAX_WEIGHT]. Bounded on purpose: an unbounded
 * IDF lets one rare term dominate a whole posting's score, which is the same "confidently wrong"
 * failure in a different costume.
 */
export function weightForDf(df, corpusSize) {
  if (!Number.isFinite(df) || df <= 0 || !Number.isFinite(corpusSize) || corpusSize <= 0) {
    return NEUTRAL_WEIGHT;
  }
  if (df < MIN_DF) return NEUTRAL_WEIGHT;
  const ceiling = Math.log(corpusSize / MIN_DF);
  if (!(ceiling > 0)) return NEUTRAL_WEIGHT;
  const rarity = Math.log(corpusSize / Math.min(df, corpusSize)) / ceiling;
  const scaled = rarity * MAX_WEIGHT;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, Number(scaled.toFixed(4))));
}

function parseSkills(raw) {
  let list = [];
  try { list = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const value = typeof entry === "string" ? entry : entry?.skill;
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return out;
}

/**
 * Recompute the whole weight table from scraped_jobs. Idempotent: the table is replaced wholesale
 * inside one transaction, so a crashed recompute leaves the previous table intact rather than a
 * half-written one that would silently score some terms and not others.
 */
export function computeTermWeights(db, { now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = db.prepare(
    `SELECT job_id, title, normalized_title, skills_json
       FROM scraped_jobs
      WHERE skills_json IS NOT NULL AND skills_json != '' AND skills_json != '[]'`
  ).all();

  // family -> { postings, df: Map<term, count> }
  const families = new Map();
  const bump = (family, terms) => {
    let bucket = families.get(family);
    if (!bucket) { bucket = { postings: 0, df: new Map() }; families.set(family, bucket); }
    bucket.postings += 1;
    for (const term of terms) bucket.df.set(term, (bucket.df.get(term) || 0) + 1);
  };

  for (const row of rows) {
    const terms = new Set();
    for (const skill of parseSkills(row.skills_json)) {
      const key = normaliseAtsTerm(skill);
      if (key) terms.add(key);
    }
    if (!terms.size) continue;
    bump(GLOBAL_FAMILY, terms);
    const family = roleFamilyForTitle(row.normalized_title || row.title || "");
    if (family) bump(family, terms);
  }

  const written = [];
  const insert = db.prepare(
    `INSERT INTO ats_term_weights (role_family, term, df, corpus_size, weight, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM ats_term_weights").run();
    for (const [family, bucket] of families) {
      // A family too small to speak for itself is not written at all. An empty result makes the
      // scorer fall back to the global table, which is the correct answer; a table of weights
      // derived from 12 postings would look authoritative and be noise.
      if (family !== GLOBAL_FAMILY && bucket.postings < MIN_FAMILY_POSTINGS) continue;
      let count = 0;
      for (const [term, df] of bucket.df) {
        // Below the floor every weight is NEUTRAL by definition, so storing those rows would
        // triple the table to say nothing. Absence means neutral, and loadTermWeights agrees.
        if (df < MIN_DF) continue;
        insert.run(family, term, df, bucket.postings, weightForDf(df, bucket.postings), now);
        count++;
      }
      written.push({ family, postings: bucket.postings, distinctTerms: bucket.df.size, weighted: count });
    }
  })();

  return { computedAt: now, corpusSize: rows.length, families: written };
}

/**
 * Load the weight table for one role family, falling back to the global table.
 *
 * Returns `{ weights, computedAt, corpusSize, family, stale }`. `weights` is a Map of normalised
 * term -> weight; a term that is absent is NEUTRAL, never zero.
 */
export function loadTermWeights(db, roleFamily = null, { now = Math.floor(Date.now() / 1000) } = {}) {
  const empty = { weights: new Map(), computedAt: null, corpusSize: 0, family: null, stale: true };
  let rows = [];
  let family = null;
  try {
    if (roleFamily) {
      rows = db.prepare(
        "SELECT term, weight, corpus_size, computed_at FROM ats_term_weights WHERE role_family = ?"
      ).all(roleFamily);
      if (rows.length) family = roleFamily;
    }
    if (!rows.length) {
      rows = db.prepare(
        "SELECT term, weight, corpus_size, computed_at FROM ats_term_weights WHERE role_family = ?"
      ).all(GLOBAL_FAMILY);
      if (rows.length) family = GLOBAL_FAMILY;
    }
  } catch {
    // The table may not exist yet (fresh DB, migration not run). Unweighted is a correct answer.
    return empty;
  }
  if (!rows.length) return empty;

  const weights = new Map();
  for (const r of rows) weights.set(r.term, r.weight);
  const computedAt = rows[0].computed_at ?? null;
  return {
    weights,
    computedAt,
    corpusSize: rows[0].corpus_size ?? 0,
    family,
    stale: weightsAreStale(computedAt, now),
  };
}

export function weightsAreStale(computedAt, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(computedAt) || computedAt <= 0) return true;
  return (now - computedAt) > MAX_WEIGHT_AGE_DAYS * 86400;
}
