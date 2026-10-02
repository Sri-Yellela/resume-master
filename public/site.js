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

// ── bands: the same cutpoints as draft's public tool (shared/atsBands.js) — coarse by design ──────
function bandOf(out) {
  if (out.outcome !== "scored") return { cls: "nosignal", label: "Not enough signal",
    blurb: "The scorer declined: the posting or the résumé had too few scorable terms. This is not a low score." };
  const s = out.score;
  if (s >= 44) return { cls: "strong", label: "Strong match", blurb: "Most of what the posting asks for, your résumé shows." };
  if (s >= 26) return { cls: "moderate", label: "Moderate match", blurb: "A real overlap, with gaps worth closing." };
  return { cls: "weak", label: "Weak match", blurb: "Little of what this posting asks for appears on the résumé." };
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
  for (const id of ["#generate-gate", "#pdf-gate"]) say($(id), gate, config.signedIn && config.model ? "" : "bad");
  $$("#generate-form button[type=submit], #pdf-form button[type=submit]").forEach(b => { b.disabled = !(config.signedIn && config.model); });
}

// ── ATS ─────────────────────────────────────────────────────────────────────────────────────────
$("#ats-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#ats-out");
  show(out); out.innerHTML = '<p class="note">Scoring…</p>';
  try {
    const r = await call("POST", "/tools/ats", {
      resumeText: f.resumeText.value,
      job: { title: f.title.value, description: f.description.value },
      store: f.store?.checked === true,
    });
    const b = bandOf(r), rep = r.report || {};
    const group = (title, list, miss) => (list && list.length ? `<h3>${title}</h3><div class="chips">${chips(list, miss)}</div>` : "");
    out.innerHTML = `
      <span class="band ${b.cls}">${b.label}</span>
      <p>${esc(b.blurb)}</p>
      ${r.outcome === "scored" ? `
        ${group("Skills the posting asks for that your résumé shows", rep.tier1_matched)}
        ${group("Skills it asks for that your résumé does not show", rep.tier1_missing, true)}
        ${group("Competencies shown", rep.competencies_matched)}
        ${group("Competencies not shown", rep.competencies_missing, true)}
        ${group("Action verbs the posting uses that you use too", rep.action_verbs_matched)}
        ${group("Hard requirements not met", (rep.hard_constraint_misses || []).map(h => h.label || h.term || h), true)}
        ${rep.experience?.summary ? `<p class="note">Experience: ${esc(rep.experience.summary)}</p>` : ""}
        <p class="note">Only add a skill you actually have. Matching is about evidence, not keywords.</p>`
      : `<p class="note">Why: ${esc((rep.decline_reasons || []).join("; ") || "too few scorable terms")}. Paste the FULL job description, or a fuller résumé.</p>`}
      ${r.saved?.stored ? '<p class="msg good">Saved to your account.</p>' : ""}`;
  } catch (err) { out.innerHTML = `<p class="msg bad">${esc(err.message)}</p>`; }
});

// ── Format ──────────────────────────────────────────────────────────────────────────────────────
const toHtml = (text) => /<[a-z][\s\S]*>/i.test(text) ? text
  : `<div>${text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join("")}</div>`;
function documentResult(out, html, title) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  out.innerHTML = `
    <iframe class="preview" sandbox="allow-modals" title="${esc(title)}"></iframe>
    <div class="row"><a class="btn" href="${url}" download="${esc(title)}.html">Download HTML</a>
      <button class="btn" type="button" data-print>Print / save as PDF</button></div>`;
  const frame = $("iframe", out);
  frame.srcdoc = html;
  $("[data-print]", out).addEventListener("click", () => frame.contentWindow?.print());
}
$("#format-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, out = $("#format-out");
  show(out); out.innerHTML = '<p class="note">Formatting…</p>';
  try {
    const r = await call("POST", "/tools/format", { html: toHtml(f.html.value), store: f.store?.checked === true, title: "Formatted résumé" });
    documentResult(out, r.html, "resume");
    if (r.saved?.stored) out.insertAdjacentHTML("beforeend", '<p class="msg good">Saved to your account.</p>');
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
      Read every line before you send it.${r.saved?.stored ? " Saved to your account." : ""}</p>`);
    refreshConfig();
  } catch (err) {
    const v = err.body?.violations;
    out.innerHTML = `<p class="msg bad">${esc(err.status === 422
      ? "Withheld: the draft claimed more than your résumé states, so it was not shown. No credit was used — try again."
      : err.message)}</p>${v ? `<ul>${v.map(x => `<li>${esc(x.message || x.kind || JSON.stringify(x))}</li>`).join("")}</ul>` : ""}`;
  }
});

// ── PDF ─────────────────────────────────────────────────────────────────────────────────────────
$("#pdf-form").addEventListener("submit", async (e) => {
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
    out.innerHTML = `<p class="msg good">Read ${r.chars} characters — ${r.credits.charged} credit used, ${r.credits.balance} left.</p>
      <textarea readonly>${esc(r.text)}</textarea>
      <div class="row"><button class="btn" type="button" data-use>Use it in the ATS check and the tailor</button></div>`;
    $("[data-use]", out).addEventListener("click", () => {
      $("#ats-form").resumeText.value = r.text; $("#generate-form").baseResumeText.value = r.text; openTab("ats");
    });
    refreshConfig();
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
      `${a.monthlyGrant} granted free each month · saved documents are kept ${a.retentionDays} days, then deleted.`;
    $("#ledger").innerHTML = "<tr><th>When</th><th>What</th><th>Credits</th><th>Tokens</th></tr>" + a.ledger.map(l =>
      `<tr><td>${new Date(l.at).toLocaleString()}</td><td>${esc(l.reason === "debit" ? l.route : l.reason.replace("_", " "))}</td>` +
      `<td>${l.delta > 0 ? "+" : ""}${l.delta}</td><td>${l.inputTokens != null ? `${l.inputTokens} in / ${l.outputTokens} out` : ""}</td></tr>`).join("");
    const d = await call("GET", "/documents");
    $("#docs").innerHTML = d.documents.length ? d.documents.map(doc =>
      `<li><span>${esc(doc.title || doc.kind)} <span class="note">· ${esc(doc.kind.replace("_", " "))} · deleted ${new Date(doc.expiresAt).toLocaleDateString()}</span></span>
        <span><button class="btn" data-doc-open="${doc.id}">Open</button> <button class="btn" data-doc-del="${doc.id}">Delete</button></span></li>`).join("")
      : '<li class="note">Nothing saved. Tick "Save to my account" on a tool to keep its result.</li>';
    $$("[data-doc-del]").forEach(b => b.addEventListener("click", async () => {
      await call("DELETE", `/documents/${b.dataset.docDel}`).catch(err => say($("#account-msg"), err.message, "bad"));
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

refreshConfig();
