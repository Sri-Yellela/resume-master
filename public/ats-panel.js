// ⭐ draft D192 (3d) · THE ATS PANEL — one module, drawn wherever a résumé is open: the workspace's properties panel (its
// Résumé tab) and the structured editor's. It is the site's ATS check moved inside the document (rm-audit M5): the job is
// typed or pasted in the panel, the résumé is the open document's own text, and the answer is draft's ATS card (the
// owner's option C, 11-19): the number painted by its band (no band word — owner 11-19 "the font color on the ats number
// should do it"), the four parts as one bar and one plain line each, the single biggest gain — then the plausibility flags
// from /v2/ats/score (D192 (4d)): a quiet ⚠ per bullet that doesn't line up with what is known about its employer, its
// one-line reason and a Dismiss that holds across re-scores (kept in this browser by the flag's key). Flags are warnings:
// the number never reads them.
//
// ⛔ D190: nothing here calls a model. The scorer is the deterministic @draft/ats-scorer behind POST /v1/site/tools/ats.
// Every write carries X-RM-Client: web (the server refuses a cross-site write without it).

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── bands: the same cutpoints as draft's (shared/atsBands.js). The band is the NUMBER's colour (a class), never a word.
export const bandClass = (s) => (typeof s !== "number" ? "nosignal" : s >= 44 ? "strong" : s >= 26 ? "moderate" : "weak");
export const pctHtml = (s, extra = "") => `<span class="ats-num ${bandClass(s)}${extra}">${typeof s === "number" ? `${Math.round(s)}%` : "—"}</span>`;

// ── THE ATS CARD: the same words as draft's shared/contextualView.js atsCardView, over the same v2 block; no model.
const CASING = Object.fromEntries(["AWS", "GCP", "Azure", "SQL", "NoSQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "Docker", "Kubernetes",
  "gRPC", "GraphQL", "REST", "TypeScript", "JavaScript", "Node.js", "React", "Terraform", "Python", "Java", "Go", "Ruby", "Rust",
  "C++", "C#", "Scala", "Kotlin", "Swift", "Spark", "Airflow", "Snowflake", "dbt", "Linux", "CI/CD", "API", "APIs", "HTML", "CSS",
  "Elasticsearch", "DynamoDB", "BigQuery", "Databricks", "Tableau", "Excel", "PyTorch", "TensorFlow", "Jenkins", "Git", "iOS", "Android"]
  .map(n => [n.toLowerCase(), n]));
const showTerm = (t) => { const s = String(t?.term ?? t ?? "").trim(), k = s.toLowerCase(); return CASING[k] || (s === k && /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s); };
const bareTech = (t) => String(t || "").replace(/^(Apache|Amazon|Google|Microsoft)\s+/, "");
const andJoin = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const shortTxt = (s, n = 60) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}…`; };
const shareOfGap = (g) => (typeof g?.share === "number" ? g.share : g?.of ? g.postings / g.of : 0);
const subName = (id) => { const t = String(id || "").split(".").pop().replace(/-/g, " "); return t ? t[0].toUpperCase() + t.slice(1) : ""; };
const LEVELS = { entry: "entry level", early: "early career", junior: "junior", mid: "mid level", senior: "senior", executive: "executive" };

export function cardLines(rep, c) {
  const parts = [];
  const have = (rep.tier1_matched || []).slice(0, 5).map(showTerm), miss = (rep.tier1_missing || []).slice(0, 3).map(showTerm);
  parts.push(["Skills", rep.score ?? c?.parts?.skill_match?.score,
    !miss.length ? (have.length ? `${have.join(", ")} — everything it asks for` : "") : `${have.length ? `${have.join(", ")} — ` : ""}missing ${miss.join(", ")}`]);
  const role = c?.parts?.role_fit, work = c?.parts?.responsibility_overlap, stack = c?.parts?.tech_stack;
  if (role?.status === "ok") {
    const job = [subName(role.posting?.subcategory), LEVELS[role.posting?.level] || ""].filter(Boolean).join(", ");
    parts.push(["Role", role.score, role.relation === "same_role" && !role.level_gap ? `${job} — the same as the job` : `The job is ${job || "another role"}`]);
  }
  if (work?.status === "ok") {
    const done = work.matched || [], left = work.missing || [];
    parts.push(["The work", work.score, !left.length ? `You have done all ${work.phrases} things it describes`
      : done.length ? `You have done ${done.length} of ${work.phrases} — not “${shortTxt(left[0], 48)}”` : `Not on your résumé yet: “${shortTxt(left[0])}”`]);
  }
  if (stack?.status === "ok") {
    const bits = [];
    const yes = (stack.exact || []).slice(0, 2).map(x => bareTech(x.tech));
    if (yes.length) bits.push(`${andJoin(yes)} yes`);
    const eco = (stack.ecosystem || []).find(e => !(stack.exact || []).some(x => x.tech === e.yours));
    if (eco) bits.push(`${bareTech(eco.yours)} ≈ their ${bareTech(eco.theirs)}`);
    const gap = [...(stack.gaps || [])].sort((a, b) => shareOfGap(b) - shareOfGap(a))[0];
    if (gap && shareOfGap(gap) >= 0.1) bits.push(`${bareTech(gap.tech)} no`);
    parts.push(["Their stack", stack.score, bits.join(" · ")]);
  }
  let gain = "";
  const g = (c?.dissimilarities || []).find(d => d.kind === "stack_gap");
  if (g) gain = `${g.tech}${shareOfGap(g) ? ` — in ${Math.round(shareOfGap(g) * 100)}% of their jobs` : ""}`;
  else if (miss.length) gain = `${miss[0]} — the posting asks for it`;
  else if ((work?.missing || []).length) gain = `Show “${shortTxt(work.missing[0])}” on your résumé`;
  return { parts: parts.filter(([, s]) => typeof s === "number"), gain };
}

export function atsCardHtml(rep, c) {
  const score = typeof c?.score === "number" ? c.score : rep.score;
  const { parts, gain } = cardLines(rep, c);
  return `<section class="atsc" aria-label="Your résumé against this job">
    <p class="atsc-num">${pctHtml(score)}</p>
    ${parts.map(([name, s, line]) => `<div class="atsc-row"><span>${esc(name)}</span>
      <span class="atsc-mid"><span class="ctx-bar" aria-hidden="true"><i class="${bandClass(s)}" style="width:${Math.max(0, Math.min(100, s))}%"></i></span>${line ? `<span class="note">${esc(line)}</span>` : ""}</span>
      <span class="ats-num sm ${bandClass(s)}">${Math.round(s)}</span></div>`).join("")}
    ${gain ? `<p class="atsc-gain">Biggest gain: ${esc(gain)}</p>` : ""}
  </section>`;
}

// ── does the résumé add up (D192 (4d)): one row per flag; a dismissed flag (its key) stays dismissed across re-scores.
const DISMISSED = "rm-ats:dismissed";
export function dismissedKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED) || "[]")); } catch { return new Set(); }
}
function setDismissed(keys) { try { localStorage.setItem(DISMISSED, JSON.stringify([...keys].slice(-500))); } catch { /* storage blocked: this visit only */ } }
export const flagsOf = (p) => (p?.entries || []).flatMap(e => (e.flags || []).map(f => ({ ...f, employer: e.employer })));
export function plausibilityHtml(p, { dismissed = new Set(), showDismissed = false, dismissable = false } = {}) {
  const all = flagsOf(p);
  if (!all.length) return "";
  const open = all.filter(f => !dismissed.has(f.key)), gone = all.length - open.length;
  const rows = showDismissed ? all : open;
  return `<section class="plaus" aria-label="Does your résumé add up?"><p class="plaus-head">Does your résumé add up?${open.length ? ` <span class="note">· ${open.length} to check</span>` : ""}</p>
    ${rows.map(f => `<div class="plaus-row" data-flag="${esc(f.key || "")}"><span class="plaus-mark" aria-hidden="true">⚠</span><span><span>${esc(f.reason)}</span>
      <span class="note">${esc(f.employer)} · “${esc(shortTxt(f.bullet, 90))}”</span>
      ${dismissable && f.key ? (dismissed.has(f.key) ? `<button type="button" class="ats-link" data-undismiss="${esc(f.key)}">Bring it back</button>`
        : `<button type="button" class="ats-link" data-dismiss="${esc(f.key)}">Dismiss</button>`) : ""}</span></div>`).join("")}
    ${dismissable && gone ? `<button type="button" class="ats-link" data-show-dismissed="">${showDismissed ? "Hide the dismissed" : `${gone} dismissed — show`}</button>` : ""}
  </section>`;
}

/** POST /v1/site/tools/ats — the one call this module makes. */
export async function scoreAts({ resumeText, title, description, company }) {
  const r = await fetch("/v1/site/tools/ats", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "x-rm-client": "web" },
    body: JSON.stringify({ resumeText, job: { title, description, ...(company ? { company } : {}) } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `The check failed (${r.status})`);
  return j;
}

export function resultHtml(r, opts = {}) {
  const rep = r.report || {};
  return r.outcome === "scored" ? atsCardHtml(rep, r.contextual) + plausibilityHtml(r.plausibility, opts)
    : `<p class="ats-head"><strong>Not enough signal</strong> — the scorer declined: too few scorable terms. This is not a low score.</p>
       <p class="note">Why: ${esc((rep.decline_reasons || []).join("; ") || "too few scorable terms")}. Paste the FULL job description, or a fuller résumé.</p>`;
}

// ── the panel ────────────────────────────────────────────────────────────────────────────────────────────────────────
const JOB = "rm-ats:job";
const jobKept = () => { try { return JSON.parse(sessionStorage.getItem(JOB) || "{}"); } catch { return {}; } };
const keepJob = (j) => { try { sessionStorage.setItem(JOB, JSON.stringify(j)); } catch { /* blocked */ } };

/**
 * Mount the panel in `box`. `resumeText()` returns the open document's text ("" when nothing is open — the panel then
 * offers a box to paste a résumé into); `resumeLabel()` names where it comes from. `refresh()` redraws that line.
 */
export function mountAtsPanel(box, { resumeText = () => "", resumeLabel = () => "" } = {}) {
  const job = jobKept();
  box.classList.add("ats-panel");
  box.innerHTML = `
    <form class="ats-form" data-ats-form="">
      <label class="ats-f">Job title<input type="text" name="title" required autocomplete="off" placeholder="e.g. Backend Engineer"></label>
      <label class="ats-f">Company <span class="note">optional — for their tech stack</span><input type="text" name="company" autocomplete="off" placeholder="e.g. Kestrel Payments"></label>
      <label class="ats-f">Job description<textarea name="description" required rows="6" placeholder="Paste the full posting…"></textarea></label>
      <p class="note" data-ats-source=""></p>
      <label class="ats-f" data-ats-paste="" hidden>Your résumé<textarea name="resume" rows="6" placeholder="Paste your résumé, or open it as a PDF…"></textarea></label>
      <button class="ws-b ws-p" type="submit">Check against this job</button>
    </form>
    <div class="ats-out" data-ats-out="" aria-live="polite"></div>`;
  const form = box.querySelector("[data-ats-form]"), out = box.querySelector("[data-ats-out]");
  for (const k of ["title", "company", "description"]) if (job[k]) form[k].value = job[k];
  let last = null, showDismissed = false;
  const refresh = () => {
    const text = resumeText();
    box.querySelector("[data-ats-paste]").hidden = !!text;
    form.resume.required = !text;
    box.querySelector("[data-ats-source]").textContent = text ? resumeLabel() : "";
  };
  const draw = () => {
    if (!last) return;
    out.innerHTML = resultHtml(last, { dismissed: dismissedKeys(), showDismissed, dismissable: true });
  };
  out.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const keys = dismissedKeys();
    if (b.dataset.dismiss) { keys.add(b.dataset.dismiss); setDismissed(keys); }
    else if (b.dataset.undismiss) { keys.delete(b.dataset.undismiss); setDismissed(keys); }
    else if ("showDismissed" in b.dataset) showDismissed = !showDismissed;
    else return;
    draw();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const resume = resumeText() || form.resume.value;
    const j = { title: form.title.value.trim(), company: form.company.value.trim(), description: form.description.value };
    keepJob(j);
    out.innerHTML = '<p class="note">Scoring…</p>';
    try { last = await scoreAts({ resumeText: resume, ...j }); draw(); }
    catch (err) { last = null; out.innerHTML = `<p class="ats-bad">${esc(err.message)}</p>`; }
  });
  form.addEventListener("focusin", refresh);   // the document may have changed since the panel was drawn
  refresh();
  return { refresh, get result() { return last; } };
}
