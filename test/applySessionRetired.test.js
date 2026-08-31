import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import applyRoutes from "../routes/apply.js";
import { at } from "../test-support/sourceAnchors.js";

/**
 * /api/apply/session — retired, not implemented.
 *
 * WHAT THEY WERE. In the server-side-Playwright era (ebeb9ae) POST /save wrote a Playwright
 * `storageState` — the cookies and localStorage of the candidate's LOGGED-IN session on an
 * employer's portal — to data/sessions/<userId>_<domain>.json in plaintext, and GET /:domain
 * reported whether that file existed. c818b9c replaced that architecture and left both as stubs
 * answering {ok:true} and {exists:false}.
 *
 * WHY THEY WERE NOT IMPLEMENTED. A gated portal is now handed to the candidate's OWN browser:
 * detectGate runs before any fill so a sign-in wall is never typed into, no credential control is
 * ever answered (g6CredentialGuard), and `login_required` becomes a portal batch resolved by one
 * real sign-in whose grant survives every same-origin navigation (G0). Restoring these would put a
 * live authenticated session to a third party back on our disk — the most sensitive thing this
 * product could hold, and precisely what that architecture removed.
 *
 * WHY 410 AND NOT THE STUBS. The stubs were the worse option: {ok:true} tells a caller its session
 * was saved when nothing was written, and {exists:false} answers "do you have my session?" with a
 * confident no that is true only by accident. Both are the wired-to-a-no-op shape.
 */

function server() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE apply_runs (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT);
           CREATE TABLE apply_run_jobs (id INTEGER PRIMARY KEY, run_id INTEGER, user_id INTEGER,
             job_id TEXT, status TEXT, hidden_at INTEGER);
           CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY);`);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, planTier: "PRO" }; next(); });
  applyRoutes(app, db, (q, r, n) => n(), () => ({ field_map: {}, handler_map: {}, custom_answers: {} }),
    async () => ({}), async () => Buffer.from(""), async () => ({}));
  return app;
}
const call = (app, method, path, body) => new Promise((resolve) => {
  const s = app.listen(0, async () => {
    const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await r.json().catch(() => null);
    s.close(() => resolve({ status: r.status, payload }));
  });
});

test("saving a portal session is GONE, and says what to do instead", async () => {
  const { status, payload } = await call(server(), "POST", "/api/apply/session/save",
    { domain: "workday.com", storageState: { cookies: [{ name: "sid", value: "secret" }] } });
  assert.equal(status, 410);
  assert.equal(payload.error, "gone");
  // A 410 that only says "gone" leaves the caller with nothing to do. The whole point of the
  // precedent is that it names the replacement.
  assert.match(payload.message, /handed to your own browser/);
  assert.match(payload.message, /sign in once/i);
});

test("asking whether a session exists is GONE — not a confident 'no'", async () => {
  // {exists:false} was the more dangerous of the two stubs: it is a definitive answer that happens
  // to be true, so a caller would loop through a re-login flow forever and never learn why.
  const { status, payload } = await call(server(), "GET", "/api/apply/session/workday.com");
  assert.equal(status, 410);
  assert.equal(payload.error, "gone");
  assert.notEqual(payload.exists, false, "must not still answer the question it can no longer answer");
});

test("nothing is written to disk, whatever is posted", async () => {
  // The original wrote data/sessions/<userId>_<domain>.json. If that directory ever reappears,
  // something has started persisting portal sessions again and this should be the thing that says so.
  await call(server(), "POST", "/api/apply/session/save",
    { domain: "greenhouse.io", storageState: { cookies: [] } });
  assert.equal(fs.existsSync("data/sessions"), false,
    "data/sessions exists — a portal session store has come back");
});

test("a path-traversing domain cannot reach the filesystem, because nothing touches it", async () => {
  // The retired implementation sanitised the domain into a filename. Worth one assertion that the
  // replacement has no filesystem path at all rather than a better-sanitised one.
  const { status } = await call(server(), "GET", "/api/apply/session/..%2F..%2Fetc%2Fpasswd");
  assert.equal(status, 410);
  const route = fs.readFileSync("routes/apply.js", "utf8");
  const block = route.slice(at(route, "RETIRED — the server does not keep your portal sessions"));
  assert.doesNotMatch(block.slice(0, at(block, "\n}")), /writeFileSync|existsSync|sessionPath/);
});

test("both routes stay behind requireAuth", () => {
  // A retired route is not a public one. Keeping the guard is also what keeps them out of the
  // PUBLIC list in the route manifest, where nobody would look at them again.
  const route = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(route, /app\.post\("\/api\/apply\/session\/save", requireAuth/);
  assert.match(route, /app\.get\("\/api\/apply\/session\/:domain", requireAuth/);
});

test("the stub shapes are gone", () => {
  const route = fs.readFileSync("routes/apply.js", "utf8");
  assert.doesNotMatch(route, /res\.json\(\{ exists: false \}\)/);
  const block = route.slice(at(route, "const SESSION_RETIRED"), at(route, "app.get(\"/api/apply/session/:domain\"") + 200);
  assert.doesNotMatch(block, /res\.json\(\{ ok: true \}\)/);
});

test("it follows the 410 precedent this codebase already set", () => {
  // /api/scrape and the retired extension save-job route both answer 410 with a sentence rather
  // than 404 or a silent success. Three retirements, one shape.
  const srv = fs.readFileSync("server.js", "utf8");
  assert.match(srv, /app\.post\("\/api\/scrape", requireAuth[\s\S]{0,200}?status\(410\)/);
  const route = fs.readFileSync("routes/apply.js", "utf8");
  assert.match(route, /following the \/api\/scrape and extension save-job precedent|\/api\/scrape and extension save-job precedent/);
});
