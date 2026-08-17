/**
 * Gated portal handoff — the browser half (TASK G2).
 * ---------------------------------------------------------------------------------------------
 * The candidate has crossed a gate we are not allowed to cross for them: they signed in, or they
 * solved a CAPTCHA. They are standing on the application form. They invoke the extension, and
 * everything the server prepared before they arrived lands in the form in front of them.
 *
 * See docs/GATED_HANDOFF_ARCHITECTURE.md. Three properties hold this together:
 *
 * 1. ACCESS IS GRANTED PER TAB, PER GESTURE. The manifest asks for no portal host permission and
 *    never will. `activeTab` is granted because the user invoked the extension, and G0 measured what
 *    that grant survives (§9): every same-origin navigation, including full page loads. It does NOT
 *    survive leaving the origin, or the portal opening a step in a new tab.
 *
 * 2. NOTHING PUSHES INWARD. `externally_connectable` is absent from the manifest and must stay
 *    absent. The extension PULLS the packet from our server with credentials:'include', the same way
 *    linkedin-content.js already talks to /api/import/job. No secret is embedded here; the user's own
 *    session is the authorisation.
 *
 * 3. TARGET MATCH BEFORE RELEASE. The packet carries a home address and work-authorization answers.
 *    It is released only onto an origin the server nominated, with a form actually present, and the
 *    match happens BEFORE the single-use token is spent — a mismatch must cost nothing, not burn the
 *    one token the packet has.
 *
 * WHAT THIS FILE NEVER DOES: cross a gate, solve a challenge, create an account, or submit. The last
 * click is the candidate's, always.
 */

import { orderForReview, readinessOf, renderOverlay } from './review-overlay.js';

/** Matches the server's token TTL. A packet outlives its grant (G0 §9), so it is cleared on purpose. */
export const PACKET_TTL_MS = 10 * 60 * 1000;

const sessionKey = (tabId) => `gate:${tabId}`;

// ── Injected: phase 1, READ ONLY, isolated world ─────────────────────────────
// Runs in the default isolated world because it only needs the DOM, and the isolated world is the
// smaller blast radius. It reports the form's SHAPE and no values — deciding whether to release
// anything must not itself require handing anything over.
//
// Must be self-contained: executeScript serialises this function, so it can close over nothing.
function probeFormShape() {
  const form = document.querySelector('form');
  const scope = form || document;
  const controls = [...scope.querySelectorAll('input, select, textarea')].filter(
    el => !['hidden', 'submit', 'button', 'image', 'reset'].includes((el.type || '').toLowerCase())
  );

  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return (l.textContent || '').trim();
    }
    const closest = el.closest('label');
    if (closest) return (closest.textContent || '').trim();
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim();
  };

  return {
    hasForm: !!form,
    url: location.href,
    origin: location.origin,
    fields: controls.map((el, index) => ({
      index,
      name: el.name || null,
      id: el.id || null,
      type: (el.type || el.tagName).toLowerCase(),
      label: labelFor(el).slice(0, 200),
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      options: el.tagName === 'SELECT'
        ? [...el.options].map(o => ({ value: o.value, text: (o.text || '').trim() })) : null,
    })),
  };
}

// ── Injected: phase 3, MAIN world ────────────────────────────────────────────
// Receives ONLY the values that already matched a field. The unmatched remainder of the packet never
// enters the page's context.
//
// MAIN rather than isolated because of the React problem: these portals track an input's value on the
// node itself, and a plain `el.value = x` from any world leaves that tracker believing nothing
// changed, so the next render puts the old value back. Assigning through the prototype's NATIVE
// setter and then dispatching input/change is what makes the change real to the framework. G0
// confirmed activeTab alone reaches the MAIN world.
function applyPlan(plan, resume) {
  const form = document.querySelector('form');
  const scope = form || document;
  const controls = [...scope.querySelectorAll('input, select, textarea')].filter(
    el => !['hidden', 'submit', 'button', 'image', 'reset'].includes((el.type || '').toLowerCase())
  );

  const nativeSetter = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : el instanceof HTMLSelectElement   ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;                                  // last resort, still better than nothing
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const filled = [], skipped = [];

  for (const step of plan) {
    const el = controls[step.index];
    // The DOM can move between the probe and the fill on an SPA. Re-verify identity rather than
    // trusting an index: writing a home address into whatever happens to be at position 7 is exactly
    // the stray release this design refuses to make.
    if (!el || (step.name && el.name !== step.name) || (step.id && el.id !== step.id)) {
      skipped.push({ field: step.label, reason: 'field_moved' });
      continue;
    }
    try {
      if (el.type === 'checkbox' || el.type === 'radio') {
        const want = step.value === 'true' || step.value === true;
        if (el.checked !== want) {
          el.checked = want;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (el.tagName === 'SELECT') {
        const match = [...el.options].find(
          o => o.value === step.value ||
               (o.text || '').trim().toLowerCase() === String(step.value).trim().toLowerCase()
        );
        // No option holds this value. Filling nothing is correct: the old behaviour of assigning
        // anyway left the select on its blank first option while the run recorded it as answered.
        if (!match) { skipped.push({ field: step.label, reason: 'value_not_in_options' }); continue; }
        nativeSetter(el, match.value);
      } else {
        nativeSetter(el, String(step.value));
      }
      filled.push({ field: step.label, name: step.name, provenance: step.provenance });
    } catch (e) {
      skipped.push({ field: step.label, reason: `error:${e.message}` });
    }
  }

  // ── The resume ─────────────────────────────────────────────────────────────
  // The piece usually assumed impossible (§5): a File can be constructed and handed to a real file
  // input through a DataTransfer. Without this the candidate still has to attach the resume by hand,
  // which is most of the work the handoff was supposed to remove.
  let resumeResult = null;
  if (resume && resume.base64) {
    const fileInput = [...scope.querySelectorAll('input[type="file"]')][0];
    if (!fileInput) {
      resumeResult = { attached: false, reason: 'no_file_input' };
    } else {
      try {
        const bin = atob(resume.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], resume.filename, { type: resume.mimeType || 'application/pdf' });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        resumeResult = {
          // Reported separately from `attached` on purpose. The property being set is not evidence
          // the page noticed; only the page's own rendering of the filename is (G2 requirement 5).
          attached: fileInput.files.length === 1 && fileInput.files[0].name === resume.filename,
          filename: resume.filename,
          size: file.size,
        };
      } catch (e) {
        resumeResult = { attached: false, reason: `error:${e.message}` };
      }
    }
  }

  return { filled, skipped, resume: resumeResult, fieldCount: controls.length };
}

// ── Matching ─────────────────────────────────────────────────────────────────

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Match the packet's answers to the controls actually on this page.
 *
 * ELIGIBILITY ANSWERS ARE MATCHED EXACTLY OR NOT AT ALL. A sponsorship answer dropped into a field
 * by a fuzzy label match is the A1 inversion trap: "do you require sponsorship" and "are you
 * authorized to work without sponsorship" are the same words and opposite questions, and getting it
 * wrong is a false attestation to an employer, not a filling error. When one cannot be matched
 * exactly it is left for the human and reported — §6, and the reason G3 pins these to the top.
 */
export function matchAnswersToFields(answers, fields) {
  const plan = [], unmatched = [];
  const taken = new Set();

  // An ATS namespaces its controls: Greenhouse serves `job_application[requires_sponsorship]`, not
  // `requires_sponsorship`. Unwrapping that is STRUCTURAL — it reads the form's own naming
  // convention — and is not the same thing as guessing from a label. Without it, eligibility answers
  // would be exact-matched against a name no real ATS emits and would therefore never be filled on
  // any of them, which is a different failure from the one the exact-match rule exists to prevent.
  const segments = (n) => String(n || '')
    .split(/[[\].]+/).map(s => s.trim()).filter(Boolean);

  const nameMatches = (fieldName, answerName) => {
    if (!fieldName || !answerName) return false;
    if (fieldName === answerName) return true;
    const segs = segments(fieldName);
    return segs.length > 1 && segs[segs.length - 1] === answerName;
  };

  const byExact = (a) => fields.find(f =>
    !taken.has(f.index) && (
      nameMatches(f.name, a.name) ||
      nameMatches(f.id, a.name) ||
      (a.field_id && f.id && f.id === a.field_id)
    ));

  const byLabel = (a) => {
    const want = normalise(a.field);
    if (!want) return null;
    return fields.find(f => !taken.has(f.index) && normalise(f.label) === want)
        || fields.find(f => !taken.has(f.index) && f.name && normalise(f.name) === normalise(a.name));
  };

  for (const a of answers) {
    if (a.value === null || a.value === undefined || a.value === '') continue;

    let field = byExact(a);
    let how = field ? 'exact' : null;

    if (!field && !a.eligibility) { field = byLabel(a); how = field ? 'label' : null; }
    if (!field && a.eligibility) {
      unmatched.push({
        field: a.field, name: a.name, eligibility: true,
        reason: 'eligibility_requires_exact_match',
      });
      continue;
    }
    if (!field) { unmatched.push({ field: a.field, name: a.name, reason: 'no_matching_control' }); continue; }

    taken.add(field.index);
    plan.push({
      index: field.index, name: field.name, id: field.id,
      label: field.label || a.field,
      value: a.value,
      provenance: a.provenance,
      confidence: a.confidence,
      eligibility: !!a.eligibility,
      matchedBy: how,
    });
  }
  return { plan, unmatched };
}

// ── Session state ────────────────────────────────────────────────────────────
// chrome.storage.session, not memory: an MV3 service worker is torn down without warning (§5). G0
// also measured that session storage OUTLIVES the activeTab grant — so a re-invoke after the grant
// lapses can resume without spending another token, and nothing else will ever clear this. It has to
// be cleared deliberately.

export async function savePacketForTab(tabId, payload) {
  await chrome.storage.session.set({
    [sessionKey(tabId)]: { ...payload, storedAt: Date.now(), expiresAt: Date.now() + PACKET_TTL_MS },
  });
}

export async function loadPacketForTab(tabId) {
  const key = sessionKey(tabId);
  const got = await chrome.storage.session.get(key);
  const entry = got?.[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { await chrome.storage.session.remove(key); return null; }
  return entry;
}

export async function clearPacketForTab(tabId) {
  await chrome.storage.session.remove(sessionKey(tabId));
}

/** Drop anything past its TTL. Cheap, and the only thing that collects abandoned handoffs. */
export async function sweepExpiredPackets(now = Date.now()) {
  const all = await chrome.storage.session.get(null);
  const dead = Object.entries(all)
    .filter(([k, v]) => k.startsWith('gate:') && v && now > v.expiresAt)
    .map(([k]) => k);
  if (dead.length) await chrome.storage.session.remove(dead);
  return dead.length;
}

// ── Per-portal batching (TASK G5) ────────────────────────────────────────────
// The gate is amortised per PORTAL, not per application: once the candidate is authenticated at
// Amazon, that session serves every queued Amazon job. G0 is what makes this more than a list —
// the activeTab grant survives every same-origin navigation, so moving the SAME TAB to the next
// application keeps the grant alive and no second gesture is needed.
//
// Batching the GATE must not batch the REVIEW. Each application is still target-matched on its own
// and still gets its own overlay to approve; what is shared is the sign-in, not the attestation.

const batchKey = (tabId) => `batch:${tabId}`;

export async function saveBatchForTab(tabId, batch) {
  await chrome.storage.session.set({ [batchKey(tabId)]: { ...batch, updatedAt: Date.now() } });
}

export async function loadBatchForTab(tabId) {
  const got = await chrome.storage.session.get(batchKey(tabId));
  return got?.[batchKey(tabId)] || null;
}

export async function clearBatchForTab(tabId) {
  await chrome.storage.session.remove(batchKey(tabId));
}

/** What else is waiting on this portal, newest first, excluding one already in hand. */
export async function portalQueueFor(serverUrl, origin, excludePacketId = null) {
  try {
    const res = await api(serverUrl, '/api/apply/gate-packets');
    if (!res.ok) return { remaining: 0, next: null, packets: [] };
    const body = await res.json();
    const mine = (body.packets || [])
      .filter(p => p.expectedOrigin === origin && p.packetId !== excludePacketId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const portal = (body.portals || []).find(g => g.origin === origin) || null;
    return {
      remaining: mine.length,
      host: portal?.host || origin,
      next: mine[0] ? {
        packetId: mine[0].packetId, applyUrl: mine[0].applyUrl,
        title: mine[0].title, company: mine[0].company,
      } : null,
      packets: mine,
    };
  } catch {
    return { remaining: 0, next: null, packets: [] };
  }
}

// ── The handoff ──────────────────────────────────────────────────────────────

const api = (serverUrl, path, init = {}) => fetch(`${serverUrl}${path}`, {
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  ...init,
});

/**
 * Run the handoff on the active tab. Returns a result object; never throws at the caller.
 *
 * The ORDER here is the security design, not an implementation detail:
 *   origin read -> packet located by origin -> form confirmed present -> ONLY THEN token minted and
 *   spent. Every refusal above happens before a token exists, so a mismatch costs nothing.
 */
export async function runGatedHandoff({ serverUrl, tab }) {
  if (!tab?.id) return { ok: false, reason: 'no_active_tab', message: 'No active tab.' };

  let origin;
  try { origin = new URL(tab.url).origin; }
  catch { return { ok: false, reason: 'unreadable_tab_url', message: 'This page cannot be read.' }; }

  if (!/^https?:$/.test(new URL(tab.url).protocol)) {
    return { ok: false, reason: 'unsupported_scheme', message: 'Only http(s) pages are supported.' };
  }

  // A packet already released into this tab — a re-invoke after the grant lapsed, or after the portal
  // moved to another step. Reuse it rather than spending a second token.
  const cached = await loadPacketForTab(tab.id);
  if (cached && cached.expectedOrigin === origin) {
    return fillFromPacket({ tab, origin, released: cached, serverUrl, reused: true });
  }

  let list;
  try {
    const res = await api(serverUrl, '/api/apply/gate-packets');
    if (res.status === 401) {
      return { ok: false, reason: 'not_signed_in', message: 'Sign in to Resume Master first.' };
    }
    if (!res.ok) return { ok: false, reason: 'server_error', message: `Server returned ${res.status}.` };
    list = await res.json();
  } catch (e) {
    // The underlying message is carried through: "could not reach" covers a dead server, a blocked
    // request and a bad URL, and troubleshooting any of them without it is guesswork.
    return { ok: false, reason: 'network_error', message: 'Could not reach Resume Master.', detail: e.message };
  }

  // TARGET MATCH, first half. The server nominated an origin for each packet; this page has to be one
  // of them. Nothing has been fetched but counts at this point.
  const candidates = (list.packets || []).filter(p => p.expectedOrigin === origin);
  if (candidates.length === 0) {
    return {
      ok: false, reason: 'origin_mismatch',
      message: `Nothing is prepared for ${origin}. Open the application from your Resume Master queue.`,
    };
  }
  // Newest first. G5 turns several packets on one portal into a batch; here the most recent wins and
  // the count is reported so the behaviour is visible rather than arbitrary.
  const chosen = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];

  // TARGET MATCH, second half: a form has to be here. Read-only, isolated world.
  let shape;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeFormShape });
    shape = r?.result;
  } catch (e) {
    return { ok: false, reason: 'no_access', message: 'Invoke the extension on the application tab.' };
  }
  if (!shape?.hasForm || shape.fields.length === 0) {
    return {
      ok: false, reason: 'no_form',
      message: 'No application form found on this page. Nothing was released.',
    };
  }
  // The probe reports the origin from inside the page. If it disagrees with the tab's, the tab moved
  // between the two reads and the match no longer means anything.
  if (shape.origin !== origin) {
    return { ok: false, reason: 'origin_moved', message: 'The page changed. Nothing was released.' };
  }

  // Only now is a token worth spending.
  let released;
  try {
    const mintRes = await api(serverUrl, `/api/apply/gate-packets/${chosen.packetId}/token`, { method: 'POST' });
    if (!mintRes.ok) {
      const err = await mintRes.json().catch(() => ({}));
      return { ok: false, reason: err.error || 'mint_failed', message: err.message || 'Could not prepare the handoff.' };
    }
    const minted = await mintRes.json();

    const exRes = await api(serverUrl, '/api/apply/gate-packet/exchange', {
      method: 'POST', body: JSON.stringify({ token: minted.token }),
    });
    if (!exRes.ok) {
      const err = await exRes.json().catch(() => ({}));
      return { ok: false, reason: err.error || 'exchange_failed', message: `Handoff refused: ${err.error || exRes.status}.` };
    }
    released = await exRes.json();
  } catch (e) {
    return { ok: false, reason: 'network_error', message: 'Could not reach Resume Master.', detail: e.message };
  }

  // Defence in depth: the server states the expected origin in the release too. If that disagrees
  // with the page, nothing is filled even though the token has already been spent — a burnt token is
  // cheap and a misplaced home address is not.
  if (released.expectedOrigin !== origin) {
    await clearPacketForTab(tab.id);
    return { ok: false, reason: 'origin_mismatch_after_release', message: 'Origin mismatch. Nothing was filled.' };
  }

  await savePacketForTab(tab.id, released);
  return fillFromPacket({ tab, origin, released, serverUrl, reused: false });
}

async function fillFromPacket({ tab, origin, released, serverUrl, reused }) {
  let shape;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeFormShape });
    shape = r?.result;
  } catch {
    return { ok: false, reason: 'no_access', message: 'Invoke the extension on the application tab.' };
  }
  if (!shape?.hasForm) return { ok: false, reason: 'no_form', message: 'No form on this page. Nothing was released.' };
  if (shape.origin !== origin) return { ok: false, reason: 'origin_moved', message: 'The page changed. Nothing was released.' };

  const answers = released.packet?.answers || [];
  const { plan, unmatched } = matchAnswersToFields(answers, shape.fields);

  // The resume travels as base64 because executeScript arguments must be JSON-serialisable — a Blob
  // cannot cross that boundary. Fetched HERE, in the extension, so the page never sees a credentialed
  // request to our server.
  let resume = null;
  if (released.resumeUrl && serverUrl) {
    try {
      const res = await fetch(`${serverUrl}${released.resumeUrl}`, { credentials: 'include' });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        resume = {
          base64: btoa(bin),
          filename: `resume-${released.packet?.jobId || 'application'}.pdf`,
          mimeType: 'application/pdf',
        };
      }
    } catch { /* the fill is still worth doing without it; reported below */ }
  }

  let outcome;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: applyPlan,
      args: [plan, resume],
    });
    outcome = r?.result;
  } catch (e) {
    return { ok: false, reason: 'inject_failed', message: `Could not fill the form: ${e.message}` };
  }

  // ── The review overlay (TASK G3) ────────────────────────────────────────────
  // What was actually written, with the rule that produced each value, ordered so the candidate
  // reads the three uncertain fields instead of the thirty certain ones.
  // matchedBy travels with each item: the overlay combines it with the value's provenance, because
  // a certain value placed into a field matched only by its label is uncertain overall, and showing
  // it as "resolved exactly" would be the more dangerous half of the truth.
  const reviewItems = plan
    .filter(step => (outcome?.filled || []).some(f => f.name === step.name && f.field === step.label))
    .map(step => ({
      field: step.label, name: step.name, id: step.id, index: step.index,
      value: step.value, provenance: step.provenance, confidence: step.confidence,
      eligibility: step.eligibility, matchedBy: step.matchedBy,
    }));

  const bands = orderForReview(reviewItems);
  const readiness = readinessOf(reviewItems);

  // Fetched before the overlay renders, because "3 more ready at amazon.jobs" is part of what the
  // candidate is deciding about — finding out after they have closed the tab is finding out too late.
  const portalForOverlay = serverUrl
    ? await portalQueueFor(serverUrl, origin, released.packetId)
    : { remaining: 0, next: null, packets: [] };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // ISOLATED, unlike the fill: the overlay needs chrome.runtime to send edits back, and only the
      // isolated world has it. The DOM is shared either way, so it is still a real element on the
      // real page.
      func: renderOverlay,
      args: [bands, {
        filledCount: outcome?.filled?.length || 0,
        resumeAttached: outcome?.resume?.attached === true,
        resolverBug: readiness.resolverBug,
        portal: portalForOverlay,
      }],
    });
  } catch (e) {
    // A form filled without an overlay is degraded, not broken — the values are in the page and the
    // candidate can still read them. Reported rather than swallowed.
    return {
      ok: true, reused: !!reused, packetId: released.packetId,
      filled: outcome?.filled || [], skipped: outcome?.skipped || [], unmatched,
      resume: outcome?.resume || null,
      overlay: { rendered: false, error: e.message },
      review: { ready: readiness.ready, guessCount: readiness.guessCount },
      message: `Filled ${outcome?.filled?.length || 0} field(s). Review and submit yourself.`,
    };
  }

  const portal = portalForOverlay;
  if (portal.remaining > 0) {
    await saveBatchForTab(tab.id, { origin, host: portal.host, remaining: portal.remaining });
  } else {
    await clearBatchForTab(tab.id);
  }

  return {
    ok: true,
    reused: !!reused,
    packetId: released.packetId,
    runJobId: released.packet?.runJobId ?? null,
    portal,
    filled: outcome?.filled || [],
    skipped: outcome?.skipped || [],
    unmatched,
    resume: outcome?.resume || (released.resumeUrl ? { attached: false, reason: 'fetch_failed' } : null),
    overlay: { rendered: true, rows: reviewItems.length },
    review: {
      ready: readiness.ready,
      guessCount: readiness.guessCount,
      eligibilityCount: bands.eligibility.length,
      uncertainCount: bands.uncertain.length,
      settledCount: bands.settled.length,
      // A fuzzy eligibility match is a resolver defect, not something to ask the candidate about.
      resolverBug: readiness.resolverBug,
    },
    // Never auto-submitted. The last action is the candidate's — §6, without exception.
    message: `Filled ${outcome?.filled?.length || 0} field(s). Review and submit yourself.`,
  };
}

// ── Edits from the overlay ───────────────────────────────────────────────────

/**
 * Write one corrected value into the real input.
 *
 * Goes through the same MAIN-world native-setter path the fill uses (G2 requirement 4, which G3
 * requirement 3 explicitly requires it reuse). A correction written any other way is reverted by the
 * page's next render, and the candidate would be looking at their own value on a form that no longer
 * holds it.
 */
export async function applyOverlayEdit({ tabId, field, value }) {
  const step = { index: field.index, name: field.name, id: field.id, label: field.label, value };
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: applyPlan, args: [[step], null],
  });
  return r?.result || null;
}
