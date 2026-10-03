// The PDF tools (A69), in the visitor's browser — the file is never uploaded. The component is
// src/pdf-toolkit (served at /lib/pdf-toolkit/); its libraries are served by this service (/lib/…),
// so the site makes no third-party request.
//   · a tool page (/pdf/<tool>/) mounts at once, on the tool its #pdf-tools names (data-initial);
//   · the home page's PDF tab (data-lazy) mounts the first time the tab opens, so nobody downloads
//     ~2 MB of PDF code for a tab they never use.
const host = document.getElementById("pdf-tools");
let started = false;

async function start() {
  if (started || !host) return;
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
    ui.mountPdfToolkit(host, { lib, pdfjs, initial: host.dataset.initial || "merge",
      onText: window.rmUseText ? (t) => window.rmUseText(t) : null });
  } catch (e) {
    started = false;
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "msg bad";
    p.textContent = `The PDF tools could not load: ${e?.message || e}`;
    host.append(p);
  }
}

if (host) {
  const panel = host.closest("[data-panel]");
  if (!("lazy" in host.dataset) || !panel) start();
  else {
    if (!panel.hidden) start();
    new MutationObserver(() => { if (!panel.hidden) start(); }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }
}
