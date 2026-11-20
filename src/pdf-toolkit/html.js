// HTML → PDF (A69's tool, moved out of the retired 16-tab UI — rm-audit M14 / M15): an HTML file or pasted HTML is shown in a
// preview frame and printed by the browser ("Save as PDF"). ⛔ The frame never runs script — sandboxed without
// allow-scripts, same-origin only so the page may call its print() — and the policy inside it keeps the promise that no
// request leaves the browser (inline styles and data: pictures and fonts only; a linked stylesheet, picture or font is
// simply not loaded).
export const HTML_SANDBOX = "allow-modals allow-same-origin";
export const HTML_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
export function htmlForPrint(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
  const src = String(html || "");
  const head = /<head(?:\s[^>]*)?>/i; // not <header>
  return head.test(src) ? src.replace(head, m => `${m}${meta}`)
    : `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${src}</body></html>`;
}
