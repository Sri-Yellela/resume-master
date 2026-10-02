// The server's door to src/parsing/pdfText.js (A70): base64 in, text out, ZERO model calls.
// Same input checks as parsePdf (the model path, which the token API still uses — see that file).
import { InvalidRequestError } from "../generation/generate.js";
import { textFromPdfDocument } from "./pdfText.js";
import { MAX_PDF_BYTES } from "./parsePdf.js";

let pdfjs = null;
async function loadPdfjs() {
  // The legacy build is the one pdf.js supports in Node; loaded on first use so a boot never pays for it.
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/** @returns {{ text, chars, pages, needsOcr, columns, usage: [] }} */
export async function extractPdfText({ pdfBase64 } = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) throw new InvalidRequestError("pdfBase64 is required");
  const clean = pdfBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new InvalidRequestError("pdfBase64 is not base64");
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new InvalidRequestError(`PDF exceeds ${MAX_PDF_BYTES} bytes`);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new InvalidRequestError("not a PDF");

  const { getDocument } = await loadPdfjs();
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") {
      throw new InvalidRequestError("This PDF is password-protected. Remove the password and try again.");
    }
    throw new InvalidRequestError("This file could not be read as a PDF.");
  }
  try {
    return { ...(await textFromPdfDocument(doc)), usage: [] };
  } finally {
    await doc.destroy();
  }
}
