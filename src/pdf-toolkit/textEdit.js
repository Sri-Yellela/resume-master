// ── PDF toolkit · inline text editing, the page's own text (A203 (2), owner 11-13: "what i want is to be able to edit a pdf
// text as inline, so upload pdf and its editable wherever, just live draft, not add more text") ───────────────────────
//
// To CHANGE words a PDF already shows, their drawing has to leave the page — a box painted over them would leave the old
// words in the file (search, copy, an employer's parser). This reads a page's content stream the way a viewer does:
// tokens → operators, the graphics state (q / Q / cm) and the text state (BT, Tm, Td, TD, T*, TL, Tf, Tc, Tw, Tz, Ts),
// and for every text-showing operator (Tj, TJ, ', ") where its glyphs start and end in user space. An operator whose
// glyphs sit inside an edited run is replaced by a pure DISPLACEMENT of the same advance ([-k] TJ), so the text matrix —
// and every word after it on the page — stays exactly where it was. Nothing else in the stream is touched.
//
// ⛔ Imports nothing (latin1 strings in and out; the caller decodes / encodes the stream and resolves fonts).

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/**
 * Tokenise a content stream (a latin1 string). Returns tokens { t: kind, v, s, e } — kinds: num, str (v = bytes as a
 * latin1 string), hex, name, op, '[' ']' '<<' '>>', and 'inline' (a whole BI … ID … EI image, kept verbatim).
 */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const code = (k) => src.charCodeAt(k);
  while (i < n) {
    const c = code(i);
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && code(i) !== 10 && code(i) !== 13) i++; continue; }   // % comment
    const s = i;
    if (c === 40) {   // ( literal string )
      let depth = 1, v = ""; i++;
      while (i < n && depth) {
        let ch = src[i];
        if (ch === "\\") {
          const nx = src[i + 1];
          const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
          if (nx in map) { v += map[nx]; i += 2; continue; }
          if (nx === "\r" || nx === "\n") { i += 2; if (nx === "\r" && src[i] === "\n") i++; continue; }
          if (/[0-7]/.test(nx)) { let o = ""; i++; while (o.length < 3 && /[0-7]/.test(src[i])) o += src[i++]; v += String.fromCharCode(parseInt(o, 8) & 255); continue; }
          i++; continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (!depth) { i++; break; } }
        v += ch; i++;
      }
      out.push({ t: "str", v, s, e: i });
      continue;
    }
    if (c === 60 && code(i + 1) === 60) { out.push({ t: "<<", s, e: i + 2 }); i += 2; continue; }
    if (c === 62 && code(i + 1) === 62) { out.push({ t: ">>", s, e: i + 2 }); i += 2; continue; }
    if (c === 60) {   // <hex>
      i++; let h = "";
      while (i < n && code(i) !== 62) { if (!WS.has(code(i))) h += src[i]; i++; }
      i++;
      if (h.length % 2) h += "0";
      let v = ""; for (let k = 0; k < h.length; k += 2) v += String.fromCharCode(parseInt(h.slice(k, k + 2), 16) || 0);
      out.push({ t: "str", v, s, e: i, hex: true });
      continue;
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) { out.push({ t: src[i], s, e: i + 1 }); i++; continue; }
    if (c === 47) {   // /Name
      i++; while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
      out.push({ t: "name", v: src.slice(s + 1, i), s, e: i });
      continue;
    }
    if (c === 41 || c === 62) { i++; continue; }   // a stray closer — skip it
    while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
    const word = src.slice(s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { out.push({ t: "num", v: Number(word), s, e: i }); continue; }
    if (word === "BI") {   // an inline image: everything to the EI that follows its ID data, verbatim
      const id = src.indexOf("ID", i);
      let k = id < 0 ? n : id + 3;
      while (k < n) {
        const ei = src.indexOf("EI", k);
        if (ei < 0) { k = n; break; }
        if (WS.has(code(ei - 1)) && (ei + 2 >= n || WS.has(code(ei + 2)))) { k = ei + 2; break; }
        k = ei + 2;
      }
      out.push({ t: "inline", s, e: k }); i = k;
      continue;
    }
    out.push({ t: "op", v: word, s, e: i });
  }
  return out;
}

/** Tokens → operators, each with its operands as values: { op, args, s, e } (s / e: the source span incl. operands). */
export function parseOps(tokens) {
  const ops = [];
  let stack = [], start = null;
  const value = (k) => {   // read one operand value from tokens[k]; returns [value, nextIndex]
    const t = tokens[k];
    if (t.t === "[") { const arr = []; k++; while (k < tokens.length && tokens[k].t !== "]") { const [v, nk] = value(k); arr.push(v); k = nk; } return [arr, k + 1]; }
    if (t.t === "<<") { let depth = 1; k++; while (k < tokens.length && depth) { if (tokens[k].t === "<<") depth++; else if (tokens[k].t === ">>") depth--; k++; } return [{ dict: true }, k]; }
    if (t.t === "num") return [t.v, k + 1];
    if (t.t === "str") return [{ str: t.v }, k + 1];
    if (t.t === "name") return [{ name: t.v }, k + 1];
    return [null, k + 1];
  };
  for (let k = 0; k < tokens.length;) {
    const t = tokens[k];
    if (t.t === "op" || t.t === "inline") {
      ops.push({ op: t.t === "inline" ? "BI" : t.v, args: stack, s: start ?? t.s, e: t.e });
      stack = []; start = null; k++;
      continue;
    }
    if (start == null) start = t.s;
    const [v, nk] = value(k);
    stack.push(v); k = nk;
  }
  return ops;
}

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const I = [1, 0, 0, 1, 0, 0];

/**
 * Walk the operators and report every text-showing one: { index, start: [x, y], end: [x, y], size (user-space height),
 * advance (text-space tx), Tfs, Th, op } in USER space. `fontWidths(name)` → { width(code) in 1/1000 em, bytes: 1 | 2 }.
 */
export function textRuns(ops, fontWidths = () => null) {
  const runs = [];
  let ctm = I.slice(); const stack = [];
  let Tm = I.slice(), Tlm = I.slice(), Tc = 0, Tw = 0, Th = 1, TL = 0, Tfs = 0, Trise = 0, font = null;
  const num = (a, k) => (typeof a[k] === "number" ? a[k] : 0);
  const show = (index, op, parts) => {
    const fw = (font && fontWidths(font)) || { width: () => 500, bytes: 1 };
    const trm0 = mul([Tfs * Th, 0, 0, Tfs, 0, Trise], mul(Tm, ctm));
    let tx = 0;
    for (const p of parts) {
      if (typeof p === "number") { tx += (-p / 1000) * Tfs * Th; continue; }
      if (!p || typeof p.str !== "string") continue;
      const b = p.str, step = fw.bytes === 2 ? 2 : 1;
      for (let k = 0; k + step - 1 < b.length; k += step) {
        const c = step === 2 ? (b.charCodeAt(k) << 8) | b.charCodeAt(k + 1) : b.charCodeAt(k);
        tx += ((fw.width(c) / 1000) * Tfs + Tc + (step === 1 && c === 32 ? Tw : 0)) * Th;
      }
    }
    Tm = mul([1, 0, 0, 1, tx, 0], Tm);
    const trm1 = mul([Tfs * Th, 0, 0, Tfs, 0, Trise], mul(Tm, ctm));
    runs.push({ index, op, start: [trm0[4], trm0[5]], end: [trm1[4], trm1[5]], size: Math.hypot(trm0[2], trm0[3]) || Math.abs(Tfs), advance: tx, Tfs, Th,
      text: parts.filter(p => p && typeof p.str === "string").map(p => p.str).join("") });
  };
  ops.forEach((o, index) => {
    const a = o.args;
    switch (o.op) {
      case "q": stack.push(ctm.slice()); break;
      case "Q": ctm = stack.pop() || I.slice(); break;
      case "cm": ctm = mul([num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)], ctm); break;
      case "BT": Tm = I.slice(); Tlm = I.slice(); break;
      case "Tm": Tm = [num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)]; Tlm = Tm.slice(); break;
      case "Td": Tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], Tlm); Tm = Tlm.slice(); break;
      case "TD": TL = -num(a, 1); Tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], Tlm); Tm = Tlm.slice(); break;
      case "T*": Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); break;
      case "TL": TL = num(a, 0); break;
      case "Tc": Tc = num(a, 0); break;
      case "Tw": Tw = num(a, 0); break;
      case "Tz": Th = num(a, 0) / 100; break;
      case "Ts": Trise = num(a, 0); break;
      case "Tf": font = a[0]?.name ?? null; Tfs = num(a, 1); break;
      case "Tj": show(index, "Tj", [a[0]]); break;
      case "TJ": show(index, "TJ", Array.isArray(a[0]) ? a[0] : []); break;
      case "'": Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); show(index, "'", [a[0]]); break;
      case "\"": Tw = num(a, 0); Tc = num(a, 1); Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); Tm = Tlm.slice(); show(index, "\"", [a[2]]); break;
      default: break;
    }
  });
  return runs;
}

/**
 * A run's frame from a pdf.js text item: origin, direction, its length and height in user space.
 * @param box { transform: [a, b, c, d, e, f], width, height }
 */
export function frameOf(box) {
  const [a, b, c, d, e, f] = box.transform;
  const ul = Math.hypot(a, b) || 1, vl = Math.hypot(c, d) || 1;
  return { o: [e, f], u: [a / ul, b / ul], v: [c / vl, d / vl], len: Math.max(0, Number(box.width) || 0), h: Math.max(1, Number(box.height) || vl) };
}
const local = (fr, p) => { const dx = p[0] - fr.o[0], dy = p[1] - fr.o[1]; return [dx * fr.u[0] + dy * fr.u[1], dx * fr.v[0] + dy * fr.v[1]]; };

/** Does text-run `r` (start → end) lie on box `fr`'s line, mostly inside it? */
export function runInBox(r, fr) {
  const a = local(fr, r.start), b = local(fr, r.end);
  const tolV = fr.h * 0.35, tolH = Math.max(1, fr.h * 0.3);
  if (Math.abs(a[1]) > tolV || Math.abs(b[1]) > tolV) return false;   // a different line
  const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
  if (hi - lo < 0.01) return lo >= -tolH && lo <= fr.len + tolH;
  const overlap = Math.min(hi, fr.len + tolH) - Math.max(lo, -tolH);
  return overlap > (hi - lo) * 0.5;
}
/** Does text-run `r` touch box `fr` at all (on its line)? — used to find the neighbours a removed operator also drew. */
export function runTouches(r, fr) {
  const a = local(fr, r.start), b = local(fr, r.end);
  const tolV = fr.h * 0.35;
  if (Math.abs(a[1]) > tolV || Math.abs(b[1]) > tolV) return false;
  const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
  return hi > 0.5 && lo < fr.len - 0.5;
}

const fmt = (n) => (Math.abs(n) < 1e-6 ? "0" : String(Math.round(n * 1000) / 1000));

/**
 * Remove the drawing of the edited boxes from a content stream.
 * @param src         the page's content (latin1)
 * @param boxes       edited runs [{ transform, width, height }] (user space, as pdf.js reports them)
 * @param fontWidths  name → { width(code), bytes } | null
 * @returns { content, removed: [count per box], touched: Set of operator indices removed, runs (every text run seen) }
 */
export function stripText(src, boxes, fontWidths) {
  const ops = parseOps(tokenize(src));
  const runs = textRuns(ops, fontWidths);
  const frames = boxes.map(frameOf);
  const removed = boxes.map(() => 0);
  const drop = new Map();   // op index → its run
  for (const r of runs) {
    const hit = frames.findIndex(fr => runInBox(r, fr));
    if (hit >= 0) { removed[hit]++; drop.set(r.index, r); }
  }
  if (!drop.size) return { content: src, removed, touched: new Set(), runs, dropped: [] };
  let out = "", at = 0;
  for (const [index, r] of [...drop.entries()].sort((x, y) => x[0] - y[0])) {
    const o = ops[index];
    const k = r.Tfs * r.Th ? -(r.advance * 1000) / (r.Tfs * r.Th) : 0;
    const move = r.op === "'" ? "T* " : r.op === "\"" ? `${fmt(o.args[0])} Tw ${fmt(o.args[1])} Tc T* ` : "";
    out += src.slice(at, o.s) + `${move}[${fmt(k)}] TJ`;
    at = o.e;
  }
  out += src.slice(at);
  return { content: out, removed, touched: new Set(drop.keys()), runs, dropped: [...drop.values()] };
}
