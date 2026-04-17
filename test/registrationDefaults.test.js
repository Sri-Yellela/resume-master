import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("registration defaults new users to Basic Simple Apply", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /apply_mode,plan_tier\) VALUES \(\?,\?,0,'SIMPLE','BASIC'\)/);
  assert.match(server, /applyMode:"SIMPLE", planTier:"BASIC"/);
});
