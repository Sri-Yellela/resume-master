// ── WHAT AN ATS SCORE IS ALLOWED TO SAY ─────────────────────────────────────────────────────────
//
// The engine orders coarsely and it cannot support a displayed number. Against the owner's
// human-graded 30 it runs Spearman rho 0.746, Kendall tau-b 0.594, with 12.2% of pairs still
// mis-ordered. That is a real, useful signal and it is nowhere near "this job is a 43".
//
// So the number stays internal — the auto-apply gate still uses it, see the note at the bottom —
// and every user-facing surface renders a BAND.
//
// ── WHERE THE CUTPOINTS COME FROM ───────────────────────────────────────────────────────────────
//
// Not from percentiles. From the owner's 30 graded postings joined to their engine scores, which is
// the only independent check this engine has ever had. (AK1's rho = 0.504 was self-graded by the
// same kind of model that does the scoring, and its 30 postings were never committed, so it cannot
// be re-joined.)
//
// STRONG >= 44 IS CHOSEN FOR PRECISION, DELIBERATELY, AND IT COSTS RECALL.
// 44 is the lowest cutpoint at which precision against "human graded this 4 or 5" reaches 100%:
//
//     cutpoint   precision(human>=4)   recall of human-5s
//       40             91%                   67%
//       42             90%                   67%
//       44            100%                   67%      <- chosen
//       46            100%                   58%
//
// Below 44 the band admits a posting the owner rated poorly; above 44 it only loses good ones. The
// explicit, accepted cost: **4 of the 12 postings the owner graded 5 do not reach Strong** — they
// render Moderate. A Strong band that admits a bad match is worse than a smaller one, because
// Strong is the band a user acts on.
//
// WEAK < 26 IS CHOSEN FOR CALIBRATION AGAINST THE HUMAN, not for separation alone. The owner graded
// 36.7% of the sample 1-or-2; a cutpoint of 26 puts 40.8% of the live board in Weak, the closest
// available match. A cutpoint of 30 separates the graded set slightly better but swells Weak to
// 64.9% of the board — an engine markedly more pessimistic than the human it is meant to agree
// with, and a board that reads as uniformly hopeless.
//
// Populations across the 1291 live postings, scored against the owner's real profile:
//     Strong             72   5.6%
//     Moderate          691  53.5%
//     Weak              527  40.8%
//     Not enough signal   1   0.1%
//
// NOT_ENOUGH_SIGNAL IS REQUIRED AND IT IS ALMOST EMPTY, and those are both true. It holds one
// posting in 1291. It is a CORRECTNESS state — the scorer declining rather than fabricating, which
// took the false-match rate from 22.8% to 0.8% — not a population to be balanced. Do not widen the
// other three to "give it something to do", and do not tune against it: it is one row. It exists
// for the surfaces the curated board does not cover (pasted job descriptions, truncated scrapes,
// and a swipe feed scoring against a base resume), and it must never render as a low score.

export const ATS_BAND = {
  STRONG: "strong",
  MODERATE: "moderate",
  WEAK: "weak",
  NOT_ENOUGH_SIGNAL: "not_enough_signal",
};

/** Cutpoints are INCLUSIVE lower bounds on the internal score. */
export const ATS_BAND_CUTPOINTS = Object.freeze({
  strong: 44,
  moderate: 26,
});

export const ATS_BAND_LABELS = Object.freeze({
  [ATS_BAND.STRONG]: {
    label: "Strong match",
    short: "Strong",
    blurb: "Your resume covers most of what this posting asks for.",
    tone: "positive",
    bg: "#dcfce7", fg: "#166534",
  },
  [ATS_BAND.MODERATE]: {
    label: "Moderate match",
    short: "Moderate",
    blurb: "Some of what this posting asks for is covered, and some is missing.",
    tone: "neutral",
    bg: "#fef9c3", fg: "#854d0e",
  },
  [ATS_BAND.WEAK]: {
    label: "Weak match",
    short: "Weak",
    blurb: "Little of what this posting asks for appears in your resume.",
    tone: "negative",
    bg: "#fee2e2", fg: "#991b1b",
  },
  // Deliberately NOT phrased as a degree of fit. It is the absence of a judgement, and the copy has
  // to say so, or it reads as a fourth, worse grade than Weak.
  [ATS_BAND.NOT_ENOUGH_SIGNAL]: {
    label: "Not enough signal",
    short: "No signal",
    blurb: "This posting does not say enough for a fit to be judged. It is not a poor match — it is an unknown one.",
    tone: "unknown",
    // Grey, and deliberately not on the green-amber-red scale: this is the absence of a
    // judgement, so it must not read as a position on the axis the other three share.
    bg: "#e5e7eb", fg: "#4b5563",
  },
});

/**
 * The band for a report, or for a bare score.
 *
 * A NULL SCORE IS NOT A ZERO. `scoreAtsLocally` returns null with `decline_reasons` when it has no
 * basis for an opinion; anything that coerced that to 0 would render the most honest answer the
 * engine gives as the worst grade it has.
 */
export function atsBandFor(reportOrScore) {
  const score = typeof reportOrScore === "number" || reportOrScore === null
    ? reportOrScore
    : reportOrScore?.score ?? null;
  if (score == null || !Number.isFinite(score)) return ATS_BAND.NOT_ENOUGH_SIGNAL;
  if (score >= ATS_BAND_CUTPOINTS.strong) return ATS_BAND.STRONG;
  if (score >= ATS_BAND_CUTPOINTS.moderate) return ATS_BAND.MODERATE;
  return ATS_BAND.WEAK;
}

export function atsBandLabel(band) {
  return ATS_BAND_LABELS[band] || ATS_BAND_LABELS[ATS_BAND.NOT_ENOUGH_SIGNAL];
}

// ── THE THIN-RESUME CASE ────────────────────────────────────────────────────────────────────────
//
// A fixed cutpoint is a fixed cutpoint, and the score is relative to a resume. Measured on the two
// profiles on this board: the owner's real resume runs median 27 / max 64, while the placeholder
// "John Doe" resume runs median 20 / max 42 — so under these bands that profile would see ZERO
// Strong and an almost entirely Weak board. That is the first thing a new user would see, and it
// would be telling them the market is hopeless when the truth is that their resume has not been
// filled in.
//
// THREE OPTIONS WERE ON THE TABLE AND THIS IS WHY THIS ONE:
//   profile-relative cutpoints — rejected. Forcing ~6% of any board into Strong invents a strong
//     match where there may be none, which is the same fabrication the decline behaviour exists to
//     prevent. It would also make two users' "Strong" incomparable.
//   a floor under every score — rejected. Arbitrary, and it lies in the same direction.
//   a distinct state — chosen. It is honest about which side the problem is on, and unlike the
//     other two it is ACTIONABLE: the user can fix a thin resume, and cannot fix a miscalibrated
//     band they cannot see.
//
// This does not replace the bands; it accompanies them, so a user still sees the ordering while
// being told why the whole board looks flat.
export const THIN_RESUME = Object.freeze({
  /** Below this many characters a resume cannot cover a posting's terms however good the fit. */
  MIN_RESUME_CHARS: 2200,
  /** Distinct skills/keywords the profile brings to matching. */
  MIN_PROFILE_SKILLS: 8,
});

/**
 * Is the FLAT BOARD explained by the resume rather than by the jobs?
 *
 * Takes the runtime basis, not a score, because this is a property of the profile and must render
 * the same on every posting rather than flickering per job.
 */
export function resumeDepthWarning(basis = {}) {
  const chars = String(basis.resumeText || "").length;
  const skills = Array.isArray(basis.skills) ? basis.skills.length : 0;
  if (chars >= THIN_RESUME.MIN_RESUME_CHARS && skills >= THIN_RESUME.MIN_PROFILE_SKILLS) return null;
  return {
    reason: chars < THIN_RESUME.MIN_RESUME_CHARS ? "short_resume" : "few_skills",
    chars,
    skills,
    headline: "Your resume may be too thin to match against",
    detail:
      "Bands are computed by comparing your resume's wording to each posting's. There is not much " +
      "here to compare, so most jobs will read as a weak match regardless of how good a fit they " +
      "actually are. Adding detail to your resume will change these bands more than changing your filters will.",
  };
}

// ── THE AUTO-APPLY GATE IS NOT A BAND ───────────────────────────────────────────────────────────
//
// The gate keeps using the NUMBER (threshold 30, recalibrated from 50 by AK1 when the scale moved).
// Bands are a display concern and must not be coupled to it, in either direction:
//
//   - Do not gate on `band === "strong"`. Strong is 44 and is tuned for PRECISION over the graded
//     set; using it as the gate would cut auto-apply volume from ~36% of the board to ~6% as a side
//     effect of a copy decision.
//   - Do not move the Strong cutpoint to match the gate. They answer different questions: the gate
//     asks "is this safe to submit unattended", the band asks "what should this person be told".
//
// The two numbers being 44 and 30 is not a near-miss to be tidied up. They are independent, and
// test/atsBandSurfaces.test.js asserts they stay that way.
