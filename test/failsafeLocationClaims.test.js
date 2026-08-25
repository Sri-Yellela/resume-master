import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  validateResumeClaims, extractTeamClaim, looksLikeLocation, resetLocationVocabulary,
  NAME_CLOSEST_MIN_SIMILARITY, similarity,
} from "../services/kb/failsafe.js";
import { normalizeOrgUnitKey } from "../services/kb/orgLayer.js";

/**
 * TASK AH4 — a city is not a team.
 *
 * OBSERVED
 *   FLAG: 'Bangalore' doesn't match any team we've seen in Stripe's job postings
 *         (closest: 'Solutions Architecture')
 *
 * on "Stripe | Payments Infrastructure, Bangalore". Bangalore is the LOCATION, the candidate did
 * work there, and this is the costly error the KB rules name explicitly: a false "this doesn't
 * match" against a claim that is TRUE.
 *
 * TWO DEFECTS, not one.
 *   1  extractTeamClaim took the LAST comma-separated segment, and in "Title, Team, Location" and
 *      "Title, Location" that is always the place. The real team was never checked either — the
 *      location shadowed it.
 *   2  the flag named `best.org_unit` at ANY score. Measured against Stripe's real KB, "Bangalore",
 *      "San Francisco", "Remote" and "Quantum Basket Weaving" every one scored EXACTLY 0.000, and
 *      all four named the same unit — whichever happened to be iterated first among a field of
 *      zeroes. The threshold was not too low; there was no similarity at all.
 */

// A KB with a company whose units include one legitimately NAMED after a place, so the fix cannot
// pass by deleting anything that looks like a city.
function kb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE company_org_units (company TEXT, org_unit TEXT, confidence REAL, status TEXT);
    CREATE TABLE company_technographics (company TEXT, skill TEXT);
    CREATE TABLE scraped_jobs (job_id TEXT PRIMARY KEY, location TEXT, workplace_type TEXT);
  `);
  const unit = db.prepare("INSERT INTO company_org_units VALUES (?,?,?,?)");
  for (const u of ["Payments", "Solutions Architecture", "Growth Marketing", "Bangalore Finance"]) {
    unit.run("Stripe", u, 0.9, "confirmed");
  }
  const job = db.prepare("INSERT INTO scraped_jobs VALUES (?,?,?)");
  // The real shapes scraped_jobs.location holds, separators and all.
  const locations = ["Bangalore", "Bengaluru, India", "San Francisco, CA", "Dublin", "Singapore",
    "US - Remote", "CA • New York", "London, England"];
  locations.forEach((loc, i) => job.run(`j${i}`, loc, i % 2 ? "remote" : "onsite"));
  return db;
}

const entry = (role) => `EXPERIENCE\n\nStripe | Jan 2021 - Present\n${role}\n- Built payment rails.\n`;
const findingsFor = (db, role) => validateResumeClaims(db, entry(role));

test.beforeEach(() => resetLocationVocabulary());

// ── 1. the reported false flag ───────────────────────────────────────────────────────────────

test("the reported resume produces NO Bangalore flag", () => {
  const db = kb();
  const findings = findingsFor(db, "Software Engineer, Payments Infrastructure, Bangalore");
  assert.ok(!findings.some(f => /Bangalore/.test(f.message)),
    `a location was reported as a team: ${findings.map(f => f.message).join(" ;; ")}`);
  db.close();
});

test("a role that names ONLY a location makes no team claim at all", () => {
  const db = kb();
  // This is the sharper version of the same defect: with nothing but a title and a place there is
  // no team being claimed, so there is nothing to check and the correct output is silence.
  for (const role of ["Software Engineer, Bangalore", "Software Engineer, San Francisco",
    "Software Engineer, Remote", "Software Engineer, US - Remote", "Software Engineer, Dublin"]) {
    assert.deepEqual(findingsFor(db, role), [], role);
  }
  db.close();
});

test("the REAL team behind the location is what gets checked", () => {
  // Before the fix the location shadowed it, so the team was never examined at all — the check
  // was not merely wrong, it was aimed at the wrong half of the line.
  const db = kb();
  assert.equal(
    extractTeamClaim({ role: "Software Engineer, Payments Infrastructure, Bangalore" }, db),
    "Payments Infrastructure");
  db.close();
});

test("a unit legitimately NAMED after a place still reads as a team", () => {
  // "Bangalore Finance" is a real Stripe org unit. A fix that deleted anything containing a city
  // would erase it, and the failsafe would go quiet on a whole class of real claims.
  const db = kb();
  assert.equal(extractTeamClaim({ role: "Analyst, Bangalore Finance" }, db), "Bangalore Finance");
  assert.deepEqual(findingsFor(db, "Analyst, Bangalore Finance"), [],
    "an exact KB match must corroborate, not flag");
  db.close();
});

test("only TRAILING location segments are dropped", () => {
  const db = kb();
  // "Title, Location, Team" is not a shape anyone writes, but if it appears the team is still last
  // and must survive.
  assert.equal(extractTeamClaim({ role: "Engineer, Bangalore, Payments" }, db), "Payments");
  db.close();
});

// ── 2. the location vocabulary comes from the data ───────────────────────────────────────────

test("the vocabulary is READ from scraped_jobs.location, not hand-listed", () => {
  const db = kb();
  for (const place of ["Bangalore", "Bengaluru", "India", "San Francisco", "Dublin", "Singapore", "London"]) {
    assert.ok(looksLikeLocation(db, place), `${place} should be recognised from the corpus`);
  }
  const src = fs.readFileSync("services/kb/failsafe.js", "utf8");
  assert.match(src, /SELECT DISTINCT location FROM scraped_jobs/);
  // A hand-written city list would be a second source of truth that goes stale the first time the
  // board learns a new market.
  assert.doesNotMatch(src, /const\s+(CITIES|CITY_NAMES|KNOWN_CITIES)\s*=/);
  db.close();
});

test("workplace types and region shapes cover the tail the corpus cannot", () => {
  const db = kb();
  for (const s of ["Remote", "Hybrid", "Onsite", "US - Remote", "EMEA", "APAC", "CA", "NY", "UK"]) {
    assert.ok(looksLikeLocation(db, s), s);
  }
  // And the shapes must not swallow real teams.
  for (const s of ["Payments", "Payments Infrastructure", "Growth Marketing", "Bangalore Finance",
    "Solutions Architecture", "Applied ML"]) {
    assert.ok(!looksLikeLocation(db, s), `${s} is a team, not a place`);
  }
  db.close();
});

test("a conjunction of places is still a place, and a team conjunction is not", () => {
  // 16 of the 145 distinct location strings in the real corpus are alternatives: "London OR
  // Dublin", "Chicago and NYC", "San Francisco or Seattle". The vocabulary holds the parts and
  // never the phrase, so after the first pass of this fix all 16 were STILL being flagged as
  // teams. A dangling conjunction ("or Chicago", which is what a split leaves behind) is a
  // fragment of the same thing.
  const db = kb();
  for (const s of ["London or Dublin", "London OR Dublin", "Bangalore and Dublin",
    "or Bangalore", "Dublin or Remote", "San Francisco or Bangalore"]) {
    assert.ok(looksLikeLocation(db, s), s);
  }
  // EVERY part has to be a place, or this would swallow a real claim.
  for (const s of ["Payments or Growth Marketing", "Payments and Bangalore Finance",
    "Bangalore or Payments"]) {
    assert.ok(!looksLikeLocation(db, s), `${s} names a team and must not read as a place`);
  }
  db.close();
});

test("a single-word team is not mistaken for a place", () => {
  // The conjunction rule reduces to the ordinary case for one part, so a short team name runs
  // through the same code and must come out the other side.
  const db = kb();
  for (const s of ["Payments", "Bridge", "Link", "Terminal", "Privy", "Accelerate"]) {
    assert.ok(!looksLikeLocation(db, s), s);
  }
  db.close();
});

test("a database with no locations degrades to the shapes, and never throws", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE company_org_units (company TEXT, org_unit TEXT, confidence REAL, status TEXT);
           CREATE TABLE company_technographics (company TEXT, skill TEXT);`);
  assert.doesNotThrow(() => looksLikeLocation(db, "Bangalore"));
  assert.equal(looksLikeLocation(db, "Bangalore"), false, "with no corpus there is nothing to know");
  assert.equal(looksLikeLocation(db, "Remote"), true, "the shapes still apply");
  db.close();
});

// ── 3. a near-match must be plausible before it is offered ───────────────────────────────────

test("a flag with no similar unit names nothing", () => {
  const db = kb();
  const [finding] = findingsFor(db, "Software Engineer, Quantum Basket Weaving");
  assert.equal(finding.type, "flag");
  assert.match(finding.message, /doesn't match any team we've seen in Stripe's job postings\.$/);
  assert.doesNotMatch(finding.message, /closest/,
    "naming a nearest neighbour at similarity 0 is a suggestion no human would make");
  db.close();
});

test("the nonsense pairing really did score zero — the floor is not arbitrary", () => {
  // The justification for the floor, asserted rather than described. If a future similarity change
  // makes these score above the floor, the floor needs revisiting and this says so.
  for (const claim of ["bangalore", "san francisco", "remote", "quantum basket weaving"]) {
    for (const unit of ["Solutions Architecture", "Payments", "Growth Marketing"]) {
      const s = similarity(claim, normalizeOrgUnitKey(unit));
      assert.ok(s < NAME_CLOSEST_MIN_SIMILARITY,
        `"${claim}" vs "${unit}" scored ${s}, at or above the floor ${NAME_CLOSEST_MIN_SIMILARITY}`);
    }
  }
});

test("a genuinely close unit is STILL named", () => {
  // The counterweight. A floor that silenced real near-misses would trade one useless finding for
  // another.
  const db = kb();
  const [finding] = findingsFor(db, "Head of, Growth Marketng Team");
  assert.ok(finding, "a garbled real unit must still produce a finding");
  assert.match(finding.message, /Growth Marketing/);
  db.close();
});

test("a genuinely wrong team name still flags", () => {
  const db = kb();
  const [finding] = findingsFor(db, "Software Engineer, Quantum Basket Weaving");
  assert.equal(finding.type, "flag");
  assert.equal(finding.severity, "review");
  assert.equal(finding.company, "Stripe");
  db.close();
});

// ── 4. the wiring, so the fix cannot be bypassed ─────────────────────────────────────────────

test("validateResumeClaims passes the db through — without it the old behaviour returns", () => {
  // extractTeamClaim keeps a db-less signature for its existing callers, which means a caller that
  // forgets the argument silently gets the pre-AH4 behaviour back. There is exactly one internal
  // caller and this pins it.
  const src = fs.readFileSync("services/kb/failsafe.js", "utf8");
  assert.match(src, /const teamClaim = extractTeamClaim\(entry, db\);/);
  // And the recruiter surface (FE-6) reuses validateResumeClaims rather than re-extracting, so it
  // inherits the fix instead of needing its own.
  assert.match(src, /function checkCandidateConsistency[\s\S]{0,400}?validateResumeClaims\(db, resumeText\)/);
});
