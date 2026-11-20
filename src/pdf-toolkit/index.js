// The PDF toolkit (A69) — Resume Master's own product. The operations are environment-neutral (core.js, pdfText.js);
// render.js, session.js and the page layer need a browser. (rm-audit M15: the 16-tab UI, ui.js, is retired — every tool is in
// the one workspace, public/workspace/.)
export * from "./core.js";
export { textFromPdfDocument, layoutPage } from "./pdfText.js";
