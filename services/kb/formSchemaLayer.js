/**
 * Company KB — application form schemas (TASK G4).
 *
 * Behind a gate is a place our server can never reach. The extension is standing inside it, so the
 * form's STRUCTURE comes back and the next candidate's packet arrives pre-mapped. This is the
 * mechanism that replaces hand-writing platformDetector's PLATFORM_LABEL_MAPS one ATS at a time —
 * greenhouse, lever and workday are written by hand today and everything else falls to `generic`.
 *
 * A form schema is a KB fact and decays like every other one: corroboration, confidence, last_seen,
 * promotion. It follows services/kb/orgLayer.js, including reusing its computeConfidence rather than
 * re-deriving the same maths, with ONE deliberate divergence recorded below.
 *
 * ── STRUCTURE ONLY ─────────────────────────────────────────────────────────────────────────────
 * Labels, types, required flags, option lists, field order. Never a value the candidate entered,
 * never anything about the candidate, never page content beyond the form's shape.
 *
 * This is enforced by a WHITELIST, not by remembering to strip. discoverFields returns
 * `current_value` on every field — a blacklist would have to know that, and would silently pass
 * whatever the next field property turns out to be. FIELD_KEYS is the allowed set and everything
 * else is dropped, which is asserted by test/formSchemaCapture.test.js rather than promised here.
 *
 * ── TWO CONSUMERS, ONE STORE ───────────────────────────────────────────────────────────────────
 * A schema captured by a candidate behind a gate and one produced by our own crawl of a public
 * careers page are the same fact about the same company, so they share a store and differ only in
 * `source`. Building a gated-only variant would mean merging the two later, and the imported-careers
 * -page consumer is the reason this is keyed by apply HOST rather than by job.
 */

import crypto from 'node:crypto';
import { computeConfidence, PROMOTE_MIN_CORROBORATION, PROMOTE_MIN_CONFIDENCE } from './orgLayer.js';
import { decayedWeight } from '../jobs/enrichJob.js';
import { PROFILE_KEY_TO_HANDLER, HANDLER_BY_ATTR, matchesWholeToken } from '../applyAutomation.js';

/**
 * The ONLY properties that may ever be stored. Anything a producer sends that is not on this list is
 * dropped — including `current_value`, which is exactly what a candidate typed.
 */
export const FIELD_KEYS = Object.freeze([
  'order', 'label', 'type', 'required', 'options', 'name', 'handler_type',
]);

const MAX_FIELDS = 200;
const MAX_OPTIONS = 100;
const MAX_TEXT = 300;

const clip = (v) => String(v ?? '').slice(0, MAX_TEXT);

/**
 * Normalise whatever a producer sent into the stored shape.
 *
 * Accepts BOTH extractors without becoming a third one: discoverFields (server side, for a public
 * careers page) emits is_required/field_id/current_value; the extension's probeFormShape emits
 * required/id/index. Neither is re-implemented here — this maps their output onto one shape and
 * throws the rest away.
 */
export function normaliseCapturedFields(rawFields) {
  const out = [];
  for (const [i, f] of (Array.isArray(rawFields) ? rawFields : []).slice(0, MAX_FIELDS).entries()) {
    if (!f || typeof f !== 'object') continue;

    const options = Array.isArray(f.options)
      ? f.options.slice(0, MAX_OPTIONS).map(o => (
          typeof o === 'string'
            ? { value: clip(o), label: clip(o) }
            : { value: clip(o?.value), label: clip(o?.label ?? o?.text) }
        ))
      : [];

    const field = {
      // Order is structure and is worth keeping: two forms with the same fields in a different
      // sequence are different forms to fill.
      order: Number.isInteger(f.order) ? f.order : (Number.isInteger(f.index) ? f.index : i),
      label: clip(f.label),
      type: clip(f.type || 'text'),
      required: f.required === true || f.is_required === true,
      options,
      // The control's NAME, which is the form's own identifier for the question — not the answer.
      name: clip(f.name || f.field_id || f.id),
      handler_type: f.handler_type ? clip(f.handler_type) : null,
    };

    // Belt and braces against the whitelist itself drifting: build the object from FIELD_KEYS so a
    // property added above without being added to the list cannot reach the store.
    out.push(Object.fromEntries(FIELD_KEYS.map(k => [k, field[k]])));
  }
  return out.sort((a, b) => a.order - b.order).map((f, i) => ({ ...f, order: i }));
}

/**
 * Fields nothing in any profile can answer.
 *
 * A property of the FORM, not of a candidate: it asks whether the question is one we have a mapping
 * for at all, so it is the same answer for everyone and belongs on a shared KB row. Requirement 4 —
 * a schema with three unresolvable fields says IN ADVANCE that the run will hold, which is worth
 * far more at queue time than at submit time.
 */
export function unmappedFields(fields) {
  const knownHandlers = new Set(Object.values(PROFILE_KEY_TO_HANDLER));
  const attrHints = Object.keys(HANDLER_BY_ATTR);
  // A file input is the resume, which the packet already carries; a submit-ish control is not a
  // question. Neither is something the candidate has to answer.
  const NOT_A_QUESTION = new Set(['file', 'hidden', 'submit', 'button', 'static']);

  return fields.filter(f => {
    if (NOT_A_QUESTION.has(f.type)) return false;
    if (f.handler_type && knownHandlers.has(f.handler_type)) return false;
    // WHOLE-TOKEN, not substring — the codebase's own convention, and for the same reason it was
    // adopted elsewhere. `includes` counts "Manager's name" as answerable because `name` is a hint,
    // which quietly under-reports the very fields requirement 4 exists to surface.
    const subject = `${f.name} ${f.label}`;
    return !attrHints.some(hint => matchesWholeToken(subject, hint));
  });
}

/**
 * A stable identity for the FORM'S SHAPE. Changes when a question is added, removed, renamed,
 * retyped, or when a required flag or an option list changes — and not when the order of two
 * equally-positioned fields wobbles between captures.
 *
 * This is what makes "the form changed" observable rather than assumed.
 */
export function shapeHash(fields) {
  const canonical = fields
    .map(f => [
      f.name, f.label, f.type, f.required ? '1' : '0',
      f.options.map(o => o.value).join('|'),
    ].join(''))
    .sort()
    .join('');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Host of an apply URL, lowercased. The key this store is organised by. Never throws. */
export function hostOf(url) {
  try { return new URL(String(url)).host.toLowerCase(); } catch { return null; }
}

/**
 * Record one observation of a company's application form.
 *
 * RECONCILES rather than duplicating. Three cases:
 *   - no row yet          a new fact, proposed, corroboration 1
 *   - same shape          corroboration += 1, confidence recomputed, may promote
 *   - DIFFERENT shape     the form changed. The new shape replaces the old, corroboration resets to
 *                         1, and a confirmed schema drops back to proposed.
 *
 * That last case is a deliberate divergence from orgLayer, which never demotes a confirmed unit. An
 * org unit that stops appearing may simply not be hiring; a form that comes back DIFFERENT is
 * positive evidence that the stored one is now wrong, and requirement 3 is explicit that a stale
 * schema which is trusted is worse than no schema at all.
 *
 * @returns {{ applyHost, status, changed, corroborationCount, confidence, fieldCount, unmappedCount }}
 */
export function recordFormSchema(db, {
  applyHost, company = null, platform = null, fields = [], source = 'extension_gated',
  now = Math.floor(Date.now() / 1000),
}) {
  const host = String(applyHost || '').toLowerCase();
  if (!host) {
    const err = new Error('a form schema needs an apply host to be keyed by');
    err.reasonCode = 'form_schema_no_host';
    throw err;
  }

  const clean = normaliseCapturedFields(fields);
  if (clean.length === 0) {
    // Refusing an empty capture is the whole point of G4's ⛔: persisting one would cache the
    // absence of information into the asset that is supposed to compound, and a later reader could
    // not tell "this form has no fields" from "discovery ran too early".
    const err = new Error('refusing to store an empty form schema');
    err.reasonCode = 'form_schema_empty';
    throw err;
  }

  const unmapped = unmappedFields(clean);
  const hash = shapeHash(clean);
  const existing = db.prepare('SELECT * FROM company_form_schemas WHERE apply_host = ?').get(host);

  const changed = !!existing && existing.shape_hash !== hash;
  const corroboration = !existing || changed ? 1 : existing.corroboration_count + 1;
  const firstSeen = existing ? existing.first_seen : now;
  const confidence = computeConfidence(corroboration, now, now);
  const promoted = corroboration >= PROMOTE_MIN_CORROBORATION && confidence >= PROMOTE_MIN_CONFIDENCE;
  const status = promoted ? 'confirmed' : 'proposed';

  db.prepare(`
    INSERT INTO company_form_schemas
      (apply_host, company, platform, fields_json, field_count, unmapped_json, unmapped_count,
       shape_hash, confidence, corroboration_count, status, source, first_seen, last_seen,
       changed_at, previous_shape_hash)
    VALUES (@apply_host, @company, @platform, @fields_json, @field_count, @unmapped_json,
            @unmapped_count, @shape_hash, @confidence, @corroboration_count, @status, @source,
            @first_seen, @last_seen, @changed_at, @previous_shape_hash)
    ON CONFLICT(apply_host) DO UPDATE SET
      company             = COALESCE(excluded.company, company_form_schemas.company),
      platform            = COALESCE(excluded.platform, company_form_schemas.platform),
      fields_json         = excluded.fields_json,
      field_count         = excluded.field_count,
      unmapped_json       = excluded.unmapped_json,
      unmapped_count      = excluded.unmapped_count,
      shape_hash          = excluded.shape_hash,
      confidence          = excluded.confidence,
      corroboration_count = excluded.corroboration_count,
      status              = excluded.status,
      source              = excluded.source,
      last_seen           = excluded.last_seen,
      changed_at          = excluded.changed_at,
      previous_shape_hash = excluded.previous_shape_hash
  `).run({
    apply_host: host,
    company, platform,
    fields_json: JSON.stringify(clean),
    field_count: clean.length,
    unmapped_json: JSON.stringify(unmapped.map(f => ({ label: f.label, name: f.name, type: f.type, required: f.required }))),
    unmapped_count: unmapped.length,
    shape_hash: hash,
    confidence,
    corroboration_count: corroboration,
    status,
    source,
    first_seen: firstSeen,
    last_seen: now,
    changed_at: changed ? now : (existing?.changed_at ?? null),
    previous_shape_hash: changed ? existing.shape_hash : (existing?.previous_shape_hash ?? null),
  });

  return {
    applyHost: host, status, changed,
    corroborationCount: corroboration, confidence,
    fieldCount: clean.length, unmappedCount: unmapped.length,
  };
}

/**
 * Confidence AS OF NOW, not as of capture.
 *
 * orgLayer recomputes on every rollup pass, so its stored value is never far from current. Nothing
 * sweeps this table — a schema is written when a candidate happens to cross a gate — so a stored
 * confidence would sit at its capture-day value forever and a two-year-old schema would read as
 * freshly corroborated. The stored column is kept for queryability and the truth is derived here.
 */
export function decayedConfidence(row, now = Math.floor(Date.now() / 1000)) {
  if (!row) return 0;
  return computeConfidence(row.corroboration_count, row.last_seen, now);
}

/**
 * One half-life without being seen again. Below this the form is old enough that it should be
 * re-discovered rather than believed.
 */
export const STALE_DECAY_FLOOR = 0.5;

/**
 * Has this schema gone cold?
 *
 * AGE ALONE, deliberately independent of corroboration. The first version tested decayed CONFIDENCE
 * against the promotion threshold, which conflated two different facts and made every capture report
 * as stale on the day it was made — a schema seen once yesterday is uncorroborated, not stale, and
 * those call for opposite responses: one wants a second sighting, the other wants a fresh look.
 *
 * Requirement 3: a stale schema that is TRUSTED is worse than no schema, so this is reported to
 * every consumer rather than left for each of them to work out.
 */
export function isStale(row, now = Math.floor(Date.now() / 1000)) {
  if (!row) return true;
  return decayedWeight(1, row.last_seen, now) < STALE_DECAY_FLOOR;
}

/** Shared row -> camelCase mapper, so every read surface agrees on shape (as orgLayer does). */
export function mapFormSchemaRow(row) {
  if (!row) return null;
  return {
    applyHost:          row.apply_host,
    company:            row.company,
    platform:           row.platform,
    fields:             JSON.parse(row.fields_json || '[]'),
    fieldCount:         row.field_count,
    unmapped:           JSON.parse(row.unmapped_json || '[]'),
    unmappedCount:      row.unmapped_count,
    shapeHash:          row.shape_hash,
    // Derived, not the stored column: nothing sweeps this table, so the stored value is the one it
    // had on the day it was captured.
    confidence:         decayedConfidence(row),
    confidenceAtCapture: row.confidence,
    stale:              isStale(row),
    corroborationCount: row.corroboration_count,
    status:             row.status,
    source:             row.source,
    firstSeen:          row.first_seen,
    lastSeen:           row.last_seen,
    changedAt:          row.changed_at,
  };
}

/**
 * What a caller needs at IMPORT or QUEUE time: does this host have a known form, and how much of it
 * can we answer? Counts only — the field list itself is a separate, heavier read.
 */
export function formSchemaSummary(db, applyUrlOrHost) {
  const host = hostOf(applyUrlOrHost) || String(applyUrlOrHost || '').toLowerCase();
  if (!host) return null;
  const row = db.prepare('SELECT * FROM company_form_schemas WHERE apply_host = ?').get(host);
  if (!row) return null;
  const unmapped = JSON.parse(row.unmapped_json || '[]');
  const stale = isStale(row);
  return {
    applyHost:      row.apply_host,
    known:          true,
    status:         row.status,
    confidence:     decayedConfidence(row),
    // Reported, never silently withheld: the caller decides whether to act on a faded schema, and
    // the honest answer is "we saw this form once, a long time ago".
    stale,
    fieldCount:     row.field_count,
    unmappedCount:  row.unmapped_count,
    // The labels, so the queue can say WHICH questions it will have to ask rather than only how many.
    unmapped:       unmapped.map(u => u.label).filter(Boolean).slice(0, 10),
    // Requirement 4, and it holds on a SINGLE capture: one sighting of a form with three
    // unresolvable questions is already enough to say the run will stop and ask them. A stale
    // schema cannot support the prediction — which is not the same as predicting it will go fine.
    willLikelyHold: !stale && row.unmapped_count > 0,
    lastSeen:       row.last_seen,
  };
}
