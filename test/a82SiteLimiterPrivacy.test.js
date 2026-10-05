// A82 (agent-raised 10-04): the site's free-tool limiters held RAW addresses — keyed on req.ip, cleared
// only past 10,000 entries — while docs/PRIVACY.md said the free tools keep nothing. They now hold an
// address the way /mcp's anonymous caps do: a salted one-way hash, in a map that holds one window and is
// emptied the moment that window turns. These tests hold that bound, and the policy's words for it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/http/app.js";
import { createRateLimiter, createDailyLimiter } from "../src/http/siteRoutes.js";
import { createAddressHasher } from "../src/http/metering.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";

loadAllPrompts();

const ADDRS = ["203.0.113.7", "198.51.100.23", "2001:db8::42"];

test("the address key is a salted one-way hash: never the address, stable within a process, different across processes", () => {
  const a = createAddressHasher(), b = createAddressHasher();
  for (const ip of ADDRS) {
    assert.equal(a(ip), a(ip), "stable, so a count can accumulate");
    assert.ok(!a(ip).includes(ip) && !a(ip).includes(ip.split(/[.:]/)[0] + "."), `no trace of ${ip} in its key`);
    assert.notEqual(a(ip), b(ip), "a fresh salt gives a different key — the hash cannot be matched across restarts");
  }
  assert.notEqual(a(ADDRS[0]), a(ADDRS[1]));
});

test("⛔ the rate limiter holds only hashes, and holds them at most a minute — emptied when the minute turns, not swept later", () => {
  let t = Date.UTC(2026, 9, 4, 12, 0, 5);
  const l = createRateLimiter({ perMinute: 2, now: () => t });
  for (const ip of ADDRS) l(ip);
  assert.equal(l.held(), 3);
  for (const k of l.heldKeys()) for (const ip of ADDRS) assert.ok(!k.includes(ip), "a raw address is never a key");
  assert.deepEqual([l(ADDRS[0]), l(ADDRS[0])], [true, false], "still counts: 2 a minute per address");
  t += 60_000;
  l("192.0.2.1");
  assert.equal(l.held(), 1, "last minute's addresses are gone the moment the minute turns");
  assert.equal(l(ADDRS[0]), true, "and their counts with them");
});

test("⛔ the daily limiter holds only hashes, and never past their UTC day", () => {
  let t = Date.UTC(2026, 9, 4, 23, 59, 30);
  const l = createDailyLimiter({ perDay: 2, now: () => t });
  for (const ip of ADDRS) l(ip);
  assert.equal(l.held(), 3);
  for (const k of l.heldKeys()) for (const ip of ADDRS) assert.ok(!k.includes(ip));
  assert.deepEqual([l(ADDRS[1]), l(ADDRS[1])], [true, false], "2 a day per address");
  t += 31_000;                                       // 00:00:01 UTC the next day
  l("192.0.2.1");
  assert.equal(l.held(), 1, "yesterday's addresses are gone at midnight UTC");
  assert.equal(createDailyLimiter({ perDay: 0 })("x"), false, "a zero ceiling still refuses");
});

test("⛔ over real HTTP: the free tools' limiters never hold the caller's address", async () => {
  const publicLimiter = createRateLimiter({ perMinute: 50 });
  const pdfDailyLimiter = createDailyLimiter({ perDay: 50 });
  const app = createApp({ version: { version: "test" }, log: () => {}, siteOptions: { publicLimiter, pdfDailyLimiter } });
  app.set("trust proxy", true);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { "content-type": "application/json", "x-rm-client": "web", "x-forwarded-for": ADDRS[0] };
    const ats = { job: { title: "Backend Engineer", description: "Go, PostgreSQL, Kubernetes." }, resumeText: "Go, PostgreSQL, Kubernetes." };
    assert.equal((await fetch(base + "/v1/site/tools/ats", { method: "POST", headers, body: JSON.stringify(ats) })).status, 200);
    await fetch(base + "/v1/site/tools/parse-pdf", { method: "POST", headers, body: JSON.stringify({ pdfBase64: "" }) });
    assert.equal(publicLimiter.held(), 1);
    assert.equal(pdfDailyLimiter.held(), 1);
    for (const k of [...publicLimiter.heldKeys(), ...pdfDailyLimiter.heldKeys()]) {
      for (const raw of [ADDRS[0], "127.0.0.1", "::ffff:127.0.0.1", "::1"]) assert.ok(!k.includes(raw), `key holds ${raw}`);
    }
  } finally { await new Promise(r => server.close(r)); }
});

test("⛔ siteRoutes keys nothing on a raw address: every limiter goes through the hasher", () => {
  const src = fs.readFileSync("src/http/siteRoutes.js", "utf8");
  assert.match(src, /const keyOf = createAddressHasher\(\);/);
  assert.doesNotMatch(src, /hits\.(?:get|set)\((?:key|ip)\b/, "a map keyed by the raw address");
});

test("the privacy policy says what the free tools hold: a salted hash of the address, for at most a day", () => {
  const md = fs.readFileSync("docs/PRIVACY.md", "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(md, /free tools on the site \(ATS scoring, formatting\) needs no account and keeps nothing\./,
    "the old sentence — untrue while the limiters held addresses — is gone");
  const section = md.slice(md.indexOf("## What an account keeps"), md.indexOf("## Who it is shared with"));
  assert.match(section, /salted hash of your network address/i);
  assert.match(section, /never the address itself/i);
  assert.match(section, /current minute/i);
  assert.match(section, /UTC/);
  assert.match(section, /restart erases/i);
});
