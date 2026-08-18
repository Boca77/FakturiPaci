/* Paci Resizer — lay photos out at real-world sizes on an A4 page and print at 1:1.
   Everything is client side: nothing is uploaded anywhere.

   The page is a free layout. Each photo is an item measured in millimetres, so the
   preview, the print output and the exported PNG are all the same geometry rendered
   at different pixel densities. */

const $ = id => document.getElementById(id);

const MM_PER_IN = 25.4;
const A4 = { w: 210, h: 297 };
const MIN_MM = 5;                 // smallest a photo can be dragged
const HANDLE_PX = 9;              // grab radius for resize handles, in screen pixels
const SNAP_PX = 6;                // snap distance, in screen pixels

const doc = {
  items: [],                      // draw order: later items sit on top
  sel: null,                      // id of the selected item
  orient: 'portrait',
  margin: 10,
  gap: 4,
  dpi: 600,
  marks: true,
  guides: true,
};

let unit = 'mm';
let uid = 0;

const sheetSize = () => doc.orient === 'portrait'
  ? { w: A4.w, h: A4.h }
  : { w: A4.h, h: A4.w };

const item = id => doc.items.find(i => i.id === id) || null;
const selected = () => item(doc.sel);

/* ─────────────────────────── units ─────────────────────────── */

function toUnit(mm) {
  switch (unit) {
    case 'cm': return mm / 10;
    case 'in': return mm / MM_PER_IN;
    case 'px': return Math.round(mm / MM_PER_IN * doc.dpi);
    default:   return mm;
  }
}

function fromUnit(v) {
  switch (unit) {
    case 'cm': return v * 10;
    case 'in': return v * MM_PER_IN;
    case 'px': return v / doc.dpi * MM_PER_IN;
    default:   return v;
  }
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const decimals = () => (unit === 'px' ? 0 : unit === 'mm' ? 1 : 2);
const mm2px = mm => Math.round(mm / MM_PER_IN * doc.dpi);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ─────────────────────────── undo ─────────────────────────── */

const history = [];

function snapshot() {
  history.push({ items: doc.items.map(i => ({ ...i })), sel: doc.sel });
  if (history.length > 40) history.shift();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  doc.items = prev.items;
  doc.sel = prev.sel;
  syncPanel();
  render();
}

/* ─────────────────────── loading photos ─────────────────────── */

async function addFiles(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) return;
  snapshot();

  for (const file of images) {
    let bitmap;
    try {
      // imageOrientation honours the EXIF rotation flag on phone photos
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(file);
    }
    const it = {
      id: ++uid,
      name: (file.name || 'слика').replace(/\.[^.]+$/, ''),
      bitmap,
      natW: bitmap.width,
      natH: bitmap.height,
      x: 0, y: 0, w: 0, h: 0,
      fit: 'contain',
      bg: '#ffffff',
      bgNone: false,
      lock: true,
    };
    placeNew(it);
    doc.items.push(it);
    doc.sel = it.id;
  }
  syncPanel();
  renderList();
  render();
}

/** Sizes a new photo sensibly and drops it in the first free spot. */
function placeNew(it) {
  const S = sheetSize();
  const availW = S.w - doc.margin * 2;
  const availH = S.h - doc.margin * 2;

  let w = Math.min(60, availW);
  let h = w * it.natH / it.natW;
  if (h > availH) { h = availH; w = h * it.natW / it.natH; }
  it.w = w; it.h = h;

  const step = 5;
  for (let y = doc.margin; y + h <= S.h - doc.margin + 0.01; y += step) {
    for (let x = doc.margin; x + w <= S.w - doc.margin + 0.01; x += step) {
      const box = { x, y, w, h };
      if (!doc.items.some(o => overlaps(o, box, doc.gap))) {
        it.x = x; it.y = y;
        return;
      }
    }
  }
  it.x = clamp(doc.margin, 0, S.w - w);
  it.y = clamp(doc.margin, 0, S.h - h);
}

const overlaps = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x &&
  a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/* ───────────────────── drawing the page ───────────────────── */

// Downscaling in one drawImage step looks mushy; halving repeatedly keeps detail.
function stepDown(src, tw, th) {
  let c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);

  while (c.width / 2 > tw && c.height / 2 > th) {
    const n = document.createElement('canvas');
    n.width = Math.max(1, Math.floor(c.width / 2));
    n.height = Math.max(1, Math.floor(c.height / 2));
    const x = n.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, n.width, n.height);
    c = n;
  }
  return c;
}

/** A copy of the source pre-shrunk near the export size, cached per item. */
function sourceFor(it, tw, th) {
  const key = Math.round(tw) + 'x' + Math.round(th);
  if (it._smallKey !== key) {
    it._small = stepDown(it.bitmap, tw, th);
    it._smallKey = key;
  }
  return it._small;
}

/** Draws src into the destination box honouring the fit mode. */
function drawFitted(ctx, src, dx, dy, dw, dh, fit) {
  const sw = src.width, sh = src.height;
  ctx.imageSmoothingQuality = 'high';

  if (fit === 'stretch') { ctx.drawImage(src, dx, dy, dw, dh); return; }

  const sAsp = sw / sh, dAsp = dw / dh;
  if (fit === 'cover') {
    // crop the source instead of clipping the output
    let cw = sw, ch = sh;
    if (sAsp > dAsp) cw = sh * dAsp; else ch = sw / dAsp;
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, dx, dy, dw, dh);
  } else {
    let iw, ih;
    if (sAsp > dAsp) { iw = dw; ih = dw / sAsp; } else { ih = dh; iw = dh * sAsp; }
    ctx.drawImage(src, dx + (dw - iw) / 2, dy + (dh - ih) / 2, iw, ih);
  }
}

/** Paints the whole page. k = pixels per millimetre, so one function serves
    the on-screen preview, the print sheet and the PNG export. */
function paintSheet(ctx, k, opts = {}) {
  const S = sheetSize();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S.w * k, S.h * k);

  for (const it of doc.items) {
    const dx = it.x * k, dy = it.y * k, dw = it.w * k, dh = it.h * k;
    if (!it.bgNone) { ctx.fillStyle = it.bg; ctx.fillRect(dx, dy, dw, dh); }
    const src = opts.quality ? sourceFor(it, dw, dh) : it.bitmap;
    drawFitted(ctx, src, dx, dy, dw, dh, it.fit);
  }

  if (doc.marks) {
    for (const it of doc.items) cutMarks(ctx, it, k, opts.markWidth || 1);
  }
}

// Short ticks just outside each corner — the usual "cut here" convention.
function cutMarks(ctx, it, k, lineWidth) {
  const x = it.x * k, y = it.y * k, w = it.w * k, h = it.h * k;
  const len = 3 * k, off = 1 * k;
  ctx.save();
  ctx.strokeStyle = '#8a8a8a';
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const [cx, sx] of [[x, -1], [x + w, 1]]) {
    for (const [cy, sy] of [[y, -1], [y + h, 1]]) {
      ctx.moveTo(cx + sx * off, cy); ctx.lineTo(cx + sx * (off + len), cy);
      ctx.moveTo(cx, cy + sy * off); ctx.lineTo(cx, cy + sy * (off + len));
    }
  }
  ctx.stroke();
  ctx.restore();
}

/* ─────────────────────────── preview ─────────────────────────── */

const view = $('preview');
let snapLines = { x: [], y: [] };

/** Screen pixels per millimetre, read back from the element so CSS scaling
    can never desynchronise the pointer maths. */
function screenK() {
  const r = view.getBoundingClientRect();
  return r.width / sheetSize().w;
}

function render() {
  const S = sheetSize();
  const stage = document.querySelector('.stage');
  const maxW = Math.max(240, stage.clientWidth - 56);
  const maxH = Math.max(320, window.innerHeight - 190);
  const k = Math.min(maxW / S.w, maxH / S.h);
  const dpr = window.devicePixelRatio || 1;

  view.style.width = S.w * k + 'px';
  view.style.height = S.h * k + 'px';
  view.width = Math.round(S.w * k * dpr);
  view.height = Math.round(S.h * k * dpr);

  const ctx = view.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintSheet(ctx, k, { quality: false, markWidth: 1 });

  if (doc.guides) drawMarginGuide(ctx, k, S);
  drawSnapLines(ctx, k, S);
  const sel = selected();
  if (sel) drawSelection(ctx, sel, k);

  updateInfo();
}

function drawMarginGuide(ctx, k, S) {
  if (doc.margin <= 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(180,85,42,.45)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeRect(doc.margin * k, doc.margin * k,
                 (S.w - doc.margin * 2) * k, (S.h - doc.margin * 2) * k);
  ctx.restore();
}

function drawSnapLines(ctx, k, S) {
  if (!snapLines.x.length && !snapLines.y.length) return;
  ctx.save();
  ctx.strokeStyle = '#b4552a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of snapLines.x) { ctx.moveTo(x * k, 0); ctx.lineTo(x * k, S.h * k); }
  for (const y of snapLines.y) { ctx.moveTo(0, y * k); ctx.lineTo(S.w * k, y * k); }
  ctx.stroke();
  ctx.restore();
}

function handlePoints(it, k) {
  const x = it.x * k, y = it.y * k, w = it.w * k, h = it.h * k;
  return {
    nw: [x, y],         n: [x + w / 2, y],     ne: [x + w, y],
    w:  [x, y + h / 2],                        e:  [x + w, y + h / 2],
    sw: [x, y + h],     s: [x + w / 2, y + h], se: [x + w, y + h],
  };
}

function drawSelection(ctx, it, k) {
  ctx.save();
  ctx.strokeStyle = '#b4552a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(it.x * k, it.y * k, it.w * k, it.h * k);

  ctx.fillStyle = '#fff';
  ctx.lineWidth = 1.5;
  for (const [, [hx, hy]] of Object.entries(handlePoints(it, k))) {
    ctx.beginPath();
    ctx.rect(hx - 4, hy - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ───────────────────── mouse interaction ───────────────────── */

const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

let drag = null;

// Some browsers refuse capture for a pointer they no longer track. It is not
// worth an exception that would abort the rest of the handler.
function capture(el, id) { try { el.setPointerCapture(id); } catch {} }
function release(el, id) { try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch {} }

function pointerMM(e) {
  const r = view.getBoundingClientRect();
  const k = r.width / sheetSize().w;
  return { mx: (e.clientX - r.left) / k, my: (e.clientY - r.top) / k, k };
}

function handleAt(it, px, py, k) {
  if (!it) return null;
  for (const [id, [hx, hy]] of Object.entries(handlePoints(it, k))) {
    if (Math.abs(px - hx) <= HANDLE_PX && Math.abs(py - hy) <= HANDLE_PX) return id;
  }
  return null;
}

function itemAt(mx, my) {
  for (let i = doc.items.length - 1; i >= 0; i--) {      // topmost first
    const it = doc.items[i];
    if (mx >= it.x && mx <= it.x + it.w && my >= it.y && my <= it.y + it.h) return it;
  }
  return null;
}

view.addEventListener('pointerdown', e => {
  const { mx, my, k } = pointerMM(e);
  const sel = selected();
  const h = handleAt(sel, mx * k, my * k, k);

  if (h) {
    snapshot();
    drag = { mode: 'resize', id: sel.id, handle: h, orig: { ...sel } };
  } else {
    const hit = itemAt(mx, my);
    if (!hit) { doc.sel = null; drag = null; syncPanel(); renderList(); render(); return; }
    snapshot();
    doc.sel = hit.id;
    drag = { mode: 'move', id: hit.id, dx: mx - hit.x, dy: my - hit.y };
    syncPanel(); renderList();
  }
  capture(view, e.pointerId);
  render();
});

view.addEventListener('pointermove', e => {
  const { mx, my, k } = pointerMM(e);

  if (!drag) {                                   // hover: just update the cursor
    const sel = selected();
    const h = handleAt(sel, mx * k, my * k, k);
    view.style.cursor = h ? CURSORS[h] : (itemAt(mx, my) ? 'move' : 'default');
    return;
  }

  const it = item(drag.id);
  if (!it) return;
  const S = sheetSize();

  if (drag.mode === 'move') {
    let nx = mx - drag.dx, ny = my - drag.dy;
    if (!e.altKey) ({ nx, ny } = snapMove(it, nx, ny, k)); else snapLines = { x: [], y: [] };
    it.x = clamp(nx, 0, S.w - it.w);
    it.y = clamp(ny, 0, S.h - it.h);
  } else {
    resize(it, drag.orig, drag.handle, mx, my);
    snapLines = { x: [], y: [] };
  }
  syncDims();
  render();
});

function endDrag(e) {
  if (!drag) return;
  drag = null;
  snapLines = { x: [], y: [] };
  if (e) release(view, e.pointerId);
  render();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

/** Nudges a moved item onto page landmarks and the edges of its neighbours. */
function snapMove(it, nx, ny, k) {
  const S = sheetSize();
  const tol = SNAP_PX / k;
  const xs = [0, doc.margin, S.w - doc.margin, S.w, S.w / 2];
  const ys = [0, doc.margin, S.h - doc.margin, S.h, S.h / 2];
  for (const o of doc.items) {
    if (o.id === it.id) continue;
    xs.push(o.x, o.x + o.w, o.x + o.w / 2);
    ys.push(o.y, o.y + o.h, o.y + o.h / 2);
  }

  const lines = { x: [], y: [] };
  const fit = (val, edges, targets) => {
    let best = null;
    for (const t of targets) {
      for (const e of edges) {
        const d = Math.abs(val + e - t);
        if (d <= tol && (!best || d < best.d)) best = { d, delta: t - (val + e), line: t };
      }
    }
    return best;
  };

  const bx = fit(nx, [0, it.w, it.w / 2], xs);
  if (bx) { nx += bx.delta; lines.x.push(bx.line); }
  const by = fit(ny, [0, it.h, it.h / 2], ys);
  if (by) { ny += by.delta; lines.y.push(by.line); }

  snapLines = lines;
  return { nx, ny };
}

function resize(it, orig, handle, mx, my) {
  const S = sheetSize();
  const right = orig.x + orig.w, bottom = orig.y + orig.h;
  const horiz = handle.includes('e') || handle.includes('w');
  const vert = handle.includes('n') || handle.includes('s');

  let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;

  if (handle.includes('w')) { nx = clamp(mx, 0, right - MIN_MM); nw = right - nx; }
  if (handle.includes('e')) { nw = clamp(mx, orig.x + MIN_MM, S.w) - orig.x; }
  if (handle.includes('n')) { ny = clamp(my, 0, bottom - MIN_MM); nh = bottom - ny; }
  if (handle.includes('s')) { nh = clamp(my, orig.y + MIN_MM, S.h) - orig.y; }

  if (it.lock) {
    const aspect = orig.w / orig.h;
    if (horiz) nh = nw / aspect; else nw = nh * aspect;

    // re-anchor against whichever edges the handle is not dragging
    nx = handle.includes('w') ? right - nw : orig.x;
    ny = handle.includes('n') ? bottom - nh : orig.y;
    if (!horiz) nx = orig.x + (orig.w - nw) / 2;
    if (!vert)  ny = orig.y + (orig.h - nh) / 2;
  }

  // keep the whole photo on the page
  nw = Math.min(nw, S.w); nh = Math.min(nh, S.h);
  it.w = Math.max(MIN_MM, nw);
  it.h = Math.max(MIN_MM, nh);
  it.x = clamp(nx, 0, S.w - it.w);
  it.y = clamp(ny, 0, S.h - it.h);
}

/* ───────────────────── thumbnails & reordering ───────────────────── */

const listEl = $('list');
let reorder = null;

function thumbFor(it) {
  if (!it._thumb) {
    const c = document.createElement('canvas');
    c.width = c.height = 88;
    const x = c.getContext('2d');
    x.fillStyle = '#f4f1ea'; x.fillRect(0, 0, 88, 88);
    drawFitted(x, it.bitmap, 0, 0, 88, 88, 'cover');
    it._thumb = c;
  }
  return it._thumb;
}

function renderList() {
  listEl.innerHTML = '';
  for (let i = 0; i < doc.items.length; i++) {
    const it = doc.items[i];
    const li = document.createElement('li');
    li.className = 'thumb' + (it.id === doc.sel ? ' sel' : '') +
                   (reorder && reorder.id === it.id ? ' dragging' : '');
    li.dataset.id = it.id;
    li.title = `${it.name} — ${round(it.w, 1)} × ${round(it.h, 1)} мм`;
    li.appendChild(thumbFor(it));
    listEl.appendChild(li);
  }
  $('listHint').hidden = doc.items.length < 2;
  const none = doc.items.length === 0;
  $('clear').disabled = none;
  $('arrange').disabled = none;
}

listEl.addEventListener('pointerdown', e => {
  const li = e.target.closest('.thumb');
  if (!li) return;
  const id = +li.dataset.id;
  doc.sel = id;
  reorder = { id, moved: false, startX: e.clientX, startY: e.clientY };
  capture(listEl, e.pointerId);
  syncPanel();
  renderList();
  render();
});

listEl.addEventListener('pointermove', e => {
  if (!reorder) return;
  if (!reorder.moved) {
    const far = Math.hypot(e.clientX - reorder.startX, e.clientY - reorder.startY) > 5;
    if (!far) return;
    reorder.moved = true;
    snapshot();
  }

  const from = doc.items.findIndex(i => i.id === reorder.id);
  const to = insertionIndex(e.clientX, e.clientY, from);
  if (to !== -1 && to !== from) {
    const [moving] = doc.items.splice(from, 1);
    doc.items.splice(to, 0, moving);
    renderList();
    render();
  }
});

/** Which slot the pointer is currently over, in the wrapped thumbnail strip. */
function insertionIndex(cx, cy, from) {
  const nodes = [...listEl.children];
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].getBoundingClientRect();
    const onRow = cy >= r.top && cy <= r.bottom;
    if (onRow && cx < r.left + r.width / 2) return i > from ? i - 1 : i;
    if (onRow && cx <= r.right) return i;
  }
  return cy > listEl.getBoundingClientRect().bottom ? doc.items.length - 1 : -1;
}

function endReorder(e) {
  if (!reorder) return;
  reorder = null;
  if (e) release(listEl, e.pointerId);
  renderList();
}
listEl.addEventListener('pointerup', endReorder);
listEl.addEventListener('pointercancel', endReorder);

/* ───────────────────── layout commands ───────────────────── */

/** Flows every photo left-to-right, top-to-bottom in list order. */
function arrange() {
  const S = sheetSize();
  const limit = S.w - doc.margin;
  let x = doc.margin, y = doc.margin, rowH = 0;

  for (const it of doc.items) {
    if (x + it.w > limit + 0.01 && x > doc.margin) { x = doc.margin; y += rowH + doc.gap; rowH = 0; }
    it.x = clamp(x, 0, Math.max(0, S.w - it.w));
    it.y = clamp(y, 0, Math.max(0, S.h - it.h));
    x += it.w + doc.gap;
    rowH = Math.max(rowH, it.h);
  }
}

const TILE_MAX = 300;              // beyond this the page becomes sluggish to edit

/** How many copies of one photo fit on the page, and where the grid starts. */
function tileGrid(src) {
  const S = sheetSize();
  const availW = S.w - doc.margin * 2;
  const availH = S.h - doc.margin * 2;
  const cols = Math.floor((availW + doc.gap) / (src.w + doc.gap));
  const rows = Math.floor((availH + doc.gap) / (src.h + doc.gap));
  if (cols < 1 || rows < 1) return { count: 0 };

  const blockW = cols * src.w + (cols - 1) * doc.gap;
  const blockH = rows * src.h + (rows - 1) * doc.gap;
  return {
    cols, rows, count: cols * rows,
    x0: doc.margin + (availW - blockW) / 2,
    y0: doc.margin + (availH - blockH) / 2,
  };
}

/** Replaces the page with a grid of copies of one photo. */
function tilePage(src) {
  const g = tileGrid(src);
  if (!g.count) return 0;

  const out = [];
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      out.push({ ...src, id: ++uid, x: g.x0 + c * (src.w + doc.gap), y: g.y0 + r * (src.h + doc.gap) });
    }
  }
  doc.items = out;
  doc.sel = out[0].id;
  return out.length;
}

/* ───────────────────── panel <-> state ───────────────────── */

function syncDims() {
  const it = selected();
  if (!it) return;
  const d = decimals();
  $('w').value = round(toUnit(it.w), d);
  $('h').value = round(toUnit(it.h), d);
  $('x').value = round(toUnit(it.x), d);
  $('y').value = round(toUnit(it.y), d);
  const step = unit === 'px' ? 1 : unit === 'mm' ? 0.1 : 0.01;
  for (const f of ['w', 'h', 'x', 'y']) $(f).step = step;
}

function syncPanel() {
  const it = selected();
  $('selCtl').classList.toggle('off', !it);
  $('selNone').hidden = !!it;
  for (const b of ['dup', 'del']) $(b).disabled = !it;
  for (const b of ['print', 'dlSheet']) $(b).disabled = doc.items.length === 0;
  $('dlImg').disabled = !it;
  if (!it) return;

  syncDims();
  $('fit').value = it.fit;
  $('bg').value = it.bg;
  $('bgNone').checked = it.bgNone;
  $('bg').disabled = it.bgNone;
  $('lock').classList.toggle('is-on', it.lock);
  $('lock').setAttribute('aria-pressed', String(it.lock));
}

function updateInfo() {
  const it = selected();
  $('outInfo').textContent = it
    ? `Големина: ${round(it.w, 1)} × ${round(it.h, 1)} мм (${mm2px(it.w)} × ${mm2px(it.h)} точки при ${doc.dpi} DPI)`
    : '—';

  const msgs = [];
  const S = sheetSize();
  // ~200 DPI is where a print starts to look soft. Capped, so raising the export
  // resolution to 600 does not flag every ordinary photo.
  const softBelow = Math.min(doc.dpi * 0.66, 200);
  let soft = 0, outside = 0;
  for (const o of doc.items) {
    const eff = o.natW / (o.w / MM_PER_IN);        // real resolution at the printed size
    if (eff < softBelow) soft++;
    if (o.x < doc.margin - 0.01 || o.y < doc.margin - 0.01 ||
        o.x + o.w > S.w - doc.margin + 0.01 || o.y + o.h > S.h - doc.margin + 0.01) outside++;
  }
  if (soft) {
    msgs.push(soft > 1
      ? `${soft} слики се со премала резолуција за оваа големина — ќе изгледаат нејасно при печатење. Намали ги малку.`
      : `Сликата е со премала резолуција за оваа големина — ќе изгледа нејасно при печатење. Намали ја малку.`);
  }
  if (outside) {
    msgs.push(outside > 1
      ? `${outside} слики излегуваат надвор од работ — повеќето печатачи не печатат толку блиску до крајот на хартијата.`
      : `Една слика излегува надвор од работ — повеќето печатачи не печатат толку блиску до крајот на хартијата.`);
  }

  $('warn').hidden = !msgs.length;
  $('warn').textContent = msgs.join(' ');
}

/* ───────────────────── DPI metadata in exports ───────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Inserts a pHYs chunk so the PNG reports the right physical resolution. */
function pngWithDpi(buf, dpi) {
  const src = new Uint8Array(buf);
  const ppm = Math.round(dpi / 0.0254);              // pixels per metre
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);                                // data length
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);            // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm);
  chunk[16] = 1;                                     // unit = metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));

  const at = 8 + 25;                                 // signature + IHDR
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return out;
}

/** Sets the JFIF density fields of a JPEG, adding the JFIF header if the
    browser's encoder left it out (Chrome often does). */
function jpegWithDpi(buf, dpi) {
  const b = new Uint8Array(buf);
  if (b[0] !== 0xFF || b[1] !== 0xD8) return b;

  let o = 2;
  while (o < b.length - 4 && b[o] === 0xFF) {
    const marker = b[o + 1];
    const len = (b[o + 2] << 8) | b[o + 3];
    const isJfif = marker === 0xE0 &&
      b[o + 4] === 0x4A && b[o + 5] === 0x46 && b[o + 6] === 0x49 && b[o + 7] === 0x46;
    if (isJfif) {
      b[o + 11] = 1;                                 // units = pixels per inch
      b[o + 12] = dpi >> 8; b[o + 13] = dpi & 0xFF;
      b[o + 14] = dpi >> 8; b[o + 15] = dpi & 0xFF;
      return b;
    }
    if (marker === 0xDA || marker === 0xD9) break;   // start of scan / end
    o += 2 + len;
  }

  const app0 = new Uint8Array([
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x01, dpi >> 8, dpi & 0xFF, dpi >> 8, dpi & 0xFF, 0x00, 0x00,
  ]);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

const toBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));

async function download(canvas, format, filename) {
  const blob = await toBlob(canvas, `image/${format}`, format === 'jpeg' ? 0.94 : undefined);
  const buf = await blob.arrayBuffer();
  const bytes = format === 'png' ? pngWithDpi(buf, doc.dpi) : jpegWithDpi(buf, doc.dpi);
  const url = URL.createObjectURL(new Blob([bytes], { type: `image/${format}` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────── export & print ───────────────────── */

/** The page at full print resolution. */
function exportSheet() {
  const S = sheetSize();
  const k = doc.dpi / MM_PER_IN;
  const c = document.createElement('canvas');
  c.width = mm2px(S.w);
  c.height = mm2px(S.h);
  paintSheet(c.getContext('2d'), k, { quality: true, markWidth: Math.max(1, doc.dpi / 600) });
  return c;
}

/** One photo on its own, at the requested printed size. */
function exportItem(it) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, mm2px(it.w));
  c.height = Math.max(1, mm2px(it.h));
  const ctx = c.getContext('2d');
  if (!it.bgNone) { ctx.fillStyle = it.bg; ctx.fillRect(0, 0, c.width, c.height); }
  drawFitted(ctx, sourceFor(it, c.width, c.height), 0, 0, c.width, c.height, it.fit);
  return c;
}

async function printSheet() {
  const S = sheetSize();
  $('pageStyle').textContent = `@page { size: A4 ${doc.orient}; margin: 0; }`;

  const img = $('printImg');
  img.style.width = S.w + 'mm';
  img.style.height = S.h + 'mm';

  const blob = await toBlob(exportSheet(), 'image/png');
  const url = URL.createObjectURL(blob);
  img.src = url;
  await img.decode();
  window.print();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Rendering an A4 sheet at 600 DPI takes a few seconds and freezes the tab.
    Show that something is happening instead of looking dead. */
async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Се подготвува…';
  // two frames, so the new label is actually painted before the heavy work starts
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    await fn();
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

/* ─────────────────────────── wiring ─────────────────────────── */

// photos in
$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
});
$('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

['dragenter', 'dragover'].forEach(t => $('drop').addEventListener(t, e => {
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach(t => $('drop').addEventListener(t, e => {
  e.preventDefault(); $('drop').classList.remove('over');
}));
$('drop').addEventListener('drop', e => addFiles(e.dataTransfer.files));

document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items || [])]
    .filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (files.length) addFiles(files);
});

// photo list actions
$('dup').addEventListener('click', () => {
  const it = selected();
  if (!it) return;
  snapshot();
  const S = sheetSize();
  const copy = { ...it, id: ++uid };
  copy.x = clamp(it.x + 5, 0, S.w - copy.w);
  copy.y = clamp(it.y + 5, 0, S.h - copy.h);
  doc.items.push(copy);
  doc.sel = copy.id;
  syncPanel(); renderList(); render();
});

$('del').addEventListener('click', () => {
  if (!selected()) return;
  snapshot();
  doc.items = doc.items.filter(i => i.id !== doc.sel);
  doc.sel = doc.items.length ? doc.items[doc.items.length - 1].id : null;
  syncPanel(); renderList(); render();
});

$('clear').addEventListener('click', () => {
  if (!doc.items.length) return;
  snapshot();
  doc.items = [];
  doc.sel = null;
  syncPanel(); renderList(); render();
});

$('arrange').addEventListener('click', () => {
  if (!doc.items.length) return;
  snapshot();
  arrange();
  syncDims(); render();
});

// selected photo
$('unit').addEventListener('change', e => { unit = e.target.value; syncDims(); });

function fieldChanged(which) {
  const it = selected();
  if (!it) return;
  const v = parseFloat($(which).value);
  if (Number.isNaN(v)) return;
  const mm = fromUnit(v);
  const S = sheetSize();

  if (which === 'w' || which === 'h') {
    if (mm < MIN_MM) return;
    if (which === 'w') {
      it.w = Math.min(mm, S.w);
      if (it.lock) it.h = it.w * it.natH / it.natW;
    } else {
      it.h = Math.min(mm, S.h);
      if (it.lock) it.w = it.h * it.natW / it.natH;
    }
    $('preset').value = '';
  } else {
    it[which] = mm;
  }
  it.x = clamp(it.x, 0, S.w - it.w);
  it.y = clamp(it.y, 0, S.h - it.h);
  syncDims(); renderList(); render();
}
for (const f of ['w', 'h', 'x', 'y']) $(f).addEventListener('input', () => fieldChanged(f));
for (const f of ['w', 'h', 'x', 'y']) $(f).addEventListener('focus', snapshot);

$('lock').addEventListener('click', () => {
  const it = selected();
  if (!it) return;
  snapshot();
  it.lock = !it.lock;
  if (it.lock) it.h = it.w * it.natH / it.natW;
  syncPanel(); render();
});

$('preset').addEventListener('change', e => {
  const it = selected();
  if (!it || !e.target.value) return;
  snapshot();
  const [w, h] = e.target.value.split(',').map(Number);
  const S = sheetSize();
  it.w = w; it.h = h; it.lock = false;
  it.x = clamp(it.x, 0, Math.max(0, S.w - w));
  it.y = clamp(it.y, 0, Math.max(0, S.h - h));
  syncPanel(); renderList(); render();
});

$('fit').addEventListener('change', e => {
  const it = selected(); if (!it) return;
  snapshot(); it.fit = e.target.value; render();
});
$('bg').addEventListener('input', e => {
  const it = selected(); if (!it) return;
  it.bg = e.target.value; render();
});
$('bgNone').addEventListener('change', e => {
  const it = selected(); if (!it) return;
  snapshot();
  it.bgNone = e.target.checked;
  $('bg').disabled = e.target.checked;
  render();
});

$('tile').addEventListener('click', () => {
  const it = selected();
  if (!it) return;

  const { count } = tileGrid(it);
  if (!count) {
    alert('Сликата е преголема за да се повтори на страницата.\n\nНамали ја големината или празниот раб.');
    return;
  }
  if (count > TILE_MAX) {
    alert(`Сликата е премногу мала — би се направиле ${count} копии и програмата ќе стане бавна.\n\n` +
          `Зголеми ја сликата или растојанието меѓу сликите.`);
    return;
  }
  if (count > 40 && !confirm(`Ќе се направат ${count} копии и ќе се замени сегашниот распоред.\n\nДа продолжам?`)) return;

  snapshot();
  tilePage(it);
  syncPanel(); renderList(); render();
});

$('center').addEventListener('click', () => {
  const it = selected();
  if (!it) return;
  snapshot();
  const S = sheetSize();
  it.x = (S.w - it.w) / 2;
  it.y = (S.h - it.h) / 2;
  syncDims(); render();
});

// page
$('orient').addEventListener('change', e => {
  snapshot();
  doc.orient = e.target.value;
  const S = sheetSize();
  for (const it of doc.items) {                    // keep everything on the page
    it.w = Math.min(it.w, S.w); it.h = Math.min(it.h, S.h);
    it.x = clamp(it.x, 0, S.w - it.w);
    it.y = clamp(it.y, 0, S.h - it.h);
  }
  syncDims(); render();
});
$('margin').addEventListener('input', e => { doc.margin = Math.max(0, +e.target.value || 0); render(); });
$('gap').addEventListener('input', e => { doc.gap = Math.max(0, +e.target.value || 0); render(); });
$('dpi').addEventListener('change', e => { doc.dpi = +e.target.value; syncDims(); render(); });
$('marks').addEventListener('change', e => { doc.marks = e.target.checked; render(); });
$('guides').addEventListener('change', e => { doc.guides = e.target.checked; render(); });

// output
$('print').addEventListener('click', e => busy(e.currentTarget, printSheet));

$('dlSheet').addEventListener('click', e => busy(e.currentTarget,
  () => download(exportSheet(), 'png', `A4-${doc.dpi}dpi.png`)));

$('dlImg').addEventListener('click', e => {
  const it = selected();
  if (!it) return;
  const fmt = $('format').value;
  busy(e.currentTarget, () =>
    download(exportItem(it), fmt, `${it.name}-${round(it.w, 1)}x${round(it.h, 1)}mm-${doc.dpi}dpi.${fmt}`));
});

// keyboard
document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); $('dup').click(); return; }

  const it = selected();
  if (!it) return;

  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('del').click(); return; }

  const step = e.shiftKey ? 10 : 1;
  const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!move) return;
  e.preventDefault();
  snapshot();
  const S = sheetSize();
  it.x = clamp(it.x + move[0], 0, S.w - it.w);
  it.y = clamp(it.y + move[1], 0, S.h - it.h);
  syncDims(); render();
});

window.addEventListener('resize', render);

syncPanel();
renderList();
render();
