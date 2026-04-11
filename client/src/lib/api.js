// client/src/lib/api.js

export async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (r.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/pdf") || ct.includes("spreadsheetml") || ct.includes("octet-stream")) return r;
  return r.json();
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
