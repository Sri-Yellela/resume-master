// ── PDF toolkit · Edit PDF and Sign PDF, the browser half (A203, owner 11-13) ─────────────────────────────────────────
//
// "the basic pdf editor … and also the signature one, both initials and vector extractor from upload."
//
// One page surface for both tools: the PDF's pages drawn by pdf.js, a layer over each where the person places items,
// drags them and resizes them; Save writes them into the PDF (core.applyEdits). Every signature is vector (sign.js):
// drawn → smoothed lines; typed → the name in a script face, traced; uploaded → the photo's ink, traced. The traced or
// drawn signature can also be kept as an SVG file.
//
// Positions are fractions of the SHOWN page (pdf.js applies the page's /Rotate), so core places them upright on a turned
// page. ⭐ Nothing leaves this browser: the PDF, the photo and the signature stay in memory, and nothing is stored.

import { traceInk, strokesToPath, svgOf } from "./sign.js";

const SCRIPT_FACES = [
  ["Segoe Script", "Flowing"],
  ["Brush Script MT", "Brush"],
  ["Lucida Handwriting", "Upright"],
  ["cursive", "This device's script face"],
];
const INKS = [["0.07,0.07,0.12", "Black ink", "#12121f"], ["0.05,0.18,0.55", "Blue ink", "#0d2e8c"]];
const MAX_TRACE = 1200;   // a photo is scaled to this long side before tracing — enough for a crisp outline

/**
 * @param h     the toolkit's helpers: { el, lib, pdfjs, core, status, say, fail, results, download, fileInput, base, readBytes }
 * @param mode  "edit" (text, white-out, picture, signature, initials) or "sign" (signature, initials, date, name)
 * @returns the panel's nodes
 */
export function buildPageEditor(h, mode = "edit") {
  const { el, lib, pdfjs, core, say, fail } = h;
  const input = h.fileInput();
  const s = h.status(), out = h.results();
  const pagesBox = el("div", { class: "pt-ed-pages", "data-pt-ed-pages": true });
  const items = [];
  let bytes = null, file = null, doc = null, armed = null, nextId = 1;
  const slots = { signature: null, initials: null };   // { d, width, height, strokeWidth?, color, colorHex }

  // ── the palette ──
  const TOOLS = mode === "sign"
    ? [["signature", "Signature"], ["initials", "Initials"], ["date", "Date"], ["name", "Name"]]
    : [["text", "Text"], ["whiteout", "White-out"], ["image", "Picture"], ["signature", "Signature"], ["initials", "Initials"]];
  const palette = el("div", { class: "pt-ed-palette", role: "toolbar", "aria-label": "Add to a page" });
  const hint = el("p", { class: "pt-muted pt-ed-hint" }, "Choose a PDF, then pick what to add and click where it goes on a page.");
  const imagePick = h.fileInput(false, "image/jpeg,image/png");
  let pendingImage = null;
  const arm = (kind) => {
    armed = kind;
    for (const b of palette.children) b.setAttribute("aria-pressed", String(b.dataset.add === kind));
    hint.textContent = !doc ? "Choose a PDF first." : kind ? `Click on a page to place the ${labelOf(kind).toLowerCase()}. Esc to stop.` : "Pick what to add, then click where it goes.";
  };
  const labelOf = (k) => (TOOLS.find(t => t[0] === k) || [k, k])[1];
  for (const [kind, label] of TOOLS) {
    palette.append(el("button", { type: "button", class: "pt-btn pt-ed-add", "data-add": kind, "aria-pressed": "false", onclick: async () => {
      if (!doc) return say(s, "Choose a PDF first.", "bad");
      if (armed === kind) return arm(null);
      if ((kind === "signature" || kind === "initials") && !slots[kind]) { maker.open(kind); return; }
      if (kind === "image") { imagePick.click(); return; }
      arm(kind);
    } }, label));
  }
  imagePick.addEventListener("change", async () => {
    const f = imagePick.files?.[0]; imagePick.value = "";
    if (!f) return;
    const b = await h.readBytes(f);
    if (!core.sniffImage(b)) return say(s, "A picture must be a JPEG or PNG.", "bad");
    const bmp = await createImageBitmap(new Blob([b])).catch(() => null);
    pendingImage = { bytes: b, url: URL.createObjectURL(new Blob([b])), ratio: bmp ? bmp.height / bmp.width : 1 };
    bmp?.close?.();
    arm("image");
  });
  const edits = el("div", { class: "pt-ed-slots" });
  const drawSlots = () => {
    edits.replaceChildren(...["signature", "initials"].filter(k => slots[k]).map(k => el("span", { class: "pt-ed-slot" },
      el("span", { class: "pt-muted" }, `${labelOf(k) || (k === "initials" ? "Initials" : "Signature")}: `),
      svgNode(slots[k], "pt-ed-slotsvg"),
      el("button", { type: "button", class: "pt-mini", onclick: () => maker.open(k) }, "Change"),
      el("a", { class: "pt-mini", download: `${k}.svg`, href: URL.createObjectURL(new Blob([svgOf(slots[k], slots[k].colorHex)], { type: "image/svg+xml" })) }, "SVG"))));
  };

  // ── the pages ──
  input.addEventListener("change", async () => {
    file = input.files?.[0]; if (!file) return;
    items.length = 0; pagesBox.replaceChildren(); out.replaceChildren();
    say(s, "Reading pages…");
    try {
      bytes = await h.readBytes(file);
      await core.info(lib, bytes);   // a locked or broken PDF says so before anything is drawn
      if (doc) await doc.destroy();
      doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
        .catch(e => { throw new core.ToolkitError(e?.name === "PasswordException" ? "This PDF is password-protected. Unlock it first." : "This file could not be read as a PDF."); });
      for (let n = 1; n <= doc.numPages; n++) await drawPage(n);
      say(s, `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}. ${mode === "sign" ? "Add your signature, then save." : "Add what you need, then save."}`);
      arm(null);
    } catch (e) { doc = null; fail(s, e); }
  });

  async function drawPage(n) {
    const page = await doc.getPage(n);
    const pts = page.getViewport({ scale: 1 });            // the SHOWN page in points (its /Rotate applied)
    const vp = page.getViewport({ scale: 1.6 });
    const canvas = el("canvas", { class: "pt-ed-canvas", width: Math.ceil(vp.width), height: Math.ceil(vp.height), "aria-hidden": "true" });
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    page.cleanup();
    const layer = el("div", { class: "pt-ed-layer", "data-page": n - 1 });
    const wrap = el("figure", { class: "pt-ed-page", "data-pt-ed-page": n, style: `aspect-ratio: ${pts.width} / ${pts.height}` },
      canvas, layer, el("figcaption", { class: "pt-muted" }, `Page ${n}`));
    wrap.dataset.ptsW = pts.width; wrap.dataset.ptsH = pts.height;
    // px per point on screen, for text sizes — kept current as the page resizes
    new ResizeObserver(() => layer.style.setProperty("--pt-k", String(layer.clientHeight / pts.height))).observe(layer);
    layer.addEventListener("click", (e) => {
      if (!armed || e.target !== layer) return;
      const r = layer.getBoundingClientRect();
      place(n - 1, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, wrap);
    });
    pagesBox.append(wrap);
  }

  function place(page, fx, fy, wrap) {
    const W = Number(wrap.dataset.ptsW), H = Number(wrap.dataset.ptsH);
    const sizeFrac = (wPts, hPts) => [Math.min(0.9, wPts / W), Math.min(0.9, hPts / H)];
    let it;
    if (armed === "signature" || armed === "initials") {
      const sig = slots[armed];
      const wPts = armed === "initials" ? 60 : 160;
      const hPts = wPts * sig.height / sig.width;
      const [fw, fh] = sizeFrac(wPts, hPts);
      it = { kind: "svg", sig, fw, fh };
    } else if (armed === "text" || armed === "name" || armed === "date") {
      const text = armed === "date" ? new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
      const [fw, fh] = sizeFrac(armed === "date" ? 130 : 180, 20);
      it = { kind: "text", text, size: 12, fw, fh, placeholder: armed === "name" ? "Your name" : "Type here" };
    } else if (armed === "whiteout") {
      const [fw, fh] = sizeFrac(120, 18);
      it = { kind: "whiteout", fw, fh };
    } else if (armed === "image" && pendingImage) {
      const [fw] = sizeFrac(140, 0);
      it = { kind: "image", image: pendingImage, fw, fh: (fw * W * pendingImage.ratio) / H };
    } else return;
    it.id = nextId++; it.page = page;
    it.fx = Math.max(0, Math.min(1 - it.fw, fx - it.fw / 2)); it.fy = Math.max(0, Math.min(1 - it.fh, fy - it.fh / 2));
    items.push(it);
    drawItem(it, wrap.querySelector(".pt-ed-layer"));
    if (armed === "image") arm(null);
  }

  function drawItem(it, layer) {
    const box = el("div", { class: `pt-ed-item pt-ed-item--${it.kind}`, tabindex: "0", "data-item": it.id,
      "aria-label": it.kind === "svg" ? "Signature — drag to move, Delete to remove" : `${it.kind} — drag to move, Delete to remove` });
    const pos = () => Object.assign(box.style, { left: `${it.fx * 100}%`, top: `${it.fy * 100}%`, width: `${it.fw * 100}%`, height: `${it.fh * 100}%` });
    pos();
    if (it.kind === "svg") box.append(svgNode(it.sig, "pt-ed-sig"));
    else if (it.kind === "image") box.append(el("img", { src: it.image.url, alt: "" }));
    else if (it.kind === "text") {
      const ta = el("textarea", { class: "pt-ed-text", rows: "1", placeholder: it.placeholder, "aria-label": "Text on the page", spellcheck: "true" });
      ta.value = it.text;
      ta.style.fontSize = `calc(var(--pt-k, 1) * ${it.size}px)`;
      ta.addEventListener("input", () => { it.text = ta.value; });
      const sz = (d) => { it.size = Math.max(6, Math.min(72, it.size + d)); ta.style.fontSize = `calc(var(--pt-k, 1) * ${it.size}px)`; };
      box.append(ta, el("span", { class: "pt-ed-tools" },
        el("button", { type: "button", class: "pt-mini", "aria-label": "Smaller text", onclick: () => sz(-1) }, "A−"),
        el("button", { type: "button", class: "pt-mini", "aria-label": "Larger text", onclick: () => sz(1) }, "A+")));
      setTimeout(() => ta.focus(), 0);
    }
    const remove = () => { items.splice(items.indexOf(it), 1); box.remove(); };
    box.append(
      el("button", { type: "button", class: "pt-ed-x", "aria-label": "Remove", onclick: remove }, "✕"),
      el("span", { class: "pt-ed-grip", "aria-hidden": "true" }),
      el("span", { class: "pt-ed-resize", "aria-hidden": "true" }));
    box.addEventListener("keydown", (e) => {
      if (e.target !== box) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
      const step = e.shiftKey ? 0.02 : 0.004;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (mv) { e.preventDefault(); it.fx = clamp(it.fx + mv[0], 0, 1 - it.fw); it.fy = clamp(it.fy + mv[1], 0, 1 - it.fh); pos(); }
    });
    // drag to move (anywhere but the text and the buttons); the corner resizes — a signature or picture keeps its shape
    box.addEventListener("pointerdown", (e) => {
      if (e.target.closest("textarea, button")) return;
      e.preventDefault();
      const resizing = e.target.classList.contains("pt-ed-resize");
      const r = layer.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh };
      const keep = it.kind === "svg" || it.kind === "image";
      box.setPointerCapture(e.pointerId);
      const move = (m) => {
        const dx = (m.clientX - start.x) / r.width, dy = (m.clientY - start.y) / r.height;
        if (resizing) {
          it.fw = clamp(start.fw + dx, 0.02, 1 - it.fx);
          it.fh = keep ? Math.min(1 - it.fy, it.fw * (start.fh / start.fw)) : clamp(start.fh + dy, 0.012, 1 - it.fy);
          if (keep) it.fw = it.fh * (start.fw / start.fh);
        } else { it.fx = clamp(start.fx + dx, 0, 1 - it.fw); it.fy = clamp(start.fy + dy, 0, 1 - it.fh); }
        pos();
      };
      const up = () => { box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up); };
      box.addEventListener("pointermove", move); box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
    });
    layer.append(box);
  }

  // ── save ──
  const save = el("button", { type: "button", class: "pt-btn pt-primary", "data-pt-ed-save": true, onclick: async () => {
    if (!bytes) return say(s, "Choose a PDF first.", "bad");
    out.replaceChildren(); save.disabled = true; say(s, "Writing it into the PDF…");
    try {
      const placed = items.map(it => {
        const at = { page: it.page, fx: it.fx, fy: it.fy, fw: it.fw, fh: it.fh };
        if (it.kind === "svg") return { ...at, kind: "svg", d: it.sig.d, vbw: it.sig.width, vbh: it.sig.height, strokeWidth: it.sig.strokeWidth || null, color: it.sig.color };
        if (it.kind === "image") return { ...at, kind: "image", image: it.image.bytes };
        if (it.kind === "text") return { ...at, kind: "text", text: it.text, size: it.size };
        return { ...at, kind: "whiteout" };
      }).filter(x => x.kind !== "text" || String(x.text).trim());
      const result = await core.applyEdits(lib, bytes, placed);
      h.download(out, result, `${h.base(file.name)}-${mode === "sign" ? "signed" : "edited"}.pdf`);
      say(s, `${placed.length} item${placed.length === 1 ? "" : "s"} written into the PDF.${placed.some(p => p.kind === "whiteout") ? " A white-out covers what is under it; the text beneath is still in the file." : ""}`, "good");
    } catch (e) { fail(s, e); } finally { save.disabled = false; }
  } }, mode === "sign" ? "Save the signed PDF" : "Save the PDF");

  // ── the signature maker ──
  const maker = signatureMaker(h, (kind, sig) => { slots[kind] = sig; drawSlots(); arm(kind); });

  const onKey = (e) => { if (e.key === "Escape" && armed) arm(null); };
  document.addEventListener("keydown", onKey);

  return [el("label", { class: "pt-field" }, "PDF", input), palette, edits, maker.node, hint, pagesBox, save, s, out];
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function svgNode(sig, cls) {   // D189 P2: the workspace draws signatures with it too
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${sig.width} ${sig.height}`);
  svg.setAttribute("class", cls);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", sig.d);
  if (sig.strokeWidth) { p.setAttribute("fill", "none"); p.setAttribute("stroke", sig.colorHex || "#12121f"); p.setAttribute("stroke-width", sig.strokeWidth); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round"); }
  else p.setAttribute("fill", sig.colorHex || "#12121f");
  svg.append(p);
  return svg;
}

/** Draw / Type / Upload a signature or initials. `onUse(kind, sig)` receives the vector signature. */
export function signatureMaker(h, onUse) {
  const { el } = h;
  let kind = "signature", how = "draw", current = null;
  const node = el("section", { class: "pt-ed-maker", hidden: true, "aria-label": "Make your signature", "data-pt-ed-maker": true });
  const title = el("h3", { class: "pt-ed-title" }, "Your signature");
  const tabs = el("div", { class: "pt-tabs", role: "tablist" });
  const body = el("div", { class: "pt-ed-body" });
  const preview = el("div", { class: "pt-ed-preview", "aria-live": "polite" });
  const msg = el("p", { class: "pt-muted" });
  const ink = el("select", { class: "pt-text", "aria-label": "Ink" }, ...INKS.map(([v, l]) => el("option", { value: v }, l)));
  const use = el("button", { type: "button", class: "pt-btn pt-primary", disabled: true, "data-pt-ed-use": true }, "Use it");
  const svgLink = el("a", { class: "pt-btn", hidden: true, download: "signature.svg" }, "Download as SVG");
  const cancel = el("button", { type: "button", class: "pt-btn", onclick: () => { node.hidden = true; } }, "Cancel");
  const inkOf = () => { const o = INKS.find(i => i[0] === ink.value) || INKS[0]; return { color: o[0].split(",").map(Number), colorHex: o[2] }; };
  const show = (sig, note = "") => {
    current = sig ? { ...sig, ...inkOf() } : null;
    preview.replaceChildren(...(current ? [svgNode(current, "pt-ed-previewsvg")] : []));
    use.disabled = !current;
    svgLink.hidden = !current;
    if (current) { svgLink.href = URL.createObjectURL(new Blob([svgOf(current, current.colorHex)], { type: "image/svg+xml" })); svgLink.download = `${kind}.svg`; }
    msg.textContent = note;
  };
  ink.addEventListener("change", () => current && show(current, msg.textContent));
  use.addEventListener("click", () => { if (current) { onUse(kind, current); node.hidden = true; } });

  const MODES = [["draw", "Draw"], ["type", "Type"], ["upload", "Upload a photo"]];
  const openMode = (m) => {
    how = m; show(null);
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.how === m));
    body.replaceChildren(...BUILD[m]());
  };
  for (const [m, l] of MODES) tabs.append(el("button", { type: "button", role: "tab", class: "pt-tab", "data-how": m, onclick: () => openMode(m) }, l));

  const BUILD = {
    draw() {
      const pad = el("canvas", { class: "pt-ed-pad", width: kind === "initials" ? 400 : 900, height: 260, "aria-label": "Draw here with a mouse, finger or pen" });
      const ctx = pad.getContext("2d");
      const strokes = [];
      let live = null;
      const at = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
      const paint = () => {
        ctx.clearRect(0, 0, pad.width, pad.height);
        ctx.strokeStyle = inkOf().colorHex; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (const st of strokes) { ctx.beginPath(); st.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (st.length === 1) ctx.lineTo(st[0].x + 0.1, st[0].y); ctx.stroke(); }
      };
      pad.addEventListener("pointerdown", (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); live = [at(e)]; strokes.push(live); paint(); });
      pad.addEventListener("pointermove", (e) => { if (!live) return; live.push(at(e)); paint(); });
      const end = () => { if (!live) return; live = null; show(strokesToPath(strokes, { strokeWidth: 4 }), "Drawn — it stays sharp at any size."); };
      pad.addEventListener("pointerup", end); pad.addEventListener("pointercancel", end);
      const clear = el("button", { type: "button", class: "pt-btn", onclick: () => { strokes.length = 0; paint(); show(null); } }, "Clear");
      return [pad, clear];
    },
    type() {
      const name = el("input", { type: "text", class: "pt-text", maxlength: kind === "initials" ? "4" : "60", placeholder: kind === "initials" ? "Your initials" : "Your full name", "aria-label": kind === "initials" ? "Your initials" : "Your name" });
      const face = el("select", { class: "pt-text", "aria-label": "Style" }, ...SCRIPT_FACES.map(([f, l]) => el("option", { value: f }, l)));
      const draw = () => {
        const t = name.value.trim();
        if (!t) return show(null);
        const c = el("canvas", { width: 1400, height: 320 });
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "#000"; g.textBaseline = "middle";
        g.font = `150px "${face.value}", cursive`;
        g.fillText(t, 30, c.height / 2, c.width - 60);
        show(traceInk(g.getImageData(0, 0, c.width, c.height), { eps: 0.6 }), "Typed, then traced to vector outlines.");
      };
      name.addEventListener("input", draw); face.addEventListener("change", draw);
      return [el("label", { class: "pt-field" }, kind === "initials" ? "Initials" : "Name", name), el("label", { class: "pt-field" }, "Style", face)];
    },
    upload() {
      const pick = h.fileInput(false, "image/*");
      const level = el("input", { type: "range", min: "0", max: "255", value: "0", "aria-label": "How dark counts as ink" });
      const levelOut = el("span", { class: "pt-muted" }, "Automatic");
      let imageData = null;
      const trace = () => {
        if (!imageData) return;
        const t = traceInk(imageData, { level: Number(level.value) ? Number(level.value) : null });
        if (!t) return show(null, "No ink found — try a darker setting, or a photo with more contrast.");
        if (!Number(level.value)) levelOut.textContent = `Automatic (${t.level})`;
        show(t, `Traced ${t.loops} outline${t.loops === 1 ? "" : "s"} from the photo — a vector signature, its paper removed.`);
      };
      pick.addEventListener("change", async () => {
        const f = pick.files?.[0]; if (!f) return;
        const bmp = await createImageBitmap(f).catch(() => null);
        if (!bmp) return show(null, "That picture could not be read — try a JPEG or PNG.");
        const k = Math.min(1, MAX_TRACE / Math.max(bmp.width, bmp.height));
        const c = el("canvas", { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
        imageData = g.getImageData(0, 0, c.width, c.height);
        trace();
      });
      level.addEventListener("input", () => { levelOut.textContent = Number(level.value) ? String(level.value) : "Automatic"; trace(); });
      return [el("label", { class: "pt-field" }, "A photo or scan of your signature on plain paper", pick),
        el("label", { class: "pt-field" }, el("span", {}, "How dark counts as ink: ", levelOut), level)];
    },
  };

  node.append(title, tabs, body, preview, msg,
    el("div", { class: "pt-row" }, el("label", { class: "pt-field" }, "Ink", ink)), el("div", { class: "pt-row" }, use, svgLink, cancel));
  return {
    node,
    open(k) {
      kind = k;
      title.textContent = k === "initials" ? "Your initials" : "Your signature";
      node.hidden = false;
      openMode(how);
      node.scrollIntoView?.({ block: "nearest" });
    },
  };
}
