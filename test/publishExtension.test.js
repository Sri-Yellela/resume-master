// The Chrome Web Store publisher.
//
// Publishing is irreversible: once a version is live it is on real users' machines and the only
// remedy is another review cycle. So what is tested here is not that it can upload — that needs
// credentials and a real store item — but that it REFUSES to, in every case where it should.
//
// The listing guard in particular exists because of a real near-miss: the v1.3.0 build was ready to
// be uploaded alongside a v1.2.0 listing that declared "personally identifiable information — not
// collected" about a build that fills a candidate's postal address into an employer's form.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  preflight, compareVersions, listingVersion, builtVersions,
} from "../scripts/publishExtension.mjs";

const src = fs.readFileSync("scripts/publishExtension.mjs", "utf8");

const file = (name, text) => ({ name, bytes: Buffer.from(text, "utf8") });
const base = () => {
  const files = [
    file("manifest.json", '{"version":"2.0.0"}'),
    file("background.js", "const URL_ = 'https://resumemaster.one';\n"),
  ];
  return {
    manifest: { version: "2.0.0", privacy_policy_url: "https://resumemaster.one/privacy" },
    sourceFiles: files,
    zipEntries: files.map(f => ({ name: f.name, bytes: f.bytes })),
    listingText: "# Chrome Web Store listing — Resume Master v2.0.0\n",
    priorVersions: ["1.1.0", "1.2.0"],
  };
};

test("a clean release passes preflight", () => {
  const r = preflight(base());
  assert.equal(r.ok, true, r.problems.join("; "));
});

// ── The listing guard ────────────────────────────────────────────────────────

test("A LISTING WRITTEN FOR THE PREVIOUS VERSION BLOCKS THE UPLOAD", () => {
  const r = preflight({ ...base(), listingText: "# Chrome Web Store listing — Resume Master v1.2.0\n" });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /written for v1\.2\.0 but this build is v2\.0\.0/);
  // The message has to say WHY it matters, or the next person just bumps the header.
  assert.match(r.problems.join(" "), /data disclosures/);
});

test("a missing listing header blocks it too", () => {
  const r = preflight({ ...base(), listingText: "# Some other document\n" });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /no recognisable version header/);
});

test("listingVersion reads the header and nothing else", () => {
  assert.equal(listingVersion("# Chrome Web Store listing — Resume Master v1.3.0\n"), "1.3.0");
  assert.equal(listingVersion("irrelevant v9.9.9"), null);
});

test("the repo's real listing matches the real manifest right now", () => {
  const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
  const listing = fs.readFileSync("extension/submission/STORE_LISTING.md", "utf8");
  assert.equal(listingVersion(listing), manifest.version,
    "bump the listing when you bump the manifest — the disclosures are part of the release");
});

// ── The artifact is the source ───────────────────────────────────────────────

test("a zip that drifted from source blocks the upload", () => {
  const b = base();
  b.zipEntries = b.zipEntries.map(e =>
    e.name === "background.js" ? { ...e, bytes: Buffer.from("tampered", "utf8") } : e);
  const r = preflight(b);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /background\.js in the zip differs/);
});

test("a zip missing a file the manifest reaches blocks the upload", () => {
  const b = base();
  b.zipEntries = b.zipEntries.filter(e => e.name !== "background.js");
  const r = preflight(b);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /manifest reaches background\.js but the zip omits it/);
});

test("a zip carrying a file the manifest does NOT reach blocks the upload", () => {
  // The saved-jobs-content.js case: a removed capability still shipping in the bundle.
  const b = base();
  b.zipEntries = [...b.zipEntries, { name: "saved-jobs-content.js", bytes: Buffer.from("x") }];
  const r = preflight(b);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /saved-jobs-content\.js, which the manifest does not reach/);
});

test("A FLIPPED DEV SWITCH BLOCKS THE UPLOAD", () => {
  // Shipping this points every real user at localhost.
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    const b = base();
    const bad = file("background.js", `const RESUME_MASTER_URL = '${url}';\n`);
    b.sourceFiles = [b.sourceFiles[0], bad];
    b.zipEntries = b.sourceFiles.map(f => ({ name: f.name, bytes: f.bytes }));
    const r = preflight(b);
    assert.equal(r.ok, false, url);
    assert.match(r.problems.join(" "), /ACTIVE localhost URL/);
  }
});

test("a commented-out dev switch is fine", () => {
  const b = base();
  const ok = file("background.js",
    "const RESUME_MASTER_URL = 'https://resumemaster.one';\n// const RESUME_MASTER_URL = 'http://localhost:3000';\n");
  b.sourceFiles = [b.sourceFiles[0], ok];
  b.zipEntries = b.sourceFiles.map(f => ({ name: f.name, bytes: f.bytes }));
  assert.equal(preflight(b).ok, true);
});

// ── Versions ─────────────────────────────────────────────────────────────────

test("a version that does not move forward blocks the upload", () => {
  const r = preflight({ ...base(), priorVersions: ["1.1.0", "2.0.0", "2.1.0"] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /not newer than already-built 2\.1\.0/);
});

test("compareVersions handles uneven segment counts", () => {
  assert.ok(compareVersions("1.3.0", "1.2.9") > 0);
  assert.ok(compareVersions("1.3", "1.3.0") === 0);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0, "numeric, not lexicographic");
  assert.ok(compareVersions("1.2.0", "1.3.0") < 0);
});

test("a malformed version blocks the upload", () => {
  const b = base();
  b.manifest = { ...b.manifest, version: "2.0.0-beta" };
  assert.match(preflight(b).problems.join(" "), /not a valid version string/);
});

test("builtVersions reads the real submission directory", () => {
  // What matters is that this reads the filesystem rather than a fixture. It used to prove that by
  // naming v1.3.0, which pinned the assertion to one artifact — so deleting that zip (E3 retired
  // every never-published build) failed a test about directory reading for a reason that had
  // nothing to do with directory reading. Assert against the version actually being shipped.
  const version = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8")).version;
  const versions = builtVersions();
  assert.ok(versions.includes(version),
    `no built zip for the manifest's v${version} — run npm run build:extension. Found: ${versions.join(", ") || "(none)"}`);
});

// ── The irreversible step is opt-in ──────────────────────────────────────────

test("PUBLISHING IS NOT THE DEFAULT — an unflagged run uploads a draft and stops", () => {
  assert.match(src, /const doPublish = has\('publish'\)/);
  assert.match(src, /if \(!doPublish\) \{[\s\S]{0,400}Draft uploaded and NOT published/,
    "without --publish it must stop after the draft");
  // The publish call must be unreachable unless the flag was passed.
  const publishCall = src.indexOf("await publish(token, itemId");
  const guard = src.indexOf("if (!doPublish)");
  assert.ok(guard > 0 && guard < publishCall, "the guard must precede the publish call");
});

test("nothing is sent when preflight fails", () => {
  // The refusal has to come before the token exchange, or a bad release has already touched the API.
  const preflightFail = src.indexOf("PREFLIGHT FAILED");
  const auth = src.indexOf("await accessToken(creds)");
  assert.ok(preflightFail > 0 && preflightFail < auth,
    "preflight must be able to refuse before any credential is used");
});

test("credentials are never printed", () => {
  // A publish script that logs its own refresh token into CI output is a credential leak.
  for (const name of ["CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_CLIENT_ID"]) {
    const logged = new RegExp(`console\\.(log|error|warn)\\([^)]*${name}[^)]*\\$\\{`, "g");
    assert.doesNotMatch(src, logged, `${name} must never be interpolated into output`);
  }
  assert.doesNotMatch(src, /console\.\w+\([^)]*creds[^)]*\)/, "the credential object must not be logged");
  assert.doesNotMatch(src, /console\.\w+\([^)]*\btoken\b[^)]*\$\{/, "the access token must not be logged");
});

test("every refusal returns a code rather than tearing the process down", () => {
  // process.exit() while undici still has a socket closing raises a libuv assertion on Windows,
  // which reads as a crash in CI even on a clean refusal.
  assert.doesNotMatch(src, /process\.exit\(/, "use `return <code>`; the entry point sets exitCode");
  assert.match(src, /process\.exitCode = code \?\? 0/);
});

test("a staged rollout is available, because a bad release is easier to stop at 10%", () => {
  assert.match(src, /deployPercentage/);
  assert.match(src, /trustedTesters/);
});
