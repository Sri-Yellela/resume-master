/**
 * PNG: read the header, and re-encode as 24-bit truecolour with NO alpha channel.
 *
 * WHY THIS EXISTS
 * The Chrome Web Store dashboard REJECTS a screenshot that carries an alpha channel. (The store
 * ICON may have one; screenshots may not.) Chrome always writes RGBA — colour type 6 — so every
 * puppeteer screenshot is rejectable as taken, and the rejection happens at the dashboard, by hand,
 * at submission time. That is the worst possible place to discover it.
 *
 * There is no image library in this project's dependencies, and adding one to drop a channel is
 * not worth the supply chain. PNG's truecolour encoding is small enough to write: zlib is built in,
 * and both directions here are deliberately narrow — 8-bit, non-interlaced, colour type 2 or 6,
 * which is every PNG Chrome produces.
 *
 * WHY FLATTEN RATHER THAN JUST DROP THE CHANNEL
 * A partially transparent pixel's RGB is meaningless on its own; discarding its alpha would show
 * whatever colour happened to sit under it. Screenshots are composited onto an opaque background
 * already, so in practice every pixel is opaque — but "in practice" is not an assertion, so the
 * pixels are composited over white and the caller is told how many were not opaque.
 */
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** IHDR only — enough to assert dimensions and the presence of an alpha channel. */
export function readPngHeader(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG does not start with IHDR");
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType,
    interlace: buf[28],
    // 4 = grey+alpha, 6 = truecolour+alpha. 2 = truecolour, which is what the store wants.
    hasAlpha: colorType === 4 || colorType === 6,
    // The store's phrasing. Truecolour at 8 bits per channel is "24-bit".
    bitsPerPixel: { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] * buf[24],
  };
}

/** Undo the five PNG scanline filters. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return out;
}

/** Decode an 8-bit non-interlaced colour-type-2 or -6 PNG to { width, height, rgb, nonOpaque }. */
export function decodeToRgb(buf) {
  const h = readPngHeader(buf);
  if (h.bitDepth !== 8) throw new Error(`unsupported bit depth ${h.bitDepth}`);
  if (h.interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (h.colorType !== 2 && h.colorType !== 6) throw new Error(`unsupported colour type ${h.colorType}`);

  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!idat.length) throw new Error("PNG has no IDAT");

  const bpp = h.colorType === 6 ? 4 : 3;
  const pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), h.width, h.height, bpp);

  if (h.colorType === 2) return { width: h.width, height: h.height, rgb: pixels, nonOpaque: 0 };

  // Composite over white, and count what actually needed compositing.
  const rgb = Buffer.alloc(h.width * h.height * 3);
  let nonOpaque = 0;
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    const a = pixels[i + 3];
    if (a === 255) {
      rgb[j] = pixels[i]; rgb[j + 1] = pixels[i + 1]; rgb[j + 2] = pixels[i + 2];
    } else {
      nonOpaque++;
      const f = a / 255;
      rgb[j]     = Math.round(pixels[i]     * f + 255 * (1 - f));
      rgb[j + 1] = Math.round(pixels[i + 1] * f + 255 * (1 - f));
      rgb[j + 2] = Math.round(pixels[i + 2] * f + 255 * (1 - f));
    }
  }
  return { width: h.width, height: h.height, rgb, nonOpaque };
}

/** Encode RGB bytes as a colour-type-2 (24-bit, no alpha) PNG. */
export function encodeRgbPng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none. Deterministic output for a deterministic input.
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 — truecolour, NO alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // non-interlaced
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Chrome's RGBA screenshot in, a store-acceptable 24-bit PNG out. */
export function toStorePng(pngBuffer) {
  const { width, height, rgb, nonOpaque } = decodeToRgb(pngBuffer);
  return { png: encodeRgbPng({ width, height, rgb }), width, height, nonOpaque };
}

/**
 * Paste one screenshot over another at (x, y), with a hairline border and a soft shadow.
 *
 * WHY COMPOSITING IS THE HONEST OPTION HERE, NOT A CHEAT
 * A browser cannot screenshot its own extension popup together with the page underneath it: the
 * popup is a separate top-level surface that CDP captures on its own, and the page capture does not
 * include it. So "the popup over a posting" is not obtainable in one shot by any means. Both halves
 * of this composite are REAL — the popup is rendered by the extension from its own popup.html,
 * having genuinely resolved the posting as the active tab, and the page behind is the fixture
 * posting as actually served. Nothing is drawn, mocked or retouched; two true captures are placed
 * in the spatial relationship the user actually sees.
 *
 * The shadow is a flat darkening, not a gaussian: it exists so the popup reads as a separate
 * surface rather than as part of the page, and anything more would be decorating the evidence.
 */
export function compositeRgb(base, overlay, x, y, { border = [190, 190, 190], shadow = 10 } = {}) {
  const out = Buffer.from(base.rgb);
  const put = (px, py, [r, g, b], strength = 1) => {
    if (px < 0 || py < 0 || px >= base.width || py >= base.height) return;
    const i = (py * base.width + px) * 3;
    out[i]     = Math.round(out[i]     * (1 - strength) + r * strength);
    out[i + 1] = Math.round(out[i + 1] * (1 - strength) + g * strength);
    out[i + 2] = Math.round(out[i + 2] * (1 - strength) + b * strength);
  };

  for (let s = shadow; s >= 1; s--) {
    const a = 0.045 * (1 - s / (shadow + 1));
    for (let py = y - s; py < y + overlay.height + s; py++) {
      for (let px = x - s; px < x + overlay.width + s; px++) {
        const inside = px >= x - s + 1 && px < x + overlay.width + s - 1 &&
                       py >= y - s + 1 && py < y + overlay.height + s - 1;
        if (!inside) put(px, py, [0, 0, 0], a);
      }
    }
  }

  for (let py = 0; py < overlay.height; py++) {
    for (let px = 0; px < overlay.width; px++) {
      const si = (py * overlay.width + px) * 3;
      put(x + px, y + py, [overlay.rgb[si], overlay.rgb[si + 1], overlay.rgb[si + 2]]);
    }
  }

  for (let px = -1; px <= overlay.width; px++) { put(x + px, y - 1, border); put(x + px, y + overlay.height, border); }
  for (let py = -1; py <= overlay.height; py++) { put(x - 1, y + py, border); put(x + overlay.width, y + py, border); }

  return { width: base.width, height: base.height, rgb: out };
}
