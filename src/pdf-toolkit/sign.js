// ── PDF toolkit · signatures (A203, owner 11-13: "the signature one, both initials and vector extractor from upload") ──
//
// Every signature this toolkit places is VECTOR — a path a PDF draws at any zoom, never a pasted picture:
//   · traced from an upload  traceInk(imageData)  — a photo or scan of a signature on paper → filled outlines
//   · typed                  the page draws the name in a script face on a canvas and traces it the same way
//   · drawn                  strokesToPath(strokes) — the pointer's strokes, smoothed, drawn as round-capped lines
//
// ⛔ Imports nothing and touches no DOM: `imageData` is { width, height, data: RGBA bytes } (a canvas's ImageData, or
// built by hand under node --test). Everything runs in the visitor's browser; nothing is uploaded.

/** Otsu's threshold over a 256-bin histogram: the level that best splits ink from paper. */
export function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, level = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; level = t; }
  }
  return level;
}

/**
 * Which pixels are ink: dark against light paper (Otsu), a transparent pixel is paper, specks smaller than `minSpeck`
 * pixels are dropped (dust, paper grain), and a picture that is mostly "ink" is read as light-on-dark and inverted.
 * @returns { mask: Uint8Array (1 = ink), width, height, level, inkPixels }
 */
export function inkMask(imageData, { level = null, minSpeck = null } = {}) {
  const { width: w, height: h, data } = imageData;
  if (!w || !h || !data || data.length < w * h * 4) throw new Error("not an image");
  const lum = new Uint8Array(w * h);
  const hist = new Array(256).fill(0);
  let opaque = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = data[p + 3];
    // transparent → paper (white); otherwise the luminance, composited over white
    const k = a / 255;
    const y = Math.round((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * k + 255 * (1 - k));
    lum[i] = y;
    if (a >= 128) { hist[y]++; opaque++; }
  }
  const t = level ?? otsu(hist, opaque || 1);
  let mask = new Uint8Array(w * h);
  let ink = 0;
  for (let i = 0; i < w * h; i++) if (lum[i] <= t && data[i * 4 + 3] >= 128) { mask[i] = 1; ink++; }
  if (ink > w * h * 0.6) {   // light ink on a dark ground
    for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] >= 128 && !mask[i] ? 1 : 0;
    ink = mask.reduce((n, v) => n + v, 0);
  }
  const speck = minSpeck ?? Math.max(4, Math.round(w * h * 0.00004));
  ink = dropSpecks(mask, w, h, speck);
  return { mask, width: w, height: h, level: t, inkPixels: ink };
}

/** Remove 8-connected ink regions smaller than `min` pixels, in place. Returns the ink left. */
function dropSpecks(mask, w, h, min) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let left = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let n = 0, top = 0;
    const region = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top]; region.push(i); n++;
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (n < min) for (const i of region) mask[i] = 0; else left += n;
  }
  return left;
}

/**
 * The outlines of the ink: every boundary between an ink pixel and a paper pixel, chained into closed loops — outer
 * edges clockwise, holes (the inside of an "o") counter-clockwise, so the non-zero fill rule draws them right.
 * @returns Array<Array<[x, y]>> in pixel-corner coordinates
 */
export function outlines(mask, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const W = w + 1;
  const out = new Map();   // vertex → [next vertices]
  const add = (x0, y0, x1, y1) => {
    const k = y0 * W + x0;
    const v = out.get(k); const e = y1 * W + x1;
    if (v) v.push(e); else out.set(k, [e]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  const loops = [];
  for (const [start] of out) {
    while (out.get(start)?.length) {
      const loop = [];
      let v = start, prevDir = null;
      do {
        const nexts = out.get(v);
        // at a saddle (two ink pixels touching only at a corner) turn the same way every time, so loops never cross
        let pick = 0;
        if (nexts.length > 1 && prevDir) {
          const vx = v % W, vy = (v - vx) / W;
          const score = (e) => { const ex = e % W, ey = (e - ex) / W; const d = [ex - vx, ey - vy]; return prevDir[0] * d[1] - prevDir[1] * d[0]; };
          pick = nexts.map(score).reduce((bi, s, i, a) => (s > a[bi] ? i : bi), 0);
        }
        const e = nexts.splice(pick, 1)[0];
        if (!nexts.length) out.delete(v);
        const vx = v % W, vy = (v - vx) / W, ex = e % W, ey = (e - ex) / W;
        loop.push([vx, vy]);
        prevDir = [ex - vx, ey - vy];
        v = e;
      } while (v !== start && out.has(v));
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop: keep the corners that matter, within `eps` pixels. */
export function simplifyLoop(pts, eps = 0.8) {
  if (pts.length <= 4) return pts;
  // split the loop at the point farthest from the first, simplify both halves as open lines
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = rdp(pts.slice(0, far + 1), eps), b = rdp([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

const r1 = (n) => Math.round(n * 10) / 10;

/** A closed loop as a smooth path: quadratic curves through the midpoints of its edges. */
function smoothLoop(pts, dx = 0, dy = 0) {
  const n = pts.length;
  const mid = (i) => { const a = pts[i % n], b = pts[(i + 1) % n]; return [(a[0] + b[0]) / 2 - dx, (a[1] + b[1]) / 2 - dy]; };
  const m0 = mid(0);
  let d = `M${r1(m0[0])} ${r1(m0[1])}`;
  for (let i = 1; i <= n; i++) { const c = pts[i % n], m = mid(i); d += `Q${r1(c[0] - dx)} ${r1(c[1] - dy)} ${r1(m[0])} ${r1(m[1])}`; }
  return `${d}Z`;
}

/**
 * Trace a signature (or initials) picture to vector outlines.
 * @param imageData  { width, height, data } — RGBA; the page scales a photo to ≤ ~1200 px first
 * @param opts       { level?: 0–255 (blank = Otsu), minSpeck?: px, eps?: simplify tolerance in px }
 * @returns { d, width, height, loops, level, inkPixels } — `d` an SVG path in a width × height box cropped to the
 *          ink (fill it, non-zero); null when no ink was found
 */
export function traceInk(imageData, { level = null, minSpeck = null, eps = 0.8 } = {}) {
  const m = inkMask(imageData, { level, minSpeck });
  if (!m.inkPixels) return null;
  const { mask, width: w, height: h } = m;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pad = 2;
  const ox = Math.max(0, x0 - pad), oy = Math.max(0, y0 - pad);
  const loops = outlines(mask, w, h).map(l => simplifyLoop(l, eps)).filter(l => l.length >= 3);
  return { d: loops.map(l => smoothLoop(l, ox, oy)).join(""), width: Math.min(w, x1 + pad + 1) - ox, height: Math.min(h, y1 + pad + 1) - oy,
    loops: loops.length, level: m.level, inkPixels: m.inkPixels };
}

/**
 * Drawn strokes → one smooth path, drawn as lines (not filled). Each stroke is [{x, y}…] in the pad's pixels; a tap is
 * a dot. The box is cropped to the ink with room for the line's width.
 * @returns { d, width, height, strokeWidth } or null when nothing was drawn
 */
export function strokesToPath(strokes, { strokeWidth = 3 } = {}) {
  const kept = (strokes || []).filter(s => s && s.length);
  if (!kept.length) return null;
  const all = kept.flat();
  const pad = strokeWidth;
  const ox = Math.min(...all.map(p => p.x)) - pad, oy = Math.min(...all.map(p => p.y)) - pad;
  const width = Math.max(...all.map(p => p.x)) + pad - ox, height = Math.max(...all.map(p => p.y)) + pad - oy;
  let d = "";
  for (const s of kept) {
    const p = s.map(q => [q.x - ox, q.y - oy]);
    if (p.length === 1) { d += `M${r1(p[0][0])} ${r1(p[0][1])}l0.01 0`; continue; }
    d += `M${r1(p[0][0])} ${r1(p[0][1])}`;
    for (let i = 1; i < p.length - 1; i++) {
      const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
      d += `Q${r1(p[i][0])} ${r1(p[i][1])} ${r1(m[0])} ${r1(m[1])}`;
    }
    const last = p[p.length - 1];
    d += `L${r1(last[0])} ${r1(last[1])}`;
  }
  return { d, width: Math.max(1, width), height: Math.max(1, height), strokeWidth };
}

/** A standalone SVG file of a signature, to keep (A203: "vector extractor from upload" — the vector is theirs). */
export function svgOf(sig, color = "#111111") {
  const body = sig.strokeWidth
    ? `<path d="${sig.d}" fill="none" stroke="${color}" stroke-width="${sig.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${sig.d}" fill="${color}" fill-rule="nonzero"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(sig.width)} ${r1(sig.height)}" width="${r1(sig.width)}" height="${r1(sig.height)}">${body}</svg>\n`;
}
