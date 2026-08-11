import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../scripts/migrations.js";

// Four of the ATS rows seeded by migration 056 were wrong, and every one failed SILENTLY:
// greenhouse.js/ashby.js wrap each company in a `.catch(() => [])`, so a 404 produced a console
// warning and an empty array, and the crawl still reported success. The board quietly ran 8 of
// 10 companies. Vercel was worse still — its Ashby board returns HTTP 200 with zero jobs, so it
// did not even produce a warning.
//
// These assertions are offline on purpose: they pin the corrected configuration so a revert or
// a re-edit of 056 fails here. Whether a slug is still LIVE is a question for the pipeline
// monitor against real data, not for the unit suite.

function migration(id) {
  const m = MIGRATIONS.find(x => x.id === id);
  assert.ok(m, `migration ${id} must exist`);
  return m;
}

// Rebuild 056's table + seed, then apply the fix, without depending on the rest of the chain
// (most migrations ALTER tables created outside MIGRATIONS).
function seededDb() {
  const db = new Database(":memory:");
  db.exec(migration("056_company_ats_list").sql);
  return db;
}

const FIX = "070_fix_dead_ats_slugs";

test("the seed really does contain the dead rows this migration exists to fix", () => {
  // If 056 is ever edited in place, this fails and the fix becomes a no-op nobody noticed.
  const db = seededDb();
  const row = (c) => db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = ?").get(c);
  assert.deepEqual(row("Notion"),   { ats_type: "greenhouse", ats_slug: "notionhq", active: 1 });
  assert.deepEqual(row("OpenAI"),   { ats_type: "greenhouse", ats_slug: "openai",   active: 1 });
  assert.deepEqual(row("Rippling"), { ats_type: "greenhouse", ats_slug: "rippling", active: 1 });
  assert.deepEqual(row("Vercel"),   { ats_type: "ashby",      ats_slug: "vercel",   active: 1 });
});

test("070 repoints Notion, OpenAI and Vercel to the boards they actually use", () => {
  const db = seededDb();
  db.exec(migration(FIX).sql);
  const row = (c) => db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = ?").get(c);
  assert.deepEqual(row("Notion"), { ats_type: "ashby",      ats_slug: "notion", active: 1 });
  assert.deepEqual(row("OpenAI"), { ats_type: "ashby",      ats_slug: "openai", active: 1 });
  // Vercel moves the OTHER way — its Ashby board is empty; Greenhouse is the live one.
  assert.deepEqual(row("Vercel"), { ats_type: "greenhouse", ats_slug: "vercel", active: 1 });
});

test("070 deactivates Rippling rather than deleting it or guessing a slug", () => {
  const db = seededDb();
  db.exec(migration(FIX).sql);
  const rippling = db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = 'Rippling'").get();
  assert.ok(rippling, "the row must survive as a record to reactivate later");
  assert.equal(rippling.active, 0, "cacheJobs filters WHERE active = 1, so this stops the failing request");
  assert.equal(rippling.ats_slug, "rippling", "no invented slug — 404 on greenhouse, ashby and lever alike");
});

test("070 is idempotent and does not clobber a hand-corrected row", () => {
  const db = seededDb();
  db.exec(migration(FIX).sql);
  const after = db.prepare("SELECT company, ats_type, ats_slug, active FROM company_ats_list ORDER BY company").all();
  db.exec(migration(FIX).sql);
  assert.deepEqual(db.prepare("SELECT company, ats_type, ats_slug, active FROM company_ats_list ORDER BY company").all(), after);

  // Someone fixing Rippling by hand must not have it re-deactivated by a later replay.
  db.prepare("UPDATE company_ats_list SET ats_type='lever', ats_slug='ripplinghq', active=1 WHERE company='Rippling'").run();
  db.exec(migration(FIX).sql);
  const rippling = db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company='Rippling'").get();
  assert.deepEqual(rippling, { ats_type: "lever", ats_slug: "ripplinghq", active: 1 },
    "the guard is narrow enough that a corrected row survives a replay");
});

test("no two active companies share an ats_type + slug", () => {
  // UNIQUE(ats_type, ats_slug) enforces this at the DB level; asserted here so a future edit
  // that moves a company between providers can't silently collide.
  const db = seededDb();
  db.exec(migration(FIX).sql);
  const dupes = db.prepare(`
    SELECT ats_type, ats_slug, COUNT(*) n FROM company_ats_list
    GROUP BY ats_type, ats_slug HAVING n > 1
  `).all();
  assert.deepEqual(dupes, []);
});
