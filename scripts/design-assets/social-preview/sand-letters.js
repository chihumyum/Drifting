// Each character of a line written as its own sand-brush mark: the glyph of an
// old serif is thinned to a skeleton, the skeleton is traced into strokes, and
// every stroke is laid with the dry brush of scripts/design-assets/brushicons.py
// (heavy where it lands, drier as it goes, tapered at free ends), then grained.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const smooth = (t) => t * t * (3 - 2 * t);
function noise1(n, k, rand) {
  const knots = Array.from({ length: k + 1 }, rand), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(1, n - 1)) * k, i0 = Math.min(Math.floor(x), k - 1), t = smooth(x - i0);
    out[i] = knots[i0] * (1 - t) + knots[i0 + 1] * t;
  }
  return out;
}
function resample(pts, step = 0.6) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = s[s.length - 1], n = Math.max(2, Math.floor(total / step)), out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const u = (k / (n - 1)) * total;
    while (j < s.length - 2 && s[j + 1] < u) j++;
    const t = s[j + 1] > s[j] ? (u - s[j]) / (s[j + 1] - s[j]) : 0;
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}

// brushicons.brush: one dry stroke.
function brush(alpha, w, h, pts, thick, rand, { load0 = 1, dry = 0.5, taper = [0.08, 0.18] } = {}) {
  pts = resample(pts);
  const n = pts.length;
  const wid = noise1(n, Math.max(3, Math.floor(n / 40)), rand);
  const wob = noise1(n, Math.max(3, Math.floor(n / 30)), rand);
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.max(1e-6, Math.hypot(tx, ty)); tx /= tl; ty /= tl;
    const s = k / (n - 1), load = load0 * (1 - dry * s);
    const aIn = taper[0] > 0 ? smooth(Math.min(1, s / taper[0])) : 1;
    const aOut = taper[1] > 0 ? smooth(Math.min(1, (1 - s) / taper[1])) : 1;
    const r = thick * (0.65 + 0.5 * wid[k]) * (0.55 + 0.45 * Math.min(aIn, aOut)) * (0.8 + 0.3 * load);
    const wb = wob[k] - 0.5;
    const px = pts[k][0] - ty * wb * 1.2, py = pts[k][1] + tx * wb * 1.2;
    const x0 = Math.max(0, Math.floor(px - r - 2)), x1 = Math.min(w, Math.ceil(px + r + 3));
    const y0 = Math.max(0, Math.floor(py - r - 2)), y1 = Math.min(h, Math.ceil(py + r + 3));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const dab = Math.min(1, Math.max(0, (r - Math.hypot(x - px, y - py)) / 1.1)) * load;
      if (dab > alpha[y * w + x]) alpha[y * w + x] = dab;
    }
  }
}
function disc(alpha, w, h, cx, cy, r, rand) {
  for (let y = Math.max(0, Math.floor(cy - r - 2)); y < Math.min(h, cy + r + 3); y++)
    for (let x = Math.max(0, Math.floor(cx - r - 2)); x < Math.min(w, cx + r + 3); x++) {
      const wob = 1 + 0.12 * (rand() - 0.5);
      const dab = Math.min(1, Math.max(0, (r * wob - Math.hypot(x - cx, y - cy)) / 1.1));
      if (dab > alpha[y * w + x]) alpha[y * w + x] = dab;
    }
}
// brushicons.grain: part dithered, part continuous, a few loose grains past the stroke.
function grain(alpha, w, h, rand, loose = 0.006) {
  const out = new Float32Array(w * h);
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] <= 0.02) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
    }
  }
  for (let p = 0; p < w * h; p++) {
    const a = alpha[p];
    const dither = rand() < a * 1.12 ? 0.6 + 0.4 * rand() : 0;
    out[p] = a * 0.38 + dither * 0.62;
    if (a < 0.02 && near[p] && rand() < loose) out[p] = 0.35 + 0.3 * rand();
  }
  return out;
}

// Zhang–Suen thinning of a binary image.
function thin(img, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const kill = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!img[y * w + x]) continue;
        const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
        const b = p.reduce((s, v) => s + v, 0);
        if (b < 2 || b > 6) continue;
        let a = 0; for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
        if (a !== 1) continue;
        if (step === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        kill.push(y * w + x);
      }
      if (kill.length) { changed = true; for (const k of kill) img[k] = 0; }
    }
  }
  return img;
}

// Trace a skeleton into polylines: between ends and junctions, then loops.
function trace(img, w, h) {
  const N = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && img[y * w + x];
  const nb = (x, y) => N.map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => on(a, b));
  const deg = (x, y) => nb(x, y).length;
  const used = new Set(), key = (x, y, a, b) => (x * 1e4 + y) * 1e8 + a * 1e4 + b;
  const useEdge = (x, y, a, b) => { used.add(key(x, y, a, b)); used.add(key(a, b, x, y)); };
  const walk = (sx, sy, nx, ny) => {
    const path = [[sx, sy]]; let px = sx, py = sy, x = nx, y = ny;
    useEdge(px, py, x, y);
    for (;;) {
      path.push([x, y]);
      if (deg(x, y) !== 2 || (x === sx && y === sy)) break;
      const next = nb(x, y).find(([a, b]) => !used.has(key(x, y, a, b)) && !(a === px && b === py));
      if (!next) break;
      useEdge(x, y, next[0], next[1]); px = x; py = y; [x, y] = next;
    }
    return path;
  };
  const lines = [];
  const nodes = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y) && deg(x, y) !== 2) nodes.push([x, y]);
  // Ends first, so a stroke starts where a pen would land.
  nodes.sort((a, b) => (deg(...a) === 1 ? 0 : 1) - (deg(...b) === 1 ? 0 : 1));
  for (const [x, y] of nodes) for (const [a, b] of nb(x, y)) if (!used.has(key(x, y, a, b))) lines.push(walk(x, y, a, b));
  // A dot thins to a lone pixel: keep it as a stroke of one point.
  for (const [x, y] of nodes) if (deg(x, y) === 0) lines.push([[x, y]]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!on(x, y)) continue;
    for (const [a, b] of nb(x, y)) if (!used.has(key(x, y, a, b))) lines.push(walk(x, y, a, b));
  }
  return lines.map((pts) => ({ pts, endA: deg(...pts[0]) <= 1, endB: deg(...pts[pts.length - 1]) <= 1 }));
}
const len = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
function soften(pts, k = 2) {
  if (pts.length < 2 * k + 2) return pts;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) { sx += pts[j][0]; sy += pts[j][1]; n++; }
    return [sx / n, sy / n];
  });
}

/** One character as a sand mark: a white-on-alpha canvas Q times the CSS size, plus its placement. */
export function letterMark(ch, { font, size, Q, thick, seed }) {
  const rand = rng(seed);
  const pad = Math.ceil(size * 0.5) * Q;
  const probe = new OffscreenCanvas(8, 8).getContext('2d');
  probe.font = font.replace('{size}', size * Q);
  const adv = probe.measureText(ch).width;
  const w = Math.ceil(adv + pad * 2), h = Math.ceil(size * Q * 1.6 + pad);
  const cv = new OffscreenCanvas(w, h), c = cv.getContext('2d');
  c.font = probe.font; c.fillStyle = '#000'; c.textBaseline = 'alphabetic';
  const base = Math.round(size * Q * 1.15 + pad / 2);
  c.fillText(ch, pad, base);
  const px = c.getImageData(0, 0, w, h).data, img = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) img[p] = px[p * 4 + 3] > 110 ? 1 : 0;
  thin(img, w, h);
  let strokes = trace(img, w, h);
  const spur = size * Q * 0.065;
  // Serif spurs go: a short branch with one free end hanging off a junction.
  // A short stroke on its own (a dot, a comma) is not a spur and stays.
  strokes = strokes.filter((st) => !(st.endA !== st.endB && len(st.pts) < spur));
  const alpha = new Float32Array(w * h);
  // A hand never writes the same letter twice: a small tilt and lift of its own.
  const tilt = (rand() - 0.5) * 0.07, lift = (rand() - 0.5) * size * Q * 0.04, cx = w / 2, cy = base - size * Q * 0.35;
  const place = ([x, y]) => [cx + (x - cx) * Math.cos(tilt) - (y - cy) * Math.sin(tilt), cy + (x - cx) * Math.sin(tilt) + (y - cy) * Math.cos(tilt) + lift];
  for (const st of strokes) {
    let pts = soften(st.pts).map(place);
    if (len(pts) < size * Q * 0.12) {
      const m = pts[Math.floor(pts.length / 2)];
      disc(alpha, w, h, m[0], m[1], thick * 1.25, rand);
      continue;
    }
    // Write top-down and left to right: a free end above or to the left is where the brush lands.
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let endA = st.endA, endB = st.endB;
    if (b[1] + b[0] * 0.3 < a[1] + a[0] * 0.3) { pts = pts.reverse(); [endA, endB] = [endB, endA]; }
    brush(alpha, w, h, pts, thick, rand, { load0: 0.95 + 0.05 * rand(), dry: 0.35 + 0.2 * rand(), taper: [endA ? 0.08 : 0, endB ? 0.2 : 0] });
  }
  const out = grain(alpha, w, h, rand);
  const img2 = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) { img2.data[p * 4] = img2.data[p * 4 + 1] = img2.data[p * 4 + 2] = 255; img2.data[p * 4 + 3] = Math.min(255, out[p] * 255); }
  c.clearRect(0, 0, w, h); c.putImageData(img2, 0, 0);
  return { canvas: cv, adv: adv / Q, pad: pad / Q, base: base / Q, w: w / Q, h: h / Q };
}

/** Write lines of text, centred, each character its own sand mark, tinted with colour. */
export async function writeInSand(canvas, lines, { font, size, lineHeight, centreY, colour, thick = 5.5, Q = 4, seed = 101 }) {
  await document.fonts.load(font.replace('{size}', size));
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = font.replace('{size}', size);
  const top = centreY - ((lines.length - 1) * lineHeight) / 2;
  const layer = new OffscreenCanvas(W * dpr, H * dpr), l = layer.getContext('2d');
  l.setTransform(dpr, 0, 0, dpr, 0, 0); l.imageSmoothingQuality = 'high';
  let n = 0;
  lines.forEach((line, row) => {
    let x = W / 2 - g.measureText(line).width / 2;
    const baseline = top + row * lineHeight + size * 0.33;
    for (const ch of line) {
      const adv = g.measureText(ch).width;
      if (ch !== ' ') {
        const m = letterMark(ch, { font, size, Q, thick, seed: seed + n * 7919 });
        l.drawImage(m.canvas, x - m.pad, baseline - m.base, m.w, m.h);
      }
      x += adv; n++;
    }
  });
  // Tint the white marks.
  l.globalCompositeOperation = 'source-in';
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.fillStyle = `rgb(${colour.map((v) => Math.round(v * 255)).join(',')})`;
  l.fillRect(0, 0, layer.width, layer.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(layer, 0, 0);
}

// The app icon (../app-icon/layers.js) traces the iceberg line art with the same skeleton.
export { thin, trace, len, rng };
