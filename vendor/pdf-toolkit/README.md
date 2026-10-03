# @draft/pdf-toolkit

PDF tools that run **in the browser** — the file never leaves the user's machine (A69, 2026-10-02).
One implementation, used by draft (`client/src/components/PdfToolkit.jsx`) and by Resume Master
(vendored, checksummed, mounted on resumemaster.one).

| Tool | How |
|---|---|
| Merge, split, extract, reorder, rotate, delete | `core.js` on [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib) |
| Watermark | `core.js` — diagonal text on every page |
| Protect / unlock | `core.js` — AES-256 via the fork's `encrypt()`; unlock needs the password, never guesses one |
| Images → PDF | `core.js` — JPEG/PNG, a page per image at its size |
| Compress | `core.js` re-encodes the **RGB JPEG pictures** inside, with the host's canvas re-encoder (`render.js`); text untouched; never returns a bigger file |
| PDF → images | `render.js` on pdf.js |
| PDF → text | `pdfText.js` — the text layer, in reading order, two columns read left then right; a scan is `needsOcr` (A70) |

**Not offered, said on the page:** PDF → Word/Excel, OCR, and compress-by-flattening (it would make
a résumé unreadable to an ATS).

`core.js`, `pdfText.js` and `render.js` import nothing — the host passes `lib` (the pdf-lib
namespace) and `pdfjs` (pdf.js with its worker configured). `ui.js` is a framework-free component:

```js
import * as lib from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist";
import { mountPdfToolkit } from "@draft/pdf-toolkit/ui";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
mountPdfToolkit(document.querySelector("#pdf-tools"), { lib, pdfjs });
```

Theme it with `--pt-host-*` CSS variables (`styles.css`). ⛔ After any edit: `npm run checksums`
here, then re-vendor into Resume Master.
