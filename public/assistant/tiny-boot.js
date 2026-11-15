// public/assistant/tiny-boot.js — ⭐ D190 · Tiny on every page of the PDF-tools site that is not the workspace (the workspace
// mounts Tiny itself, with the open document's handlers). It brings its own stylesheet, so a page needs only this one line:
//   <script type="module" src="/assistant/tiny-boot.js"></script>
if (!document.querySelector("[data-ws]") && !document.querySelector("[data-tiny-root]")) {
  if (!document.querySelector('link[href="/assistant/tiny.css"]')) {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/assistant/tiny.css"; document.head.append(css);
  }
  const { mountTiny } = await import("/assistant/tiny.js");
  window.__rmTiny = await mountTiny({ onDocument: false });
}
