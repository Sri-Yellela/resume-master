// A69 (owner, 10-02): the PDF tools run in the visitor's browser. This service only SERVES them —
// self-hosted (no third-party request), as JavaScript, and a miss is the usual JSON 404. The tools'
// own behaviour is tested in test/pdf-toolkit/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";

async function serve() {
  const app = createApp({ log: () => {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  // closeAllConnections: a keep-alive socket left open would hold server.close() for ever.
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }) };
}

test("the libraries and the component are served from here, as JavaScript", async () => {
  const s = await serve();
  try {
    for (const p of ["/lib/pdf-lib/pdf-lib.esm.min.js", "/lib/pdfjs/pdf.min.mjs", "/lib/pdfjs/pdf.worker.min.mjs",
                     "/lib/pdf-toolkit/ui.js", "/lib/pdf-toolkit/core.js", "/lib/pdf-toolkit/pdfText.js"]) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type"), /^text\/javascript/, `${p}: a module script refuses any other type`);
      await r.arrayBuffer();
    }
    // Tier 2 (owner, 10-03): Office files and OCR, self-hosted too.
    for (const p of ["/lib/fflate/browser.js", "/lib/tesseract/tesseract.esm.min.js", "/lib/tesseract/worker.min.js",
                     "/lib/tesseract-core/tesseract-core-simd-lstm.wasm.js"]) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type"), /^text\/javascript/, p);
      await r.arrayBuffer();
    }
    const wasm = await fetch(`${s.base}/lib/tesseract-core/tesseract-core-simd-lstm.wasm`);
    assert.equal(wasm.headers.get("content-type"), "application/wasm", "streaming compilation needs the wasm type");
    await wasm.arrayBuffer();
    const data = await fetch(`${s.base}/lib/tessdata/eng.traineddata.gz`);
    assert.equal(data.status, 200);
    assert.equal(data.headers.get("content-encoding"), null, "the reader unzips the data itself — never Content-Encoding");
    assert.ok(Number(data.headers.get("content-length")) < 4_000_000, "the LSTM-only data (≈2.9 MB), not the 10.9 MB legacy set");
    await data.arrayBuffer();
    const miss = await fetch(`${s.base}/lib/pdf-toolkit/nope.js`);
    assert.equal(miss.status, 404, "a missing file is a 404, not a 500");
    assert.equal((await miss.json()).error, "not_found");
  } finally { await s.close(); }
});

test("the page mounts the toolkit and loads only same-origin code — the file is never uploaded", () => {
  const page = fs.readFileSync("public/index.html", "utf8");
  assert.match(page, /<div id="pdf-tools"/);
  assert.match(page, /<script type="module" src="\/pdf-tools\.js"><\/script>/);
  const loader = fs.readFileSync("public/pdf-tools.js", "utf8");
  for (const m of loader.matchAll(/import\("([^"]+)"\)/g)) assert.match(m[1], /^\/lib\//, `${m[1]} must be served from here`);
  assert.doesNotMatch(loader, /https?:\/\//);
  assert.doesNotMatch(loader, /fetch\(|XMLHttpRequest/);
});
