/**
 * Provenance overlay (TASK G3).
 * ---------------------------------------------------------------------------------------------
 * Replaces "read the whole form and check it" with "approve three uncertain fields."
 *
 * The resolver already knows whether each value came from an exact handler hit or a fuzzy label
 * guess (services/applyAutomation.js PROVENANCE). That distinction was never shown to anyone. Here
 * it becomes the ordering, and the ordering is the entire feature: two minutes reading thirty
 * certain fields becomes ten seconds checking three uncertain ones, and the audit trail falls out
 * for free.
 *
 * WHAT GOES FIRST, AND WHY IT IS NOT CONFIDENCE
 * Eligibility answers pin to the top REGARDLESS of confidence. A work-authorization answer that the
 * resolver is completely certain about is still an attestation to an employer — the candidate is the
 * only one who can make it, and being sure is not the same as being entitled to make it for them
 * (§6). Everything else sorts by how much doubt there is.
 *
 * The overlay never submits. It hands back to the candidate, who does.
 */

// Mirrors services/applyAutomation.js. Duplicated because an extension cannot import from the
// server, and asserted equal to the server's table by test/reviewOverlay.test.js so the two cannot
// drift into disagreeing about what a provenance tier is worth.
export const CONFIDENCE_BY_PROVENANCE = {
  handler_exact:   1.0,
  field_map_exact: 0.9,
  label_exact:     0.85,
  custom_answer:   0.85,
  label_fuzzy:     0.3,
  default:         0.1,
};

/** Below this an answer may not be auto-submitted; here, it is what "uncertain" means. */
export const LOW_CONFIDENCE = 0.8;

/** A guess, not a resolution. Requires an explicit acknowledgement (requirement 4). */
export const GUESS_PROVENANCE = new Set(['label_fuzzy', 'default']);

export const TIER_LABEL = {
  handler_exact:   'exact',
  field_map_exact: 'exact',
  label_exact:     'label',
  custom_answer:   'your answer',
  label_fuzzy:     'guess',
  default:         'guess',
};

/**
 * How sure we are that this value belongs in THIS control.
 *
 * Separate from provenance, which is about where the VALUE came from. The two are independent and
 * the review needs both: a value the resolver is certain of, dropped into a field matched only
 * because its label looked similar, is exactly the kind of uncertainty this overlay exists to
 * surface — and showing it as "resolved exactly" because the value was, is the more dangerous half
 * of the truth. The first version did precisely that, and the trap form's "Current Company" sat in
 * the collapsed section with nothing to acknowledge.
 */
export const MATCH_CONFIDENCE = { exact: 1.0, label: 0.5 };

/**
 * Normalise one filled field into what the overlay renders. The single place the two kinds of
 * uncertainty are combined, so ordering and readiness cannot disagree about what counts as a guess.
 */
export function toReviewItem(step) {
  const valueConfidence = typeof step.confidence === 'number'
    ? step.confidence
    : (CONFIDENCE_BY_PROVENANCE[step.provenance] ?? 0);
  const matchConfidence = MATCH_CONFIDENCE[step.matchedBy] ?? MATCH_CONFIDENCE.label;

  const valueIsGuess = GUESS_PROVENANCE.has(step.provenance);
  const fieldIsGuess = step.matchedBy !== undefined && step.matchedBy !== 'exact';

  return {
    ...step,
    valueConfidence,
    matchConfidence,
    // The weaker of the two. A chain is not stronger than the link that placed it.
    confidence: Math.min(valueConfidence, matchConfidence),
    isGuess: valueIsGuess || fieldIsGuess,
    // Names WHICH half is uncertain, because the candidate's next move differs: a guessed value is
    // checked against what they know about themselves, a guessed field against the form.
    tierLabel: valueIsGuess ? 'guessed value'
             : fieldIsGuess ? 'guessed field'
             : (TIER_LABEL[step.provenance] || step.provenance),
  };
}

/**
 * Group the filled fields into the three bands the overlay renders.
 *
 * @param {Array} items  { field, name, value, provenance, confidence, eligibility, matchedBy }
 * @returns {{ eligibility: Array, uncertain: Array, settled: Array }}
 */
export function orderForReview(items = []) {
  const normalised = items.map(toReviewItem);

  const eligibility = normalised.filter(i => i.eligibility);
  const rest = normalised.filter(i => !i.eligibility);

  // Least certain first inside each band, so the first thing read is the thing most worth reading.
  const byDoubt = (a, b) => a.confidence - b.confidence;

  return {
    eligibility: eligibility.sort(byDoubt),
    uncertain: rest.filter(i => i.isGuess || i.confidence < LOW_CONFIDENCE).sort(byDoubt),
    // Collapsed behind a disclosure. Not hidden — a candidate who wants to read thirty certain
    // fields still can; they are simply not what the overlay is FOR.
    settled: rest.filter(i => !i.isGuess && i.confidence >= LOW_CONFIDENCE).sort(byDoubt),
  };
}

/**
 * Is this review complete?
 *
 * Every guess must be individually acknowledged. Approving in bulk would recreate exactly what the
 * overlay exists to replace — a single gesture that means "I did not read any of this".
 *
 * A fuzzy match on an ELIGIBILITY field is not something to ask the candidate to rubber-stamp. G2's
 * matcher refuses to place one, so its appearance here means the resolver produced it, and that is a
 * bug to surface rather than a decision to delegate (requirement 4).
 */
export function readinessOf(items = [], acknowledged = new Set()) {
  const normalised = items.map(toReviewItem);
  const guesses = normalised.filter(i => i.isGuess);
  const fuzzyEligibility = guesses.filter(i => i.eligibility);
  const unacknowledged = guesses.filter(i => !acknowledged.has(keyOf(i)));

  return {
    ready: fuzzyEligibility.length === 0 && unacknowledged.length === 0,
    guessCount: guesses.length,
    unacknowledged,
    // Never merely "unacknowledged". This is a defect report about the resolver, and it says so.
    resolverBug: fuzzyEligibility.length > 0 ? fuzzyEligibility : null,
  };
}

export const keyOf = (i) => `${i.name || ''}::${i.field || ''}`;

// ── The injected renderer ────────────────────────────────────────────────────
// Runs in the ISOLATED world: it needs chrome.runtime to send edits back, and the isolated world is
// the one that has it. The DOM is shared, so the overlay is a real element on the real page.
//
// Self-contained by necessity — executeScript serialises this function, so it closes over nothing
// and the ordering rules are passed in already applied.
//
// The visual language is the product's, not a debug panel's: pills at radius 999 in 9px/700, the
// same #dcfce7/#166534 green the KB uses for `verified`, a confidence bar, and a glass surface.
// A candidate should recognise this as the same application they queued the job in.
export function renderOverlay(bands, meta) {
  const ID = 'rm-gate-review-overlay';
  document.getElementById(ID)?.remove();

  const css = `
    #${ID} { position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px);
      overflow: auto; z-index: 2147483647; font: 13px/1.45 system-ui, -apple-system, sans-serif;
      color: #0f172a; background: rgba(255,255,255,.86); backdrop-filter: blur(12px);
      border: 1px solid rgba(15,23,42,.10); border-radius: 14px;
      box-shadow: 0 12px 40px rgba(15,23,42,.18); }
    #${ID} * { box-sizing: border-box; }
    #${ID} .rm-hd { padding: 14px 16px 10px; border-bottom: 1px solid rgba(15,23,42,.08); }
    #${ID} .rm-t { font-size: 13px; font-weight: 700; letter-spacing: -.01em; }
    #${ID} .rm-s { font-size: 11px; color: #64748b; margin-top: 2px; }
    #${ID} .rm-sec { padding: 10px 16px; }
    #${ID} .rm-lbl { font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
      color: #64748b; margin-bottom: 8px; }
    #${ID} .rm-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0;
      border-top: 1px solid rgba(15,23,42,.05); }
    #${ID} .rm-row:first-of-type { border-top: none; }
    #${ID} .rm-bar { width: 3px; align-self: stretch; border-radius: 999px; background: #e2e8f0; flex: none; }
    #${ID} .rm-main { flex: 1; min-width: 0; }
    #${ID} .rm-f { font-size: 11px; color: #64748b; }
    #${ID} .rm-v { font-size: 12.5px; font-weight: 600; word-break: break-word; }
    #${ID} .rm-pill { font-size: 9px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      white-space: nowrap; background: #f1f5f9; color: #64748b; }
    #${ID} .rm-pill.ok { background: #dcfce7; color: #166534; }
    #${ID} .rm-pill.guess { background: #fef3c7; color: #92400e; }
    #${ID} .rm-pill.elig { background: #dbeafe; color: #1e40af; }
    #${ID} .rm-btn { font: inherit; font-size: 10px; font-weight: 700; padding: 3px 9px;
      border-radius: 999px; border: 1px solid rgba(15,23,42,.15); background: #fff; cursor: pointer; }
    #${ID} .rm-btn:hover { background: #f8fafc; }
    #${ID} .rm-btn.ack { background: #fef3c7; border-color: #fcd34d; color: #92400e; }
    #${ID} .rm-btn.done { background: #dcfce7; border-color: #86efac; color: #166534; }
    #${ID} .rm-edit { width: 100%; font: inherit; font-size: 12px; padding: 4px 6px; margin-top: 4px;
      border: 1px solid rgba(15,23,42,.2); border-radius: 6px; }
    #${ID} .rm-ft { position: sticky; bottom: 0; padding: 12px 16px; background: rgba(255,255,255,.94);
      border-top: 1px solid rgba(15,23,42,.08); }
    #${ID} .rm-state { font-size: 11px; font-weight: 700; }
    #${ID} .rm-state.ready { color: #166534; }
    #${ID} .rm-state.block { color: #92400e; }
    #${ID} .rm-bug { margin: 8px 16px; padding: 9px 11px; border-radius: 9px; background: #fee2e2;
      border: 1px solid #fca5a5; color: #991b1b; font-size: 11px; }
    #${ID} details > summary { cursor: pointer; font-size: 11px; color: #64748b; padding: 6px 0; }
    #${ID} .rm-next { margin-top: 10px; padding: 9px 11px; border-radius: 9px; background: #eff6ff;
      border: 1px solid #bfdbfe; color: #1e3a8a; font-size: 11px; }
  `;

  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Resume Master — review before you submit');
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const acknowledged = new Set();
  const edits = new Map();

  const rowHtml = (i, idx, band) => {
    const conf = typeof i.confidence === 'number' ? i.confidence : 0;
    const guess = i.isGuess;
    const pill = i.eligibility ? 'elig' : guess ? 'guess' : conf >= 0.8 ? 'ok' : '';
    const tier = i.tierLabel || (guess ? 'guess' : 'exact');
    return `
      <div class="rm-row" data-band="${band}" data-idx="${idx}">
        <div class="rm-bar" style="background:${guess ? '#fbbf24' : conf >= 0.8 ? '#22c55e' : '#94a3b8'}"></div>
        <div class="rm-main">
          <div class="rm-f">${esc(i.field)}</div>
          <div class="rm-v" data-role="value">${esc(i.value)}</div>
          <input class="rm-edit" data-role="input" value="${esc(i.value)}" hidden>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex:none">
          <span class="rm-pill ${pill}">${esc(i.eligibility ? 'eligibility' : tier)}</span>
          <button class="rm-btn" data-role="edit">edit</button>
          ${guess ? `<button class="rm-btn ack" data-role="ack">acknowledge</button>` : ''}
        </div>
      </div>`;
  };

  const section = (title, items, band) => items.length ? `
    <div class="rm-sec">
      <div class="rm-lbl">${title}</div>
      ${items.map((i, n) => rowHtml(i, n, band)).join('')}
    </div>` : '';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="rm-hd">
      <div class="rm-t">Review before you submit</div>
      <div class="rm-s">${meta.filledCount} field(s) filled${meta.resumeAttached ? ' · resume attached' : ''}.
        Resume Master never submits for you.</div>
    </div>
    ${meta.resolverBug ? `<div class="rm-bug"><b>Resolver bug.</b> An eligibility answer was matched by a
      guess: ${esc(meta.resolverBug.map(b => b.field).join(', '))}. This should be unreachable — do not
      rubber-stamp it. Answer it yourself.</div>` : ''}
    ${section('Eligibility — you are attesting to these', bands.eligibility, 'eligibility')}
    ${section('Worth checking', bands.uncertain, 'uncertain')}
    ${bands.settled.length ? `<div class="rm-sec"><details><summary>${bands.settled.length} more,
      resolved exactly</summary>${bands.settled.map((i, n) => rowHtml(i, n, 'settled')).join('')}</details></div>` : ''}
    <div class="rm-ft">
      <div class="rm-state" data-role="state"></div>
      <div class="rm-s" style="margin-top:6px">Submit the form yourself when you are happy with it.</div>
      ${meta.portal && meta.portal.remaining > 0 ? `
        <div class="rm-next">
          <div><b>${meta.portal.remaining}</b> more ready at ${esc(meta.portal.host)}${
            // The sign-in reassurance belongs to a GATE crossing, where crossing once really did
            // release the batch. Held reviews also queue up per origin, and telling the candidate a
            // sign-in cleared them would be a claim about work nobody did.
            meta.portal.gateCrossing ? ' — you are already signed in.' : ', prepared and waiting.'
          }</div>
          ${meta.portal.next ? `<div class="rm-s" style="margin-top:2px">Next:
            ${esc(meta.portal.next.title || meta.portal.next.company || 'application')}</div>` : ''}
          <button class="rm-btn" data-role="next" style="margin-top:7px">Submit this one first, then go to the next</button>
        </div>` : ''}
    </div>`;
  root.appendChild(body);
  document.documentElement.appendChild(root);

  const all = [...bands.eligibility, ...bands.uncertain, ...bands.settled];
  const guesses = all.filter(i => i.isGuess);
  const stateEl = root.querySelector('[data-role="state"]');

  const refresh = () => {
    const left = guesses.filter(i => !acknowledged.has(`${i.name || ''}::${i.field || ''}`));
    const blocked = meta.resolverBug || left.length > 0;
    stateEl.className = `rm-state ${blocked ? 'block' : 'ready'}`;
    stateEl.textContent = meta.resolverBug
      ? 'Not ready — an eligibility answer was guessed. Answer it yourself.'
      : left.length
        ? `Not ready — ${left.length} guess(es) still to acknowledge.`
        : 'Ready. Everything uncertain has been checked.';
    // Reported, never acted on: the overlay does not submit and does not enable a submit control.
    try {
      chrome.runtime.sendMessage({
        type: 'GATE_REVIEW_STATE',
        ready: !blocked,
        acknowledged: [...acknowledged],
        edits: [...edits.entries()].map(([k, v]) => ({ key: k, value: v })),
      });
    } catch { /* the worker may be asleep; the next message wakes it */ }
  };

  const bandOf = (name) => bands[name] || [];

  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;

    // Role first, row second. The batch button lives in the FOOTER, not in a field row, so looking
    // up `.rm-row` before checking the role threw on a null row and killed the handler — the button
    // did nothing at all, silently, because the throw happened inside the listener.
    if (btn.dataset.role === 'next') {
      btn.disabled = true;
      btn.textContent = 'opening the next one…';
      try {
        // The reply is read, not discarded. A batch that cannot advance used to leave this button
        // sitting on "opening…" forever, which is indistinguishable from slow.
        chrome.runtime.sendMessage({ type: 'GATE_BATCH_NEXT' }, (reply) => {
          if (chrome.runtime.lastError || !reply?.ok) {
            btn.disabled = false;
            btn.textContent = 'Could not open the next one — try again';
            btn.dataset.error = chrome.runtime.lastError?.message || reply?.reason || 'no_reply';
          }
        });
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Could not open the next one — try again';
        btn.dataset.error = e.message;
      }
      return;
    }

    const row = btn.closest('.rm-row');
    if (!row) return;
    const item = bandOf(row.dataset.band)[Number(row.dataset.idx)];
    if (!item) return;
    const key = `${item.name || ''}::${item.field || ''}`;

    if (btn.dataset.role === 'ack') {
      acknowledged.add(key);
      btn.className = 'rm-btn done';
      btn.textContent = 'acknowledged';
      btn.disabled = true;
      refresh();
      return;
    }

    if (btn.dataset.role === 'edit') {
      const input = row.querySelector('[data-role="input"]');
      const valueEl = row.querySelector('[data-role="value"]');
      if (input.hidden) {
        input.hidden = false; input.focus(); btn.textContent = 'save';
      } else {
        const next = input.value;
        input.hidden = true; btn.textContent = 'edit';
        valueEl.textContent = next;
        edits.set(key, next);
        // An edit is a correction to the real input, not to this card. It goes back through the
        // service worker so it is written with the SAME native-setter path the fill used — a value
        // set any other way is reverted by the page's next render.
        try {
          chrome.runtime.sendMessage({
            type: 'GATE_REVIEW_EDIT',
            field: { name: item.name, id: item.id ?? null, index: item.index, label: item.field },
            value: next,
          });
        } catch { /* reported in the state message on the next refresh */ }
        // An edited value is the candidate's own, so it is no longer a guess to acknowledge.
        acknowledged.add(key);
        const ack = row.querySelector('[data-role="ack"]');
        if (ack) { ack.className = 'rm-btn done'; ack.textContent = 'yours'; ack.disabled = true; }
        refresh();
      }
    }
  });

  refresh();
  return { ok: true, rendered: all.length };
}
