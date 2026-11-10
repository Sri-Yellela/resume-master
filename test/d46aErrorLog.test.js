// draft 46a: every résumé generation since 11-07 answered 500 with only "TypeError" logged. An unexpected error now logs its
// message and the src/ locations it was thrown from — code locations only, never the request or the model's text.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the error handler logs an unexpected error's message and its src/ code locations", () => {
  const src = fs.readFileSync("src/http/app.js", "utf8");
  assert.ok(src.includes("err.status == null && (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError)"));
  assert.ok(src.includes('message: String(err.message || "").slice(0, 200)'), "the message, capped");
  assert.ok(src.includes(".slice(0, 4)"), "at most 4 code locations");
  assert.ok(src.includes("[\\\\/]src[\\\\/]"), "src/ frames only");
});
