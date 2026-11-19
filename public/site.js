// Resume Master — the site's one script (A54). No framework, no build, no third-party request.
// Every call goes to this service's own /v1/site/… routes with X-RM-Client: web (the server refuses
// a cross-site write without it). Errors show the server's own sentence.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let config = { accounts: false, signedIn: false };

async function call(method, path, body) {
  const r = await fetch(`/v1/site${path}`, {
    method, credentials: "same-origin",
    headers: { "content-type": "application/json", "x-rm-client": "web" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (el, on = true) => { el.hidden = !on; };
function say(el, text, kind = "") { el.className = `msg ${kind}`; el.textContent = text || ""; }

// ── bands: the same cutpoints as draft's (shared/atsBands.js). draft D192 (owner 11-19): "the font color on the ats number
// should do it no need for the words" — the band is the NUMBER's colour (a class), never a word or a blurb beside it.
const bandClass = (s) => (typeof s !== "number" ? "nosignal" : s >= 44 ? "strong" : s >= 26 ? "moderate" : "weak");
const pctHtml = (s, extra = "") => `<span class="ats-num ${bandClass(s)}${extra}">${typeof s === "number" ? `${Math.round(s)}%` : "—"}</span>`;

// ── THE ATS CARD (draft D192, the owner's option C, 11-19): the number, the four parts as one bar and one plain line each,
// the single biggest gain — no lists of terms, no band word (each number is painted by its band). The same words as draft's
// shared/contextualView.js atsCardView, over the same v2 block; no model.
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
function cardLines(rep, c) {
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
function atsCardHtml(rep, c) {
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

const chips = (arr, miss) => (arr || []).slice(0, 24).map(t => `<span class="chip${miss ? " miss" : ""}">${esc(t?.term ?? t)}</span>`).join("");

// ── tabs and dialogs ────────────────────────────────────────────────────────────────────────────
function openTab(name) {
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$("[data-panel]").forEach(p => show(p, p.dataset.panel === name));
  $$("[data-dialog]").forEach(d => show(d, false));
}
function openDialog(name) {
  $$("[data-dialog]").forEach(d => show(d, d.dataset.dialog === name));
  if (name === "account") loadAccount();
  $(`[data-dialog="${name}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
$$(".tab").forEach(t => t.addEventListener("click", () => openTab(t.dataset.tab)));
$$("[data-open]").forEach(b => b.addEventListener("click", () => openDialog(b.dataset.open)));

// ── session state ───────────────────────────────────────────────────────────────────────────────
async function refreshConfig() {
  try { config = await call("GET", "/config"); } catch { config = { accounts: false, signedIn: false }; }
  show($("#acct-signed-out"), !config.signedIn && config.accounts);
  show($("#acct-signed-in"), !!config.signedIn);
  if (config.signedIn) {
    $("#acct-email").textContent = config.user.email;
    $("#acct-balance").textContent = `${config.balance} credit${config.balance === 1 ? "" : "s"}`;
  }
  $$(".keep").forEach(k => show(k, !!config.signedIn));
  const gate = !config.accounts ? "Accounts are not switched on yet — the free tools above work without one."
    : !config.signedIn ? "Sign in to use this tool. An account gets free credits every month."
    : !config.model ? "The model behind this tool is not configured on this deployment."
    : `Uses 1 credit, only if it succeeds. You have ${config.balance}.`;
  say($("#generate-gate"), gate, config.signedIn && config.model ? "" : "bad");
  // PDF → text is free and anonymous (A70) — never gated on an account or a model.
  $$("#generate-form button[type=submit]").forEach(b => { b.disabled = !(config.signedIn && config.model); });
}

// ── ATS ─────────────────────────────────────────────────────────────────────────────────────────
$("#ats-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#ats-out");
  show(out); out.innerHTML = '<p class="note">Scoring…</p>';
  try {
    const r = await call("POST", "/tools/ats", {
      resumeText: f.resumeText.value,
      job: { title: f.title.value, description: f.description.value, ...(f.company?.value.trim() ? { company: f.company.value.trim() } : {}) },
      store: f.store?.checked === true,
    });
    const rep = r.report || {};
    out.innerHTML = `
      ${r.outcome === "scored" ? atsCardHtml(rep, r.contextual)
        : `<p class="ats-head"><strong>Not enough signal</strong> — the scorer declined: too few scorable terms. This is not a low score.</p>
          <p class="note">Why: ${esc((rep.decline_reasons || []).join("; ") || "too few scorable terms")}. Paste the FULL job description, or a fuller résumé.</p>`}
      ${savedNote(r.saved)}`;
  } catch (err) { out.innerHTML = `<p class="msg bad">${esc(err.message)}</p>`; }
});

// A save that was asked for and refused says why (A65: a full volume refuses rather than fails).
const SAVE_REFUSED = {
  storage_full: "Not saved — storage is full right now. Download it instead.",
  too_many: "Not saved — you have the most saved documents allowed. Delete one first.",
  too_large: "Not saved — the document is too large to keep.",
  signed_out: "Not saved — sign in to keep results.",
};
const savedNote = (saved) => saved?.stored ? '<p class="msg good">Saved to your account.</p>'
  : saved?.reason ? `<p class="msg bad">${esc(SAVE_REFUSED[saved.reason] || "Not saved.")}</p>` : "";

// ── Format ──────────────────────────────────────────────────────────────────────────────────────
const toHtml = (text) => /<[a-z][\s\S]*>/i.test(text) ? text
  : `<div>${text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join("")}</div>`;
function documentResult(out, html, title) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  out.innerHTML = `
    <iframe class="preview" sandbox="allow-modals allow-same-origin" title="${esc(title)}"></iframe>
    <div class="row"><a class="btn" href="${url}" download="${esc(title)}.html">Download HTML</a>
      <button class="btn" type="button" data-print>Print / save as PDF</button></div>`;
  const frame = $("iframe", out);
  frame.srcdoc = html;
  // ⛔ The preview stays script-free (no allow-scripts: nothing in the document can run), and same-origin so THIS page
  // may call its print(). With "allow-modals" alone the frame's origin was opaque and the call threw a SecurityError —
  // the button did nothing (D157 T6, measured in Chrome 11-06).
  $("[data-print]", out).addEventListener("click", () => frame.contentWindow?.print());
}
$("#format-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#format-out");
  show(out); out.innerHTML = '<p class="note">Formatting…</p>';
  try {
    const r = await call("POST", "/tools/format", { html: toHtml(f.html.value), store: f.store?.checked === true, title: "Formatted résumé" });
    documentResult(out, r.html, "resume");
    out.insertAdjacentHTML("beforeend", savedNote(r.saved));
  } catch (err) { out.innerHTML = `<p class="msg bad">${esc(err.message)}</p>`; }
});

// ── Generate ────────────────────────────────────────────────────────────────────────────────────
$("#generate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#generate-out");
  show(out); out.innerHTML = '<p class="note">Tailoring — this takes up to a minute…</p>';
  try {
    const years = f.years.value === "" ? undefined : Number(f.years.value);
    const r = await call("POST", "/tools/generate", {
      mode: "GENERATE", baseResumeText: f.baseResumeText.value,
      candidate: { fullName: f.fullName.value, ...(years != null ? { yearsOfExperience: years } : {}) },
      job: { title: f.title.value, company: f.company.value, description: f.description.value },
      options: { includeSummary: f.includeSummary.checked },
      store: f.store?.checked === true,
    });
    documentResult(out, r.html, `resume-${(f.company.value || "tailored").replace(/\W+/g, "-")}`);
    out.insertAdjacentHTML("afterbegin", `<p class="msg good">Done — ${r.credits.charged} credit used, ${r.credits.balance} left.
      Read every line before you send it.</p>${savedNote(r.saved)}`);
    refreshConfig();
  } catch (err) {
    const v = err.body?.violations;
    out.innerHTML = `<p class="msg bad">${esc(err.status === 422
      ? "Withheld: the draft claimed more than your résumé states, so it was not shown. No credit was used — try again."
      : err.message)}</p>${v ? `<ul>${v.map(x => `<li>${esc(x.message || x.kind || JSON.stringify(x))}</li>`).join("")}</ul>` : ""}`;
  }
});

// ── PDF ─────────────────────────────────────────────────────────────────────────────────────────
// A69: the PDF tab is the in-browser toolkit (public/pdf-tools.js). Its "Use this text" lands here.
window.rmUseText = (text) => {
  $("#ats-form").resumeText.value = text; $("#generate-form").baseResumeText.value = text; openTab("ats");
};
if ($("#pdf-form")) $("#pdf-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#pdf-out"), file = f.file.files[0];
  if (!file) return;
  show(out); out.innerHTML = '<p class="note">Reading…</p>';
  try {
    const pdfBase64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.onerror = () => rej(new Error("Could not read that file."));
      fr.readAsDataURL(file);
    });
    const r = await call("POST", "/tools/parse-pdf", { pdfBase64, store: f.store?.checked === true, title: file.name });
    if (r.needsOcr) { out.innerHTML = `<p class="msg bad">${esc(r.message)}</p>`; return; }
    const cols = (r.columns || []).some(c => c > 1) ? " Two columns were read left, then right — check the order." : "";
    out.innerHTML = `<p class="msg good">Read ${r.chars} characters from ${r.pages} page${r.pages === 1 ? "" : "s"}.${cols}</p>${savedNote(r.saved)}
      <textarea readonly>${esc(r.text)}</textarea>
      <div class="row"><button class="btn" type="button" data-use>Use it in the ATS check and the tailor</button></div>`;
    $("[data-use]", out).addEventListener("click", () => {
      $("#ats-form").resumeText.value = r.text; $("#generate-form").baseResumeText.value = r.text; openTab("ats");
    });
  } catch (err) { out.innerHTML = `<p class="msg bad">${esc(err.message)}</p>`; }
});

// ── account ─────────────────────────────────────────────────────────────────────────────────────
async function authForm(id, path, msgId) {
  $(id).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await call("POST", path, { email: e.target.email.value, password: e.target.password.value });
      e.target.reset(); say($(msgId), ""); $$("[data-dialog]").forEach(d => show(d, false));
      await refreshConfig();
    } catch (err) { say($(msgId), err.message, "bad"); }
  });
}
authForm("#signin-form", "/account/signin", "#signin-msg");
authForm("#signup-form", "/account/signup", "#signup-msg");
$("#signout").addEventListener("click", async () => { await call("POST", "/account/signout", {}).catch(() => {}); refreshConfig(); });

$("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { say($("#reset-msg"), (await call("POST", "/account/password-reset", { email: e.target.email.value })).message, "good"); }
  catch (err) { say($("#reset-msg"), err.message, "bad"); }
});
const resetToken = (location.hash.match(/^#reset=([A-Za-z0-9_-]+)$/) || [])[1];
if (resetToken) {
  show($("#reset-form"), false); show($("#reset-confirm-form"));
  openDialog("reset");
  $("#reset-confirm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      say($("#reset-msg"), (await call("POST", "/account/password-reset/confirm", { token: resetToken, password: e.target.password.value })).message, "good");
      history.replaceState(null, "", "/");
    } catch (err) { say($("#reset-msg"), err.message, "bad"); }
  });
}

async function loadAccount() {
  try {
    const a = await call("GET", "/account");
    $("#account-lede").textContent = `${a.user.email} · ${a.balance} credit${a.balance === 1 ? "" : "s"} · ` +
      `${a.monthlyGrant} granted free each month · saved documents are kept ${a.retentionDays} days, then deleted — unless you pin them.`;
    $("#ledger").innerHTML = "<tr><th>When</th><th>What</th><th>Credits</th><th>Tokens</th></tr>" + a.ledger.map(l =>
      `<tr><td>${new Date(l.at).toLocaleString()}</td><td>${esc(l.reason === "debit" ? l.route : l.reason.replace("_", " "))}</td>` +
      `<td>${l.delta > 0 ? "+" : ""}${l.delta}</td><td>${l.inputTokens != null ? `${l.inputTokens} in / ${l.outputTokens} out` : ""}</td></tr>`).join("");
    const d = await call("GET", "/documents");
    $("#docs").innerHTML = d.documents.length ? d.documents.map(doc =>
      `<li><span>${esc(doc.title || doc.kind)} <span class="note">· ${esc(doc.kind.replace("_", " "))} · ${doc.pinned ? "pinned — kept until you unpin or delete it" : `deleted ${new Date(doc.expiresAt).toLocaleDateString()}`}</span></span>
        <span><button class="btn" data-doc-open="${doc.id}">Open</button> <button class="btn" data-doc-pin="${doc.id}" data-pinned="${doc.pinned ? 1 : 0}">${doc.pinned ? "Unpin" : "Pin"}</button> <button class="btn" data-doc-del="${doc.id}">Delete</button></span></li>`).join("")
      : '<li class="note">Nothing saved. Tick "Save to my account" on a tool to keep its result.</li>';
    $$("[data-doc-del]").forEach(b => b.addEventListener("click", async () => {
      await call("DELETE", `/documents/${b.dataset.docDel}`).catch(err => say($("#account-msg"), err.message, "bad"));
      loadAccount();
    }));
    $$("[data-doc-pin]").forEach(b => b.addEventListener("click", async () => {
      await call("POST", `/documents/${b.dataset.docPin}/pin`, { pinned: b.dataset.pinned !== "1" })
        .catch(err => say($("#account-msg"), err.message, "bad"));
      loadAccount();
    }));
    $$("[data-doc-open]").forEach(b => b.addEventListener("click", async () => {
      const doc = await call("GET", `/documents/${b.dataset.docOpen}`);
      const html = doc.kind === "pdf_text" || doc.kind === "ats_report" ? `<pre style="white-space:pre-wrap">${esc(doc.content)}</pre>` : doc.content;
      window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank", "noopener");
    }));
  } catch (err) { say($("#account-msg"), err.message, "bad"); }
}
$("#delete-account").addEventListener("click", async () => {
  const password = prompt("This deletes your account, its credits and every saved document. Enter your password to confirm:");
  if (!password) return;
  try { say($("#account-msg"), (await call("DELETE", "/account", { password })).message, "good"); refreshConfig(); }
  catch (err) { say($("#account-msg"), err.message, "bad"); }
});

// The shared header links here with a fragment (/#format, /#signin): open what it names.
function followHash() {
  const name = location.hash.slice(1);
  if (!name || name.startsWith("reset=")) return;
  if ($(`[data-tab="${name}"]`)) { openTab(name); $("#tools")?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  else if ($(`[data-dialog="${name}"]`)) openDialog(name);
}
window.addEventListener("hashchange", followHash);
followHash();

refreshConfig();
