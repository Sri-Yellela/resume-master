/**
 * services/kb/technographics.js — canonicalising the company stack layer (G3).
 *
 * WHAT WAS DILUTED, MEASURED. company_technographics holds 8690 rows across 10 companies, and 386
 * of them are the SAME SKILL spelled differently for the same company:
 *
 *     OpenAI  "Infrastructure-as-Code" · "infrastructure-as-code" · "Infrastructure as code"
 *             "Infrastructure as Code" · "Infrastructure-as-code" · "infrastructure as code"
 *     Stripe  "problem-solving" · "problem solving" · "Problem-solving"
 *     Airbnb  "code review" · "code reviews" · "Code review"
 *
 * Six rows for one thing. Each carries a fraction of the evidence, so the stack view ranks them
 * all below skills that happen to have a single spelling, and FE-4's STACK block renders a diluted
 * ordering. That is the defect G3 describes.
 *
 * ⛔ BUT IT IS NOT THE ONE G3 PREDICTED. The task's example was "Postgres" and "PostgreSQL" as two
 * entries. Measured: `postgres`, `k8s` and `js` are ABSENT from this corpus — only the canonical
 * `postgresql`, `kubernetes` and `javascript` appear. enrichJob's extraction already emits
 * canonical technology names. The dilution here is CASE AND PUNCTUATION, which needs no synonym
 * table at all, and the synonym table adds 26 further merges on top of normalisation's 386.
 *
 * ── MERGED AT READ, NOT AT WRITE ───────────────────────────────────────────────────────────────
 *
 * The obvious implementation collapses the rows in place. This does not, and the reason is
 * specific to this database rather than general caution: `cleanup_log` id 85 deleted 1288 postings,
 * so skills_json is gone for all but 5 rows and THIS TABLE CANNOT BE REBUILT. The raw variants are
 * now the only surviving record of what each posting actually said. Destroying them to tidy a
 * display would trade irreplaceable provenance for a cosmetic win.
 *
 * So the rows stay exactly as written, and the merge happens where the surface is built.
 */

import { normaliseAtsTerm } from "../localAtsScorer.js";

/**
 * The clustering key. normaliseAtsTerm first — case, punctuation, plurals — then G1's CONFIRMED
 * synonyms, resolved to the lexicographically smallest member so the key does not depend on which
 * variant happened to be seen first.
 *
 * BUILD ONCE, USE TWICE (requirement 1): this is the same normaliser the ATS scorer matches with
 * and the same synonym table it expands with. A second vocabulary here would mean a company's
 * stack and a candidate's match were computed against different ideas of what a skill is.
 */
export function canonicalSkillKey(skill, synonyms = null) {
  const key = normaliseAtsTerm(skill);
  if (!key || !synonyms || !synonyms.size) return key;
  const equivalents = synonyms.get(key);
  if (!equivalents || !equivalents.length) return key;
  // ONE HOP, as in the scorer: [key, ...its direct equivalents] only. Chaining through each
  // equivalent's own synonyms would merge terms no reviewer ever compared.
  return [key, ...equivalents].sort()[0];
}

/**
 * Merge stack rows by canonical key.
 *
 * ⛔ CONFIDENCE IS THE MERGED EVIDENCE, NOT THE STRONGEST VARIANT (requirement 3). Six spellings of
 * Infrastructure-as-Code seen once each are six postings' worth of evidence, and taking the MAX
 * would report one — which is the dilution this exists to fix, just moved one level up. So weight
 * and posting_count SUM, and last_seen takes the most recent.
 *
 * ⚠ THE SUM CAN DOUBLE-COUNT, AND THAT IS STATED RATHER THAN HIDDEN. Until the write path was
 * fixed (see upsertTechnographics), one posting listing both "problem-solving" and "problem
 * solving" incremented two rows, so merging them counts that posting twice. It cannot be corrected
 * after the fact: posting_count is a bare integer with no per-posting provenance, and the postings
 * themselves are deleted. `variants` is returned so a surface can show what was merged, and the
 * caller can judge.
 *
 * @returns {Array<{skill, key, weight, postingCount, lastSeen, variants: string[]}>}
 */
export function mergeStackRows(rows = [], synonyms = null) {
  const groups = new Map();
  for (const r of rows) {
    const key = canonicalSkillKey(r.skill, synonyms);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, weight: 0, postingCount: 0, lastSeen: 0, variants: [], _best: null, _bestWeight: -1 };
      groups.set(key, g);
    }
    g.weight += r.weight || 0;
    g.postingCount += r.posting_count || 0;
    g.lastSeen = Math.max(g.lastSeen, r.last_seen || 0);
    if (!g.variants.includes(r.skill)) g.variants.push(r.skill);
    // THE DISPLAY NAME IS THE HEAVIEST VARIANT'S OWN SPELLING, not the normalised key. A stack
    // block reading "infrastructure as code" in lower case looks like a bug; and the key is
    // stemmed, so "code reviews" would render as "code review". Ties break on the raw string so
    // the choice is stable across runs rather than depending on row order.
    const w = r.weight || 0;
    if (w > g._bestWeight || (w === g._bestWeight && String(r.skill) < String(g._best))) {
      g._bestWeight = w;
      g._best = r.skill;
    }
  }
  return [...groups.values()].map(g => ({
    skill: g._best,
    key: g.key,
    weight: g.weight,
    postingCount: g.postingCount,
    lastSeen: g.lastSeen,
    variants: g.variants.sort(),
  }));
}
