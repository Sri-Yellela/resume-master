/**
 * Company KB — matching a `company` string to DOL LCA legal entities (Task X3, Phase 1's output).
 *
 * The whole risk of the H-1B sponsorship signal lives in this file. LCA employer names are legal
 * entities ("GOOGLE LLC", "AMAZON.COM SERVICES LLC", "People Center, Inc. d/b/a Rippling") and our
 * `company` strings are brands ("Google", "Amazon", "Rippling"). Telling a candidate that a company
 * sponsors because a similarly-named OTHER company filed is the "confident wrong answer" failure
 * this codebase keeps producing, so every rule below is written to fail closed.
 *
 * MEASURED, 2026-08-22, against FY2025 Q4 + FY2026 Q1 (18,279 / 24,887 distinct employer names) for
 * all 20 distinct company strings this DB knows:
 *
 *   naive normalise + legal-suffix strip, exact          9/20 = 45%   <- fails the ~60% bar
 *   tiers A+B+C below                                   15/20 = 75%
 *   ...of the 5 misses, ALL FIVE are true negatives (no such employer files under any spelling),
 *      so recall against companies that actually filed is 15/15.
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
 *   C  0.60  brand + a remainder drawn ENTIRELY from HOLDCO_TOKENS, and exactly one FEIN in the
 *            candidate set. Recovers OpenAI OpCo LLC, Notion Labs Inc, Ramp Business Corporation.
 *
 * WHAT IS DELIBERATELY NOT A TIER: substring / token-containment matching. It is not tuned down,
 * it is absent. Measured, it produces `Linear -> Thomson Linear LLC` and
 * `Retool -> GLOBAL RETOOL GROUP AMERICA, LLC`. There is no threshold at which that is useful.
 *
 * WHY HOLDCO_TOKENS IS A CLOSED LIST AND NOT A SUFFIX HEURISTIC — the Mercury case, which is the
 * reason this file is shaped like this. Four unrelated `Mercury *` employers file every quarter.
 * The fintech is `Mercury Technologies, Inc.` (2-6 certified); `Mercury Insurance Services, LLC`
 * files 7. And Mercury Insurance's LCAs are for *Senior Software Engineer, Staff Software Engineer,
 * Senior Site Reliability Engineer* — so NAICS code and job title DO NOT disambiguate them. The
 * obvious "pick the software-looking one" heuristic picks the wrong Mercury, confidently. Only an
 * allowlist of tokens that carry no line-of-business meaning ("Technologies", "OpCo", "Labs") can
 * be crossed safely, and even then only when it leaves exactly one FEIN standing.
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

  // Tier A — exact on the registered name. Multiple entities here are the SAME brand's legal
  // family (AIRBNB, INC. and its siblings), which is a roll-up and not an ambiguity, so this tier
  // never returns 'ambiguous'. The entity list is stored so the UI can disclose what it summed.
  const tierA = entities.filter(e => e.legalKey === key);
  if (tierA.length) {
    return { ...base, status: 'matched', tier: 'A', confidence: TIER_CONFIDENCE.A,
      entities: tierA, candidateCount: tierA.length,
      reason: `exact legal-name match on "${key}"` };
  }

  // Tier B — exact on a parsed trading name.
  const tierB = entities.filter(e => e.dbaKeys.includes(key));
  if (tierB.length) {
    return { ...base, status: 'matched', tier: 'B', confidence: TIER_CONFIDENCE.B,
      entities: tierB, candidateCount: tierB.length,
      reason: `d/b/a trading-name match on "${key}"` };
  }

  // Tier C — brand + holdco tokens only, and it must leave exactly one FEIN standing. Two FEINs
  // means two companies as far as this rule can tell, and it declines rather than guessing.
  const tierC = entities.filter(e => isHoldcoExtension(key, e.legalKey));
  if (tierC.length) {
    const feins = new Set(tierC.map(e => e.fein).filter(Boolean));
    if (feins.size <= 1) {
      return { ...base, status: 'matched', tier: 'C', confidence: TIER_CONFIDENCE.C,
        entities: tierC, candidateCount: tierC.length,
        reason: `brand-prefix match: ${tierC.map(e => e.employerName).join(', ')}` };
    }
    return { ...base, status: 'ambiguous', candidateCount: tierC.length, entities: tierC,
      reason: `${feins.size} distinct employers share the name "${key}": ` +
              `${tierC.map(e => e.employerName).join(', ')}` };
  }

  return { ...base, status: 'unmatched', reason: `no LCA employer matches "${key}"` };
}

/**
 * Builds the entity index matchCompanyToEntities() consumes, from rows of lca_employer_periods
 * (or from a freshly parsed file, which is why it takes plain objects and not a DB handle).
 * Collapses the per-period rows into one entry per (employer_name, FEIN).
 */
function buildEntityIndex(rows) {
  const byId = new Map();
  for (const r of rows) {
    const legalKey = r.employer_key || companyMatchKey(r.employer_name);
    const id = `${r.fein || ''}|${legalKey}|${r.employer_name}`;
    if (!byId.has(id)) {
      byId.set(id, {
        legalKey,
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
  matchCompanyToEntities,
  buildEntityIndex,
};
