/**
 * HTML → plain text for job descriptions.
 *
 * schema.js's normalizeJob contract (see its `description` param) requires plain text with no
 * HTML, but several ATS list endpoints hand back markup — and Greenhouse hands back markup that
 * is itself entity-encoded, so the raw string looks like `&lt;p&gt;Hello&lt;/p&gt;` rather than
 * `<p>Hello</p>`. Stripping tags off that without decoding first removes nothing at all: there
 * are no literal `<` characters to match.
 *
 * Hence decode → strip → decode: the first decode turns the encoded markup into real markup, the
 * strip removes it, and the second decode resolves entities that were part of the actual text
 * (a `&amp;amp;` in the source is `&amp;` after one pass and `&` only after two). The second pass
 * runs on tag-free text, so it can't resurrect markup.
 *
 * Deliberately regex-based rather than a parser dependency: the output is only ever read by an
 * LLM (enrichJob.js) and truncated into `summary`, so structural fidelity doesn't matter —
 * only that the words survive and the tags don't.
 */

// Cap for a stored job description. Sized to sit just above enrichJob.js's 4000-char prompt
// slice, so enrichment always sees its full window while the DB never holds an unbounded blob.
const JOB_DESCRIPTION_MAX_LENGTH = 5000;

// How much of the END of a posting to keep when it exceeds the cap.
//
// A prefix-only truncation drops precisely the part worth keeping: compensation disclosures, EEO
// statements and benefits are written at the BOTTOM of a posting. Measured on Figma's greenhouse
// board — 29 of 36 stored postings contained a pay figure in the source and every one of them was
// cut off before it, so enrichment read text whose salary had already been removed and then
// correctly reported finding none.
//
// Keeping a tail slice costs nothing extra: the total stays within JOB_DESCRIPTION_MAX_LENGTH.
// What it trades away is the middle of a long posting, which is the least information-dense part —
// responsibilities and requirements lead, and the ~3000-char head still covers them.
//
// 2000 is measured, not guessed. The pay figure is NOT the last thing in a posting — EEO and
// diversity boilerplate follows it — so the tail has to reach past that trailer. Across Figma's 94
// postings that quote a figure, the distance from the end to the figure is 1898-1900 characters
// (the trailer is near-identical between postings). A 1200-char tail covered 0 of 94; 2000 covers
// all 94 with room for a longer trailer elsewhere. Re-measure before assuming it holds for a
// company whose boilerplate is longer.
const JOB_DESCRIPTION_TAIL_LENGTH = 2000;

// Marked rather than silent: an elided middle that reads as continuous prose would let the model
// treat two unrelated sentences as one claim.
const ELISION = '\n[…]\n';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Reject non-characters rather than emitting U+FFFD garbage into the description.
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

/**
 * Converts (possibly entity-encoded) HTML into plain text suitable for normalizeJob.
 * @param {string|null|undefined} html
 * @param {{ maxLength?: number, tailLength?: number }} [options]
 *   maxLength  caps the result; omit for no cap.
 *   tailLength when the text exceeds maxLength, keep this many characters from the END as well as
 *              the head, joined by an elision marker. The total still respects maxLength. Omit for
 *              plain prefix truncation.
 * @returns {string|null} plain text, or null if there was no usable text
 */
function htmlToText(html, { maxLength, tailLength = 0 } = {}) {
  if (typeof html !== 'string' || !html.trim()) return null;

  let text = decodeEntities(html);

  // Drop script/style wholesale — their contents are code, not description prose.
  text = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Preserve the line structure that carries meaning in a posting (bullets, paragraph breaks)
  // before flattening everything else, so requirement lists don't run together into one blob.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text);

  // Collapse the whitespace the tag-stripping just introduced, but keep paragraph breaks.
  text = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return null;
  return truncateWithTail(text, maxLength, tailLength);
}

/**
 * Cap `text` at `maxLength`, keeping `tailLength` characters from the end when one is asked for.
 * Exported so callers holding already-plain text (ashby's `descriptionPlain`) truncate the same
 * way as callers going through htmlToText, rather than a bare prefix slice.
 */
function truncateWithTail(text, maxLength, tailLength = 0) {
  if (typeof text !== 'string') return text;
  if (!maxLength || text.length <= maxLength) return text;

  // headRoom <= 0 means the caller asked for a tail as large as the whole budget; there is no head
  // to keep, so fall back to plain prefix truncation rather than returning a marker and a tail.
  const headRoom = maxLength - tailLength - ELISION.length;
  if (!tailLength || headRoom <= 0) return text.slice(0, maxLength).trim();

  return text.slice(0, headRoom).trim() + ELISION + text.slice(-tailLength).trim();
}

export {
  htmlToText, decodeEntities, truncateWithTail,
  JOB_DESCRIPTION_MAX_LENGTH, JOB_DESCRIPTION_TAIL_LENGTH,
};
