// D17 (draft's owner, 10-03): only résumé generation may call a model. The token API's PDF → text
// (/v1/resumes/parse-pdf) used to be Sonnet transcribing the document; since contract 1.2.0 it reads
// the PDF's own text layer, like the site's tool (A70). These pin that it stays that way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { TINY_PDF_BASE64, NO_TEXT_PDF_BASE64 } from "../src/contract/harness.js";

// A model client that fails the test if anything so much as looks at it.
const tripwire = new Proxy({}, { get(_t, key) { throw new Error(`the model client was touched (.${String(key)})`); } });

async function serve() {
  const { token, entry } = mintToken("draft");
  const app = createApp({ anthropic: tripwire, version: { version: "test" }, log: () => {},
    clients: parseClientTokens(entry) });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/v1/resumes/parse-pdf`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { post, close: () => new Promise(r => server.close(r)) };
}

test("D17: /v1/resumes/parse-pdf reads the text layer and never touches the model client", async () => {
  const s = await serve();
  try {
    const r = await s.post({ pdfBase64: TINY_PDF_BASE64 });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.text, /JANE DOE/);
    assert.deepEqual(body.usage, [], "no model, so no usage");
    const scan = await s.post({ pdfBase64: NO_TEXT_PDF_BASE64 });
    assert.equal(scan.status, 400, "a scan is refused, never answered with an empty résumé");
    assert.match((await scan.json()).message, /no text layer/);
  } finally { await s.close(); }
});

test("D17: the model transcription is gone, and the route is declared free", () => {
  assert.equal(fs.existsSync("src/parsing/parsePdf.js"), false, "parsePdf.js (Sonnet reads the PDF) came back");
  const app = fs.readFileSync("src/http/app.js", "utf8");
  assert.doesNotMatch(app, /metered\("resumes\.parse-pdf"/);
  const contract = JSON.parse(fs.readFileSync("contract/resume-master-api.v1.json", "utf8"));
  const op = contract.paths["/v1/resumes/parse-pdf"].post;
  assert.ok(!op.responses["502"], "a model-failure answer is declared again");
});
