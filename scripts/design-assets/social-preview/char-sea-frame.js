// One still frame of the character sea (src/renderer/lib/char-sea), drawn on a
// 2D canvas the way its fragment shader lays the cells: the English prose in
// reading order, a word held up out of the water by its ink coverage (no
// outline: the cells it lifts surface, swell and take the accent), and one
// frame of the loading rain lighting the cells' own letters.

// The English text of char-sea-text.ts.
const PROSE =
  'The fog came in from the harbour while Lin was tucking the third letter under the lamp. The iron stairs of the lighthouse were cold with damp, and every step gave a small sound, as if someone below were counting. ' +
  'The keeper said no boats would come tonight. She did not answer. She opened the window a crack and let the sea wind turn the pages on the desk, and a corner lifted to show a faint line of pencil on the back, in her own hand, though she could not remember writing it. ' +
  'Far off the foghorn sounded twice, stopped, and sounded once more. On the seventh turn of the light a small glow rose on the water, as if someone under the sea had struck a match. ';

// The loading word's face (LOADING_FONT in char-sea.ts).
const WORD_FONT = (size) => `700 ${size}px "Times New Roman", Tinos, Times, serif`;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function colour(value) {
  const el = document.createElement('i');
  el.style.color = value;
  document.body.append(el);
  const m = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
  el.remove();
  return m.slice(0, 3).map((v) => v / 255);
}
/** A CSS colour token of the page as [r, g, b] in 0..1. */
export function token(name) {
  return colour(getComputedStyle(document.body).getPropertyValue(name).trim());
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

/**
 * Draw the frame on a canvas sized in CSS pixels. Defaults are the app's own;
 * a sharing card, seen at half size, packs the cells tighter (density) and
 * makes the risen and rained-on glyphs heavier (peakBoost, rainWeight).
 */
export async function drawSea(canvas, opts) {
  const {
    word, wordCentreY = 250, dark = false, seed = 7,
    density = 1, peakBoost = 1, wordHeight = 0.3, wordWidth = 0.7,
    rainDensity = 0.2, rainStrength = 0.55, rainSurface = 0.7, rainTint = 0.55,
    rainLength = [7, 27], rainWeight = 0, rainWidth = 1,
    quiet = [], // [{x, y, w, h, soft}]: no rain here
  } = opts;
  const CW = 6.5 / density, CH = 10 / density, WATER = 7 / density;
  const ground = token('--paper-deep'), ink = token('--ink-2'), tint = token('--accent');
  const rest = dark ? 0.09 : 0.075, peak = Math.min(1, (dark ? 0.58 : 0.62) * peakBoost);
  await document.fonts.load(`400 24px "Newsreader Variable"`, PROSE);
  await document.fonts.load(WORD_FONT(100));
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = rgb(ground); g.fillRect(0, 0, W, H);

  // The word as each water cell's share of its ink (loadingWordShape), held at 0.45.
  const wc = Math.ceil(W / WATER), wr = Math.ceil(H / WATER);
  const share = new Float32Array(wc * wr);
  if (word) {
    const S = 4, ras = new OffscreenCanvas(wc * S, wr * S), r = ras.getContext('2d');
    let size = H * wordHeight;
    r.font = WORD_FONT(size);
    const wide = r.measureText(word).width;
    if (wide > W * wordWidth) size *= (W * wordWidth) / wide;
    const k = S / WATER;
    r.font = WORD_FONT(size * k);
    const m = r.measureText(word);
    r.fillStyle = '#fff'; r.textAlign = 'center'; r.textBaseline = 'alphabetic';
    r.fillText(word, (W / 2) * k, wordCentreY * k + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
    const px = r.getImageData(0, 0, ras.width, ras.height).data;
    for (let y = 0; y < wr; y++) for (let x = 0; x < wc; x++) {
      let s = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) s += px[((y * S + j) * ras.width + x * S + i) * 4 + 3];
      share[y * wc + x] = s / (S * S * 255);
    }
  }
  // The spring that holds the word spreads it a little into the water around.
  const h = new Float32Array(wc * wr), tmp = new Float32Array(wc * wr);
  const K = [0.25, 0.5, 0.25];
  for (let y = 0; y < wr; y++) for (let x = 0; x < wc; x++) {
    let s = 0; for (let d = -1; d <= 1; d++) s += share[y * wc + Math.min(wc - 1, Math.max(0, x + d))] * K[d + 1]; tmp[y * wc + x] = s;
  }
  for (let y = 0; y < wr; y++) for (let x = 0; x < wc; x++) {
    let s = 0; for (let d = -1; d <= 1; d++) s += tmp[Math.min(wr - 1, Math.max(0, y + d)) * wc + x] * K[d + 1]; h[y * wc + x] = 0.45 * s;
  }
  const hAt = (px, py) => {
    const fx = px / WATER - 0.5, fy = py / WATER - 0.5;
    const x0 = Math.max(0, Math.min(wc - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(wr - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const a = h[y0 * wc + x0], b = h[y0 * wc + x0 + 1], c = h[(y0 + 1) * wc + x0], d = h[(y0 + 1) * wc + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  // One frame of the rain: about rainDensity of the drops falling, each a lit
  // head and a trail that fades behind it (CharSeaRain in char-sea-model.ts).
  const cols = Math.ceil(W / CW), rows = Math.ceil(H / CH);
  const trail = new Float32Array(cols * rows), head = new Float32Array(cols * rows);
  const rand = rng(seed);
  const quietAt = (x, y) => {
    let k = 1;
    for (const q of quiet) {
      const dx = Math.max(q.x - x, 0, x - (q.x + q.w)), dy = Math.max(q.y - y, 0, y - (q.y + q.h));
      k = Math.min(k, Math.min(1, Math.hypot(dx, dy) / (q.soft ?? 30)));
    }
    return k;
  };
  // A drop is rainWidth columns wide (now and then one more), so a denser sea
  // keeps the rain as wide as it falls on the app's own 6.5px columns.
  for (let c0 = 0; c0 < cols; c0 += rainWidth) {
    const span = rainWidth + (rand() < 0.25 ? 1 : 0);
    const drops = rand() < rainDensity ? (rand() < 0.3 ? 2 : 1) : 0;
    let top = rows + 20;
    for (let n = 0; n < drops; n++) {
      const length = rainLength[0] + rand() * (rainLength[1] - rainLength[0]);
      const y = n === 0 ? rand() * (rows + length) : top - 3 - rand() * 18;
      top = y - length;
      const hr = Math.floor(y);
      for (let r = Math.max(0, hr - Math.ceil(length)); r <= Math.min(rows - 1, hr); r++) {
        const t = Math.max(0, 1 - (y - r) / length);
        for (let c = c0; c < Math.min(cols, c0 + span); c++) {
          trail[r * cols + c] = Math.max(trail[r * cols + c], rainStrength * t ** 1.25);
          if (r === hr) head[r * cols + c] = rainStrength;
        }
      }
    }
  }

  // The cells, as the fragment shader lays them: light themes multiply the ink on.
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.globalCompositeOperation = dark ? 'source-over' : 'multiply';
  let i = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++, i++) {
    const x = c * CW + CW / 2, y = r * CH + CH / 2;
    const q = quietAt(x, y);
    const rx = trail[r * cols + c] * q, ry = head[r * cols + c] * q;
    const hc = hAt(x, y);
    const cr = Math.max(-1, Math.min(1, hc * 3)), sc = 1 + 0.2 * cr;
    const s = Math.max(smoothstep(0.04, 0.26, Math.abs(hc)), rainSurface * rx);
    const glyph = PROSE[i % PROSE.length];
    const dotA = rest * (1 - s);
    if (dotA > 0.004) {
      g.globalAlpha = dotA; g.fillStyle = rgb(ink);
      g.beginPath(); g.arc(x, y, 0.62, 0, Math.PI * 2); g.fill();
    }
    if (s < 0.01 || glyph === ' ') continue;
    g.globalAlpha = s * peak * (0.6 + 0.4 * Math.max(cr, ry, rx * rainWeight));
    g.fillStyle = rgb(mix3(ink, tint, Math.min(1, 0.45 * s * Math.max(cr, 0) + rainTint * ry)));
    // At a sharing card's size a risen glyph also takes weight, or the word reads too pale.
    g.font = `${Math.round(400 + 260 * Math.max(cr, 0, rx * rainWeight))} ${(CH * 0.72 * sc).toFixed(2)}px "Newsreader Variable"`;
    g.fillText(glyph, x, y + CH * 0.03);
  }
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
}
