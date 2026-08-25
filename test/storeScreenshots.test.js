// AI2 — the Chrome Web Store listing screenshots, and the guarantees around producing them.
//
// The images themselves are produced by a real browser run (`npm run store:screenshots`), which
// cannot happen here. What CAN be checked without a browser is everything that decides whether
// that run is trustworthy: the PNG encoder that strips the alpha channel the dashboard rejects,
// the fixture's presentation variant, and the harness's refusal to write a file it has not proved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import zlib from "node:zlib";
import {
  readPngHeader, decodeToRgb, encodeRgbPng, toStorePng, compositeRgb,
} from "../services/pngTruecolor.js";

const SHOT_DIR = "docs/store-screenshots";
const SHOTS = ["1-review-overlay", "2-popup", "3-options"];

// ── The PNG encoder ─────────────────────────────────────────────────────────────────────────────

const solid = (w, h, [r, g, b]) => {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < rgb.length; i += 3) { rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; }
  return { width: w, height: h, rgb };
};

test("what it writes is colour type 2 — 24-bit truecolour with NO alpha", () => {
  const h = readPngHeader(encodeRgbPng(solid(9, 4, [12, 200, 90])));
  assert.equal(h.colorType, 2, "colour type 6 is RGBA, which the store dashboard rejects");
  assert.equal(h.hasAlpha, false);
  assert.equal(h.bitDepth, 8);
  assert.equal(h.bitsPerPixel, 24);
  assert.equal(h.interlace, 0);
  assert.deepEqual([h.width, h.height], [9, 4]);
});

test("encode -> decode is lossless, so the flattening cannot quietly change the picture", () => {
  const w = 37, h = 23;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 97 + (i >> 5)) % 256;
  const back = decodeToRgb(encodeRgbPng({ width: w, height: h, rgb }));
  assert.equal(back.rgb.equals(rgb), true);
  assert.equal(back.nonOpaque, 0);
});

test("it is deterministic — the same pixels produce the same bytes", () => {
  const a = encodeRgbPng(solid(16, 16, [3, 4, 5]));
  const b = encodeRgbPng(solid(16, 16, [3, 4, 5]));
  assert.equal(a.equals(b), true, "a re-run must overwrite cleanly, not produce a churning diff");
});

test("an RGBA source is FLATTENED over white, and the caller is told how many pixels needed it", () => {
  // Hand-built colour-type-6 PNG: one opaque red pixel, one half-transparent red pixel.
  const raw = Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 128]); // filter 0, then two RGBA pixels
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const crcOf = (b) => { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const rgba = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);

  assert.equal(readPngHeader(rgba).hasAlpha, true, "the fixture must actually carry alpha");
  const out = toStorePng(rgba);
  assert.equal(readPngHeader(out.png).hasAlpha, false);
  assert.equal(out.nonOpaque, 1, "the half-transparent pixel must be counted, not silently dropped");

  const px = decodeToRgb(out.png).rgb;
  assert.deepEqual([...px.subarray(0, 3)], [255, 0, 0], "the opaque pixel is untouched");
  // The SECOND pixel is the half-transparent one — 128/255 red over white lands near (255,127,127).
  // The point is that it was composited: had the alpha simply been dropped it would still read
  // (255,0,0) and be indistinguishable from the opaque pixel beside it.
  const [r2, g2, b2] = px.subarray(3, 6);
  assert.equal(r2, 255);
  assert.ok(g2 > 100 && b2 > 100, `composited over white, got (${r2},${g2},${b2})`);
});

test("a malformed input is refused rather than half-read", () => {
  assert.throws(() => readPngHeader(Buffer.from("not a png")), /not a PNG/);
  assert.throws(() => decodeToRgb(Buffer.alloc(0)), /not a PNG/);
});

test("compositing keeps the base's dimensions and actually paints the overlay", () => {
  const base = solid(40, 30, [255, 255, 255]);
  const over = solid(10, 8, [0, 0, 0]);
  const merged = compositeRgb(base, over, 12, 9, { shadow: 2 });
  assert.deepEqual([merged.width, merged.height], [40, 30], "the canvas must stay 1280x800-shaped");
  const at = (x, y) => [...merged.rgb.subarray((y * 40 + x) * 3, (y * 40 + x) * 3 + 3)];
  assert.deepEqual(at(16, 12), [0, 0, 0], "a pixel inside the overlay is the overlay's");
  assert.deepEqual(at(0, 0), [255, 255, 255], "a pixel far from it is untouched");
  assert.notDeepEqual(at(12, 8), [255, 255, 255], "the border marks the overlay's edge");
});

test("an overlay hanging off the edge is clipped, not written out of bounds", () => {
  const base = solid(20, 20, [255, 255, 255]);
  const merged = compositeRgb(base, solid(15, 15, [0, 0, 0]), 14, 14, { shadow: 3 });
  assert.equal(merged.rgb.length, 20 * 20 * 3);
});

// ── The fixture's presentation variant ──────────────────────────────────────────────────────────

test("?presentation=1 removes the trap CAPTIONS and keeps the traps THEMSELVES", () => {
  // Store policy: a screenshot must depict actual functionality. The traps are the functionality —
  // they are why the review overlay has anything to show — so they stay. Only the didactic labels
  // a reviewer would read as a test rig are removed.
  const ats = fs.readFileSync("scripts/fakeAts.js", "utf8");
  const form = ats.slice(ats.indexOf("function gatedForm("), ats.indexOf("// ── G0: multi-step"));

  assert.match(form, /const legend = \(teaching, neutral\) => presentation \? neutral : teaching;/);
  // The traps are outside the conditional — the field names are unconditional text.
  assert.match(form, /name="authorized_no_sponsorship"/);
  assert.match(form, /name="job_application\[requires_sponsorship\]"/);
  assert.match(form, /name="work_authorization"/);
  assert.match(form, /name="org"/);
  // And each trap caption is on the teaching side of a legend() call.
  assert.match(form, /legend\('TRAP: label-only match', 'Employment'\)/);
  assert.match(form, /legend\('TRAP: sponsorship_inversion', 'Voluntary Disclosures'\)/);
  // The route passes the flag through.
  assert.match(ats, /gatedForm\(\{ presentation: url\.searchParams\.get\('presentation'\) === '1' \}\)/);
});

test("the posting behind the popup drops the harness caption AND the real employer's brand", () => {
  const ats = fs.readFileSync("scripts/fakeAts.js", "utf8");
  const form = ats.slice(ats.indexOf("function ashbySpaForm("), ats.indexOf("function ashbySpaThanks("));
  assert.match(form, /presentation \? 'Senior Backend Engineer — Northwind Systems'/);
  assert.match(form, /Northwind Systems &middot; Remote/);
  // The transcribed shape keeps the real posting's field names — that is the point of it.
  assert.match(form, /_systemfield_name|_systemfield_email/,
    "the measured field names must survive the presentation flag");
  assert.match(ats, /presentation: url\.searchParams\.get\('presentation'\) === '1',/);
});

// ── The harness's guarantees ────────────────────────────────────────────────────────────────────

const harness = fs.readFileSync("scripts/g3ReviewOverlay.mjs", "utf8");

test("nothing is written until the image has been proved 1280x800, 24-bit and alpha-free", () => {
  const write = harness.slice(harness.indexOf("function writeShot("), harness.indexOf("const ATS_PORT"));
  const validateAt = write.indexOf("readPngHeader(png)");
  const writeAt = write.indexOf("fs.writeFileSync(file, png)");
  assert.ok(validateAt > 0 && writeAt > 0, "writeShot must both validate and write");
  assert.ok(validateAt < writeAt, "a file must never reach disk ahead of its own validation");
  assert.match(write, /the store needs \$\{SHOT_SIZE\.width\}x\$\{SHOT_SIZE\.height\}/);
  assert.match(write, /h\.hasAlpha \|\| h\.colorType !== 2/);
  assert.match(write, /h\.bitDepth !== 8 \|\| h\.bitsPerPixel !== 24/);
  // Re-read from disk: everything above validated a buffer, not the artefact that gets uploaded.
  assert.match(write, /const onDisk = readPngHeader\(fs\.readFileSync\(file\)\)/);
  // It throws. A check() would count a failure and let the run write the other two.
  assert.doesNotMatch(write, /check\(/, "a wrong-sized image must kill the run, not be tallied");
});

test("both capture paths go through the same gate", () => {
  // The composited popup shot is built differently and must not be written differently.
  assert.equal((harness.match(/fs\.writeFileSync\(file, png\)/g) || []).length, 1,
    "one write path only — a second is how one of the three ends up unvalidated");
  assert.match(harness, /writeShot\('2-popup',/);
});

test("the run is clean-slate, so a stale file cannot stand in for one that failed", () => {
  assert.match(harness, /fs\.rmSync\(SHOT_DIR, \{ recursive: true, force: true \}\)/);
  assert.match(harness, /onDisk\.join\(','\) === '1-review-overlay\.png,2-popup\.png,3-options\.png'/);
});

test("captures are checked against the developer's REAL profile values", () => {
  assert.match(harness, /SELECT full_name, first_name, last_name, email, phone, location FROM user_profile/);
  assert.match(harness, /REAL personal data is visible in the capture/);
  // And it says so when it has nothing to look for, rather than passing vacuously.
  assert.match(harness, /the "no real personal data" check has no values to look for/);
});

test("trap captions and a real employer's brand are both forbidden in a capture", () => {
  const list = harness.slice(harness.indexOf("const FORBIDDEN_IN_SHOTS"), harness.indexOf("let REAL_VALUES"));
  for (const needle of ["TRAP:", "sponsorship_inversion", "rendered by JavaScript", "OpenAI"]) {
    assert.ok(list.includes(needle), `${needle} must be refused in a store screenshot`);
  }
});

test("the capture points at localhost only — the A5 gate stands", () => {
  assert.match(harness, /const PORTAL = `http:\/\/localhost:\$\{ATS_PORT\}`;/);
  assert.doesNotMatch(harness, /https:\/\/(?!resumemaster\.one)[a-z]/i,
    "a screenshot run must never be pointed at a real employer");
  // The assertions run on the SAME page that is photographed, which is what makes it evidence.
  assert.match(harness, /const FORM_URL = `\$\{PORTAL\}\/gated\/form\$\{SHOTS \? '\?presentation=1' : ''\}`;/);
});

test("a fakeAts predating the presentation flag kills the run before a browser opens", () => {
  assert.match(harness, /still serves trap captions at \?presentation=1/);
  assert.match(harness, /the presentation form is missing the traps/);
});

test("one npm script produces them", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["store:screenshots"], "node scripts/g3ReviewOverlay.mjs --screenshots");
});

test("the harness stays out of verify:harness, with a stated reason", () => {
  // It is IN the suite without --screenshots (g3 is a real harness). What must not happen is the
  // suite driving the screenshot path, which needs a foreground window and a hotkey.
  const runner = fs.readFileSync("scripts/verifyHarnesses.mjs", "utf8");
  assert.doesNotMatch(runner, /--screenshots/);
  assert.doesNotMatch(runner, /g3ReviewOverlay:/, "g3 itself must keep running in the suite");
});

// ── The committed images ────────────────────────────────────────────────────────────────────────

test("the three committed screenshots are 1280x800, 24-bit, and carry no alpha", () => {
  const present = fs.existsSync(SHOT_DIR) ? fs.readdirSync(SHOT_DIR).filter(f => f.endsWith(".png")).sort() : [];
  assert.deepEqual(present, SHOTS.map(s => `${s}.png`),
    "exactly the three, nothing missing and nothing stale");
  for (const name of SHOTS) {
    const h = readPngHeader(fs.readFileSync(`${SHOT_DIR}/${name}.png`));
    assert.deepEqual([h.width, h.height], [1280, 800], `${name} is ${h.width}x${h.height}`);
    assert.equal(h.hasAlpha, false, `${name} carries an alpha channel`);
    assert.equal(h.colorType, 2, `${name} is colour type ${h.colorType}`);
    assert.equal(h.bitsPerPixel, 24, `${name} is ${h.bitsPerPixel}-bit`);
  }
});
