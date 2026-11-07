// draft D173 (5): ONE REQUEST ID ACROSS SERVICES. draft sends `x-request-id` with every call it makes here; this
// service logs it on the request's line and echoes it back, so one application's run can be followed from draft's
// log to this one. A malformed id is dropped, never invented.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp, requestIdOf } from "../src/http/app.js";

const hdr = (v) => ({ headers: { "x-request-id": v } });

test("d173RequestIdAcrossServices: a plain token is taken; anything else is null", () => {
  assert.equal(requestIdOf(hdr("run42-job317")), "run42-job317");
  assert.equal(requestIdOf(hdr("0b9c3f8e-6f7a-4c1e-9a55-2f1d3c4b5a69")), "0b9c3f8e-6f7a-4c1e-9a55-2f1d3c4b5a69");
  for (const bad of [undefined, "", "abc", "x".repeat(81), "a b c d e f", "id\r\nset-cookie: x", "<script>"]) {
    assert.equal(requestIdOf(hdr(bad)), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("d173RequestIdAcrossServices: the id is logged on the request's line and echoed back", async () => {
  const lines = [];
  const app = createApp({ log: (e) => lines.push(e), version: { commit: "test" }, env: {} });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/v1/version`, { headers: { "x-request-id": "run7-job99" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "run7-job99");
    const bare = await fetch(`${base}/v1/version`);
    assert.equal(bare.headers.get("x-request-id"), null, "no id sent → none invented");
    await new Promise(r => setTimeout(r, 20));
    const logged = lines.filter(l => l.path === "/v1/version");
    assert.equal(logged.length, 2);
    assert.equal(logged[0].rid, "run7-job99");
    assert.ok(!("rid" in logged[1]));
  } finally { server.close(); }
});
