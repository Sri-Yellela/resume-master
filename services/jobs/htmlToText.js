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
 * @param {{ maxLength?: number }} [options] maxLength caps the result; omit for no cap.
 * @returns {string|null} plain text, or null if there was no usable text
 */
function htmlToText(html, { maxLength } = {}) {
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
  return maxLength && text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

export { htmlToText, decodeEntities, JOB_DESCRIPTION_MAX_LENGTH };
