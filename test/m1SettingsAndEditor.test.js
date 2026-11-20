// ⭐ rm-audit M1 / M2 / M4 / M6 / M7 / M11 / M12 / M16 / M17 (draft D192 (2), owner 11-19 "approving all open items"):
// the header points at where the tools live now; the account is ONE Settings dialog on every page (no prompt()); the home
// page is one line and the Documents drop target; Format and Tailor are part of the résumé editor; the workspace's
// Download is a menu; the /pdf/ hub wears the Documents grid.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { NAV, FOOTER, renderHub, renderSitemap } from "../scripts/site/buildSite.mjs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("m1 · the header and footer point at the workspace and the editor; one Settings button; no stale band line", () => {
  for (const href of ["/workspace/?panel=resume", "/editor/", "/editor/?panel=tailor", "/pdf/"]) assert.ok(NAV.includes(`href="${href}"`), href);
  assert.doesNotMatch(NAV + FOOTER, /\/#ats|\/#format|\/#generate|data-open="|Get started/);
  assert.match(NAV, /data-open-settings=""/);
  assert.doesNotMatch(FOOTER, /coarse by design|Bands are calibrated/);
  assert.match(read("public/chrome.js"), /"#format": "\/editor\/\?paste=1"/, "old home-page addresses go where the tool lives now");
  assert.match(renderSitemap(), /<loc>https:\/\/resumemaster\.one\/editor\/<\/loc>/, "the editor is in the sitemap");
});

test("m16 / m17 · the account is a section of Settings — sign in, create, reset; documents, credits, export, delete with a password FIELD", () => {
  const a = read("public/account-panel.js");
  for (const route of ['"/account/signin"', '"/account/signup"', '"/account/password-reset"', '"/account/password-reset/confirm"', '"/account"', '"/documents"', '/v1/site/account/export', '"/account/signout"']) assert.ok(a.includes(route), route);
  assert.doesNotMatch(a, /\bprompt\(["'`]/, "no native prompt() for the delete password");
  assert.match(a, /"Your password, to delete the account", \{ type: "password", name: "password", required: true/);
  assert.match(a, /location\.href = "\/editor\/";/, "a saved résumé opens in the editor, not a raw blob tab");
  assert.match(read("public/workspace/workspace.js"), /appearanceNode\(el\), accountNode\(el\), close\);/);
  assert.match(read("public/site-settings.js"), /appearanceNode\(el\), accountNode\(el, \{ onChange: label \}\)/);
  assert.match(read("public/site-settings.js"), /\^#\(reset=\|signin\|signup\|account\)/, "a reset link and old account addresses open it");
});

test("m2 / m4 / m9 · the home page: one line, then the Documents drop target; no tool tabs, no Everything cards, no repeated 'free'", () => {
  const home = read("public/index.html");
  assert.match(home, /<section class="hero hero--small">\n\s*<h1 class="hero__title">Résumé tools that show their work\.<\/h1>/);
  assert.doesNotMatch(home, /class="tabs"|data-tab=|class="everything"|hero__cta|free, with no account/);
  assert.ok(home.indexOf("data-docs-home") > home.indexOf("hero__title"), "the drop target follows the one line");
});

test("m6 / m7 · the editor by itself carries Paste (Format) and a properties column — the ATS panel and Tailor", () => {
  const side = read("public/editor/editor-side.js");
  assert.match(side, /import \{ mountAtsPanel \} from "\/ats-panel\.js";/);
  assert.match(side, /tab\("resume", "Résumé"\); tab\("tailor", "Tailor"\);/);
  assert.match(side, /"Back to before tailoring"/);
  assert.match(side, /x\.status === 422 \? "Withheld: the draft claimed more than your résumé states/);
  assert.match(read("public/editor/editor.css"), /\.wrap\.wrap--side \{ grid-template-columns: 250px minmax\(0, 816px\) 300px; \}/);
});

test("m11 · Download ▾ — PDF · Word · text; m12 · the hub is the Documents grid with no numerals", () => {
  assert.match(read("public/workspace/index.html"), /id="ws-download" disabled aria-haspopup="menu" aria-expanded="false">Download ▾</);
  assert.match(read("public/workspace/workspace.js"), /\[\["pdf", "PDF"\], \["word", "Word \(\.docx\)"\], \["txt", "Text \(\.txt\)"\]\]/);
  const hub = renderHub();
  assert.match(hub, /<section class="docs-tools" aria-label="PDF tools">/);
  assert.doesNotMatch(hub, /card__num|class="card"/);
});
