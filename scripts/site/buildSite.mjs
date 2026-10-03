// The site's generated parts (A68 + A69, owner 10-03):
//   · the HEADER and FOOTER — one definition, written between <!-- chrome:… --> markers into every
//     page, so the pages cannot drift apart (the old site's look: the white boxed stamp, a glass bar);
//   · the PDF product pages — /pdf/ and one page per tool, each findable on its own (the A69 row: "merge
//     pdf" / "compress pdf" are search categories), each mounting the same in-browser toolkit;
//   · sitemap.xml and robots.txt; and public/sky.svg (scripts/site/sky.mjs).
//
//   node scripts/site/buildSite.mjs            write
//   node scripts/site/buildSite.mjs --check    exit 1 if any generated file is stale (the test runs this)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSky } from "./sky.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = path.join(ROOT, "public");
export const ORIGIN = "https://resumemaster.one";

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── the tools, as pages ──────────────────────────────────────────────────────────────────────────
// `tool` is the toolkit's id (src/pdf-toolkit/ui.js TOOLS). Titles are what people search for.
export const PDF_PAGES = [
  { slug: "merge-pdf", tool: "merge", name: "Merge PDF", h1: "Merge PDF files",
    desc: "Combine PDFs into one file, in the order you choose.", steps: ["Add two or more PDFs", "Put them in order", "Merge, and download one PDF"] },
  { slug: "split-pdf", tool: "split", name: "Split PDF", h1: "Split a PDF",
    desc: "Split a PDF into single pages, or into the page ranges you choose.", steps: ["Choose a PDF", "Leave ranges blank for every page, or type 1-2, 3, 4-", "Download each part"] },
  { slug: "organize-pdf", tool: "organise", name: "Organize PDF", h1: "Organize PDF pages",
    desc: "Reorder, rotate or delete the pages of a PDF, with a picture of each page.", steps: ["Choose a PDF", "Move, rotate or remove pages", "Save, and download"] },
  { slug: "compress-pdf", tool: "compress", name: "Compress PDF", h1: "Compress a PDF",
    desc: "Make a PDF smaller for an upload limit: the pictures shrink and the text stays selectable — or, at Maximum, every page becomes a picture for the smallest file.", steps: ["Choose a PDF", "Pick how much to shrink it", "Download — or keep the original if it could not get smaller"] },
  { slug: "watermark-pdf", tool: "watermark", name: "Watermark PDF", h1: "Add a watermark to a PDF",
    desc: "Stamp text diagonally across every page of a PDF.", steps: ["Choose a PDF", "Type the watermark", "Download"] },
  { slug: "protect-pdf", tool: "protect", name: "Protect PDF", h1: "Password-protect a PDF",
    desc: "Lock a PDF with a password, encrypted with AES-256.", steps: ["Choose a PDF", "Type a password twice", "Download the locked copy — keep the password safe"] },
  { slug: "unlock-pdf", tool: "unlock", name: "Unlock PDF", h1: "Unlock a PDF",
    desc: "Remove the password from a PDF you have the password for. It never guesses one.", steps: ["Choose the PDF", "Type its password", "Download the unlocked copy"] },
  { slug: "jpg-to-pdf", tool: "images", name: "JPG to PDF", h1: "JPG and PNG to PDF",
    desc: "Turn JPEG or PNG pictures into one PDF, a page per picture.", steps: ["Choose your pictures", "They go in the order chosen", "Download the PDF"] },
  { slug: "pdf-to-jpg", tool: "toimages", name: "PDF to JPG", h1: "PDF to JPG or PNG",
    desc: "Save every page of a PDF as a picture.", steps: ["Choose a PDF", "Pick PNG or JPEG", "Download each page"] },
  { slug: "pdf-to-text", tool: "text", name: "PDF to text", h1: "PDF to text",
    desc: "Copy the text out of a PDF, in reading order — two columns read left, then right. No AI.", steps: ["Choose a PDF", "Read it", "Copy or download the text"] },
  { slug: "pdf-to-word", tool: "word", name: "PDF to Word", h1: "PDF to Word",
    desc: "Turn a PDF into an editable Word document: the text in reading order, with headings and paragraphs.", steps: ["Choose a PDF", "Make the Word file", "Download the .docx and check the layout"] },
  { slug: "pdf-to-excel", tool: "excel", name: "PDF to Excel", h1: "PDF to Excel",
    desc: "Turn tables and statements in a PDF into an Excel workbook — rows and columns, numbers kept as numbers.", steps: ["Choose a PDF", "Make the Excel file", "Download the .xlsx — one sheet per page"] },
  { slug: "ocr-pdf", tool: "ocr", name: "OCR PDF", h1: "OCR a scanned PDF",
    desc: "Read the text in a scanned PDF, and get a searchable copy you can select and search.", steps: ["Choose a scanned PDF", "Read it — a page at a time, on this computer", "Download the text and the searchable PDF"] },
];

// ── the shared chrome ────────────────────────────────────────────────────────────────────────────
export const STAMP = (size = "") =>
  `<a class="stamp${size ? ` stamp--${size}` : ""}" href="/" aria-label="Resume Master — home"><span class="stamp__box">` +
  `<span>R</span><span class="stamp__fold">esume</span><span>M</span><span class="stamp__fold">aster</span></span></a>`;

export const NAV = `<header class="nav" id="nav">
  ${STAMP()}
  <nav class="nav__links" aria-label="Tools">
    <a class="nav__link" href="/#ats" data-nav="ats">ATS check</a>
    <a class="nav__link" href="/#format" data-nav="format">Format</a>
    <a class="nav__link" href="/#generate" data-nav="generate">Tailor</a>
    <a class="nav__link" href="/pdf/" data-nav="pdf">PDF tools</a>
  </nav>
  <details class="nav__menu">
    <summary>Menu</summary>
    <nav class="nav__menu-panel glass" aria-label="Tools">
      <a href="/#ats">ATS check</a><a href="/#format">Format</a><a href="/#generate">Tailor a résumé</a>
      <a href="/pdf/">PDF tools</a><a href="/privacy.html">Privacy</a>
    </nav>
  </details>
  <div class="nav__account">
    <span id="acct-signed-out"><button class="btn ghost" data-open="signin">Sign in</button> <button class="btn primary" data-open="signup">Get started</button></span>
    <span id="acct-signed-in" class="account-bar" hidden>
      <span id="acct-email"></span> · <span class="balance" id="acct-balance"></span>
      <button class="btn ghost" data-open="account">Account</button>
      <button class="btn ghost" id="signout">Sign out</button>
    </span>
  </div>
</header>`;

export const FOOTER = `<footer class="foot">
  ${STAMP()}
  <p>Résumé tools that show their work, and PDF tools that never upload your file. Bands are calibrated on
    human-graded postings and are coarse by design.</p>
  <p class="foot__links"><a href="/#ats">ATS check</a> · <a href="/#format">Format</a> · <a href="/#generate">Tailor</a> ·
    <a href="/pdf/">PDF tools</a> · <a href="/privacy.html">Privacy — what is kept, and for how long</a></p>
</footer>`;

const head = ({ title, description, canonical }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${ORIGIN}${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${ORIGIN}${canonical}">
  <link rel="stylesheet" href="/site.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>`;

const wrapChrome = (body) => `<body>
  <!-- chrome:nav -->
${NAV}
  <!-- /chrome:nav -->
  <main class="wrap">
${body}
  </main>
  <!-- chrome:footer -->
${FOOTER}
  <!-- /chrome:footer -->
  <script src="/chrome.js" defer></script>
  <script type="module" src="/pdf-tools.js"></script>
</body>
</html>
`;

const card = (p, i) => `      <a class="card" href="/pdf/${p.slug}/">
        <span class="card__num">${String(i + 1).padStart(2, "0")}</span><span class="card__rule"></span>
        <span class="card__title">${esc(p.name)}</span>
        <span class="card__desc">${esc(p.desc)}</span>
      </a>`;

export function renderHub() {
  return head({ title: "Free PDF tools that never upload your file — Resume Master",
    description: "Merge, split, organize, compress, watermark, protect, unlock and convert PDFs — free, no account, and your file never leaves your browser.",
    canonical: "/pdf/" }) + "\n" + wrapChrome(`    <section class="hero hero--small">
      <h1>PDF tools that never upload your file</h1>
      <p class="hero__tagline">Every tool here runs in your browser. Nothing is uploaded, stored or seen by anyone — free, no account.</p>
    </section>
    <section class="cards" aria-label="PDF tools">
${PDF_PAGES.map(card).join("\n")}
    </section>
    <section class="panel glass notes">
      <h2>Why it is private</h2>
      <p>Most PDF sites upload your file to their servers to work on it. These tools do the work on your own computer,
        in this page — so a résumé, a contract or a statement never travels anywhere.</p>
      <h2>What each conversion carries</h2>
      <p>PDF to Word keeps the text, in reading order, as headings and paragraphs — not the exact layout, fonts or pictures.
        PDF to Excel builds rows and columns from text that is aligned in columns. OCR reads English from scanned pages and
        makes a searchable copy; read it through, because OCR misreads some characters. Compress at Maximum turns every page
        into a picture, so its text can no longer be selected or read by software.</p>
    </section>`);
}

export function renderToolPage(p) {
  const others = PDF_PAGES.filter(o => o.slug !== p.slug);
  return head({ title: `${p.h1} — free, in your browser | Resume Master`,
    description: `${p.desc} Free, no account — your file never leaves your browser.`,
    canonical: `/pdf/${p.slug}/` }) + "\n" + wrapChrome(`    <p class="crumbs"><a href="/pdf/">PDF tools</a> › ${esc(p.name)}</p>
    <section class="hero hero--small">
      <h1>${esc(p.h1)}</h1>
      <p class="hero__tagline">${esc(p.desc)}</p>
    </section>
    <section class="panel glass">
      <ol class="steps">${p.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
      <div id="pdf-tools" class="pdf-tools" data-initial="${p.tool}"><p class="note">Loading the tool…</p></div>
    </section>
    <section class="more" aria-label="More PDF tools">
      <h2>More PDF tools</h2>
      <p class="more__links">${others.map(o => `<a href="/pdf/${o.slug}/">${esc(o.name)}</a>`).join(" · ")}</p>
    </section>`);
}

export function renderSitemap() {
  const urls = ["/", "/pdf/", ...PDF_PAGES.map(p => `/pdf/${p.slug}/`), "/privacy.html"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
}

export const ROBOTS = `User-agent: *\nDisallow: /v1/\nDisallow: /mcp\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`;

// The browser-tab mark: the stamp's "RM", white box on night.
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#00283f"/>` +
  `<g transform="rotate(-4 16 16)"><rect x="4" y="9" width="24" height="14" rx="1" fill="#fff" stroke="#0f0f0f" stroke-width="1.6"/>` +
  `<text x="16" y="20.5" text-anchor="middle" font-family="Arial Narrow, Arial, sans-serif" font-weight="800" font-style="italic" font-size="11" fill="#0f0f0f">RM</text></g></svg>\n`;

/** Put the shared chrome between its markers in a hand-written page. */
export function injectChrome(html) {
  const put = (src, name, block) => {
    const re = new RegExp(`(<!-- chrome:${name} -->)[\\s\\S]*?(<!-- /chrome:${name} -->)`);
    if (!re.test(src)) throw new Error(`no <!-- chrome:${name} --> markers`);
    return src.replace(re, `$1\n${block}\n  $2`);
  };
  return put(put(html, "nav", NAV), "footer", FOOTER);
}

export function plan() {
  const files = new Map();
  files.set("sky.svg", renderSky());
  files.set("favicon.svg", FAVICON);
  files.set("sitemap.xml", renderSitemap());
  files.set("robots.txt", ROBOTS);
  files.set("pdf/index.html", renderHub());
  for (const p of PDF_PAGES) files.set(`pdf/${p.slug}/index.html`, renderToolPage(p));
  for (const f of ["index.html", "privacy.html"]) {
    files.set(f, injectChrome(fs.readFileSync(path.join(PUB, f), "utf8").replace(/\r\n/g, "\n")));
  }
  return files;
}

export function staleFiles() {
  const stale = [];
  for (const [rel, want] of plan()) {
    const p = path.join(PUB, rel);
    const have = fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") : null;
    if (have !== want) stale.push(rel);
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const s = staleFiles();
    for (const f of s) console.error(`⛔ stale: public/${f}`);
    if (!s.length) console.log("✓ the site's generated files are current");
    process.exit(s.length ? 1 : 0);
  }
  for (const [rel, content] of plan()) {
    const p = path.join(PUB, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  console.log(`wrote ${plan().size} files under public/`);
}
