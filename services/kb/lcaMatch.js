/**
 * Company KB — matching a `company` string to DOL LCA legal entities (Task X3, Phase 1's output).
 *
 * The whole risk of the H-1B sponsorship signal lives in this file. LCA employer names are legal
 * entities ("GOOGLE LLC", "AMAZON.COM SERVICES LLC", "People Center, Inc. d/b/a Rippling") and our
 * `company` strings are brands ("Google", "Amazon", "Rippling"). Telling a candidate that a company
 * sponsors because a similarly-named OTHER company filed is the "confident wrong answer" failure
 * this codebase keeps producing, so every rule below is written to fail closed.
 *
 * MEASURED against the full ingested corpus — FY2021 Q1 to FY2026 Q1, 21 quarters, 2.9M certified
 * determinations, 144,584 distinct employers — for all 20 company strings this DB knows:
 *
 *   naive normalise + legal-suffix strip, exact          9/20 = 45%   <- fails the ~60% bar
 *   tiers A+B+C below                                   14/20 = 70% matched, 3 ambiguous, 3 unmatched
 *
 * WIDENING THE WINDOW MADE THE MATCHER STRICTER, NOT LOOSER, and that is the headline result. Over 2
 * quarters this file matched 15 of 20 and looked better. Over 21 the extra history brought in
 * companies that share our brands' names — "LINEAR SIGNS, INC.", "Mercury Systems Inc.",
 * "Ramp Systems, Inc." — and every one of them turned a confident match into a declined one:
 *
 *   Linear   5 quarters: unmatched  ->  21 quarters: AMBIGUOUS (8 other employers use "linear")
 *   Mercury  5 quarters: matched C  ->  21 quarters: AMBIGUOUS (37 others use "mercury")
 *   Ramp     5 quarters: matched C  ->  21 quarters: AMBIGUOUS (Ramp Systems, Inc. is not Ramp)
 *
 * The Linear row is the one that matters. At 21 quarters the data contains "Linear Labs LLC", an
 * electric-motor company, and it was the SOLE all-holdco candidate — so the old candidate-set
 * ambiguity check passed it and reported that Linear.app sponsors H-1Bs. It has never filed one.
 * brandFamily() exists because of that: a guard that only asks whether the candidates disagree with
 * each other never asks whether the single candidate is plausible.
 *
 * THE TIERS. Confidence is not a vibe; each number is the measured ambiguity of its rule.
 *
 *   A  0.95  exact match on the legal name after stripping legal-entity suffixes.
 *            Measured: only 1.0% of stripped keys span more than one FEIN, and nearly all of those
 *            are a brand's own subsidiaries (Fidelity, Barclays, Deloitte). Safe.
 *   B  0.80  exact match on a name parsed out of the `d/b/a` / TRADE_NAME_DBA field.
 *            Not an enhancement — Rippling is reachable ONLY this way ("People Center, Inc. d/b/a
 *            Rippling", 30 certified in FY2025 Q4). Ranked below A because a DBA is a claim about a
 *            trading name rather than the registered entity.
 *   C  0.60  brand + a remainder drawn ENTIRELY from HOLDCO_TOKENS, and exactly one distinct
 *            employer in the candidate set — by FEIN where the source file carries one, by legal
 *            name where it does not (see countDistinctEntities; the pre-FY2024 files have no FEIN
 *            column at all) — AND the brand token must be distinctive (see brandFamily).
 *
 * WHAT IS DELIBERATELY NOT A TIER: substring / token-containment matching. It is not tuned down,
 * it is absent. Measured, it produces `Linear -> Thomson Linear LLC` and
 * `Retool -> GLOBAL RETOOL GROUP AMERICA, LLC`. There is no threshold at which that is useful.
 *
 * WHY HOLDCO_TOKENS IS A CLOSED LIST AND NOT A SUFFIX HEURISTIC — the Mercury case, which is the
 * reason this file is shaped like this. THIRTY-EIGHT distinct employers whose name starts with
 * "Mercury" appear in 21 quarters. The fintech is `Mercury Technologies, Inc.`; `Mercury Insurance
 * Services, LLC` files more, and the insurer's LCAs are for *Senior Software Engineer, Staff
 * Software Engineer, Senior Site Reliability Engineer* — so NAICS code and job title DO NOT
 * disambiguate them. The obvious "pick the software-looking one" heuristic picks the wrong Mercury,
 * confidently. Only an allowlist of tokens that carry no line-of-business meaning ("Technologies",
 * "OpCo", "Labs") can be crossed safely, and even then only when it leaves exactly one employer
 * standing AND nobody else uses the brand word at all.
 *
 * Pure and dependency-free on purpose: the ingester, the reconciler and the tests all call the same
 * functions, so "what does this match" has one answer.
 */

// Registered-entity forms. Stripped from the TAIL, repeatedly, because "Foo Inc. USA" happens.
// `pbc` is in here because leaving it out is what cost us Anthropic (52 certified) in the naive run.
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'lc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'lp', 'llp', 'pllc', 'plc', 'pc', 'pbc', 'sa', 'nv', 'bv', 'ag', 'gmbh', 'pte', 'pvt', 'private',
  'ulc', 'lllp',
]);

// Geographic/organisational qualifiers that a US filing entity appends without changing the brand.
// Note what is NOT here: 'technologies', 'services', 'group' and friends. Stripping those would
// collapse `Mercury Insurance Services` into `Mercury`, and `PowerLattice Technologies` (a real
// company string of ours) into `PowerLattice`.
const GEO_SUFFIXES = new Set([
  'usa', 'us', 'america', 'na', 'international', 'global', 'worldwide',
]);

// The ONLY tokens a brand may be followed by and still be treated as the same brand (tier C).
// Every entry has to be a word that says nothing about what the company DOES — that is the test for
// adding one. "Insurance", "Healthcare", "Semiconductor", "Bearing" are lines of business and must
// never appear here, or Mercury happens.
const HOLDCO_TOKENS = new Set([
  'opco', 'labs', 'lab', 'technologies', 'technology', 'platforms', 'platform', 'holdings',
  'holding', 'group', 'ventures', 'payments', 'systems', 'software', 'solutions', 'brands',
  'enterprises', 'business', 'operations', 'studios', 'works', 'digital',
]);

const TIER_CONFIDENCE = { A: 0.95, B: 0.80, C: 0.60 };

// Below this a match is stored but NEVER rendered as a statement about the company. See
// lcaLayer.js's `presentable` and the UI's use of it.
const PRESENTABLE_MIN_CONFIDENCE = 0.60;
// At or above this, the evidence renders as prose with a count. Between the two it renders only
// with the matched legal entity named inline and a "matched on name" qualifier.
const HIGH_CONFIDENCE = 0.80;

/**
 * Brand/entity name -> comparable key. Lowercase, punctuation to spaces, `&` spelled out,
 * parentheticals dropped, and everything from the first d/b/a marker onward removed (that tail is
 * a DIFFERENT name and is extracted separately by parseDbaNames).
 */
function normalizeEmployerName(raw) {
  if (raw == null) return '';
  return String(raw)
    .toLowerCase()
    .replace(/\bd\/?b\/?a\b/g, '|')
    .replace(/\bdba\b/g, '|')
    .split('|')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    // DOTTED ACRONYMS FIRST, before punctuation becomes whitespace. "OpenAI, L.L.C." otherwise
    // tokenises to `openai l l c`, whose tail is three single letters that stripLegalSuffix has no
    // entry for — so it survives as a distinct "employer" and made OpenAI look like a brand token
    // shared with two unrelated businesses. Deliberately narrow: it only collapses runs of
    // single-letter-plus-dot, so `L.L.C.` -> `llc` and `L.P.` -> `lp` while `Amazon.com` is left alone.
    .replace(/\b(?:[a-z]\.){2,}/g, m => m.replace(/\./g, ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The trading names hiding inside an employer/trade-name string, i.e. everything AFTER a d/b/a
 * marker. `People Center, Inc. d/b/a Rippling` -> ['rippling'].
 */
function parseDbaNames(raw) {
  if (raw == null) return [];
  return String(raw)
    .toLowerCase()
    .replace(/\bd\/?b\/?a\b/g, '|')
    .replace(/\bdba\b/g, '|')
    .split('|')
    .slice(1)
    .map(part => stripLegalSuffix(normalizeEmployerName(part)))
    .filter(Boolean);
}

/** Repeatedly drops trailing legal/geo suffix tokens. Never strips the last remaining token. */
function stripLegalSuffix(normalized) {
  if (!normalized) return '';
  const tokens = normalized.split(' ');
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    if (LEGAL_SUFFIXES.has(last) || GEO_SUFFIXES.has(last)) { tokens.pop(); changed = true; }
  }
  return tokens.join(' ');
}

/** The key a `company` string and an LCA `EMPLOYER_NAME` are compared on. */
function companyMatchKey(raw) {
  return stripLegalSuffix(normalizeEmployerName(raw));
}

/**
 * True when `entityKey` is `brandKey` followed only by HOLDCO_TOKENS — the tier-C shape.
 * Requires a strictly longer token list, so it can never fire on an exact match (that is tier A).
 */
function isHoldcoExtension(brandKey, entityKey) {
  if (!brandKey || !entityKey || !entityKey.startsWith(brandKey + ' ')) return false;
  const brandLen = brandKey.split(' ').length;
  const tail = entityKey.split(' ').slice(brandLen);
  return tail.length > 0 && tail.every(t => HOLDCO_TOKENS.has(t));
}

/**
 * Everything in the LCA data whose legal name STARTS with this brand, split three ways.
 *
 * This is the measurement that makes the brand-prefix rules safe, and it exists because widening
 * the corpus from 5 quarters to 21 broke both of them in opposite directions:
 *
 *   `foreign` — entities that begin with the brand token and then say what they DO:
 *      "LINEAR SIGNS, INC.", "Linear Financial Technologies LLC", "Mercury Insurance Services".
 *      A non-empty foreign set is direct evidence that the brand token is a WORD other businesses
 *      use, not a distinctive name. Over 21 quarters "linear" picks up three such companies, and
 *      tier C — seeing exactly one all-holdco candidate, "Linear Labs LLC" — happily matched it.
 *      Linear.app has never filed an LCA. That is a confidently wrong answer produced by a guard
 *      that only ever checked for ambiguity AMONG candidates, never whether the one candidate was
 *      plausible at all.
 *
 *   `holdco` — brand + tokens that carry no line of business ("OpenAI OpCo, LLC",
 *      "AIRBNB PAYMENTS, INC.", "Notion Labs, Inc.").
 *
 *   `exact` — the registered name is the brand.
 *
 * A brand with an empty foreign set is DISTINCTIVE: nobody else in ~500k employer-quarters uses the
 * word, so its holdco siblings are the same company and can be counted together. That is what fixes
 * the other break — OpenAI files as "OpenAI, LP" (11 certified) AND "OpenAI OpCo, LLC" (179), and a
 * tier A that stopped at the exact match reported 9 for a company with ~193.
 */
function brandFamily(brandKey, entities) {
  const exact = [], holdco = [], foreign = [];
  for (const e of entities) {
    if (e.legalKey === brandKey) { exact.push(e); continue; }
    if (!e.legalKey.startsWith(brandKey + ' ')) continue;
    (isHoldcoExtension(brandKey, e.legalKey) ? holdco : foreign).push(e);
  }
  return { exact, holdco, foreign, distinctive: foreign.length === 0 };
}

/**
 * How many DISTINCT employers a candidate set contains, and by what measure.
 *
 * FEIN is the right answer and the reason tier C is safe at all — it is the employer's tax ID, so
 * two candidates sharing one FEIN are one company wearing two names, and two FEINs are two
 * companies. But **the OFLC disclosure files did not carry EMPLOYER_FEIN before FY2024 Q1**: FY2021
 * through FY2023 are 96 columns with no employer tax ID anywhere in them. Counting FEINs over those
 * rows yields zero, and `0 <= 1` would have quietly turned the ambiguity guard OFF for twelve of the
 * twenty-one quarters — the exact false attribution the tier exists to prevent, arriving silently as
 * a side effect of widening the window.
 *
 * So the basis DEGRADES rather than disappearing: if every candidate has a FEIN, count FEINs; if any
 * candidate does not, fall back to counting distinct normalised legal names. The fallback is
 * strictly more cautious — it declines a genuine roll-up of two holdco entities under one FEIN
 * ("Foo Labs" + "Foo Platforms", same tax ID) that the FEIN basis would have accepted. That is the
 * correct direction to be wrong in: a missed match costs a candidate a chip on a company page, a
 * wrong one tells them a company sponsors when it does not.
 */
function countDistinctEntities(candidates) {
  const feins = candidates.map(e => e.fein).filter(Boolean);
  if (feins.length === candidates.length) {
    return { count: new Set(feins).size, basis: 'FEIN' };
  }
  return { count: new Set(candidates.map(e => e.legalKey)).size, basis: 'legal name' };
}

/**
 * Resolves one company string against an LCA entity index.
 *
 * @param {string} company
 * @param {{ legalKey: string, dbaKeys: string[], fein: string, employerName: string, state: string }[]} entities
 *   One element per distinct (employer_name, FEIN) the LCA data contains. The caller builds this
 *   once and reuses it — matching 20 companies must not mean 20 scans in production, but the scan
 *   is here rather than an index so that the ambiguity check sees the WHOLE candidate set.
 * @returns {{ status: 'matched'|'ambiguous'|'unmatched', tier: 'A'|'B'|'C'|null,
 *   confidence: number, key: string, entities: object[], candidateCount: number,
 *   reason: string }}
 */
function matchCompanyToEntities(company, entities) {
  const key = companyMatchKey(company);
  const base = { key, tier: null, confidence: 0, entities: [], candidateCount: 0 };
  if (!key) return { ...base, status: 'unmatched', reason: 'empty company name' };

  const family = brandFamily(key, entities);

  // Tier A — the registered name IS the brand. Holdco siblings join it only when the brand token is
  // distinctive, i.e. no other business in the corpus uses the word. That condition is what lets
  // "OpenAI, LP" and "OpenAI OpCo, LLC" be counted as one company (they are) without licensing the
  // same move for a brand like "Mercury", where the token is shared with an insurer and a defence
  // contractor. Never 'ambiguous': an exact registered-name match plus a distinctive token is not a
  // guess. The entity list travels with the match so the UI names everything it summed.
  if (family.exact.length) {
    const rolled = family.distinctive ? [...family.exact, ...family.holdco] : family.exact;
    const extra = rolled.length - family.exact.length;
    return { ...base, status: 'matched', tier: 'A', confidence: TIER_CONFIDENCE.A,
      entities: rolled, candidateCount: rolled.length,
      reason: `exact legal-name match on "${key}"` +
        (extra ? `, plus ${extra} holding-company sibling${extra === 1 ? '' : 's'} ` +
                 `(${family.holdco.map(e => e.employerName).join(', ')})` : '') +
        (family.foreign.length
          ? `; ${family.foreign.length} unrelated employer(s) share the name and were excluded`
          : '') };
  }

  // Tier B — exact on a parsed trading name.
  const tierB = entities.filter(e => e.dbaKeys.includes(key));
  if (tierB.length) {
    return { ...base, status: 'matched', tier: 'B', confidence: TIER_CONFIDENCE.B,
      entities: tierB, candidateCount: tierB.length,
      reason: `d/b/a trading-name match on "${key}"` };
  }

  // Tier C — no registered name matches the brand, only brand-plus-holdco names do. TWO conditions,
  // and the second one is the lesson from Linear: the candidate set must be unambiguous AND the brand
  // token must not be a word other businesses use. Checking only the first matched Linear.app to
  // "Linear Labs LLC", an unrelated motor company, because it was the sole all-holdco candidate.
  if (family.holdco.length) {
    if (!family.distinctive) {
      return { ...base, status: 'ambiguous', candidateCount: family.holdco.length,
        entities: family.holdco,
        reason: `"${key}" is not a distinctive name — ${family.foreign.length} other employer(s) ` +
                `use it (${family.foreign.slice(0, 3).map(e => e.employerName).join(', ')}), so ` +
                `${family.holdco.map(e => e.employerName).join(', ')} cannot be attributed safely` };
    }
    const { count, basis } = countDistinctEntities(family.holdco);
    if (count <= 1) {
      return { ...base, status: 'matched', tier: 'C', confidence: TIER_CONFIDENCE.C,
        entities: family.holdco, candidateCount: family.holdco.length,
        reason: `brand-prefix match: ${family.holdco.map(e => e.employerName).join(', ')}` };
    }
    return { ...base, status: 'ambiguous', candidateCount: family.holdco.length,
      entities: family.holdco,
      reason: `${count} distinct employers (by ${basis}) share the name "${key}": ` +
              `${family.holdco.map(e => e.employerName).join(', ')}` };
  }

  return { ...base, status: 'unmatched', reason: `no LCA employer matches "${key}"` };
}

/**
 * Builds the entity index matchCompanyToEntities() consumes, from rows of lca_employer_periods
 * (or from a freshly parsed file, which is why it takes plain objects and not a DB handle).
 * Collapses the per-period rows into one entry per (employer_name, FEIN).
 *
 * `legalKey` IS ALWAYS RECOMPUTED from the employer name, never read from the row — and that is the
 * point of this comment. `lca_employer_periods.employer_key` was written by whatever version of
 * companyMatchKey() was current when the file was parsed, so it goes stale the moment normalisation
 * improves. It did: adding dotted-acronym handling left 280 of OpenAI's 308 filings behind a
 * `openai l l c` key that no longer matches anything the matcher produces, and because that stale
 * key parses as a non-holdco remainder it read as an UNRELATED employer — which switched off the
 * brand's distinctiveness and silently blocked the roll-up. The company rendered 28 instead of 308.
 *
 * `storedKey` is kept beside it because the database lookup has to use the value actually on disk
 * (it is part of the primary key). Two rows whose stale keys differ but whose recomputed keys agree
 * become two entities with the same legalKey, which is exactly right: they are one company filing
 * under several spellings, and each still resolves to its own rows.
 */
function buildEntityIndex(rows) {
  const byId = new Map();
  for (const r of rows) {
    const legalKey = companyMatchKey(r.employer_name) || r.employer_key || '';
    const id = `${r.fein || ''}|${r.employer_key || legalKey}|${r.employer_name}`;
    if (!byId.has(id)) {
      byId.set(id, {
        legalKey,
        storedKey: r.employer_key || legalKey,
        dbaKeys: [],
        fein: r.fein || '',
        employerName: r.employer_name,
        state: r.state || null,
      });
    }
    const e = byId.get(id);
    let dba = r.dba_keys_json;
    if (typeof dba === 'string') { try { dba = JSON.parse(dba); } catch { dba = []; } }
    for (const k of dba || []) if (k && !e.dbaKeys.includes(k)) e.dbaKeys.push(k);
  }
  return [...byId.values()];
}

export {
  LEGAL_SUFFIXES,
  GEO_SUFFIXES,
  HOLDCO_TOKENS,
  TIER_CONFIDENCE,
  PRESENTABLE_MIN_CONFIDENCE,
  HIGH_CONFIDENCE,
  normalizeEmployerName,
  parseDbaNames,
  stripLegalSuffix,
  companyMatchKey,
  isHoldcoExtension,
  brandFamily,
  countDistinctEntities,
  matchCompanyToEntities,
  buildEntityIndex,
};
