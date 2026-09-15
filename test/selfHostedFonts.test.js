import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ── WEB FONTS ARE A DISCLOSED DATA FLOW, NOT A BUILD PREFERENCE ──────────────────────────────────
//
// Until 2026-09-15 four families were fetched from fonts.googleapis.com on every page load, from
// TWO call sites that had to be found separately:
//
//   client/index.html   <link> + two preconnects   Barlow Condensed, DM Sans
//   client/src/index.css  @import url(...)         Instrument Serif, Inter
//
// The second one is why this test exists rather than a one-line grep in a review checklist: a sweep
// of index.html found two families and looked complete, and the CSS @import kept Google receiving
// every visitor's IP and user-agent anyway. That is the same failure shape as the Google S2 favicon
// fallback task X removed — a third party seeing browsing that the privacy policy did not name.
//
// The policy now states that fonts are served from our own origin and that Google receives nothing.
// That sentence is only true while these assertions hold, so this is a guard on a legal statement.

const FORBIDDEN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/** Comments EXPLAIN the retirement by naming the host, so a live-reference check must ignore them. */
const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, " ")        // html
  .replace(/\/\*[\s\S]*?\*\//g, " ")       // css + js block
  .replace(/^\s*\/\/[^\n]*$/gm, " ");      // js line

const SOURCES = [
  "client/index.html",
  "client/src/index.css",
  "client/src/main.jsx",
];

// ⛔ THE PRIVACY PAGE IS THE ONE FILE ALLOWED TO NAME THESE HOSTS, because naming a retired
// recipient is the disclosure — the policy says in as many words that nothing is requested from
// fonts.googleapis.com or fonts.gstatic.com. Same carve-out sourceAnchorGuard makes for itself and
// privacyReconciliation makes by stripping comments: a check that fails on its own rationale is a
// check somebody deletes. What that page must not do is LOAD a font, and it declares no <link>,
// no @import and no url() — the sweep below still covers every other file under client/.
const PROSE_EXEMPT = new Set(["client/src/pages/marketing/PrivacyPage.jsx"]);

test("NO CLIENT SOURCE FETCHES A FONT FROM GOOGLE", () => {
  for (const file of SOURCES) {
    const live = stripComments(fs.readFileSync(file, "utf8"));
    for (const host of FORBIDDEN_HOSTS) {
      assert.ok(!live.includes(host),
        `${file} references ${host} outside a comment. Every visitor's browser would request a ` +
        `font from Google on every page, handing them an IP and user-agent — and the privacy ` +
        `policy now states in as many words that we send Google nothing. Self-host it via ` +
        `@fontsource instead of re-adding the link.`);
    }
  }
});

test("the whole client tree is swept, not just the two known call sites", () => {
  // index.html was swept once and looked clean while index.css was still importing from Google.
  // So the check cannot be a list of the files that were wrong last time.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|css|jsx?|tsx?)$/.test(e.name)) continue;
      if (PROSE_EXEMPT.has(p)) {
        // The exemption is for PROSE. It still must not load anything.
        const src = fs.readFileSync(p, "utf8");
        for (const host of FORBIDDEN_HOSTS) {
          const loads = new RegExp(`(?:url\\(|href=|src=|@import)[^\\n]{0,40}${host.replace(/\./g, "\\.")}`);
          if (loads.test(src)) offenders.push(`${p} (LOADS a font, not just names it)`);
        }
        continue;
      }
      const live = stripComments(fs.readFileSync(p, "utf8"));
      if (FORBIDDEN_HOSTS.some(h => live.includes(h))) offenders.push(p);
    }
  };
  walk("client");
  assert.deepEqual(offenders, [],
    `these fetch a font from Google outside a comment:\n${offenders.map(o => `  ${o}`).join("\n")}`);
});

test("⛔ NO @fontsource-variable PACKAGE — ITS FAMILY NAME IS DIFFERENT", () => {
  // @fontsource-variable/dm-sans declares the family 'DM Sans Variable'. The app asks for
  // 'DM Sans' in ~40 places, so importing the variable package renders NOTHING differently at
  // build time and silently falls every one of them through to system-ui at runtime. It was
  // installed and swapped back out while making this change; nothing in the suite would have
  // caught it, which is the whole reason this assertion is here by name.
  const pkg = JSON.parse(fs.readFileSync("client/package.json", "utf8"));
  const variable = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith("@fontsource-variable/"));
  assert.deepEqual(variable, [],
    `${variable.join(", ")} declares a family name suffixed "Variable", which no call site asks ` +
    `for. Use the static @fontsource/<family> package, or rename every call site deliberately.`);

  // Comments stripped: main.jsx documents this very trap by naming the package, and a check that
  // fails on its own rationale is a check somebody deletes.
  const main = stripComments(fs.readFileSync("client/src/main.jsx", "utf8"));
  assert.ok(!main.includes("@fontsource-variable/"),
    "main.jsx imports a variable fontsource package; see above");
});

test("every self-hosted family is one the UI actually asks for, under the name it asks for", () => {
  const main = fs.readFileSync("client/src/main.jsx", "utf8");
  const imports = [...main.matchAll(/@fontsource\/([a-z0-9-]+)\/([\w-]+)\.css/g)]
    .map(m => ({ pkg: m[1], weight: m[2] }));
  assert.ok(imports.length > 0, "main.jsx imports no self-hosted fonts at all");

  // ⛔ THE EXACT SET, because the family check alone does not see an unused WEIGHT: importing
  // barlow-condensed/100.css passed it, since Barlow Condensed is a family the UI does ask for.
  // This list is exactly what the two retired Google Fonts requests asked for and nothing else —
  //   index.html   Barlow+Condensed:wght@700;800  and  DM+Sans:wght@400;500;700;800
  //   index.css    Instrument+Serif:ital@0;1      and  Inter:wght@400;500
  // so a diff here is either a real typography decision or accidental payload, and both deserve to
  // be looked at rather than discovered in a bundle report.
  assert.deepEqual(
    imports.map(i => `${i.pkg}/${i.weight}`).sort(),
    [
      "barlow-condensed/700", "barlow-condensed/800",
      "dm-sans/400", "dm-sans/500", "dm-sans/700", "dm-sans/800",
      "instrument-serif/400", "instrument-serif/400-italic",
      "inter/400", "inter/500",
    ],
    "the self-hosted font set changed. If that is deliberate, update this list and say why in the " +
    "commit; if it is not, a weight nobody asked for is being shipped to every visitor");

  // Every imported package must be a real dependency, or the deploy's `npm ci` installs nothing
  // and all four families fall back to system fonts in production only.
  const deps = JSON.parse(fs.readFileSync("client/package.json", "utf8")).dependencies || {};
  for (const { pkg } of imports) {
    assert.ok(deps[`@fontsource/${pkg}`],
      `main.jsx imports @fontsource/${pkg} but client/package.json does not depend on it — ` +
      `npm ci would not install it and the family would silently fall back in production`);
  }

  const dir = "client/node_modules/@fontsource";
  if (!fs.existsSync(dir)) {
    // Not a silent skip: say so, because a guard that quietly does nothing is the thing this file
    // is about. The two assertions above still ran and cover the regressions that have happened.
    console.warn("[selfHostedFonts] client/node_modules absent — family-name check skipped. " +
                 "Run `npm --prefix client install` to include it.");
    return;
  }

  // The families the UI requests, from both inline styles and stylesheets.
  const requested = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(css|jsx?)$/.test(e.name)) continue;
      // A family name reaches the UI by several routes, and matching only `font-family:` missed
      // one: Instrument Serif arrives as a CSS custom property (`--font-display: 'Instrument
      // Serif', serif`) that inline styles then read through `var(--font-display, 'Instrument
      // Serif', serif)`. So take every quoted token on any line that mentions a font at all.
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!/font/i.test(line)) continue;
        for (const m of line.matchAll(/['"]([^'"]+)['"]/g)) {
          for (const part of m[1].split(",")) requested.add(part.trim().replace(/^['"]|['"]$/g, ""));
        }
      }
    }
  };
  walk("client/src");

  for (const { pkg, weight } of imports) {
    const css = fs.readFileSync(`${dir}/${pkg}/${weight}.css`, "utf8");
    const family = css.match(/font-family:\s*'([^']+)'/)?.[1];
    assert.ok(family, `@fontsource/${pkg}/${weight}.css declares no font-family`);
    assert.ok(requested.has(family),
      `@fontsource/${pkg}/${weight}.css declares the family "${family}", which NOTHING in ` +
      `client/src asks for. Either the UI names it differently — the 'DM Sans Variable' trap, ` +
      `where every call site falls through to system-ui and nothing fails — or this weight is ` +
      `payload nobody uses.`);
  }
});

test("the policy's font claim matches what the build does", () => {
  // ⛔ STRIP COMMENTS BEFORE TAGS. Stripping only JSX tags leaves the FILE's own source comments in
  // the "prose", and the comment above EFFECTIVE_DATE explains this very change — so deleting the
  // user-facing sentence still passed. Caught by injecting exactly that deletion.
  const policy = stripComments(fs.readFileSync("client/src/pages/marketing/PrivacyPage.jsx", "utf8"))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(policy, /served from our own origin|self-host/i,
    "the policy must state where fonts come from, now that it names Google as a former recipient");
  assert.match(policy, /Google Fonts/,
    "the policy should name Google Fonts, so a reader who expected it knows it was retired");
});
