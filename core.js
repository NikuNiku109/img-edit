// core.js —— 平台无关纯函数（不碰 DOM / canvas / 事件）
// 网页版和小程序版共享这一套算法。平台层只负责：拿像素、加载字体、手势、画到画布、导出。

// ================= 几何 =================

// 规范化矩形：保证 x1<x2, y1<y2，并裁剪到图像边界
function normalizeRect(ax, ay, bx, by, w, h) {
  const x1 = Math.max(0, Math.min(Math.min(ax, bx), w));
  const y1 = Math.max(0, Math.min(Math.min(ay, by), h));
  const x2 = Math.max(0, Math.min(Math.max(ax, bx), w));
  const y2 = Math.max(0, Math.min(Math.max(ay, by), h));
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

function isValidRect(r) {
  return !!(r && r.w > 0 && r.h > 0);
}

// ================= 颜色 =================

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function rgbaToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

// 解析颜色字符串（#hex 或 rgb()/rgba()），返回 [r,g,b]
function parseColor(c) {
  if (typeof c === 'string' && c.trim().startsWith('#')) return hexToRgb(c);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c));
  if (m) return [+m[1], +m[2], +m[3]];
  return [0, 0, 0];
}

// ================= 像素 =================

// 采样单个像素 [r,g,b,a]，越界返回 null
function samplePixel(data, w, h, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

// ================= 抹字（inpainting） =================

// 用「边界向内加权扩散」填充选区：每轮把与已知区相邻的待填像素，用其已知邻居均值填充。
// 纯色 / 渐变 / 简单纹理效果好；复杂纹理是近似（会糊但边缘不脏）。
// TODO: 后续升级为完整 Telea 修补（考虑梯度方向），并可按 edgeVariance 分层。
function eraseRect(srcData, w, h, rect) {
  const out = new Uint8ClampedArray(srcData);
  const mask = new Uint8Array(w * h);
  for (let y = rect.y1; y < rect.y2; y++) {
    for (let x = rect.x1; x < rect.x2; x++) mask[y * w + x] = 1;
  }

  let remaining = rect.w * rect.h;
  let guard = remaining * 4 + 100; // 防死循环
  while (remaining > 0 && guard-- > 0) {
    const boundary = [];
    for (let y = rect.y1; y < rect.y2; y++) {
      for (let x = rect.x1; x < rect.x2; x++) {
        const idx = y * w + x;
        if (!mask[idx]) continue;
        let n = 0, sr = 0, sg = 0, sb = 0, sa = 0;
        if (x > 0 && !mask[idx - 1]) { const i = (idx - 1) * 4; sr += out[i]; sg += out[i + 1]; sb += out[i + 2]; sa += out[i + 3]; n++; }
        if (x < w - 1 && !mask[idx + 1]) { const i = (idx + 1) * 4; sr += out[i]; sg += out[i + 1]; sb += out[i + 2]; sa += out[i + 3]; n++; }
        if (y > 0 && !mask[idx - w]) { const i = (idx - w) * 4; sr += out[i]; sg += out[i + 1]; sb += out[i + 2]; sa += out[i + 3]; n++; }
        if (y < h - 1 && !mask[idx + w]) { const i = (idx + w) * 4; sr += out[i]; sg += out[i + 1]; sb += out[i + 2]; sa += out[i + 3]; n++; }
        if (n > 0) boundary.push({ idx, r: sr / n, g: sg / n, b: sb / n, a: sa / n });
      }
    }
    if (boundary.length === 0) break;
    for (const p of boundary) {
      const i = p.idx * 4;
      out[i] = p.r; out[i + 1] = p.g; out[i + 2] = p.b; out[i + 3] = p.a;
      mask[p.idx] = 0;
      remaining--;
    }
  }
  return out;
}

// 选区边缘一圈的颜色方差（保留给「低方差用中值、高方差用 Telea」的分层策略）
function edgeVariance(data, w, h, rect) {
  const px = [];
  const push = (x, y) => { const p = samplePixel(data, w, h, x, y); if (p) px.push(p); };
  for (let x = rect.x1; x < rect.x2; x++) { push(x, rect.y1 - 1); push(x, rect.y2); }
  for (let y = rect.y1; y < rect.y2; y++) { push(rect.x1 - 1, y); push(rect.x2, y); }
  if (px.length === 0) return 0;
  let mr = 0, mg = 0, mb = 0;
  for (const p of px) { mr += p[0]; mg += p[1]; mb += p[2]; }
  mr /= px.length; mg /= px.length; mb /= px.length;
  let v = 0;
  for (const p of px) { v += (p[0] - mr) ** 2 + (p[1] - mg) ** 2 + (p[2] - mb) ** 2; }
  return v / px.length;
}

// ================= 格式 =================

// 根据原图 MIME 决定输出 MIME（容器一致：PNG→PNG，其余→JPEG）
function outputMimeFromSource(mime) {
  return mime === 'image/png' ? 'image/png' : 'image/jpeg';
}

// ================= 随机（贴图位置） =================

// mulberry32 可复现伪随机
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成一个不贴边的随机位置（素材左上角），返回 { x, y }
function randomStickerPosition(imgW, imgH, stickerW, stickerH, seed) {
  const rnd = mulberry32(seed);
  const margin = 8;
  const maxX = Math.max(margin, imgW - stickerW - margin);
  const maxY = Math.max(margin, imgH - stickerH - margin);
  const x = margin + rnd() * Math.max(0, maxX - margin);
  const y = margin + rnd() * Math.max(0, maxY - margin);
  return { x: Math.round(x), y: Math.round(y) };
}

// 导出（CommonJS 供小程序 require，浏览器里这些函数直接挂全局）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeRect, isValidRect, clamp255, rgbaToHex, hexToRgb, parseColor,
    samplePixel, eraseRect, edgeVariance, outputMimeFromSource,
    mulberry32, randomStickerPosition
  };
}
