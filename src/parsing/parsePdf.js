// Résumé PDF → text. draft's POST /api/parse-pdf, minus multer: an API takes the PDF as base64 in
// JSON, which keeps the service to one body format and one size limit.
import { callAnthropic, textOf, MODEL_SONNET } from "../model/anthropicCall.js";
import { InvalidRequestError } from "../generation/generate.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** @returns { text, chars, usage: UsageRecord[] } */
export async function parsePdf(client, { pdfBase64 } = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) throw new InvalidRequestError("pdfBase64 is required");
  const clean = pdfBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new InvalidRequestError("pdfBase64 is not base64");
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new InvalidRequestError(`PDF exceeds ${MAX_PDF_BYTES} bytes`);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new InvalidRequestError("not a PDF");
  const { message, usage } = await callAnthropic(client, {
    purpose: "parse_pdf",
    model: MODEL_SONNET,
    // Explicit, as draft's was: a truncated extraction silently yields a partial résumé.
    thinking: { type: "disabled" },
    max_tokens: 8000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: clean } },
      { type: "text", text: "Extract all text from this resume PDF preserving section structure. Return plain text only, no commentary." },
    ]}],
  });
  const text = textOf(message).trim();
  return { text, chars: text.length, usage: [usage] };
}
