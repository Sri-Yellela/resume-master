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

// ── Task W — 102 / 103 ────────────────────────────────────────────────────────
// The lever seed was the same defect as 070's, one layer down: the list was PRESENT and the
// fetcher WORKED, but all three slugs 404'd because the companies had moved off Lever. Five
// crawls in a row recorded `no_results`, which the plugin's per-company `.catch(() => [])`
// makes indistinguishable from a healthy empty board. Offline on purpose, for the same reason
// as above: these pin the corrected configuration, not the liveness of a third party.

const LEVER_FIX = "102_fix_dead_lever_slugs";
const SEED_REST = "103_seed_remaining_ats_companies";

test("the 056 seed still contains the three dead lever rows 102 exists to fix", () => {
  const db = seededDb();
  const row = (c) => db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = ?").get(c);
  assert.deepEqual(row("Mercury"), { ats_type: "lever", ats_slug: "mercury", active: 1 });
  assert.deepEqual(row("Ramp"),    { ats_type: "lever", ats_slug: "ramp",    active: 1 });
  assert.deepEqual(row("Retool"),  { ats_type: "lever", ats_slug: "retool",  active: 1 });
});

test("102 repoints Mercury and Ramp to the boards they actually use", () => {
  const db = seededDb();
  db.exec(migration(LEVER_FIX).sql);
  const row = (c) => db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = ?").get(c);
  // Both moved OFF Lever, in different directions — which is why the fix is per company and
  // not a blanket "lever is broken".
  assert.deepEqual(row("Mercury"), { ats_type: "greenhouse", ats_slug: "mercury", active: 1 });
  assert.deepEqual(row("Ramp"),    { ats_type: "ashby",      ats_slug: "ramp",    active: 1 });
});

test("102 deactivates Retool rather than deleting it or guessing a slug", () => {
  const db = seededDb();
  db.exec(migration(LEVER_FIX).sql);
  const retool = db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = 'Retool'").get();
  assert.ok(retool, "the row must survive as a record to reactivate later");
  assert.equal(retool.active, 0);
  assert.equal(retool.ats_slug, "retool", "no invented slug — 404 on greenhouse, ashby and lever alike");
});

test("102 is idempotent and does not clobber a hand-corrected row", () => {
  const db = seededDb();
  db.exec(migration(LEVER_FIX).sql);
  const after = db.prepare("SELECT company, ats_type, ats_slug, active FROM company_ats_list ORDER BY company").all();
  db.exec(migration(LEVER_FIX).sql);
  assert.deepEqual(db.prepare("SELECT company, ats_type, ats_slug, active FROM company_ats_list ORDER BY company").all(), after);

  db.prepare("UPDATE company_ats_list SET ats_type='lever', ats_slug='retoolhq', active=1 WHERE company='Retool'").run();
  db.exec(migration(LEVER_FIX).sql);
  assert.deepEqual(
    db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company='Retool'").get(),
    { ats_type: "lever", ats_slug: "retoolhq", active: 1 },
    "the guard is narrow enough that a corrected row survives a replay"
  );
});

test("103 activates only the providers whose rows arrive with a description", () => {
  const db = seededDb();
  db.exec(migration(SEED_REST).sql);
  const activeTypes = db.prepare(
    "SELECT DISTINCT ats_type FROM company_ats_list WHERE active = 1 ORDER BY ats_type"
  ).all().map(r => r.ats_type);

  // smartrecruiters and workday are seeded but MUST stay inactive: their list endpoints carry no
  // job text, so every row would land description-less and enrichJob.js skips those outright.
  // Flipping either on without first adding a per-posting detail fetch is the regression here.
  assert.ok(!activeTypes.includes("smartrecruiters"), "smartrecruiters rows have 0% description coverage");
  assert.ok(!activeTypes.includes("workday"),         "workday rows have 0% description coverage");
  for (const t of ["greenhouse", "lever", "ashby", "workable", "recruitee"]) {
    assert.ok(activeTypes.includes(t), `${t} produces complete rows and should be active`);
  }
});

test("103 keeps the firehose companies seeded but inactive", () => {
  const db = seededDb();
  db.exec(migration(SEED_REST).sql);
  const row = (c) => db.prepare("SELECT ats_type, ats_slug, active FROM company_ats_list WHERE company = ?").get(c);
  // Veeva's rows are complete and correct — it is held back purely on volume: 596 kept rows is
  // +47% on a ~1266-active board, while enrichment drains at 25/day. Recorded, not discarded.
  assert.deepEqual(row("Veeva Systems"), { ats_type: "lever", ats_slug: "veeva", active: 0 });
  assert.equal(row("Bosch").active, 0);
  assert.equal(row("Ubisoft").active, 0);
});

test("103 stores a Workday board as wdNumber|tenant|site, not a bare slug", async () => {
  const db = seededDb();
  db.exec(migration(SEED_REST).sql);
  const { parseSlug } = await import("../services/jobs/sources/workday.js");
  const adobe = db.prepare("SELECT ats_slug FROM company_ats_list WHERE company = 'Adobe'").get();
  // A Workday board is per-tenant and the wd# subdomain varies, so one slug cannot address it.
  // Parsed with the plugin's OWN parser rather than a second split() written for the test.
  assert.deepEqual(parseSlug(adobe.ats_slug), { wdNumber: "5", tenant: "adobe", site: "external_experienced" });
});

test("every seeded ats_type is a provider the aggregator actually registers", async () => {
  // The seed and the plugin registry are two halves of one contract: a row whose ats_type no
  // plugin answers to is silently never crawled, which is precisely how four providers sat at
  // `skipped_unconfigured` unnoticed. DIRECT_ATS_SOURCES is what cacheJobs keys its map off.
  const db = seededDb();
  db.exec(migration(LEVER_FIX).sql);
  db.exec(migration(SEED_REST).sql);
  const { DIRECT_ATS_SOURCES } = await import("../services/jobs/directApplyFilter.js");
  const seeded = db.prepare("SELECT DISTINCT ats_type FROM company_ats_list").all().map(r => r.ats_type);
  for (const t of seeded) {
    assert.ok(DIRECT_ATS_SOURCES.has(t), `ats_type '${t}' has no registered plugin — it would never be crawled`);
  }
});
