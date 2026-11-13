// D189 P4 · Documents home (resumemaster.one/) and the tool landing pages: a dropped PDF is handed to the workspace in THIS
// browser (IndexedDB — src/pdf-toolkit/docstore.js), never uploaded; Recent lists the documents kept here.
const store = await import("/lib/pdf-toolkit/docstore.js");
const drop = document.querySelector("[data-docs-drop]");
const input = drop?.querySelector("input[type=file]");
const mode = drop?.dataset.mode || "edit";
async function hand(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { drop.dataset.err = "That isn't a PDF."; drop.querySelector(".docs-drop__s").textContent = "That isn't a PDF — choose a .pdf file."; return; }
  await store.setHandoff(new Uint8Array(await file.arrayBuffer()), file.name, mode, drop.dataset.tool || null);
  location.href = `/workspace/?open=1&mode=${encodeURIComponent(mode)}`;
}
if (drop) {
  input?.addEventListener("change", () => hand(input.files?.[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.dataset.drag = "true"; });
  drop.addEventListener("dragleave", () => { delete drop.dataset.drag; });
  drop.addEventListener("drop", (e) => { e.preventDefault(); delete drop.dataset.drag; hand(e.dataTransfer?.files?.[0]); });
}
const recent = document.querySelector("#docs-recent");
if (recent) {
  const docs = await store.listDocs();
  if (docs.length) {
    recent.hidden = false;
    const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
    document.querySelector("#docs-recent-list").replaceChildren(...docs.map(d => {
      const a = document.createElement("a");
      a.className = "docs-doc"; a.href = `/workspace/?doc=${encodeURIComponent(d.id)}`; a.dataset.doc = d.id;
      const img = document.createElement("img"); img.alt = ""; if (d.thumb) img.src = d.thumb;
      const b = document.createElement("b"); b.textContent = d.name;
      const s = document.createElement("small"); s.textContent = `${d.kind} · ${d.pages} page${d.pages === 1 ? "" : "s"} · edited ${ago(d.editedAt)}`;
      a.append(img, b, s);
      return a;
    }));
  }
}
