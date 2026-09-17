// SCRAPING — SCHEDULED FOR REMOVAL AFTER MIGRATION
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

const server = fs.readFileSync("server.js", "utf8");
const jobQuery = fs.readFileSync("services/jobs/jobQuery.js", "utf8");
const profileTitleFilter = fs.readFileSync("services/profileTitleFilter.js", "utf8");
const domainProfiles = fs.readFileSync("routes/domainProfiles.js", "utf8");
const jobsPanel = fs.readFileSync("client/src/panels/JobsPanel.jsx", "utf8");

test("jobs and scrape endpoints expose controlled no-profile and no-resume states", () => {
  assert.match(server, /needsProfileSetup: true/);
  assert.match(server, /function getOrRepairActiveProfile\(userId\)/);
  assert.match(server, /UPDATE domain_profiles SET is_active=1/);
  assert.match(server, /function userHasBaseResume\(userId\)/);
  assert.match(server, /profileHasBaseResume\(db, \{ userId, profileId: activeProfile\.id \}\)/);
  assert.match(server, /needsBaseResume: true/);
  assert.match(server, /reason: "no_base_resume"/);
  // The user-facing copy lives in the CLIENT, not server.js — the server exposes the state
  // (needsBaseResume / reason: "no_base_resume", both asserted above) and JobsPanel renders the
  // message. This assertion was simply pointed at the wrong file; the gate itself is fully live.
  assert.match(jobsPanel, /Upload the active profile's base resume before searching jobs/);
});

test("the QUEUES narrow by target title; the BOARD ranks by it and excludes nothing", () => {
  // ⛔ THIS TEST CHANGED MEANING IN CC1, AND IT WAS NOT RELAXED TO DO SO.
  //
  // It used to assert that all three query paths apply profileTitleSql as a WHERE predicate, on the
  // invariant "wrong-profile jobs must not leak into any of them". Two of the three still do. The
  // BOARD no longer does, deliberately, and the old assertion is replaced by a stricter pair: the
  // board must apply NO title predicate AND must rank by the titles instead. Both halves are
  // asserted, because dropping the filter without adding the ranking would be the regression this
  // test now exists to catch — an unscoped board rather than a reordered one.
  //
  // Why: profileTitleSql requires EVERY token of a target title to appear in the posting title. The
  // user set `target_titles`; they did not set that rule. Measured on 2,460 active rows for the
  // owner's profile, it kept 405 rows and 8 of their own 30 graded postings — excluding 5 of the 12
  // they graded 5, all of them titled "...Engineer". See the note on DERIVED_RANK_ORDER.
  assert.match(server, /import \{ profileTitleSql, parseProfileArray \} from "\.\/services\/profileTitleFilter\.js"/);
  assert.match(profileTitleFilter, /export function profileTitleSql\(column, profile\)/,
    "the matcher still exists — the queues below use it");

  // 1. THE BOARD BINDS NO TITLE PREDICATE. `titleFilter` survives as a literal so the SQL template
  //    and its argument list keep their shape; what matters is that it can never be anything else.
  assert.match(server, /const titleFilter = \{ sql: "1 = 1", params: \[\] \};/,
    "the board must not splice a title predicate into its WHERE clause");
  // Comment lines are stripped first: the note above the change deliberately QUOTES the call it
  // replaced, and an assertion that cannot tell prose from code would be satisfied by deleting the
  // explanation. The invariant is about executable lines.
  const serverCode = server
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(serverCode, /profileTitleSql\("sj\.title", sessionActiveProfile\)/,
    "the board's own path must no longer call the hard matcher at all");

  // 2. AND IT RANKS INSTEAD. Without this the change is a widening, not a reordering.
  assert.match(server, /appliedDerivedKeys\.push\('target_title_exact', 'target_title_role'\)/,
    "the titles must reach buildJobFilters as DERIVED rank keys");
  assert.match(server, /filterParams\.target_titles = profileTargetTitles/);
  assert.match(server, /const profileTargetTitles = savedTab \? \[\] : parseProfileArray\(sessionActiveProfile\?\.target_titles\)/,
    "the Saved tab contributes no titles, so it is not reordered by them either");

  // 3. THE QUEUES STILL NARROW, and that is a separate decision recorded rather than assumed.
  //    /api/jobs/poll drives new-job notifications and /api/jobs/pending drives a work queue;
  //    widening either changes how much a user is interrupted, which is not CC1's question. They
  //    keep the hard matcher until someone decides otherwise on purpose.
  assert.match(server, /const pollProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
  assert.match(server, /const pendingProfileTitleFilter = profileTitleSql\("sj\.title", activeProfile\)/);
});

test("target_titles ranks in TWO keys, so specialisation demotes instead of disappearing", () => {
  // One broad key would have made "Backend Engineer" and "Software Engineer" indistinguishable to
  // a user who asked for the latter; one narrow key would have buried the five graded-5 postings at
  // the bottom instead of excluding them, which is barely better. Two keys order them: the user's
  // own phrasing, then the same role noun, then everything else.
  // Sliced to the declaration rather than matched against the whole file, so a failure prints the
  // array and not 30KB of module.
  const rankOrder = jobQuery.slice(
    at(jobQuery, "const DERIVED_RANK_ORDER = ["),
    at(jobQuery, "profileTitleSql's tokenisation"));
  assert.match(rankOrder, /'q', 'role_key', 'target_title_exact', 'target_title_role',/,
    "both title keys must be in DERIVED_RANK_ORDER, behind role_key (the declared role is " +
    "coarser than the words used for it) and ahead of level/skills/sponsorship");
  // ⛔ NEITHER KEY MAY EVER REACH THE WHERE CLAUSE. Every other dimension in buildJobFilters has an
  // `else` branch that pushes it to `clauses` when the value is explicit rather than derived. These
  // two do not, and that asymmetry IS the fix.
  // `at` rather than indexOf: a missing anchor returns -1, and slice reads -1 as an offset from
  // the END — so the region silently becomes far too wide and the assertions below keep passing
  // while they check most of the file instead of this block. See test/sourceAnchorGuard.test.js.
  const block = jobQuery.slice(
    at(jobQuery, "const targetTitles = toArray(params.target_titles)"),
    at(jobQuery, "const locations = toArray(params.locations)"));
  assert.ok(block.length > 200, "the target-title rank block must exist");
  assert.doesNotMatch(block, /clauses\.push/,
    "a target-title predicate in the WHERE clause is the defect CC1 removed");
  assert.match(block, /ranks\.target_title_exact/);
  assert.match(block, /ranks\.target_title_role/);
});

test("the Saved tab is exempt from discovery narrowing, and only the Saved tab is", () => {
  // The three narrowings the Saved tab drops — role_key join, profileTitleSql, profile bridge — and
  // the proof that each drop is conditional on savedTab rather than removed outright. A regression
  // here is invisible in behaviour until someone stars a job the classifier bucketed elsewhere.
  // ⛔ CC1b: the role join is a LEFT JOIN now, and the scope moved into a soft-null predicate.
  // This assertion is STRICTER than the INNER JOIN one it replaces, because a LEFT JOIN on its own
  // would drop the scope entirely and hand every profile every posting — the exact thing the brief
  // said not to do. So both halves are pinned: the join must be LEFT, and the WHERE must still
  // exclude an explicit mismatch.
  assert.match(server, /\$\{savedTab \? '' : 'LEFT JOIN job_role_map jrm ON jrm\.job_id = sj\.job_id AND jrm\.role_key = \?'\}/,
    "the role join must be a LEFT JOIN, keeping role_key in the ON clause so it cannot duplicate rows");
  assert.match(server, /jrm\.role_key IS NOT NULL\s*\n\s*OR NOT EXISTS \(SELECT 1 FROM job_role_map m WHERE m\.job_id = sj\.job_id\)/,
    "scope must survive as a soft-null predicate: in my bucket, OR never classified");
  assert.match(server, /if \(!savedTab\) appliedDerivedKeys\.push\('role_key'\)/,
    "and the rows the softened join admits must be RANKED, not merely let in");
  assert.match(server, /const derivedFilters = \(req\.query\.curate === 'off' \|\| savedTab\)/,
    "the profile bridge must not curate the user's own saved jobs");
  // The args list has to track the join, or every bound parameter after it shifts by one.
  assert.match(server, /\.\.\.\(savedTab \? \[\] : \[roleKey\]\)/,
    "no role_key placeholder on the Saved tab means no roleKey argument either");
});

test("domain profile API repairs zero-active profile state and marks empty profile setup incomplete", () => {
  assert.match(domainProfiles, /!rows\.some\(r => r\.is_active\)/);
  assert.match(domainProfiles, /UPDATE domain_profiles SET is_active=1/);
  assert.match(domainProfiles, /domain_profile_complete=\?/);
});

test("jobs UI does not keep a stale active profile id when there are no profiles", () => {
  assert.match(jobsPanel, /const activeProfileKey = activeDomainProfile\?\.id \|\| null/);
  assert.match(jobsPanel, /Create a job profile/);
  assert.match(jobsPanel, /Upload a profile resume/);
});
