// client/src/lib/api.js

const AUTH_CONTEXT_KEY = "rm_auth_context";

export function getAuthContext() {
  try { return sessionStorage.getItem(AUTH_CONTEXT_KEY) || ""; }
  catch { return ""; }
}

export function setAuthContext(token) {
  try {
    if (token) sessionStorage.setItem(AUTH_CONTEXT_KEY, token);
    else sessionStorage.removeItem(AUTH_CONTEXT_KEY);
  } catch {}
}

export function authHeaders(headers = {}) {
  const token = getAuthContext();
  return token ? { "X-RM-Auth-Context": token, ...headers } : headers;
}

export function authContextQuery() {
  const token = getAuthContext();
  return token ? `authContext=${encodeURIComponent(token)}` : "";
}

export async function api(path, opts = {}) {
  const bodyIsForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers = authHeaders({
    ...(bodyIsForm ? {} : { "Content-Type": "application/json" }),
    ...(opts.headers || {}),
  });
  const r = await fetch(path, {
    credentials: "include",
    ...opts,
    headers,
  });
  if (r.status === 401) throw Object.assign(new Error("Session expired. Sign in again."), { status: 401 });
  if (r.status === 429) {
    const payload = await r.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error || "Too many requests. Try again shortly."), { status: 429, payload });
  }
  if (r.status >= 500) {
    const payload = await r.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error || "Service temporarily unavailable. Try again shortly."), { status: r.status, payload });
  }
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/pdf") || ct.includes("spreadsheetml") || ct.includes("octet-stream")) return r;
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(payload.error || `Request failed (${r.status})`), { status: r.status, payload });
  return payload;
}

export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement("a"), { href:url, download:filename });
  a.click();
  URL.revokeObjectURL(url);
}

export const dislikeJob = (jobId) =>
  api(`/api/jobs/${jobId}/disliked`, { method:"PATCH" });

export const postLinkedInCookies  = (cookies) =>
  api("/api/linkedin/cookies", { method:"POST",   body:JSON.stringify({ cookies }) });
export const getLinkedInStatus    = ()         =>
  api("/api/linkedin/status");
export const deleteLinkedInCookies = ()        =>
  api("/api/linkedin/cookies", { method:"DELETE" });

// Chromium File System Access API — shows Save As dialog, returns chosen filename.
// Falls back to standard download on unsupported browsers.
export function printResume(html, filename) {
  const win = window.open("", "_blank");
  if (!win) { alert("Pop-up blocked — please allow pop-ups for this site and try again."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  // Set title so the browser suggests the right filename in the print dialog
  try { win.document.title = filename || "Resume"; } catch {}
  win.print();
}

export async function saveWithPicker(blob, suggestedName, mimeType) {
  try {
    if (window.showSaveFilePicker) {
      const ext    = suggestedName.split(".").pop();
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: ext === "pdf" ? "PDF Document" : "Excel File", accept: { [mimeType]: ["." + ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name || suggestedName;
    }
  } catch (e) {
    if (e.name === "AbortError") throw e; // user cancelled
  }
  // Fallback
  await downloadBlob(blob, suggestedName);
  return suggestedName;
}
