// A69 — the PDF tools, in the visitor's browser. The component is @draft/pdf-toolkit (vendored,
// checksummed, served at /lib/pdf-toolkit/) — the same file draft mounts. Libraries come from this
// service (/lib/…): the site makes no third-party request, and the file is never uploaded.
// Loaded only when the PDF tab is first opened, so nobody pays ~2 MB for a tab they never use.
const panel = document.querySelector('[data-panel="pdf"]');
const host = document.getElementById("pdf-tools");
let started = false;

async function start() {
  if (started) return;
  started = true;
  try {
    const [lib, pdfjs, ui] = await Promise.all([
      import("/lib/pdf-lib/pdf-lib.esm.min.js"),
      import("/lib/pdfjs/pdf.min.mjs"),
      import("/lib/pdf-toolkit/ui.js"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.min.mjs";
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "/lib/pdf-toolkit/styles.css";
    document.head.append(css);
    ui.mountPdfToolkit(host, { lib, pdfjs, initial: "merge", onText: (t) => window.rmUseText?.(t) });
  } catch (e) {
    started = false;
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "msg bad";
    p.textContent = `The PDF tools could not load: ${e?.message || e}`;
    host.append(p);
  }
}

if (panel && host) {
  if (!panel.hidden) start();
  new MutationObserver(() => { if (!panel.hidden) start(); }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
}
