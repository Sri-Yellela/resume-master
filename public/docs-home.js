// D189 P4 · Documents home (resumemaster.one/) and the tool landing pages: a dropped PDF is handed to the workspace in THIS
// browser (IndexedDB — src/pdf-toolkit/docstore.js), never uploaded; Recent lists the documents kept here.
const store = await import("/lib/pdf-toolkit/docstore.js");
const drop = document.querySelector("[data-docs-drop]");
const input = drop?.querySelector("input[type=file]");
const mode = drop?.dataset.mode || "edit";
// ⭐ rm-audit M14: the JPG-to-PDF and HTML-to-PDF pages take pictures / an HTML file — the workspace starts a PDF from them
const takes = (file) => drop.dataset.tool === "images" ? /^image\/(jpeg|png)$/i.test(file.type) || /\.(jpe?g|png)$/i.test(file.name)
  : drop.dataset.tool === "html" ? /html/i.test(file.type) || /\.html?$/i.test(file.name)
  : /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) || /\.docx$/i.test(file.name) || /wordprocessingml/i.test(file.type);
async function hand(file) {
  if (!file) return;
  // ⭐ D188 LATER: a Word file (.docx) is welcome too — the workspace makes it a PDF in this browser
  if (!takes(file)) { drop.dataset.err = "wrong type"; drop.querySelector(".docs-drop__s").textContent = drop.dataset.tool === "images" ? "That isn't a JPEG or PNG picture." : drop.dataset.tool === "html" ? "That isn't an HTML file (.html)." : "That isn't a PDF or a Word file — choose a .pdf or .docx."; return; }
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
