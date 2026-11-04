// app.js —— 网页端平台适配层
// 只负责：拿像素、加载字体、手势、画到画布、导出。算法调用 core.js。

(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    imgW: 0, imgH: 0,
    sourceMime: 'image/jpeg',
    baseCanvas: null,     // 底图 canvas（原图 + 已抹掉的字）
    baseCtx: null,
    display: null,        // 显示 canvas
    dctx: null,
    view: { scale: 1, ox: 0, oy: 0 },  // 视图变换
    tool: 'erase',        // erase | text | sticker | pan
    layers: [],           // 叠加层对象（文字 / 贴图）
    selection: null,      // 抹字选区（图像坐标）
    undoStack: [],        // 抹字撤销栈（区域快照）
    textSeed: 0,
    stickerSeed: 1,
    activeText: null,     // 正在编辑的文字对象
    activeSticker: null,  // 正在拖动的贴图对象
    picking: false,       // 吸管取色模式
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const stage = $('stage');
  const dctx = canvas.getContext('2d');
  state.display = canvas;
  state.dctx = dctx;

  // ---------- 工具切换 ----------
  document.querySelectorAll('.tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTool(btn.dataset.tool);
    });
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
    state.sourceMime = file.type || 'image/jpeg';

    // EXIF 方向摆正 + 长边 > 4096 先缩小（iOS 18 前 canvas 面积上限约 1600 万像素）
    let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const MAX = 4096;
    if (bitmap.width > MAX || bitmap.height > MAX) {
      const s = MAX / Math.max(bitmap.width, bitmap.height);
      const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap = await createImageBitmap(c);
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
    fitView();
    render();
  }

  // ---------- 视图变换 ----------
  function fitView() {
    const r = stage.getBoundingClientRect();
    state.view.scale = Math.min(r.width / state.imgW, r.height / state.imgH) || 1;
    state.view.ox = (r.width - state.imgW * state.view.scale) / 2;
    state.view.oy = (r.height - state.imgH * state.view.scale) / 2;
    canvas.width = r.width;
    canvas.height = r.height;
  }

  function screenToImage(sx, sy) {
    return { x: (sx - state.view.ox) / state.view.scale, y: (sy - state.view.oy) / state.view.scale };
  }
  function imageToScreen(x, y) {
    return { x: x * state.view.scale + state.view.ox, y: y * state.view.scale + state.view.oy };
  }

  window.addEventListener('resize', () => { if (state.imgW) { fitView(); render(); } });

  // ---------- 渲染 ----------
  function render() {
    if (!state.baseCanvas) { dctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    dctx.clearRect(0, 0, canvas.width, canvas.height);
    dctx.setTransform(state.view.scale, 0, 0, state.view.scale, state.view.ox, state.view.oy);
    dctx.drawImage(state.baseCanvas, 0, 0);

    for (const layer of state.layers) drawLayer(layer);

    // 抹字选区框
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

  // ---------- 抹字 ----------
  function applyErase() {
    const r = state.selection;
    if (!isValidRect(r)) return;
    // 保存区域快照用于撤销
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
      type: 'text',
      x, y,
      text: $('textContent').value || '文字',
      family: $('textFamily').value,
      weight: $('textWeight').value,
      size: +$('textSize').value,
      color: $('textColor').value,
    };
    state.layers.push(layer);
    state.activeText = layer;
    $('textWeightVal').textContent = layer.weight;
    $('textSizeVal').textContent = layer.size;
    $('textPanel').hidden = false;
    render();
  }

  // 把输入框当前值写回正在编辑的文字对象
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

  // 输入框 → 正在编辑的文字对象（只绑定一次，避免重复绑定）
  ['textContent', 'textFamily', 'textWeight', 'textSize', 'textColor'].forEach((id) => {
    $(id).addEventListener('input', () => { syncTextInputs(); render(); });
  });

  $('btnApplyText').addEventListener('click', () => {
    state.activeText = null;
    $('textPanel').hidden = true;
    render();
  });

  // 吸管取色：点画布取原图颜色
  $('btnPick').addEventListener('click', () => {
    state.picking = true;
    state.tool = 'text';
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'text'));
  });
  function pickColor(x, y) {
    const data = state.baseCtx.getImageData(0, 0, state.imgW, state.imgH).data;
    const p = samplePixel(data, state.imgW, state.imgH, x, y);
    if (p) {
      $('textColor').value = rgbaToHex(p[0], p[1], p[2]);
      if (state.activeText) state.activeText.color = $('textColor').value;
      render();
    }
    state.picking = false;
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
    sticker.x = pos.x;
    sticker.y = pos.y;
    render();
  }
  $('btnRandomPos').addEventListener('click', () => {
    if (state.activeSticker) randomizeSticker(state.activeSticker);
  });

  // ---------- 手势（Pointer Events 统一鼠标/单指触摸） ----------
  let dragging = null; // { mode: 'pan'|'select'|'sticker', sx, sy, ... }

  canvas.addEventListener('pointerdown', (e) => {
    const p = screenToImage(e.offsetX, e.offsetY);
    if (state.picking) { pickColor(p.x, p.y); return; }

    if (state.tool === 'text') {
      addTextAt(p.x, p.y);
      return;
    }
    if (state.tool === 'sticker') {
      const hit = hitSticker(p.x, p.y);
      if (hit) {
        state.activeSticker = hit;
        dragging = { mode: 'sticker', layer: hit, dx: p.x - hit.x, dy: p.y - hit.y };
      } else {
        state.activeSticker = null;
        dragging = { mode: 'pan', sx: e.offsetX, sy: e.offsetY, ox: state.view.ox, oy: state.view.oy };
      }
      render();
      return;
    }
    if (state.tool === 'pan') {
      dragging = { mode: 'pan', sx: e.offsetX, sy: e.offsetY, ox: state.view.ox, oy: state.view.oy };
      return;
    }
    // erase：拉矩形选区
    dragging = { mode: 'select', sx: p.x, sy: p.y };
    state.selection = null;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = screenToImage(e.offsetX, e.offsetY);
    if (dragging.mode === 'pan') {
      state.view.ox = dragging.ox + (e.offsetX - dragging.sx);
      state.view.oy = dragging.oy + (e.offsetY - dragging.sy);
      render();
    } else if (dragging.mode === 'sticker') {
      dragging.layer.x = p.x - dragging.dx;
      dragging.layer.y = p.y - dragging.dy;
      render();
    } else if (dragging.mode === 'select') {
      state.selection = normalizeRect(dragging.sx, dragging.sy, p.x, p.y, state.imgW, state.imgH);
      render();
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    if (dragging.mode === 'select') {
      applyErase();
    }
    dragging = null;
  });

  function hitSticker(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.type === 'sticker' && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l;
    }
    return null;
  }

  // 双指缩放画布（touch）
  let pinch = null;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && state.imgW) {
      pinch = {
        dist: distTouches(e.touches),
        scale: state.view.scale,
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const rect = canvas.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      const ns = Math.min(8, Math.max(0.2, pinch.scale * distTouches(e.touches) / pinch.dist));
      // 以捏合中心为锚缩放
      const ix = (pinch.cx - rect.left - state.view.ox) / state.view.scale;
      const iy = (pinch.cy - rect.top - state.view.oy) / state.view.scale;
      state.view.scale = ns;
      state.view.ox = cx - ix * ns;
      state.view.oy = cy - iy * ns;
      render();
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => { pinch = null; });

  function distTouches(ts) {
    const dx = ts[0].clientX - ts[1].clientX;
    const dy = ts[0].clientY - ts[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------- 导出 ----------
  $('btnExport').addEventListener('click', exportImage);

  async function exportImage() {
    const out = document.createElement('canvas');
    out.width = state.imgW;
    out.height = state.imgH;
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
    const quality = mime === 'image/jpeg' ? 0.92 : undefined;
    const blob = await new Promise((res) => out.toBlob(res, mime, quality));
    const file = new File([blob], 'result.' + (mime === 'image/png' ? 'png' : 'jpg'), { type: mime });

    // 优先系统分享（iOS 进相册），失败回退下载/长按
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // 分享失败则走下载
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 初始
  render();
})();
