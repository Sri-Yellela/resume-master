import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  KNOWN_DOMAINS, companyToDomain, getKnownLogoUrl, logoUrlForDomain, isKnownLogoUrlHost, LOGO_HOST,
} from "../shared/companyLogos.js";
import {
  backfillCompanyLogos, isRetiredLogoUrl, RETIRED_LOGO_HOSTS,
} from "../services/jobs/backfillCompanyLogos.js";

// TASK X — Clearbit retired logo.clearbit.com and the code kept calling it. Everything here is
// OFFLINE: whether a third party is up today is a question for a liveness probe, not for the unit
// suite. What these pin is that the app has ONE logo host, that a retired one cannot survive in a
// stored row, and that a near-miss company name gets a letter rather than someone else's logo.

function boardDb(rows) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, company TEXT, company_icon_url TEXT)");
  const ins = db.prepare("INSERT INTO scraped_jobs (job_id, company, company_icon_url) VALUES (?,?,?)");
  rows.forEach((r, i) => ins.run("j" + i, r.company, r.url));
  return db;
}
const iconOf = (db, id) => db.prepare("SELECT company_icon_url u FROM scraped_jobs WHERE job_id=?").get(id).u;

// ── One host ─────────────────────────────────────────────────────────────────

test("every logo URL the app produces comes from the one shared host", () => {
  // Clearbit's hostname was written out longhand in THREE places — shared/companyLogos.js,
  // services/jobs/enrichLogos.js and server.js's fetchCompanyIcon — so retiring it was a hunt
  // rather than an edit. getKnownLogoUrl and logoUrlForDomain must agree, by construction.
  assert.equal(getKnownLogoUrl("Stripe"), logoUrlForDomain("stripe.com"));
  assert.ok(getKnownLogoUrl("Stripe").startsWith(LOGO_HOST + "/"));
  assert.ok(isKnownLogoUrlHost(getKnownLogoUrl("Figma")));
});

test("the retired hosts are not the current one, and are recognised as retired", () => {
  assert.ok(RETIRED_LOGO_HOSTS.length > 0);
  for (const h of RETIRED_LOGO_HOSTS) {
    assert.ok(!h.startsWith(LOGO_HOST), `${h} is listed as retired but is also the current host`);
  }
  assert.ok(isRetiredLogoUrl("https://logo.clearbit.com/stripe.com"));
  assert.ok(isRetiredLogoUrl("https://www.google.com/s2/favicons?domain=stripe.com&sz=64"));
  assert.ok(!isRetiredLogoUrl(getKnownLogoUrl("Stripe")));
  assert.ok(!isRetiredLogoUrl(null));
});

// ── A wrong logo is worse than a letter ──────────────────────────────────────

test("a known brand buried inside a longer word is NOT that brand", () => {
  // `lower.includes(key)` shipped these, and every one renders a real company's logo on a
  // different company's card. The lettered tile is the correct answer: it admits it does not know.
  const falseMatches = {
    "Physical Superintelligence": "intel.com",     // real row on the board
    "Squarespace":                "squareup.com",
    "Altogether Labs":            "together.ai",
    "Neonatal Care Group":        "neon.tech",
    "Metabolic Health Co":        "meta.com",
    "Applecart":                  "apple.com",
  };
  for (const [name, wrong] of Object.entries(falseMatches)) {
    assert.notEqual(companyToDomain(name), wrong, `${name} must not resolve to ${wrong}`);
    assert.equal(getKnownLogoUrl(name), null, `${name} must get the lettered tile, not a logo`);
  }
});

test("word-boundary matching kept every entry in the table working", () => {
  // The counterweight to the test above: tightening a matcher is only correct if nothing genuine
  // stopped matching. Includes the keys with punctuation and spaces, which a naive \b or a split
  // on whitespace would break.
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    assert.equal(companyToDomain(key), domain, `KNOWN_DOMAINS key '${key}' no longer resolves to itself`);
  }
  for (const [name, domain] of Object.entries({
    "Stripe, Inc.": "stripe.com", "Scale AI": "scale.com", "Hugging Face": "huggingface.co",
    "Fly.io": "fly.io", "C3.ai": "c3.ai", "PlanetScale": "planetscale.com",
  })) {
    assert.equal(companyToDomain(name), domain);
  }
});

test("an unknown company still slugs a domain but never gets a logo URL", () => {
  // companyToDomain's slug fallback feeds the enrichment path, which verifies. Handing the same
  // guess to an <img> is the broken-image-per-card failure the module was built to avoid.
  assert.equal(companyToDomain("Brightmoor Analytics Group"), "brightmooranalytics.com");
  assert.equal(getKnownLogoUrl("Brightmoor Analytics Group"), null);
});

// ── The backfill ─────────────────────────────────────────────────────────────

test("rows on a retired host are repointed at the current one", () => {
  const db = boardDb([
    { company: "Stripe", url: "https://logo.clearbit.com/stripe.com" },
    { company: "Figma",  url: "https://www.google.com/s2/favicons?domain=figma.com&sz=64" },
  ]);
  const r = backfillCompanyLogos(db);
  assert.equal(r.updated, 2);
  assert.equal(iconOf(db, "j0"), getKnownLogoUrl("Stripe"));
  assert.equal(iconOf(db, "j1"), getKnownLogoUrl("Figma"));
});

test("a feed's own logo is never touched, in either mode", () => {
  // LinkedIn's and serpapi's rows carry a CDN logo from the feed that found the job. It is more
  // specific than anything the domain table can derive, and overwriting it would be a downgrade
  // dressed up as a repair.
  const feed = "https://media.licdn.com/dms/image/C4E0BAQ/company-logo_200_200.png";
  const db = boardDb([{ company: "Stripe", url: feed }]);
  assert.equal(backfillCompanyLogos(db).kept, 1);
  assert.equal(iconOf(db, "j0"), feed);
  backfillCompanyLogos(db, { all: true });
  assert.equal(iconOf(db, "j0"), feed, "--all must not reach feed-supplied URLs either");
});

test("a retired URL for a company the table cannot place is CLEARED, not re-guessed", () => {
  // This is the real board row: 'Physical Superintelligence' had a clearbit URL for intel.com.
  // Trading a dead address for a confidently wrong one would be the worse outcome.
  const db = boardDb([{ company: "Physical Superintelligence", url: "https://logo.clearbit.com/intel.com" }]);
  const r = backfillCompanyLogos(db);
  assert.equal(r.cleared, 1);
  assert.equal(iconOf(db, "j0"), null);
});

test("the backfill is idempotent and is a no-op on an already-repaired board", () => {
  const db = boardDb([{ company: "Stripe", url: "https://logo.clearbit.com/stripe.com" }]);
  backfillCompanyLogos(db);
  const after = iconOf(db, "j0");
  const second = backfillCompanyLogos(db);
  assert.equal(second.updated, 0);
  assert.equal(second.cleared, 0);
  assert.equal(iconOf(db, "j0"), after);
});

test("default mode leaves current-host rows alone; --all re-resolves them", () => {
  // A row already on the current host but resolved from a STALE table entry is only worth
  // rewriting when someone asks — that is what --all is for. Boot must stay a cheap no-op.
  const db = boardDb([{ company: "Stripe", url: LOGO_HOST + "/wrongdomain.com.ico" }]);
  assert.equal(backfillCompanyLogos(db).updated, 0);
  assert.equal(iconOf(db, "j0"), LOGO_HOST + "/wrongdomain.com.ico");
  assert.equal(backfillCompanyLogos(db, { all: true }).updated, 1);
  assert.equal(iconOf(db, "j0"), getKnownLogoUrl("Stripe"));
});

test("the backfill makes no network call", async () => {
  // It runs at boot. A boot path that waits on a third party hangs when that third party is
  // precisely what broke — which is the whole situation this task exists for.
  const src = (await import("node:fs")).readFileSync("services/jobs/backfillCompanyLogos.js", "utf8");
  assert.ok(!/axios|fetch\(|http\.request/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
});
