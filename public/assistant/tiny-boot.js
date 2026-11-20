// public/assistant/tiny-boot.js — ⭐ D190 · Tiny on every page of the PDF-tools site that is not the workspace (the workspace
// mounts Tiny itself, with the open document's handlers). It brings its own stylesheet, so a page needs only this one line:
//   <script type="module" src="/assistant/tiny-boot.js"></script>
// Never inside draft's embedded editor (rm-editor/1): draft draws its own assistant, and Tiny's button
// would sit over the résumé. Read from the page itself, not editor.js's data-embedded — the two are
// separate module scripts, and editor.js may still be awaiting when this one runs.
const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();
const embedded = document.documentElement.dataset.embedded === "true"
  || (framed && new URLSearchParams(location.search).get("embed") === "1");
if (!embedded && !document.querySelector("[data-ws]") && !document.querySelector("[data-tiny-root]")) {
  if (!document.querySelector('link[href="/assistant/tiny.css"]')) {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/assistant/tiny.css"; document.head.append(css);
  }
  const { mountTiny } = await import("/assistant/tiny.js");
  window.__rmTiny = await mountTiny({ onDocument: false });
}
