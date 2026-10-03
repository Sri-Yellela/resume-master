// A70 (owner, 10-02): PDF → text on the site is FREE — it reads the PDF's own text layer, zero model
// calls. Real PDFs built with pdf-lib; real server; NO model client at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { createApp } from "../src/http/app.js";
import { loadAllPrompts } from "../src/generation/promptAssembler.js";
import { mintToken, parseClientTokens } from "../src/http/auth.js";
import { openStore } from "../src/store/db.js";
import { creditConfig } from "../src/accounts/credits.js";
import { extractPdfText } from "../src/parsing/extractPdfText.js";

loadAllPrompts();

async function pdf(draw) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  draw(page, font);
  return Buffer.from(await doc.save()).toString("base64");
}
const line = (page, font) => (text, x, y, size = 11) => page.drawText(text, { x, y, size, font });

// One column, dates flushed right — the common résumé shape. Must NOT be read as two columns.
const oneCol = (dateX) => (page, font) => {
  const t = line(page, font);
  t("Jordan Example", 50, 740, 18);
  t("jordan.example@example.com | Austin, TX", 50, 718);
  t("EXPERIENCE", 50, 690, 12);
  const roles = [["Northwind — Senior Software Engineer", "2021 – 2025", "Built the payment ledger service in Go and PostgreSQL."],
                 ["Fabrikam — Software Engineer", "2018 – 2021", "Wrote the reconciliation pipeline in Python and Kafka."],
                 ["Contoso — Engineer", "2016 – 2018", "Kept the build green."]];
  let y = 670;
  for (const [role, dates, bullet] of roles) { t(role, 50, y); t(dates, dateX, y); t(bullet, 62, y - 15); y -= 40; }
  t("EDUCATION", 50, y, 12); t("B.S. Computer Science, University of Texas at Austin, 2018", 50, y - 18);
};
const ONE_COL = oneCol(500);

// Two columns: a narrow left rail and the main column, side by side on every row.
const TWO_COL = (page, font) => {
  const t = line(page, font);
  const left = ["SKILLS", "Go", "Python", "PostgreSQL", "Kafka", "Kubernetes", "EDUCATION", "University of Texas"];
  const right = ["EXPERIENCE", "Northwind — Senior Software Engineer", "Built the payment ledger service in Go.",
                 "Led the migration to six services.", "Fabrikam — Software Engineer", "Wrote the reconciliation pipeline.",
                 "Owned the on-call rotation for payments.", "Mentored two engineers."];
  left.forEach((s, i) => t(s, 50, 700 - i * 18));
  right.forEach((s, i) => t(s, 240, 700 - i * 18));
};

for (const [where, dateX] of [["flushed right", 500], ["at a mid-page tab stop", 380]]) test(`one column with dates ${where} reads in order, as one column`, async () => {
  const r = await extractPdfText({ pdfBase64: await pdf(oneCol(dateX)) });
  assert.equal(r.needsOcr, false);
  assert.deepEqual(r.columns, [1], "a flushed-right date is not a second column");
  const order = ["Jordan Example", "EXPERIENCE", "Northwind — Senior Software Engineer 2021 – 2025",
                 "Built the payment ledger", "Fabrikam — Software Engineer 2018 – 2021", "Wrote the reconciliation",
                 "EDUCATION", "University of Texas at Austin, 2018"];
  let at = -1;
  for (const s of order) {
    const i = r.text.indexOf(s);
    assert.ok(i > at, `"${s}" must come after the previous item:\n${r.text}`);
    at = i;
  }
  assert.deepEqual(r.usage, [], "zero model calls");
});

test("two columns are read left column first, then right — never interleaved row by row", async () => {
  const r = await extractPdfText({ pdfBase64: await pdf(TWO_COL) });
  assert.deepEqual(r.columns, [2]);
  assert.ok(r.text.indexOf("University of Texas") < r.text.indexOf("EXPERIENCE"), r.text);
  assert.doesNotMatch(r.text, /Go Northwind|SKILLS EXPERIENCE/, "rows must not be glued across the gutter");
  assert.match(r.text, /Northwind — Senior Software Engineer\nBuilt the payment ledger service in Go\./);
});

test("a PDF with no text layer (a scan) says it needs OCR — no text, no guess, no model", async () => {
  const r = await extractPdfText({ pdfBase64: await pdf((page) => page.drawRectangle({ x: 50, y: 50, width: 400, height: 600 })) });
  assert.equal(r.needsOcr, true);
  assert.equal(r.text, "");
});

test("bad input is refused legibly", async () => {
  await assert.rejects(extractPdfText({ pdfBase64: Buffer.from("hello").toString("base64") }), /not a PDF/);
  await assert.rejects(extractPdfText({ pdfBase64: Buffer.from("%PDF-1.4 garbage").toString("base64") }), /could not be read as a PDF/);
  await assert.rejects(extractPdfText({}), /pdfBase64 is required/);
});

async function serve(env = {}) {
  const { entry } = mintToken("draft");
  const app = createApp({ anthropic: null, version: { version: "test" }, log: () => {},
    clients: parseClientTokens(entry), store: openStore(":memory:"), env });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/v1/site/tools/parse-pdf`, { method: "POST",
    headers: { "content-type": "application/json", "x-rm-client": "web" }, body: JSON.stringify(body) });
  return { post, close: () => new Promise(r => server.close(r)) };
}

test("the site route is free and anonymous: no account, no credits, no model client at all", async () => {
  const s = await serve();
  try {
    const r = await s.post({ pdfBase64: await pdf(ONE_COL) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.text, /Northwind/);
    assert.equal(body.credits, undefined, "nothing is charged, so nothing is reported");
    const scan = await (await s.post({ pdfBase64: await pdf((p) => p.drawRectangle({ x: 1, y: 1, width: 9, height: 9 })) })).json();
    assert.equal(scan.needsOcr, true);
    assert.match(scan.message, /OCR\) is not offered/);
  } finally { await s.close(); }
});

test("free is not unbounded: a per-address daily ceiling", async () => {
  const s = await serve({ RM_PDF_TEXT_PER_DAY: "2" });
  try {
    const b = { pdfBase64: await pdf(ONE_COL) };
    assert.equal((await s.post(b)).status, 200);
    assert.equal((await s.post(b)).status, 200);
    const third = await s.post(b);
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, "daily_limit");
  } finally { await s.close(); }
});

test("⛔ a debit can never come back on this route unnoticed", () => {
  assert.equal(creditConfig({}).cost["resumes.parse-pdf"], undefined, "no cost entry for PDF → text");
  const routes = fs.readFileSync("src/http/siteRoutes.js", "utf8");
  assert.doesNotMatch(routes, /paid\("resumes\.parse-pdf"/);
  const route = routes.slice(routes.indexOf('r.post("/tools/parse-pdf"'));
  assert.ok(route.length > 0);
  assert.doesNotMatch(route.slice(0, route.indexOf("\n  });")), /paid\(|debitOnSuccess|checkCanAfford|anthropic/);
  const page = fs.readFileSync("public/index.html", "utf8");
  const panel = page.slice(page.indexOf('data-panel="pdf"'), page.indexOf("</section>", page.indexOf('data-panel="pdf"')));
  assert.doesNotMatch(panel, /credit/i, "the PDF panel must not mention a cost");
});
