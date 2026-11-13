// ── PDF toolkit · documents kept in THIS browser (D189 P4: Documents home, version history, the tool pages' hand-off) ────
//
// IndexedDB, this origin only — nothing is uploaded, nothing leaves the device. Three stores:
//   docs      { id, name, kind, pages, size, editedAt, thumb }      — "Recent on this device" (the newest 12 kept)
//   versions  { id, docId, at, note, bytes }                        — each document's history (the newest 15 kept)
//   handoff   { id: "pending", bytes, name, mode, tool }           — a file dropped on Documents home or a tool page, picked
//                                                                     up once by /workspace/
// Every call degrades to "nothing kept" when storage is blocked (a private window, a strict setting) — never a failure.

const DB = "rm-docs", VERSION = 1;
const MAX_DOCS = 12, MAX_VERSIONS = 15;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no storage"));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions", { keyPath: "id" }).createIndex("docId", "docId");
      if (!db.objectStoreNames.contains("handoff")) db.createObjectStore("handoff", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  } catch { return null; }
}
const all = (store, index, key) => tx(store, "readonly", (s) => (index ? s.index(index).getAll(key) : s.getAll()));

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Recent documents, newest first. */
export async function listDocs() { return ((await all("docs")) || []).sort((a, b) => b.editedAt - a.editedAt); }
export async function getDoc(id) { return tx("docs", "readonly", (s) => s.get(id)); }
/** Keep (or refresh) a document in Recent; the oldest beyond 12 leave, with their versions. */
export async function putDoc(doc) {
  await tx("docs", "readwrite", (s) => s.put({ ...doc, editedAt: doc.editedAt || Date.now() }));
  const docs = await listDocs();
  for (const old of docs.slice(MAX_DOCS)) await deleteDoc(old.id);
}
export async function deleteDoc(id) {
  await tx("docs", "readwrite", (s) => s.delete(id));
  for (const v of (await all("versions", "docId", id)) || []) await tx("versions", "readwrite", (s) => s.delete(v.id));
}

/** A version of a document: its bytes at that moment and a short note ("Downloaded", "Autosaved", "Pages changed"). */
export async function addVersion(docId, bytes, note = "Saved") {
  const v = { id: newId(), docId, at: Date.now(), note, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
  await tx("versions", "readwrite", (s) => s.put(v));
  const vs = await listVersions(docId);
  for (const old of vs.slice(MAX_VERSIONS)) await tx("versions", "readwrite", (s) => s.delete(old.id));
  return v;
}
/** A document's versions, newest first (with their bytes). */
export async function listVersions(docId) { return ((await all("versions", "docId", docId)) || []).sort((a, b) => b.at - a.at); }
export async function getVersion(id) { return tx("versions", "readonly", (s) => s.get(id)); }

/** A file handed to the workspace by Documents home or a tool page (one at a time; read once). */
export async function setHandoff(bytes, name, mode = "edit", tool = null) {
  return tx("handoff", "readwrite", (s) => s.put({ id: "pending", bytes, name, mode, tool, at: Date.now() }));
}
export async function takeHandoff() {
  const h = await tx("handoff", "readonly", (s) => s.get("pending"));
  if (h) await tx("handoff", "readwrite", (s) => s.delete("pending"));
  return h && Date.now() - h.at < 10 * 60 * 1000 ? h : null;
}
