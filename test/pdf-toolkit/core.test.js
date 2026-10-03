// The PDF toolkit — the operations, on real PDFs, under node --test. Synthetic content only.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import * as lib from "@cantoo/pdf-lib";
import {
  parsePageRanges, merge, selectPages, split, deletePages, rotate, watermark, protect, unlock,
  imagesToPdf, compress, info, sniffImage, ToolkitError, NOT_OFFERED,
} from "../../src/pdf-toolkit/core.js";

async function makePdf(labels, size = [300, 400]) {
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  for (const l of labels) doc.addPage(size).drawText(l, { x: 30, y: 300, size: 14, font });
  return doc.save();
}
async function texts(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push((await (await doc.getPage(p)).getTextContent()).items.map(i => i.str).join(""));
  await doc.destroy();
  return out;
}

// A real 2×2 JPEG (baseline, made by Chrome), and the same picture carrying a 20 kB comment segment — "a big photo".
const JPEG_SMALL = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKwBRN//2Q==", "base64");
const COMMENT = Buffer.alloc(20000, 0x20);
const JPEG_BIG = Buffer.concat([JPEG_SMALL.subarray(0, 2), Buffer.from([0xff, 0xfe, (COMMENT.length + 2) >> 8, (COMMENT.length + 2) & 0xff]), COMMENT, JPEG_SMALL.subarray(2)]);

function png(width, height) {
  const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let x = 0xffffffff; for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80); for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("page ranges: written order, open ends, and errors a person can act on", () => {
  assert.deepEqual(parsePageRanges("1-3, 5", 6), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRanges("5-", 6), [4, 5]);
  assert.deepEqual(parsePageRanges("3,1", 6), [2, 0]);
  assert.throws(() => parsePageRanges("7", 6), /Page 7 does not exist — this PDF has 6 pages/);
  assert.throws(() => parsePageRanges("4-2", 6), /runs backwards/);
  assert.throws(() => parsePageRanges("a-b", 6), /is not a page or a range/);
  assert.throws(() => parsePageRanges("", 6), ToolkitError);
});

test("merge keeps every page, in the order the files were given", async () => {
  const out = await merge(lib, [await makePdf(["A1", "A2"]), await makePdf(["B1"])]);
  assert.deepEqual(await texts(out), ["A1", "A2", "B1"]);
  await assert.rejects(merge(lib, [await makePdf(["only"])]), /at least two/);
});

test("extract / reorder, split, delete", async () => {
  const src = await makePdf(["p1", "p2", "p3", "p4"]);
  assert.deepEqual(await texts(await selectPages(lib, src, [3, 0])), ["p4", "p1"]);
  const parts = await split(lib, src, "1-2, 4");
  assert.deepEqual(parts.map(p => p.pages), [[1, 2], [4]]);
  assert.deepEqual(await texts(parts[1].bytes), ["p4"]);
  assert.equal((await split(lib, src)).length, 4, "each page on its own");
  assert.deepEqual(await texts(await deletePages(lib, src, [1, 2])), ["p1", "p4"]);
  await assert.rejects(deletePages(lib, src, [0, 1, 2, 3]), /every page/);
});

test("rotate adds to the existing rotation and refuses odd angles", async () => {
  const once = await rotate(lib, await makePdf(["r"]), 90);
  const twice = await rotate(lib, once, 270, [0]);
  assert.equal((await lib.PDFDocument.load(once)).getPage(0).getRotation().angle, 90);
  assert.equal((await lib.PDFDocument.load(twice)).getPage(0).getRotation().angle, 0);
  await assert.rejects(rotate(lib, once, 45), /90, 180 or 270/);
});

test("watermark draws on every page and keeps the original text", async () => {
  const out = await watermark(lib, await makePdf(["one", "two"]), "DRAFT");
  const t = await texts(out);
  assert.equal(t.length, 2);
  for (const [i, s] of t.entries()) { assert.match(s, /DRAFT/); assert.match(s, i ? /two/ : /one/); }
  await assert.rejects(watermark(lib, await makePdf(["x"]), "  "), /watermark text/);
});

test("protect then unlock: AES-256, the wrong password refused, the unlocked copy has no /Encrypt", async () => {
  const locked = await protect(lib, await makePdf(["secret"]), "open-sesame");
  assert.equal((await info(lib, locked)).encrypted, true);
  await assert.rejects(selectPages(lib, locked, [0]), /password-protected. Unlock it first/);
  await assert.rejects(unlock(lib, locked, "wrong"), /password is not right/);
  const open = await unlock(lib, locked, "open-sesame");
  assert.doesNotMatch(Buffer.from(open).toString("latin1"), /\/Encrypt/);
  assert.deepEqual(await texts(open), ["secret"]);
});

test("images → PDF: one page per image, at the image's size; anything else refused", async () => {
  assert.equal(sniffImage(JPEG_SMALL), "jpeg");
  assert.equal(sniffImage(png(4, 3)), "png");
  const out = await imagesToPdf(lib, [{ name: "a.png", bytes: png(40, 30) }, { name: "b.jpg", bytes: JPEG_SMALL }]);
  const doc = await lib.PDFDocument.load(out);
  assert.deepEqual(doc.getPages().map(p => [p.getWidth(), p.getHeight()]), [[40, 30], [2, 2]]);
  await assert.rejects(imagesToPdf(lib, [{ name: "x.gif", bytes: Buffer.from("GIF89a") }]), /x.gif is not a JPEG or PNG/);
});

test("compress shrinks the PICTURES and leaves the text alone — and says what it did", async () => {
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText("Résumé text stays", { x: 20, y: 250, size: 12, font });
  page.drawImage(await doc.embedJpg(JPEG_BIG), { x: 20, y: 20, width: 100, height: 100 });
  const src = await doc.save();
  const calls = [];
  const r = await compress(lib, src, { reencodeJpeg: async (bytes, opts) => { calls.push([bytes.length, opts]); return { bytes: JPEG_SMALL, width: 2, height: 2 }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0] > 20000, "the host is handed the picture's own bytes");
  assert.equal(r.images, 1); assert.equal(r.recompressed, 1);
  assert.ok(r.after < r.before - 15000, `smaller: ${r.before} → ${r.after}`);
  assert.match(r.note, /1 of 1 picture made smaller. Text is untouched/);
  assert.deepEqual(await texts(r.bytes), ["Résumé text stays"]);
});

test("compress leaves a CMYK picture alone — a canvas can only hand back RGB", async () => {
  const doc = await lib.PDFDocument.create();
  const img = await doc.embedJpg(JPEG_BIG);
  doc.addPage([200, 200]).drawImage(img, { x: 0, y: 0, width: 100, height: 100 });
  await doc.flush?.();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof lib.PDFRawStream && obj.dict.get(lib.PDFName.of("Subtype")) === lib.PDFName.of("Image")) {
      obj.dict.set(lib.PDFName.of("ColorSpace"), lib.PDFName.of("DeviceCMYK"));
    }
  }
  let asked = 0;
  const r = await compress(lib, await doc.save(), { reencodeJpeg: async () => { asked++; return { bytes: JPEG_SMALL, width: 2, height: 2 }; } });
  assert.equal(asked, 0, "the re-encoder is never handed a CMYK picture");
  assert.equal(r.recompressed, 0);
});

test("compress never makes a file bigger — the original comes back, and the note says so", async () => {
  const src = await makePdf(["tiny"]);
  const r = await compress(lib, src, { reencodeJpeg: async () => null });
  if (r.keptOriginal) {
    assert.equal(r.bytes, src);
    assert.match(r.note, /could not be made smaller/);
  } else {
    assert.ok(r.after < r.before);
    assert.match(r.note, /No pictures inside/);
  }
});

test("what is NOT offered is stated, including the 'compress by flattening' trap", () => {
  const what = NOT_OFFERED.map(n => n.what).join(" | ");
  assert.match(what, /Word or Excel/);
  assert.match(what, /OCR/);
  assert.match(what, /turning pages into images/);
});
