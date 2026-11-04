// app.js —— 网页端平台适配层
// 只负责：拿像素、加载字体、手势、画到画布、导出。算法调用 core.js。

(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    imgW: 0, imgH: 0,
    sourceMime: 'image/jpeg',
    baseCanvas: null, baseCtx: null,
    view: { scale: 1, ox: 0, oy: 0 },
    tool: 'erase',            // erase | text | sticker | pan
    layers: [],
    selection: null,
    undoStack: [],
    stickerSeed: 1,
    activeText: null,
    activeSticker: null,
    picking: false,
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const stage = $('stage');
  const dctx = canvas.getContext('2d');

  // ---------- 工具切换 ----------
  document.querySelectorAll('.tool').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    state.selection = null;
    state.picking = false;
    $('textPanel').hidden = !(t === 'text' && state.activeText);
    $('stickerPanel').hidden = !(t === 'sticker');
    render();
  }

  // ---------- 图片导入 ----------
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', onImport);

  async function onImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    // 文件头判断格式（不信 file.type，可能为空或 WebP/HEIC）
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    state.sourceMime = detectImageFormat(head);

    let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

    // 边长 + 面积一起卡
    const origW = bitmap.width, origH = bitmap.height;
    const MAX_EDGE = 4096;
    const s = calcFitScale(origW, origH, MAX_EDGE);
    let scaledMsg = '';
    if (s < 1) {
      const w = Math.round(origW * s), h = Math.round(origH * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap = await createImageBitmap(c);
      scaledMsg = `已从 ${origW}×${origH} 缩到 ${w}×${h}，导出即此尺寸`;
    }

    state.imgW = bitmap.width;
    state.imgH = bitmap.height;
    state.baseCanvas = document.createElement('canvas');
    state.baseCanvas.width = state.imgW;
    state.baseCanvas.height = state.imgH;
    state.baseCtx = state.baseCanvas.getContext('2d');
    state.baseCtx.drawImage(bitmap, 0, 0);

    state.layers = [];
    state.undoStack = [];
    state.activeText = null;
    state.activeSticker = null;

    $('emptyHint').hidden = true;
    $('btnExport').disabled = false;
    if (scaledMsg) alert(scaledMsg);
    fitView();
    render();
  }

  // ---------- 视图 ----------
  // 导入时：重置视图（适配居中）
  function fitView() {
    const r = stage.getBoundingClientRect();
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
    state.view.scale = Math.min(r.width / state.imgW, r.height / state.imgH) || 1;
    state.view.ox = (r.width - state.imgW * state.view.scale) / 2;
    state.view.oy = (r.height - state.imgH * state.view.scale) / 2;
  }
  // 尺寸变化（面板开关/旋转）：只改画布尺寸，不动 view（不重置用户缩放）
  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      render();
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeCanvas).observe(stage);
  }

  function screenToImage(sx, sy) {
    return { x: (sx - state.view.ox) / state.view.scale, y: (sy - state.view.oy) / state.view.scale };
  }

  // ---------- 渲染 ----------
  function render() {
    if (!state.baseCanvas) { dctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    dctx.clearRect(0, 0, canvas.width, canvas.height);
    dctx.setTransform(state.view.scale, 0, 0, state.view.scale, state.view.ox, state.view.oy);
    dctx.drawImage(state.baseCanvas, 0, 0);
    for (const layer of state.layers) drawLayer(layer);
    if (state.selection && isValidRect(state.selection)) {
      dctx.strokeStyle = '#2f6feb';
      dctx.lineWidth = 2 / state.view.scale;
      dctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
      dctx.strokeRect(state.selection.x1, state.selection.y1, state.selection.w, state.selection.h);
      dctx.setLineDash([]);
    }
    dctx.resetTransform();
  }

  function drawLayer(layer) {
    if (layer.type === 'text') {
      dctx.font = `${layer.weight} ${layer.size}px ${layer.family}`;
      dctx.fillStyle = layer.color;
      dctx.textBaseline = 'top';
      dctx.fillText(layer.text, layer.x, layer.y);
    } else if (layer.type === 'sticker') {
      dctx.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
      if (layer === state.activeSticker) {
        dctx.strokeStyle = '#2f6feb';
        dctx.lineWidth = 2 / state.view.scale;
        dctx.strokeRect(layer.x, layer.y, layer.w, layer.h);
      }
    }
  }

  // ---------- 手势层（纯 Pointer Events + pointers Map） ----------
  const pointers = new Map();
  let gesture = null;   // 单指操作
  let pinch = null;     // 双指缩放
  canvas.style.touchAction = 'none';

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, point(e));
    if (pointers.size === 2) {
      rollbackGesture();   // 撤销第一指已做的操作（落字/选区/平移/拖贴图）
      beginPinch();
      return;
    }
    beginSingleFinger(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, point(e));
    if (pointers.size >= 2) updatePinch();
    else updateSingleFinger(e);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) commitSingleFinger();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function beginSingleFinger(e) {
    const p = point(e);
    const img = screenToImage(p.x, p.y);

    if (state.picking) { pickColorAt(img.x, img.y); gesture = { mode: 'pick' }; return; }

    if (state.tool === 'text') {
      const hit = hitText(img.x, img.y);
      if (hit) {
        state.activeText = hit;
        fillPanelFromActive();
        $('textPanel').hidden = false;
        gesture = { mode: 'editText' };
      } else {
        const layer = addTextAt(img.x, img.y);
        gesture = { mode: 'addedText', layer };
      }
      return;
    }

    if (state.tool === 'sticker') {
      const hit = hitSticker(img.x, img.y);
      if (hit) {
        state.activeSticker = hit;
        gesture = { mode: 'dragSticker', layer: hit, sx: hit.x, sy: hit.y, dx: img.x - hit.x, dy: img.y - hit.y };
      } else {
        state.activeSticker = null;
        gesture = { mode: 'pan', sv: { ...state.view }, sx: p.x, sy: p.y };
      }
      render();
      return;
    }

    if (state.tool === 'pan') {
      gesture = { mode: 'pan', sv: { ...state.view }, sx: p.x, sy: p.y };
      return;
    }

    // erase：拉矩形选区
    gesture = { mode: 'select', sx: img.x, sy: img.y };
    state.selection = null;
  }

  function updateSingleFinger(e) {
    if (!gesture) return;
    const p = point(e);
    const img = screenToImage(p.x, p.y);
    if (gesture.mode === 'pan') {
      state.view.ox = gesture.sv.ox + (p.x - gesture.sx);
      state.view.oy = gesture.sv.oy + (p.y - gesture.sy);
      render();
    } else if (gesture.mode === 'dragSticker') {
      gesture.layer.x = img.x - gesture.dx;
      gesture.layer.y = img.y - gesture.dy;
      render();
    } else if (gesture.mode === 'select') {
      state.selection = normalizeRect(gesture.sx, gesture.sy, img.x, img.y, state.imgW, state.imgH);
      render();
    }
  }

  function commitSingleFinger() {
    if (!gesture) return;
    if (gesture.mode === 'select') {
      // 最小边长 8px 防误触
      if (state.selection && state.selection.w >= 8 && state.selection.h >= 8) {
        applyErase();
      } else {
        state.selection = null;
        render();
      }
    }
    gesture = null;
  }

  function rollbackGesture() {
    if (!gesture) return;
    if (gesture.mode === 'addedText') {
      const i = state.layers.indexOf(gesture.layer);
      if (i >= 0) state.layers.splice(i, 1);
      state.activeText = null;
      $('textPanel').hidden = true;
    } else if (gesture.mode === 'select') {
      state.selection = null;
    } else if (gesture.mode === 'dragSticker') {
      gesture.layer.x = gesture.sx;
      gesture.layer.y = gesture.sy;
    } else if (gesture.mode === 'pan') {
      state.view = gesture.sv;
    }
    gesture = null;
    render();
  }

  function beginPinch() {
    const pts = [...pointers.values()];
    pinch = {
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      scale: state.view.scale,
      cx: (pts[0].x + pts[1].x) / 2,
      cy: (pts[0].y + pts[1].y) / 2,
    };
  }

  function updatePinch() {
    if (!pinch) return;
    const pts = [...pointers.values()];
    const cx = (pts[0].x + pts[1].x) / 2;
    const cy = (pts[0].y + pts[1].y) / 2;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const ns = Math.min(8, Math.max(0.2, pinch.scale * d / pinch.dist));
    const ix = (pinch.cx - state.view.ox) / state.view.scale;
    const iy = (pinch.cy - state.view.oy) / state.view.scale;
    state.view.scale = ns;
    state.view.ox = cx - ix * ns;
    state.view.oy = cy - iy * ns;
    render();
  }

  // ---------- 命中检测 ----------
  function hitSticker(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.type === 'sticker' && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l;
    }
    return null;
  }
  function hitText(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.type !== 'text') continue;
      dctx.font = `${l.weight} ${l.size}px ${l.family}`;
      const w = dctx.measureText(l.text).width;
      if (x >= l.x && x <= l.x + w && y >= l.y && y <= l.y + l.size) return l;
    }
    return null;
  }

  // ---------- 抹字 ----------
  function applyErase() {
    const r = state.selection;
    if (!isValidRect(r)) return;
    const snap = state.baseCtx.getImageData(r.x1, r.y1, r.w, r.h);
    const full = state.baseCtx.getImageData(0, 0, state.imgW, state.imgH);
    const out = eraseRect(full.data, state.imgW, state.imgH, r);
    state.baseCtx.putImageData(new ImageData(out, state.imgW, state.imgH), 0, 0);
    state.undoStack.push({ x: r.x1, y: r.y1, w: r.w, h: r.h, data: snap });
    $('btnUndo').disabled = false;
    state.selection = null;
    render();
  }

  function undo() {
    const s = state.undoStack.pop();
    if (!s) return;
    state.baseCtx.putImageData(s.data, s.x, s.y);
    $('btnUndo').disabled = state.undoStack.length === 0;
    render();
  }
  $('btnUndo').addEventListener('click', undo);

  // ---------- 文字 ----------
  function addTextAt(x, y) {
    const layer = {
      type: 'text', x, y,
      text: $('textContent').value || '文字',
      family: $('textFamily').value,
      weight: $('textWeight').value,
      size: +$('textSize').value,
      color: $('textColor').value,
    };
    state.layers.push(layer);
    state.activeText = layer;
    fillPanelFromActive();
    $('textPanel').hidden = false;
    render();
    return layer;
  }

  function fillPanelFromActive() {
    const layer = state.activeText;
    if (!layer) return;
    $('textContent').value = layer.text;
    $('textFamily').value = layer.family;
    $('textWeight').value = layer.weight;
    $('textSize').value = layer.size;
    $('textColor').value = layer.color;
    $('textWeightVal').textContent = layer.weight;
    $('textSizeVal').textContent = layer.size;
  }

  function syncTextInputs() {
    const layer = state.activeText;
    if (!layer) return;
    layer.text = $('textContent').value || '文字';
    layer.family = $('textFamily').value;
    layer.weight = $('textWeight').value;
    layer.size = +$('textSize').value;
    layer.color = $('textColor').value;
    $('textWeightVal').textContent = layer.weight;
    $('textSizeVal').textContent = layer.size;
  }
  ['textContent', 'textFamily', 'textWeight', 'textSize', 'textColor'].forEach((id) => {
    $(id).addEventListener('input', () => { syncTextInputs(); render(); });
  });

  $('btnApplyText').addEventListener('click', () => {
    state.activeText = null;
    $('textPanel').hidden = true;
    render();
  });

  // 吸管取色
  $('btnPick').addEventListener('click', () => {
    state.picking = true;
    state.tool = 'text';
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'text'));
  });

  function pickColorAt(x, y) {
    // 点在图片外：保持吸管状态，不退出
    if (x < 0 || y < 0 || x >= state.imgW || y >= state.imgH) return;
    const d = state.baseCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    $('textColor').value = rgbaToHex(d[0], d[1], d[2]);
    if (state.activeText) state.activeText.color = $('textColor').value;
    state.picking = false;
    render();
  }

  // ---------- 贴图 ----------
  $('stickerFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const sticker = { type: 'sticker', img: bmp, x: 0, y: 0, w: bmp.width, h: bmp.height };
    state.layers.push(sticker);
    randomizeSticker(sticker);
    state.activeSticker = sticker;
    render();
  });

  function randomizeSticker(sticker) {
    const pos = randomStickerPosition(state.imgW, state.imgH, sticker.w, sticker.h, state.stickerSeed++);
    sticker.x = pos.x; sticker.y = pos.y;
    render();
  }
  $('btnRandomPos').addEventListener('click', () => {
    if (state.activeSticker) randomizeSticker(state.activeSticker);
  });

  // ---------- 导出 ----------
  $('btnExport').addEventListener('click', exportImage);

  async function exportImage() {
    const out = document.createElement('canvas');
    out.width = state.imgW; out.height = state.imgH;
    const ctx = out.getContext('2d');
    ctx.drawImage(state.baseCanvas, 0, 0);
    for (const layer of state.layers) {
      if (layer.type === 'text') {
        ctx.font = `${layer.weight} ${layer.size}px ${layer.family}`;
        ctx.fillStyle = layer.color;
        ctx.textBaseline = 'top';
        ctx.fillText(layer.text, layer.x, layer.y);
      } else if (layer.type === 'sticker') {
        ctx.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
      }
    }
    const mime = outputMimeFromSource(state.sourceMime);
    const quality = mime === 'image/jpeg' ? 0.95 : undefined;
    const blob = await new Promise((res) => out.toBlob(res, mime, quality));
    const file = new File([blob], 'result.' + (mime === 'image/png' ? 'png' : 'jpg'), { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
    URL.revokeObjectURL(url);
  }

  render();
})();
