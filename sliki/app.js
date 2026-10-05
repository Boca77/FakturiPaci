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
    const id = ++uid;
    const it = {
      id,
      src: id,                    // shared by every copy of this photo
      name: (file.name || 'слика').replace(/\.[^.]+$/, ''),
      orig: bitmap,               // untouched, so the editor can always start over
      edit: null,                 // what the editor did to it, see openEditor
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
  placeFab(sel, k, S);

  updateInfo();
}

/** Parks the "edit" button under the selected photo, or inside it at the page bottom. */
function placeFab(it, k, S) {
  const fab = $('editFab');
  fab.hidden = !it || !!drag;
  if (fab.hidden) return;
  const below = (it.y + it.h) * k + 12;
  const fits = below + 50 <= S.h * k;
  fab.style.top = (fits ? below : (it.y + it.h) * k - 62) + 'px';
  fab.style.left = clamp((it.x + it.w / 2) * k, 95, Math.max(95, S.w * k - 95)) + 'px';
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
    drag = { mode: 'move', id: hit.id, dx: mx - hit.x, dy: my - hit.y,
             sx: e.clientX, sy: e.clientY, moved: false, wasSel: doc.sel === hit.id };
    doc.sel = hit.id;
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
    // a shaky click must stay a click: it is how the editor is opened
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
    }
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
  const click = drag.mode === 'move' && !drag.moved;
  const edit = click && drag.wasSel && e && e.type === 'pointerup';
  if (click) history.pop();                      // nothing moved, nothing to undo
  drag = null;
  snapLines = { x: [], y: [] };
  if (e) release(view, e.pointerId);
  render();
  if (edit) openEditor(selected());              // second click on a photo edits it
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
  reorder = { id, moved: false, startX: e.clientX, startY: e.clientY, wasSel: doc.sel === id };
  doc.sel = id;
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
  const edit = !reorder.moved && reorder.wasSel && e && e.type === 'pointerup';
  reorder = null;
  if (e) release(listEl, e.pointerId);
  renderList();
  if (edit) openEditor(selected());
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

/* ───────────────────── editing one photo ───────────────────── */

/* The editor never touches it.orig. It keeps a recipe (turn, mirror, crop, light)
   and on "done" bakes orig + recipe into a new it.bitmap, so reopening a photo
   shows the whole original with the old crop frame still adjustable. */

const edView = $('edView');
const PREVIEW_PX = 2e6;           // editor works on a small copy, so sliders stay instant
const BAKE_PX = 24e6;             // cap for the saved result; plenty for A4 at 600 DPI
const ED_GRAB = 30;               // grab distance for the crop frame, in screen pixels
const ED_MIN = 0.08;              // smallest crop, as a share of the photo

let ed = null;
let edDrag = null;

/** src turned by quarter turns and optionally mirrored, shrunk to at most maxPx pixels. */
function oriented(src, rot, flip, maxPx) {
  const sc = Math.min(1, Math.sqrt(maxPx / (src.width * src.height)));
  const sw = Math.max(1, Math.round(src.width * sc));
  const sh = Math.max(1, Math.round(src.height * sc));
  const c = document.createElement('canvas');
  c.width = rot % 2 ? sh : sw;
  c.height = rot % 2 ? sw : sh;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.translate(c.width / 2, c.height / 2);
  if (flip) x.scale(-1, 1);
  x.rotate(rot * Math.PI / 2);
  x.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  x.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

/* shapes: r is a fixed width,height shape; mm also sets the printed size */
const SHAPES = [
  { k: 'rect',    name: 'Правоаголник',    shape: 'rect',    r: '' },
  { k: 'square',  name: 'Квадрат',         shape: 'rect',    r: '1,1' },
  { k: 'round',   name: 'Заоблен',         shape: 'round',   r: '' },
  { k: 'circle',  name: 'Круг',            shape: 'oval',    r: '1,1' },
  { k: 'oval',    name: 'Овал',            shape: 'oval',    r: '' },
  { k: 'star',    name: 'Ѕвезда',          shape: 'star',    r: '1,1' },
  { k: 'heart',   name: 'Срце',            shape: 'heart',   r: '1,1' },
  { k: 'diamond', name: 'Ромб',            shape: 'diamond', r: '' },
  { k: 'pass',    name: 'Пасошка 35 × 45', shape: 'rect',    r: '35,45', mm: true },
];
const shapeOf = k => SHAPES.find(s => s.k === k) || SHAPES[0];

// five-pointed star, stretched so its points touch all four sides of the box
const STAR = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.42 : 1;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  return pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h]);
})();

/** Adds the outline of a shape filling the given box to the current path. */
function shapePath(ctx, shape, x, y, w, h) {
  const X = u => x + u * w, Y = v => y + v * h;
  switch (shape) {
    case 'oval':
      ctx.moveTo(x + w, y + h / 2);
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'round': {
      const r = Math.min(w, h) * 0.2;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      break;
    }
    case 'diamond':
      ctx.moveTo(X(0.5), y); ctx.lineTo(x + w, Y(0.5)); ctx.lineTo(X(0.5), y + h); ctx.lineTo(x, Y(0.5));
      break;
    case 'star':
      STAR.forEach(([u, v], i) => ctx[i ? 'lineTo' : 'moveTo'](X(u), Y(v)));
      break;
    case 'heart':
      ctx.moveTo(X(0.5), Y(1));
      ctx.bezierCurveTo(X(0.2), Y(0.8), X(0), Y(0.55), X(0), Y(0.3));
      ctx.bezierCurveTo(X(0), Y(0.12), X(0.13), Y(0), X(0.28), Y(0));
      ctx.bezierCurveTo(X(0.38), Y(0), X(0.46), Y(0.06), X(0.5), Y(0.16));
      ctx.bezierCurveTo(X(0.54), Y(0.06), X(0.62), Y(0), X(0.72), Y(0));
      ctx.bezierCurveTo(X(0.87), Y(0), X(1), Y(0.12), X(1), Y(0.3));
      ctx.bezierCurveTo(X(1), Y(0.55), X(0.8), Y(0.8), X(0.5), Y(1));
      break;
    default:
      ctx.rect(x, y, w, h);
      return;
  }
  ctx.closePath();
}

/** Finds the background by spreading inwards from the edges of the picture over
    everything that looks like the most common edge colour. Returns a canvas whose
    alpha is what to keep. Good on plain walls and paper, not on busy scenes. */
function bgMask(src, tol) {
  const w = src.width, h = src.height, n = w * h;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;

  // the background colour: the commonest colour along the four edges
  const bins = new Map();
  const edge = i => {
    const p = i * 4;
    const key = (d[p] >> 4) << 8 | (d[p + 1] >> 4) << 4 | d[p + 2] >> 4;
    let b = bins.get(key);
    if (!b) bins.set(key, b = [0, 0, 0, 0]);
    b[0]++; b[1] += d[p]; b[2] += d[p + 1]; b[3] += d[p + 2];
  };
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  border.forEach(edge);
  let top = null;
  for (const b of bins.values()) if (!top || b[0] > top[0]) top = b;
  const br = top[1] / top[0], bg = top[2] / top[0], bb = top[3] / top[0];

  const T = 12 + tol * 1.3;
  const near2 = T * T;                       // clearly background
  const far2 = (T * 1.8) ** 2;               // maybe background, if it changes smoothly
  const step2 = (T * 0.25) ** 2;             // "smoothly": close to the pixel we came from
  const gone = new Uint8Array(n);
  const q = new Int32Array(n);
  let head = 0, tail = 0;

  const dist = i => {
    const p = i * 4, a = d[p] - br, b = d[p + 1] - bg, c = d[p + 2] - bb;
    return a * a + b * b + c * c;
  };
  const visit = (j, from) => {
    if (gone[j]) return;
    const p = j * 4;
    let ok = d[p + 3] < 8;
    if (!ok) {
      const dj = dist(j);
      ok = dj <= near2;
      if (!ok && from >= 0 && dj <= far2) {  // lets a shadow or uneven light on a wall through
        const f = from * 4, a = d[p] - d[f], b = d[p + 1] - d[f + 1], c = d[p + 2] - d[f + 2];
        ok = a * a + b * b + c * c <= step2;
      }
    }
    if (ok) { gone[j] = 1; q[tail++] = j; }
  };

  for (const i of border) visit(i, -1);
  while (head < tail) {
    const i = q[head++], x = i % w;
    if (x > 0) visit(i - 1, i);
    if (x < w - 1) visit(i + 1, i);
    if (i >= w) visit(i - w, i);
    if (i < n - w) visit(i + w, i);
  }

  const m = new ImageData(w, h);
  for (let i = 0; i < n; i++) m.data[i * 4 + 3] = gone[i] ? 0 : 255;
  const raw = document.createElement('canvas');
  raw.width = w; raw.height = h;
  raw.getContext('2d').putImageData(m, 0, 0);

  // a one pixel blur takes the staircase off the cut edge
  const soft = document.createElement('canvas');
  soft.width = w; soft.height = h;
  const sx = soft.getContext('2d');
  sx.filter = 'blur(1px)';
  sx.drawImage(raw, 0, 0);
  return soft;
}

/** Erases from ctx everything the mask does not keep. */
function knock(ctx, mask, w, h) {
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

/** Applies a look in place: brightness b, contrast c and colour strength s
    (each -100..100), then a colour filter `tint` (#rrggbb or '') at strength ta (0..100). */
function adjust(ctx, w, h, { b, c, s, tint, ta }) {
  if (!b && !c && !s && !tint) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const k = 2 ** (c / 100), off = b * 1.28, sat = 1 + s / 100;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = (i - 128) * k + 128 + off;

  const a = tint ? ta / 100 : 0;
  const tr = a ? parseInt(tint.slice(1, 3), 16) : 0;
  const tg = a ? parseInt(tint.slice(3, 5), 16) : 0;
  const tb = a ? parseInt(tint.slice(5, 7), 16) : 0;
  // the filter colours the photo by its light and dark, like looking through tinted glass,
  // so shadows stay dark and highlights stay bright instead of everything going flat
  const glass = (l, t) => l < 128 ? 2 * l * t / 255 : 255 - 2 * (255 - l) * (255 - t) / 255;

  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], bl = lut[d[i + 2]];
    if (s || a) {
      const l = 0.299 * r + 0.587 * g + 0.114 * bl;
      if (s) { r = l + (r - l) * sat; g = l + (g - l) * sat; bl = l + (bl - l) * sat; }
      if (a) {
        r += (glass(l, tr) - r) * a;
        g += (glass(l, tg) - g) * a;
        bl += (glass(l, tb) - bl) * a;
      }
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = bl;
  }
  ctx.putImageData(img, 0, 0);
}

const TINTS = [
  ['', 'Без боја'],
  ['#d93a2b', 'Црвена'], ['#f08a24', 'Портокалова'], ['#f2c81d', 'Жолта'], ['#3f9b4b', 'Зелена'],
  ['#2f6fd6', 'Сина'], ['#8a4fc7', 'Виолетова'], ['#e0569b', 'Розова'], ['#8a5a2b', 'Кафеава'],
];

/* brush: strokes are kept as points in 0..1 of the turned photo, so they survive
   being redrawn at any size; size is a share of the photo's longer side */
const BRUSHES = [['oval', 'Круг'], ['rect', 'Квадрат'], ['star', 'Ѕвезда'], ['heart', 'Срце'], ['diamond', 'Ромб']];
const BRUSH_COLORS = [...TINTS.slice(1), ['#1c1a17', 'Црна'], ['#ffffff', 'Бела']];
const brush = { shape: 'oval', color: '#d93a2b' };       // remembered between photos

function paintStrokes(ctx, strokes, W, H) {
  for (const st of strokes) {
    const sz = st.size * Math.max(W, H);
    const P = st.pts.map(([u, v]) => [u * W, v * H]);
    const stamp = (x, y) => shapePath(ctx, st.shape, x - sz / 2, y - sz / 2, sz, sz);
    ctx.fillStyle = ctx.strokeStyle = st.color;

    if (st.shape === 'oval') {                   // a round brush is just a thick rounded line
      ctx.lineWidth = sz; ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      P.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y));
      ctx.stroke();
    }
    // a square drags into a line; stars, hearts and diamonds are left as a trail of stamps
    const gap = st.shape === 'rect' ? Math.max(1, sz * 0.2) : sz * 1.15;
    ctx.beginPath();
    stamp(P[0][0], P[0][1]);
    let since = 0;                               // distance travelled since the last stamp
    for (let i = 1; i < P.length && st.shape !== 'oval'; i++) {
      const [ax, ay] = P[i - 1], dx = P[i][0] - ax, dy = P[i][1] - ay;
      const len = Math.hypot(dx, dy);
      let pos = gap - since;
      for (; pos <= len; pos += gap) stamp(ax + dx * pos / len, ay + dy * pos / len);
      since = len - (pos - gap);
    }
    ctx.fill();
  }
}

/** Moves every stroke along when the photo is turned or mirrored. */
function mapStrokes(fn) {
  for (const st of ed.strokes) st.pts = st.pts.map(fn);
}

const edVal = id => +$(id).value;
/** The sliders and colour filter as adjust() wants them. */
const edLook = () => ({
  b: edVal('edB'), c: edVal('edC'), s: edVal('edS'), tint: ed.tint, ta: edVal('edTA'),
});
const edFull = () => ({ x: 0, y: 0, w: 1, h: 1 });

function openEditor(it) {
  if (!it || $('editor').open) return;
  const e = it.edit || {};
  ed = {
    it,
    rot: e.rot || 0,
    flip: !!e.flip,
    crop: e.crop ? { ...e.crop } : edFull(),
    pick: e.pick || 'rect',       // key into SHAPES
    bg: !!e.bg,                   // background removed?
    tint: e.tint || '',           // colour filter, #rrggbb
    strokes: (e.strokes || []).map(st => ({ ...st })),
    brush: false,                 // true while dragging on the photo paints
    mm: null,                  // set when a fixed print size is picked in this session
  };
  $('edB').value = e.b || 0;
  $('edC').value = e.c || 0;
  $('edS').value = e.s || 0;
  $('edT').value = e.t || 30;
  $('edTA').value = e.ta || 50;
  syncShape();
  syncBg();
  syncTint();
  syncBrush();
  $('editor').showModal();
  edOrient();
}

/** Rebuilds the working copy after a turn or mirror. */
function edOrient() {
  ed.base = oriented(ed.it.orig, ed.rot, ed.flip, PREVIEW_PX);
  edCut();
}

/** Recomputes which part is background. */
function edCut() {
  ed.mask = ed.bg ? bgMask(ed.base, edVal('edT')) : null;
  edAdjust();
}

function edAdjust() {
  const c = document.createElement('canvas');
  c.width = ed.base.width; c.height = ed.base.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ed.base, 0, 0);
  if (ed.mask) knock(x, ed.mask, c.width, c.height);
  adjust(x, c.width, c.height, edLook());
  ed.adj = c;
  edRender();
}

function edRender() {
  if (!ed) return;
  const st = $('edStage');
  const W = ed.base.width, H = ed.base.height;
  const k = Math.min((st.clientWidth - 40) / W, (st.clientHeight - 40) / H);
  const w = W * k, h = H * k;
  const dpr = window.devicePixelRatio || 1;

  edView.style.width = w + 'px';
  edView.style.height = h + 'px';
  edView.width = Math.round(w * dpr);
  edView.height = Math.round(h * dpr);

  const ctx = edView.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';

  // checkerboard, so a removed background reads as "nothing here"
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d9d4ca';
  for (let cy = 0; cy * 16 < h; cy++) {
    for (let cx = cy % 2; cx * 16 < w; cx += 2) ctx.fillRect(cx * 16, cy * 16, 16, 16);
  }
  ctx.drawImage(ed.adj, 0, 0, w, h);
  paintStrokes(ctx, ed.strokes, w, h);

  // everything outside the shape is what gets cut away
  const shape = shapeOf(ed.pick).shape;
  const x = ed.crop.x * w, y = ed.crop.y * h, cw = ed.crop.w * w, ch = ed.crop.h * h;
  ctx.fillStyle = 'rgba(28,26,23,.66)';
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  shapePath(ctx, shape, x, y, cw, ch);
  ctx.fill('evenodd');

  for (const [color, width] of [['rgba(28,26,23,.75)', 4], ['#fff', 2]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    shapePath(ctx, shape, x, y, cw, ch);
    ctx.stroke();
  }
  if (shape !== 'rect') {                        // the box the corners belong to
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    ctx.setLineDash([]);
  }

  // thick corner brackets: the things to grab. Dark underlay keeps them visible on white photos.
  const len = Math.min(30, cw / 3, ch / 3), inset = 4;
  ctx.lineCap = 'square';
  for (const [color, width] of [['rgba(28,26,23,.75)', 10], ['#fff', 6]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [cx, sx] of [[x + inset, 1], [x + cw - inset, -1]]) {
      for (const [cy, sy] of [[y + inset, 1], [y + ch - inset, -1]]) {
        ctx.moveTo(cx, cy + sy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * len, cy);
      }
    }
    ctx.stroke();
  }
}

/** The chosen shape as width/height of the crop in its 0..1 units, or 0 when free. */
function edRatio() {
  const { r } = shapeOf(ed.pick);
  if (!r) return 0;
  const [a, b] = r.split(',').map(Number);
  return (a / b) * ed.base.height / ed.base.width;
}

/** Largest centred frame of the chosen shape. */
function fitRatio() {
  const rf = edRatio();
  if (!rf) return;
  let w = 1, h = 1 / rf;
  if (h > 1) { h = 1; w = rf; }
  ed.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Marks the button in a row whose data-v matches as the chosen one. */
function mark(row, val) {
  for (const b of row.children) {
    const on = b.dataset.v === val;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

const syncShape = () => mark($('edShapes'), ed.pick);

function syncBg() {
  $('edBg').setAttribute('aria-pressed', String(ed.bg));
  $('edBg').textContent = ed.bg ? '✓ Позадината е тргната — врати ја' : 'Тргни ја позадината';
  $('edBgCtl').hidden = !ed.bg;
}

function syncTint() {
  mark($('edTints'), ed.tint);
  $('edTintCtl').hidden = !ed.tint;
}

function syncBrush() {
  $('edBrush').setAttribute('aria-pressed', String(ed.brush));
  $('edBrush').textContent = ed.brush ? '✓ Цртањето е вклучено — исклучи го' : 'Цртај врз сликата';
  $('edBrushCtl').hidden = !ed.brush;
  $('edBrushUndo').disabled = !ed.strokes.length;
  mark($('edBrushShapes'), brush.shape);
  mark($('edBrushColors'), brush.color);
}

/** A round colour button; an empty hex makes the "no colour" one. */
function swatchBtn(hex, name) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.v = hex;
  if (hex) {
    btn.style.background = hex;
    btn.title = name;
    btn.setAttribute('aria-label', name);
  } else {
    btn.textContent = name;
    btn.className = 'none';
  }
  return btn;
}

/** A button with a little drawing of the shape, a wide to b tall. */
function shapeBtn(val, name, shape, a, b) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.v = val;
  const c = document.createElement('canvas');
  c.width = c.height = 80;
  const iw = a >= b ? 72 : 72 * a / b, ih = a >= b ? 72 * b / a : 72;
  const x = c.getContext('2d');
  x.fillStyle = '#5d584f';
  x.beginPath();
  shapePath(x, shape, (80 - iw) / 2, (80 - ih) / 2, iw, ih);
  x.fill();
  btn.append(c, name);
  return btn;
}

for (const [hex, name] of TINTS) $('edTints').appendChild(swatchBtn(hex, name));
for (const s of SHAPES) {
  const [a, b] = s.r ? s.r.split(',').map(Number) : [4, 3];
  $('edShapes').appendChild(shapeBtn(s.k, s.name, s.shape, a, b));
}
for (const [shape, name] of BRUSHES) $('edBrushShapes').appendChild(shapeBtn(shape, name, shape, 1, 1));
for (const [hex, name] of BRUSH_COLORS) $('edBrushColors').appendChild(swatchBtn(hex, name));

function edTurn(dir) {                           // +1 clockwise, -1 anticlockwise
  const c = ed.crop;
  ed.crop = dir > 0
    ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
    : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  mapStrokes(dir > 0 ? ([u, v]) => [1 - v, u] : ([u, v]) => [v, 1 - u]);
  // the mirror is applied after the turn, so a mirrored photo turns the other way underneath
  ed.rot = (ed.rot + (ed.flip ? -dir : dir) + 4) % 4;
  ed.base = oriented(ed.it.orig, ed.rot, ed.flip, PREVIEW_PX);
  fitRatio();                                    // a fixed shape cannot be turned, so re-seat it
  edCut();
}

/** Stretches the darkest and lightest parts of the photo to black and white. */
function edAuto() {
  const d = ed.base.getContext('2d').getImageData(0, 0, ed.base.width, ed.base.height).data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    if (d[i + 3] < 8) continue;
    hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
    n++;
  }
  // ignore the extreme half percent at each end: specks and glare
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.005) hi--;
  if (hi - lo < 24) return;                      // a flat colour: nothing sensible to do

  const k = Math.min(2, 255 / (hi - lo));
  $('edC').value = Math.round(100 * Math.log2(k));
  $('edB').value = clamp(Math.round((128 - (lo + hi) / 2) * k / 1.28), -100, 100);
  edAdjust();
}

/* crop frame: drag a corner or an edge to resize, drag inside to move */

function edPoint(e) {
  const r = edView.getBoundingClientRect();
  return {
    px: e.clientX - r.left, py: e.clientY - r.top,
    fx: clamp((e.clientX - r.left) / r.width, 0, 1),
    fy: clamp((e.clientY - r.top) / r.height, 0, 1),
    W: r.width, H: r.height,
  };
}

function edHandleAt({ px, py, W, H }) {
  const c = ed.crop;
  const L = c.x * W, R = (c.x + c.w) * W, T = c.y * H, B = (c.y + c.h) * H;
  if (px < L - ED_GRAB || px > R + ED_GRAB || py < T - ED_GRAB || py > B + ED_GRAB) return null;

  const dl = Math.abs(px - L), dr = Math.abs(px - R);
  const dt = Math.abs(py - T), db = Math.abs(py - B);
  const hx = Math.min(dl, dr) <= ED_GRAB ? (dl < dr ? 'w' : 'e') : '';
  const hy = Math.min(dt, db) <= ED_GRAB ? (dt < db ? 'n' : 's') : '';
  // a fixed shape can only be sized from its corners
  if (edRatio() && !(hx && hy)) return 'move';
  return hy + hx || 'move';
}

edView.addEventListener('pointerdown', e => {
  if (!ed) return;
  const p = edPoint(e);

  if (ed.brush) {
    const paint = {
      shape: brush.shape, color: brush.color,
      size: 0.005 + edVal('edBS') / 100 * 0.145,
      pts: [[p.fx, p.fy]],
    };
    ed.strokes.push(paint);
    edDrag = { paint };
    capture(edView, e.pointerId);
    syncBrush();
    edRender();
    return;
  }

  const handle = edHandleAt(p);
  if (!handle) return;
  edDrag = { handle, box: { ...ed.crop }, dx: p.fx - ed.crop.x, dy: p.fy - ed.crop.y };
  capture(edView, e.pointerId);
});

edView.addEventListener('pointermove', e => {
  if (!ed) return;
  const p = edPoint(e);

  if (!edDrag) {
    const h = ed.brush ? null : edHandleAt(p);
    edView.style.cursor = ed.brush ? 'crosshair' : !h ? 'default' : h === 'move' ? 'move' : CURSORS[h];
    return;
  }
  if (edDrag.paint) {
    edDrag.paint.pts.push([p.fx, p.fy]);
    edRender();
    return;
  }

  const o = edDrag.box, h = edDrag.handle;
  if (h === 'move') {
    ed.crop = { ...o, x: clamp(p.fx - edDrag.dx, 0, 1 - o.w), y: clamp(p.fy - edDrag.dy, 0, 1 - o.h) };
  } else {
    let L = o.x, R = o.x + o.w, T = o.y, B = o.y + o.h;
    if (h.includes('w')) L = clamp(p.fx, 0, R - ED_MIN);
    if (h.includes('e')) R = clamp(p.fx, L + ED_MIN, 1);
    if (h.includes('n')) T = clamp(p.fy, 0, B - ED_MIN);
    if (h.includes('s')) B = clamp(p.fy, T + ED_MIN, 1);

    const rf = edRatio();
    if (rf) {
      // shrink to the shape inside the dragged box, keeping the opposite corner still
      let w = R - L, hh = B - T;
      if (w / hh > rf) w = hh * rf; else hh = w / rf;
      if (h.includes('w')) L = R - w; else R = L + w;
      if (h.includes('n')) T = B - hh; else B = T + hh;
    }
    ed.crop = { x: L, y: T, w: R - L, h: B - T };
  }
  edRender();
});

function edEndDrag(e) {
  if (!edDrag) return;
  edDrag = null;
  release(edView, e.pointerId);
}
edView.addEventListener('pointerup', edEndDrag);
edView.addEventListener('pointercancel', edEndDrag);

/** Swaps the edited picture into one item and keeps its box sensible. */
function applyEdit(o, bmp, edit, mm) {
  const turned = (((o.edit ? o.edit.rot : 0) - (edit ? edit.rot : 0)) % 2) !== 0;
  o.bitmap = bmp;
  o.natW = bmp.width; o.natH = bmp.height;
  o.edit = edit;
  o._thumb = null; o._small = null; o._smallKey = null;

  if (mm) {
    o.w = mm[0]; o.h = mm[1]; o.lock = true;
  } else if (o.lock) {
    // fit the new shape inside the old box, so a crop never pushes into the neighbours
    let bw = o.w, bh = o.h;
    if (turned) [bw, bh] = [bh, bw];
    const a = o.natW / o.natH;
    if (bw / bh > a) bw = bh * a; else bh = bw / a;
    o.w = Math.max(MIN_MM, bw); o.h = Math.max(MIN_MM, bh);
  }
  const S = sheetSize();
  o.w = Math.min(o.w, S.w); o.h = Math.min(o.h, S.h);
  o.x = clamp(o.x, 0, S.w - o.w);
  o.y = clamp(o.y, 0, S.h - o.h);
}

function edDone() {
  const { it, rot, flip, crop, pick, bg, mask, strokes, mm } = ed;
  const look = edLook(), t = edVal('edT');
  const shape = shapeOf(pick).shape;
  const plain = !rot && !flip && !look.b && !look.c && !look.s && !look.tint && !bg && shape === 'rect' &&
                !strokes.length && crop.w > 0.999 && crop.h > 0.999;

  let bmp = it.orig;
  if (!plain) {
    const full = oriented(it.orig, rot, flip, BAKE_PX);
    if (mask) knock(full.getContext('2d'), mask, full.width, full.height);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(crop.w * full.width));
    out.height = Math.max(1, Math.round(crop.h * full.height));
    const x = out.getContext('2d', { willReadFrequently: true });
    if (shape !== 'rect') {
      x.beginPath();
      shapePath(x, shape, 0, 0, out.width, out.height);
      x.clip();
    }
    const ox = -Math.round(crop.x * full.width), oy = -Math.round(crop.y * full.height);
    x.drawImage(full, ox, oy);
    adjust(x, out.width, out.height, look);
    x.translate(ox, oy);                         // paint goes on last, so its colours stay true
    paintStrokes(x, strokes, full.width, full.height);
    bmp = out;
  }
  const edit = plain ? null : { rot, flip, crop: { ...crop }, pick, bg, t, strokes, ...look };

  snapshot();
  // copies made with "Копирај" or "Пополни ја страницата" follow along
  for (const o of doc.items) if (o.src === it.src) applyEdit(o, bmp, edit, mm);
  $('editor').close();
  syncPanel(); renderList(); render();
}

$('edit').addEventListener('click', () => openEditor(selected()));
$('editFab').addEventListener('click', () => openEditor(selected()));

$('edLeft').addEventListener('click', () => edTurn(-1));
$('edRight').addEventListener('click', () => edTurn(1));
$('edFlip').addEventListener('click', () => {
  ed.flip = !ed.flip;
  ed.crop.x = 1 - ed.crop.x - ed.crop.w;
  mapStrokes(([u, v]) => [1 - u, v]);
  edOrient();
});

$('edBrush').addEventListener('click', () => { ed.brush = !ed.brush; syncBrush(); });
$('edBrushShapes').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn) { brush.shape = btn.dataset.v; syncBrush(); }
});
$('edBrushColors').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn) { brush.color = btn.dataset.v; syncBrush(); }
});
$('edBrushUndo').addEventListener('click', () => { ed.strokes.pop(); syncBrush(); edRender(); });

$('edShapes').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const s = shapeOf(btn.dataset.v);
  ed.pick = s.k;
  ed.mm = s.mm ? s.r.split(',').map(Number) : null;
  fitRatio();
  syncShape();
  edRender();
});

$('edBg').addEventListener('click', () => {
  ed.bg = !ed.bg;
  syncBg();
  edCut();
});
$('edT').addEventListener('input', edCut);

$('edTints').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  ed.tint = btn.dataset.v;
  syncTint();
  edAdjust();
});

$('edAuto').addEventListener('click', edAuto);
for (const id of ['edB', 'edC', 'edS', 'edTA']) $(id).addEventListener('input', edAdjust);
for (const btn of document.querySelectorAll('.ed-slide button')) {
  btn.addEventListener('click', () => {
    const r = $(btn.dataset.for);
    r.value = clamp(+r.value + +btn.dataset.d, +r.min, +r.max);
    r.dispatchEvent(new Event('input'));
  });
}

$('edReset').addEventListener('click', () => {
  Object.assign(ed, { rot: 0, flip: false, crop: edFull(), pick: 'rect', bg: false, tint: '', strokes: [], mm: null });
  syncBrush();
  for (const id of ['edB', 'edC', 'edS']) $(id).value = 0;
  $('edT').value = 30;
  $('edTA').value = 50;
  syncShape();
  syncBg();
  syncTint();
  edOrient();
});

$('edCancel').addEventListener('click', () => $('editor').close());
$('edDone').addEventListener('click', e => busy(e.currentTarget, edDone));
$('editor').addEventListener('close', () => { ed = null; edDrag = null; });

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
  if ($('editor').open) return;                  // the page behind the editor stays put

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

window.addEventListener('resize', () => { render(); edRender(); });

syncPanel();
renderList();
render();
