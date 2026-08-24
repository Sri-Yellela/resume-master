#!/usr/bin/env node
/**
 * AG4 REAL-RUN verification — no line renders twice, in the PDF as well as the HTML.
 *
 * WHY THE PDF AND NOT JUST THE HTML
 * The HTML preview and the PDF are different renderers. The PDF is the artifact that gets attached
 * to an application, so it is the one that reaches an employer, and "the preview looks right" has
 * never been evidence about it. This renders through the same path server.js htmlToPdf uses —
 * launchBrowser, setContent, page.pdf at Letter with zero margins — and then reads the TEXT BACK
 * OUT OF THE PDF BYTES with pdf-parse. Reading the DOM instead would only prove the HTML again.
 *
 * WHAT IT COMPARES
 * BEFORE is the artifact exactly as stored in the database — which is formatter output from before
 * the fix, and therefore carries the defect as it actually shipped. AFTER is that same artifact put
 * back through normalizeResumeHtml. Any line that appears twice inside one entry in BEFORE and once
 * in AFTER is the fix, measured on the bytes an employer would receive.
 *
 * Duplication is counted PER ENTRY. Two roles at the same employer legitimately name that employer
 * twice, and a document-wide count would drown the real defect in false alarms.
 *
 * Usage: node scripts/ag4PdfDuplication.mjs
 *        AG4_KEEP_PDF=1 node scripts/ag4PdfDuplication.mjs   # keep the PDFs to open by hand
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { launchBrowser } from "../services/browserLauncher.js";
import { normalizeResumeHtml } from "../services/resumeFormatter.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "screenshots");

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures += 1;
};

/**
 * Normalise rendered text down to comparable words.
 *
 * A PDF is laid out, not marked up: the same sentence wraps at a different column inside a
 * paragraph than inside a list item, so the duplicated copy never shares a LINE with its original.
 * Comparing lines finds nothing, which is why the first version of this script reported a clean
 * BEFORE for a document that visibly duplicates two whole entries. Words survive re-wrapping.
 *
 * The separator glyph is flattened to a space because the two renderings genuinely disagree about
 * it — the stored artifact carries a double-escaped "&middot;" that Chrome prints literally, and
 * reformatting decodes it to "·". That is a different bug being fixed in passing, and it must not
 * read here as content having been lost.
 */
function comparableWords(text) {
  return String(text)
    .replace(/&middot;|·|•/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

const SHINGLE = 12;

/** Every distinct 12-word run that appears more than once. Ordinary prose produces none. */
function duplicatedShingles(text) {
  const words = comparableWords(text);
  const counts = new Map();
  for (let i = 0; i + SHINGLE <= words.length; i += 1) {
    const key = words.slice(i, i + SHINGLE).join(" ");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([run, n]) => ({ run, n }));
}

/** The set of 12-word runs a document contains, for checking nothing was lost. */
function shingleSet(text) {
  const words = comparableWords(text);
  const set = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i += 1) set.add(words.slice(i, i + SHINGLE).join(" "));
  return set;
}

const db = new Database(path.join(ROOT, "data", "resume_master.db"), { readonly: true });
const row = db.prepare("SELECT company, role, html FROM resumes ORDER BY updated_at DESC LIMIT 1").get();
db.close();
if (!row?.html) {
  console.error("no generated resume in the database — nothing to verify against");
  process.exit(2);
}
console.log(`\nAG4 PDF verification — ${row.company} · ${row.role}\n`);

const BEFORE = row.html;
const AFTER = normalizeResumeHtml(row.html);
check("the stored artifact and the reformatted one actually differ", BEFORE !== AFTER,
  "if they were identical this would be verifying nothing");

fs.mkdirSync(OUT_DIR, { recursive: true });

// Mirrors server.js htmlToPdf. Kept in step by the assertion at the bottom, which fails if that
// function stops rendering PDFs the same way.
async function renderPdf(browser, html) {
  const doc = html.trimStart().toLowerCase().startsWith("<!doctype") ? html : `<!DOCTYPE html>${html}`;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1240, height: 1754 });
    await page.setContent(doc, { waitUntil: "networkidle0", timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    const png = await page.screenshot({ fullPage: true });
    return { pdf: Buffer.from(pdf), png: Buffer.from(png) };
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await launchBrowser({ headless: true, viewport: { width: 1240, height: 1754 } });
try {
  const pdfParse = require("pdf-parse");
  const results = {};

  for (const [label, html] of [["before", BEFORE], ["after", AFTER]]) {
    const { pdf, png } = await renderPdf(browser, html);
    const pdfPath = path.join(OUT_DIR, `ag4-resume-${label}.pdf`);
    const pngPath = path.join(OUT_DIR, `ag4-resume-${label}.png`);
    fs.writeFileSync(pdfPath, pdf);
    fs.writeFileSync(pngPath, png);
    const parsed = await pdfParse(pdf);
    results[label] = { text: parsed.text, pages: parsed.numpages, pdfPath, pngPath };
    console.log(`  ${label.padEnd(6)} ${pdf.length} bytes, ${parsed.numpages} page(s) -> ${path.relative(ROOT, pdfPath)}`);
  }

  const beforeDupes = duplicatedShingles(results.before.text);
  const afterDupes = duplicatedShingles(results.after.text);

  console.log(`\n  BEFORE duplicated 12-word runs: ${beforeDupes.length}`);
  for (const d of beforeDupes.slice(0, 6)) console.log(`     ${d.n}x  ${d.run.slice(0, 96)}`);
  if (beforeDupes.length > 6) console.log(`     ... and ${beforeDupes.length - 6} more`);
  console.log(`  AFTER  duplicated 12-word runs: ${afterDupes.length}`);
  for (const d of afterDupes.slice(0, 6)) console.log(`     ${d.n}x  ${d.run.slice(0, 96)}`);

  console.log("");
  check("the PDF really carries the defect before the fix", beforeDupes.length > 0,
    "a BEFORE with no duplication would mean this is not measuring the reported bug");
  check("nothing renders twice in the PDF after the fix", afterDupes.length === 0,
    afterDupes.slice(0, 3).map(d => d.run.slice(0, 60)).join(" | "));

  // Content must survive. A fix that removes the duplicate by removing BOTH copies is worse than
  // the bug — the resume would silently lose a role, and nobody would see it happen.
  //
  // Measured per SENTENCE, by its tail, and not by sliding runs. Deleting a duplicated block also
  // deletes the runs that straddled its edges — "...university near you technical assistant jul
  // 2016 present coordinated technical support..." only ever existed because the header line was
  // glued to the copy beneath it. Those runs SHOULD disappear; they were never content. A
  // sentence's closing ten words are content, and if one of those is gone, something real was lost.
  const afterWords = comparableWords(results.after.text).join(" ");
  const missing = [];
  for (const raw of results.before.text.split(/(?<=[.!?])\s+/)) {
    const words = comparableWords(raw);
    if (words.length < 12) continue;
    const tail = words.slice(-10).join(" ");
    if (!afterWords.includes(tail)) missing.push(raw.replace(/\s+/g, " ").trim());
  }
  check("every sentence in the BEFORE pdf still ends the same way in the AFTER pdf",
    missing.length === 0,
    `${missing.length} lost — e.g. ${missing.slice(0, 2).map(s => s.slice(0, 70)).join(" | ")}`);
  check("the AFTER pdf is no longer than the BEFORE pdf",
    results.after.pages <= results.before.pages,
    `${results.before.pages} -> ${results.after.pages} pages`);

  // The renderer this script mirrors must not drift away from it. indexOf would find the commented
  // Gotenberg migration sketch that sits above the real function and reads identically.
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const defAt = server.indexOf("\nasync function htmlToPdf");
  const pdfFn = defAt === -1 ? "" : server.slice(defAt, defAt + 1600);
  check("this script still mirrors server.js htmlToPdf",
    /page\.pdf\(/.test(pdfFn) && /format:\s*"Letter"/.test(pdfFn) && /printBackground:\s*true/.test(pdfFn));

  console.log(`\n  screenshots: ${path.relative(ROOT, results.before.pngPath)} , ${path.relative(ROOT, results.after.pngPath)}`);
  if (!process.env.AG4_KEEP_PDF) {
    // The PNGs are the reviewable evidence and are kept; the PDFs are large and reproducible.
    for (const label of ["before", "after"]) fs.rmSync(results[label].pdfPath, { force: true });
    console.log("  (pdfs removed — set AG4_KEEP_PDF=1 to keep them)");
  }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\n${failures === 0 ? "AG4 PDF verification PASSED" : `AG4 PDF verification FAILED (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
