/**
 * services/pii/tokenizer.js — deterministic tokenization for generation payloads (task F).
 *
 * WHY TOKENIZATION WORKS HERE AT ALL. Work history is STABLE, so the mapping can be deterministic:
 * the same employer gets the same token every time. The model still sees coherent structure —
 * COMPANY_A for 18 months, then COMPANY_B — and can tailor against it, which a redaction to
 * "[REDACTED]" destroys.
 *
 * ── THE REVERSAL IS WHERE THE RISK MOVES, AND IT IS ASSERTED, NOT HOPED ────────────────────────
 *
 * Tokenizing is easy and safe. Putting the names back is neither, and it has exactly two failure
 * modes, both of which produce a plausible-looking document:
 *
 *   a. A TOKEN IS DROPPED. The model rephrases around COMPANY_B — "at my previous employer" — and
 *      the reversal has nothing to substitute. The artifact is missing a job. It reads fine.
 *   b. A TOKEN IS INVENTED. The model writes COMPANY_C, which was never sent. Reversal either
 *      leaves the literal string in the résumé or, worse, a future mapping change resolves it to
 *      somebody. The artifact contains an employer the candidate never had. It also reads fine.
 *
 * Both are silent. So both are ASSERTIONS, and a generation failing either does not persist. This
 * is the property that makes the design compliance-defensible rather than compliance-shaped: not
 * "we tokenize", but "we can prove what came back is what went out".
 *
 * ⛔ WHAT IS NOT TOKENIZED IS NOT THEREBY SAFE. Excluded fields (immigration status, email,
 * LinkedIn) are not tokenized at all — they are never in the payload. A token still carries the
 * value, and its mapping travels with the request. See shared/piiPolicy.js.
 */

/**
 * Token shapes. Deliberately UPPERCASE_WITH_INDEX and deliberately unlike anything a résumé
 * contains, so the round-trip scan for unsent tokens cannot collide with ordinary prose.
 */
const SHAPES = Object.freeze({
  employer: "COMPANY",
  team: "TEAM",
  institution: "SCHOOL",
  person: "CANDIDATE",
});

/** Any token of any shape. Used to detect INVENTED tokens in a model's output. */
export const ANY_TOKEN_RE = new RegExp(`\\b(?:${Object.values(SHAPES).join("|")})_[A-Z0-9]+\\b`, "g");

/** A, B, ... Z, AA, AB — stable and readable, unlike a hash. */
function letterIndex(n) {
  let s = "";
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Build the mapping for one generation.
 *
 * DETERMINISTIC BY SORTED VALUE, not by encounter order. Encounter order makes the same candidate
 * produce COMPANY_A for different employers on different runs, which means a stored mapping cannot
 * be re-derived and an audit of "what did we send in March" is unanswerable. Sorting is what makes
 * "same employer, same token, every time" true rather than approximately true.
 */
export function buildTokenMap({ employers = [], teams = [], institutions = [], names = [] } = {}) {
  const forward = new Map();  // real value -> token
  const reverse = new Map();  // token -> real value

  const assign = (values, shape) => {
    const unique = [...new Set(values.map(v => String(v || "").trim()).filter(Boolean))].sort();
    unique.forEach((value, i) => {
      if (forward.has(value)) return;
      const token = `${shape}_${shape === SHAPES.employer || shape === SHAPES.person ? letterIndex(i) : i + 1}`;
      forward.set(value, token);
      reverse.set(token, value);
    });
  };

  assign(names, SHAPES.person);
  assign(employers, SHAPES.employer);
  assign(teams, SHAPES.team);
  assign(institutions, SHAPES.institution);

  return { forward, reverse };
}

/** Longest-first, so "Stripe Payments" is replaced before "Stripe" leaves a dangling fragment. */
function orderedEntries(forward) {
  return [...forward.entries()].sort((a, b) => b[0].length - a[0].length);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Replace every real value with its token. Case-insensitive: résumés are not consistent. */
export function tokenizeText(text, map) {
  let out = String(text || "");
  for (const [value, token] of orderedEntries(map.forward)) {
    out = out.replace(new RegExp(escapeRe(value), "gi"), token);
  }
  return out;
}

/** Put the real values back. */
export function detokenizeText(text, map) {
  let out = String(text || "");
  for (const [token, value] of map.reverse.entries()) {
    out = out.replace(new RegExp(`\\b${escapeRe(token)}\\b`, "g"), value);
  }
  return out;
}

/** Which tokens actually appear in the payload we are about to send. */
export function tokensPresentIn(text) {
  return new Set(String(text || "").match(ANY_TOKEN_RE) || []);
}

/**
 * ⛔ THE ROUND TRIP. Both failure modes, both loud.
 *
 * @param sent    Set of tokens that appeared in the OUTBOUND payload.
 * @param output  the model's raw response, before detokenization.
 * @returns {{ok:boolean, dropped:string[], invented:string[], reason:string|null}}
 */
export function checkRoundTrip(sent, output) {
  const seen = tokensPresentIn(output);
  const dropped = [...sent].filter(t => !seen.has(t));
  const invented = [...seen].filter(t => !sent.has(t));
  const ok = dropped.length === 0 && invented.length === 0;
  return {
    ok, dropped, invented,
    reason: ok ? null
      : [
          dropped.length
            ? `${dropped.length} token(s) did not come back (${dropped.join(", ")}) — the model ` +
              `rephrased around them, so the artifact is missing that history`
            : null,
          invented.length
            ? `${invented.length} token(s) were INVENTED (${invented.join(", ")}) — they were never ` +
              `sent, so they resolve to nobody and would put an employer in the résumé that the ` +
              `candidate never had`
            : null,
        ].filter(Boolean).join("; "),
  };
}

/**
 * The whole reversal, refusing rather than returning a damaged document.
 *
 * A GENERATION THAT FAILS THE ROUND TRIP DOES NOT PERSIST. Returning a best-effort artifact would
 * hand the candidate a résumé with a missing job or an invented employer, which is precisely the
 * outcome tokenization was adopted to make impossible.
 */
export function reverseOrThrow({ sentTokens, output, map }) {
  const check = checkRoundTrip(sentTokens, output);
  if (!check.ok) {
    const e = new Error(`tokenization round trip failed: ${check.reason}`);
    e.code = "PII_ROUND_TRIP_FAILED";
    e.dropped = check.dropped;
    e.invented = check.invented;
    throw e;
  }
  const restored = detokenizeText(output, map);
  // Belt and braces: after substitution nothing token-shaped may remain, or a placeholder ships.
  const leftover = restored.match(ANY_TOKEN_RE);
  if (leftover?.length) {
    const e = new Error(`tokenization leaked into the artifact: ${[...new Set(leftover)].join(", ")}`);
    e.code = "PII_TOKEN_LEAKED";
    throw e;
  }
  return restored;
}
