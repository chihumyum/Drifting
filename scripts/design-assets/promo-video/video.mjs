// The promo video, as a page whose every frame is a function of time.
// build.mjs bundles it to /assets/video.js. The sea is the app's own
// (lib/char-sea), raising DRIFTING as the landing page does; the three
// corners of the workspace are the landing page's, played here on the
// video's timeline instead of on timers. clock.js holds time still until
// step(t) moves it, so render.mjs can capture frame after frame and get the
// same video every time.
import doneIcon from '../../../src/assets/design/icons/status-done.png';
import loaderIcon from '../../../src/assets/design/icons/loader.png';
import { charSeaWordBox, createCharSea } from '../../../src/renderer/lib/char-sea/char-sea';
import { SAND_FRAME_PAD, drawSandStroke, paintSandStroke, rgbOfComputedColour } from '../../../src/renderer/lib/sand-frame';

const clock = window.__clock;
const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'zh' ? 'zh' : 'en';
const root = document.documentElement;
root.dataset.lang = lang;
root.lang = lang === 'zh' ? 'zh-CN' : 'en';
// The video is dark, as the sharing card is; ?theme=light makes it the light
// interface's (the bookends of a recording in the light theme). The sea reads
// its theme from the class, the site's styles from data-theme.
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
root.dataset.theme = theme;
if (theme === 'dark') root.classList.add('dark');
// ?aspect=4:3 lays the page out 1152×864 for a 4:3 cover (a still of the opening).
const aspect = params.get('aspect') === '4:3' ? '4:3' : '16:9';
root.dataset.aspect = aspect;
// ?tagline=1.3 sets the 16:9 cover's tagline 1.3 times its size (a still of the opening).
const taglineScale = Number(params.get('tagline')) || 1;
const $ = (selector, within = document) => within.querySelector(selector);
const $$ = (selector, within = document) => [...within.querySelectorAll(selector)];

// ── Time ─────────────────────────────────────────────────────────────
// Seconds. The rain has been falling for a while when the video starts (the
// first frame is what a feed shows before it plays); a stone drops, the name
// rises and bursts; then for each of the three pillars, stones fall on the
// open sea (STONES before its sheet) and its sheet unfolds over the rings,
// folding away again before the next; and the name rises again over where to
// find it.
const T = {
  rain: -2.4,
  drop: 0.25,
  rise: 0.75,
  taglineIn: 2.0,
  taglineOut: 4.9,
  burst: 5.25,
  write: [6.1, 13.1],
  build: [13.8, 20.2],
  tend: [20.9, 27.8],
  closeRise: 28.1,
  closeIn: 29.0,
  end: 32.2,
};
const STONES = 0.4;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const span = (t, from, length) => clamp01((t - from) / length);
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeIn = (x) => x * x * x;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
// CSS cubic-bezier(x1, y1, x2, y2) as a function of progress.
function bezier(x1, y1, x2, y2) {
  const at = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, s = x;
    for (let i = 0; i < 40; i += 1) {
      s = (lo + hi) / 2;
      if (at(x1, x2, s) < x) lo = s;
      else hi = s;
    }
    return at(y1, y2, s);
  };
}
const structural = bezier(0.32, 0.72, 0, 1);
// A tab switch pushes the panels like a heavy block of ice (the app's PUSH_MS and PUSH_EASING).
const PUSH = 0.265;
const pushEase = bezier(0.8, 0, 0.66, 1);
// A typist's unevenness, the same on every render.
const jitter = (a, b) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function rise(el, t, from) {
  const r = easeOut(span(t, from, 0.55));
  el.style.opacity = String(r);
  el.style.translate = `0 ${((1 - r) * 12).toFixed(2)}px`;
}
// Where a sound is heard, left (−1) to right (1): where its element sits across the frame.
function panOf(node) {
  const box = node.getBoundingClientRect();
  return Number((Math.max(-1, Math.min(1, ((box.left + box.width / 2) / innerWidth) * 2 - 1))).toFixed(3));
}

// ── The sea ──────────────────────────────────────────────────────────
// Times bold's hairlines are thinner than one of the app's cells, so on a
// 1080p frame the capitals read only on a denser sheet with heavier risen
// characters (the sharing card packs its sheet 1.9 times). At 1.75 a raindrop
// still shows. The canvas is lifted a little so the sea carries on a phone.
const SEA = {
  word: 'DRIFTING',
  wordCentreY: 0.4,
  wordSpan: () => 0.82,
  density: () => 1.75,
  wordInk: 2.2,
};
if (theme === 'dark') $('#sea').style.filter = 'brightness(1.3)';

// ── Write: each line takes shape as it is typed, and the file beside it is saved ──
function writeCorner(el) {
  const MD = {
    zh: { first: '雾从港口那边漫过来的时候，林岚正把第三封信压在灯座底下。', lines: ['# 铁梯', '她每往上走一级，脚下就响一声，像有人在楼下**跟着数**。', '## 第七圈', '海面上亮起一点很小的光。'] },
    en: { first: 'The fog came in from the harbour while Lin was tucking the third letter under the lamp.', lines: ['# The stairs', 'Every step gave a small sound, as if someone below were **counting**.', '## The seventh turn', 'A small glow rose on the water.'] },
  }[lang];
  const live = $('#md-typed', el);
  const raw = $('#md-raw', el);
  const rawGhost = $('#md-raw-ghost', el);
  const rawLine = (text, cls) => {
    const line = document.createElement('span');
    line.className = `line${cls ? ` ${cls}` : ''}`;
    line.textContent = text;
    return line;
  };
  const fillRaw = (lines, box) => {
    box.innerHTML = '';
    ['---', 'drifting-id: 3f9c2a', '---'].forEach((text) => box.appendChild(rawLine(text, 'fm')));
    box.appendChild(rawLine(''));
    box.appendChild(rawLine(MD.first));
    lines.forEach((text) => { box.appendChild(rawLine('')); box.appendChild(rawLine(text)); });
  };
  const renderLine = (text, caret) => {
    let kind = 'p', body = text;
    if (/^## /.test(text)) { kind = 'h2'; body = text.slice(3); } else if (/^# /.test(text)) { kind = 'h1'; body = text.slice(2); }
    const html = esc(body).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*|^#{1,2}$/g, (m) => `<span class="md">${m}</span>`);
    const tag = kind === 'p' ? 'p' : 'div';
    return `<${tag}${kind === 'p' ? '' : ` class="${kind}"`}>${html}${caret ? '<span class="caret"></span>' : ''}</${tag}>`;
  };
  // The finished page and file, hidden, hold the corner's height while the lines are typed over them.
  const ghost = document.createElement('div');
  ghost.className = 'typed-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.innerHTML = live.innerHTML;
  live.parentNode.insertBefore(ghost, live);
  live.parentNode.classList.add('has-ghost');
  fillRaw(MD.lines, rawGhost);
  fillRaw([], raw);
  live.innerHTML = '';

  const pace = lang === 'zh' ? [0.05, 0.026] : [0.015, 0.012];
  let at = 0.7;
  const lines = MD.lines.map((text, i) => {
    const chars = [...text];
    const start = at;
    at += 0.12;
    const times = chars.map((ch, j) => {
      const shown = at;
      at += ch === ' ' || ch === '*' || ch === '#' ? 0.045 : pace[0] + pace[1] * jitter(i, j);
      return shown;
    });
    const done = at;
    const saved = done + 0.2;
    at = saved + 0.3;
    return { chars, start, times, done, saved };
  });
  let lastKey = '';
  let savedCount = 0;
  const play = (tau) => {
    const parts = [];
    let key = '';
    lines.forEach((line) => {
      if (tau < line.start) return;
      const typed = line.times.filter((time) => time <= tau).length;
      const typing = tau < line.done;
      key += `${typed}${typing ? '|' : '.'}`;
      parts.push(renderLine(line.chars.slice(0, typed).join(''), typing));
    });
    if (key !== lastKey) {
      live.innerHTML = parts.join('');
      lastKey = key;
    }
    const nowSaved = lines.filter((line) => tau >= line.saved).length;
    for (; savedCount < nowSaved; savedCount += 1) {
      raw.appendChild(rawLine(''));
      raw.appendChild(rawLine(MD.lines[savedCount], 'fresh'));
    }
  };
  // A key for each character as it appears, and the file saving each line.
  const keyPan = panOf(live), filePan = panOf(raw);
  play.sounds = lines.flatMap((line) => [
    ...line.chars.map((ch, j) => ({ at: line.times[j], kind: 'key', ch, pan: keyPan })),
    { at: line.saved, kind: 'saved', pan: filePan },
  ]);
  return play;
}

// ── Build: a tab shows its panel, a click opens the page and the brush goes round the cell ──
function studioCorner(el) {
  const side = $('#studio-sb', el);
  const frame = $('.cell-frame', side);
  const row = $('.sb-tabs', side);
  const block = $('.sb-tab-block', row);
  const tabs = $$('.sb-tab', side);
  const panes = $$('.sb-pane', side);
  const cells = $$('.cell', side);
  const pages = $$('[data-p]', el);
  const tabOf = (name) => tabs.find((tab) => tab.dataset.tab === name);
  const paneOf = (name) => panes.find((pane) => pane.dataset.pane === name);
  const cellOf = (k) => cells.find((cell) => cell.dataset.k === k);
  // [when, tab to show, cell to open]
  const TOUR = [[0.85, null, 'letters'], [2.0, 'elements', null], [2.4, null, 'lin'], [3.45, null, 'pier'], [4.55, 'drifts', null], [4.95, null, 'match']];
  const SEEDS = [0x5eed, 0x1f2e3d4c, 0x7a3b9c21, 0x0badf00d, 0x2468ace1];
  const within = (node) => {
    let x = 0, y = 0;
    for (let at = node; at && at !== side; at = at.offsetParent) { x += at.offsetLeft; y += at.offsetTop; }
    return { x, y };
  };
  block.style.transition = 'none';
  let stroke = null, strokeKey = '', painted = '', lastCell = '';
  const play = (tau) => {
    let tab = 'nodes', from = 'nodes', switchAt = -Infinity, cell = 'fog', selectAt = -Infinity, chosen = 0, travelled = 0;
    for (const [at, nextTab, nextCell] of TOUR) {
      if (at > tau) break;
      if (nextTab) {
        travelled += Math.abs(tabOf(nextTab).offsetLeft - tabOf(tab).offsetLeft);
        from = tab;
        tab = nextTab;
        switchAt = at;
      }
      if (nextCell) { cell = nextCell; selectAt = at; chosen += 1; }
    }
    const u = pushEase(clamp01((tau - switchAt) / PUSH));
    const pushing = u < 1;
    const a = tabOf(from), b = tabOf(tab);
    tabs.forEach((t) => t.classList.toggle('is-on', t === b));
    block.style.transform = `translateX(${a.offsetLeft + (b.offsetLeft - a.offsetLeft) * u}px)`;
    block.style.width = `${a.offsetWidth + (b.offsetWidth - a.offsetWidth) * u}px`;
    // Its glass runs with the distance it travels.
    row.style.setProperty('--flow', (travelled - Math.abs(b.offsetLeft - a.offsetLeft) * (1 - u)).toFixed(1));
    const fromPane = paneOf(from), toPane = paneOf(tab);
    const ahead = panes.indexOf(toPane) > panes.indexOf(fromPane) ? -100 : 100;
    panes.forEach((pane) => {
      const moving = pushing && fromPane !== toPane;
      pane.classList.toggle('off', !(pane === toPane || (moving && pane === fromPane)));
      pane.style.transform = !moving ? '' : pane === fromPane ? `translateX(${ahead * u}%)` : pane === toPane ? `translateX(${-ahead * (1 - u)}%)` : '';
    });
    if (cell !== lastCell) {
      cells.forEach((c) => (c.dataset.k === cell ? c.setAttribute('aria-current', 'true') : c.removeAttribute('aria-current')));
      pages.forEach((page) => page.classList.toggle('on', page.dataset.p === cell));
      lastCell = cell;
    }
    // The brush waits out the push and is laid where its cell landed.
    const current = cellOf(cell);
    const shown = !pushing && !current.closest('.sb-pane').classList.contains('off');
    frame.hidden = !shown;
    if (!shown) return;
    const w = current.offsetWidth, h = current.offsetHeight, dpr = window.devicePixelRatio || 1;
    const seed = SEEDS[chosen % SEEDS.length];
    const key = `${w}x${h}@${dpr}:${seed}`;
    if (key !== strokeKey) { stroke = drawSandStroke({ width: w, height: h, dpr, seed }); strokeKey = key; }
    const { x, y } = within(current);
    frame.style.left = `${x - SAND_FRAME_PAD}px`;
    frame.style.top = `${y - SAND_FRAME_PAD}px`;
    frame.style.width = `${w + SAND_FRAME_PAD * 2}px`;
    frame.style.height = `${h + SAND_FRAME_PAD * 2}px`;
    frame.style.setProperty('--c', current.style.getPropertyValue('--c'));
    const drawn = clamp01((tau - Math.max(selectAt, switchAt + PUSH)) / 0.38);
    const p = selectAt === -Infinity ? 1 : 1 - (1 - drawn) ** 2.2;
    const paint = `${key}:${p.toFixed(4)}`;
    if (paint !== painted) {
      paintSandStroke(frame, stroke, rgbOfComputedColour(getComputedStyle(frame).color), p);
      painted = paint;
    }
  };
  // A push for each tab, a click for each cell and the brush going round it once the push is over.
  const sidePan = panOf(side);
  play.sounds = [];
  let shownTab = 'nodes', lastSwitch = -Infinity;
  for (const [at, nextTab, nextCell] of TOUR) {
    if (nextTab) {
      play.sounds.push({ at, kind: 'push', dur: PUSH, pan: sidePan });
      shownTab = nextTab;
      lastSwitch = at;
    }
    if (nextCell) play.sounds.push({ at, kind: 'click', pan: sidePan }, { at: Math.max(at, lastSwitch + PUSH), kind: 'brush', dur: 0.38, pan: sidePan });
  }
  return play;
}

// ── Tend: the ask, its steps arriving one by one, the edit erased and written into the page ──
function agentCorner(el) {
  const AG = {
    zh: { old: '守塔人说，今晚这样的大雾，港口里不会有任何一条船敢出来，你就别再等了，等也是白等。', now: '守塔人说今晚不会有船。' },
    en: { old: 'The keeper said that in a fog like this not a single boat would dare come out tonight, so she might as well stop waiting.', now: 'The keeper said no boats would come tonight.' },
  }[lang];
  const edit = $('#ag-edit', el);
  const steps = $$('#ag-log .step', el);
  // What the edit keeps, removes and writes: the common start and end stay as they were.
  let p = 0, s = 0;
  while (p < AG.old.length && p < AG.now.length && AG.old[p] === AG.now[p]) p += 1;
  while (s < AG.old.length - p && s < AG.now.length - p && AG.old[AG.old.length - 1 - s] === AG.now[AG.now.length - 1 - s]) s += 1;
  const head = esc(AG.old.slice(0, p)), tail = esc(AG.old.slice(AG.old.length - s));
  const gone = [...AG.old.slice(p, AG.old.length - s)], come = [...AG.now.slice(p, AG.now.length - s)];

  // The page never changes height while the edit plays: it keeps the old text's height.
  const page = edit.closest('.pg');
  const cs = getComputedStyle(page);
  const clone = page.cloneNode(true);
  const old = $('#ag-edit', clone);
  old.removeAttribute('id');
  old.textContent = AG.old;
  clone.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;min-height:0;max-width:none;width:${page.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
  page.parentNode.appendChild(clone);
  page.style.minHeight = `${clone.offsetHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)}px`;
  clone.remove();

  const typePace = lang === 'zh' ? 0.07 : 0.028;
  const mark = 3.55, erase = 4.1, eraseFor = 0.45;
  const typeFrom = erase + eraseFor + 0.1;
  const settle = typeFrom + come.length * typePace + 0.55;
  const shows = [0.45, 1.2, 2.05, 2.9, settle + 0.3];
  const dones = [null, 1.95, 2.8, settle, null];
  steps.forEach((step) => step.classList.add('wait'));
  let lastHtml = '';
  const lastState = [];
  const play = (tau) => {
    let html;
    if (tau < mark) html = esc(AG.old);
    else if (tau < erase) html = `${head}<span class="del">${esc(gone.join(''))}</span>${tail}`;
    else if (tau < typeFrom) {
      const left = Math.round(gone.length * (1 - clamp01((tau - erase) / eraseFor)));
      html = `${head}<span class="del">${esc(gone.slice(0, left).join(''))}</span>${tail}`;
    } else if (tau < settle) {
      const typed = Math.min(come.length, Math.floor((tau - typeFrom) / typePace) + 1);
      html = `${head}<span class="ins">${esc(come.slice(0, typed).join(''))}</span><span class="caret"></span>${tail}`;
    } else html = `${head}<span class="ins-done">${esc(come.join(''))}</span>${tail}`;
    if (html !== lastHtml) { edit.innerHTML = html; lastHtml = html; }
    steps.forEach((step, i) => {
      const state = tau < shows[i] ? 0 : dones[i] !== null && tau >= dones[i] ? 2 : 1;
      if (lastState[i] === state) return;
      lastState[i] = state;
      step.classList.toggle('wait', state === 0);
      const icon = $('.ic', step);
      if (!icon || !step.classList.contains('agt-tool')) return;
      step.classList.toggle('glass-sweep', state > 0);
      icon.classList.toggle('spin', state === 1);
      icon.style.setProperty('--i', `url(${state === 1 ? loaderIcon : doneIcon})`);
    });
  };
  // The ask sent, each step arriving and finishing, the edit marked, erased and typed, and the reply.
  const logPan = panOf($('#ag-log', el)), pagePan = panOf(edit);
  play.sounds = [
    { at: shows[0], kind: 'send', pan: logPan },
    ...[1, 2, 3].map((i) => ({ at: shows[i], kind: 'step', pan: logPan })),
    ...[1, 2].map((i) => ({ at: dones[i], kind: 'done', pan: logPan })),
    { at: mark, kind: 'mark', pan: pagePan },
    { at: erase, kind: 'erase', dur: eraseFor, pan: pagePan },
    ...come.map((ch, n) => ({ at: typeFrom + n * typePace, kind: 'key', ch, pan: pagePan })),
    { at: settle, kind: 'settle', pan: pagePan },
    { at: shows[4], kind: 'reply', pan: logPan },
  ];
  return play;
}

// ── Scenes ───────────────────────────────────────────────────────────
// A pillar's words rise one after another and its corner plays, then fade.
function sheetScene(el, [open, close], play) {
  const rises = $$('.pv-rise', el);
  const corner = $('.vg', el);
  const scene = (t) => {
    if (t < open - 0.1 || t > close + 0.6) { el.style.opacity = '0'; return; }
    el.style.opacity = String(1 - easeOut(span(t, close, 0.28)));
    el.style.transform = `translate(-50%, -50%) scale(${(1 + 0.03 * easeInOut(span(t, open, close - open))).toFixed(5)})`;
    rises.forEach((item, i) => rise(item, t, open + 0.3 + i * 0.09));
    rise(corner, t, open + 0.22);
    play(t - open);
  };
  scene.el = el;
  scene.open = open;
  scene.close = close;
  scene.sounds = (play.sounds ?? []).map(({ at, ...sound }) => ({ ...sound, t: open + at }));
  return scene;
}

// Each pillar lies on a sheet of glass the sea draws. It unfolds from its
// middle over the rings of the stones that fell before it, and folds back to
// its middle as its words fade, so the next stones fall on open water: under
// the glass the sea shows at only 12%, and their rings would not be seen.
function sheetGlass(sheets) {
  return (t, shapes) => {
    sheets.forEach((sheet, n) => {
      const unfold = structural(span(t, sheet.open, 0.7)) * (1 - easeIn(span(t, sheet.close + 0.04, 0.35)));
      if (unfold < 0.002) return;
      const box = sheet.el.getBoundingClientRect();
      const height = box.height * unfold;
      shapes.push({ id: n + 1, x: box.left, y: box.top + (box.height - height) / 2, width: box.width, height, radius: 2, rest: 0.85 * Math.min(1, unfold * 1.4), hover: false, textureX: 14, textureY: 46 });
    });
  };
}

function underScene(el, [from, to], rises) {
  const lines = $$(`[data-l="${lang}"] .su`, el);
  const scene = (t) => {
    if (t < from - 0.1 || t > to + 0.6) { el.style.opacity = '0'; return; }
    el.style.opacity = String(1 - easeIn(span(t, to, 0.45)));
    rises.forEach((item, i) => rise(item, t, from + i * 0.18));
    lines.forEach((line, i) => line.style.setProperty('--draw', easeOut(span(t, from + 0.7 + i * 0.38, 0.6)).toFixed(4)));
  };
  // The brush under each word, heard where the word is.
  scene.sounds = lines.map((line, i) => ({ t: from + 0.7 + i * 0.38, kind: 'brush', dur: 0.6, pan: panOf(line) }));
  return scene;
}

// A cover's tagline, larger, and the word and the tagline centred together.
// On a 4:3 cover the tagline is one phrase a line, its widest line as wide as
// the word above it; on a 16:9 one it keeps its lines, `taglineScale` times
// its size.
function fitCover() {
  const hero = $('#s-hero');
  const tagline = $('.tagline', hero);
  if (aspect === '4:3') fitTaglineToWord(tagline);
  else tagline.style.fontSize = `${parseFloat(getComputedStyle(tagline).fontSize) * taglineScale}px`;
  const box = charSeaWordBox(innerWidth, innerHeight, SEA);
  const word = box.bottom - box.top;
  const under = parseFloat(getComputedStyle(hero).paddingTop) + tagline.getBoundingClientRect().height;
  SEA.wordCentreY = (innerHeight / 2 - (word + under) / 2 + word / 2) / innerHeight;
}

function fitTaglineToWord(tagline) {
  // A break after each comma that has none yet (the video's own markup is left as it is).
  const texts = [];
  const walker = document.createTreeWalker($(`[data-l="${lang}"]`, tagline), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const text of texts) {
    const commas = [...text.data.matchAll(/[，,] ?/g)]
      .filter((comma) => comma.index + comma[0].length < text.data.length || text.nextSibling?.nodeName !== 'BR');
    for (const comma of commas.reverse()) {
      const rest = text.splitText(comma.index + 1);
      rest.data = rest.data.replace(/^ /, '');
      rest.before(document.createElement('br'));
    }
  }
  // As wide as its widest line, at any size.
  tagline.style.maxWidth = 'none';
  tagline.style.width = 'max-content';
  const target = innerWidth * SEA.wordSpan();
  // Twice: the lines keep their breaks, but spacing rounds.
  for (let pass = 0; pass < 2; pass += 1) {
    const { width } = tagline.getBoundingClientRect();
    tagline.style.fontSize = `${(parseFloat(getComputedStyle(tagline).fontSize) * target) / width}px`;
  }
}

const canvas = $('#sea');
let sea = null;
let scenes = [];
let cues = [];
let sounds = [];
let fired = 0;

async function setUp() {
  // The faces the sea, the corners and the words are written in, before anything is measured.
  await Promise.all([
    '400 24px "Newsreader Variable"', '500 24px "Newsreader Variable"', '400 24px "Inter Tight Variable"', '500 24px "Inter Tight Variable"',
    '600 24px "Inter Tight Variable"', '400 24px "Noto Serif SC Variable"', '700 24px "Times New Roman"',
  ].map((face) => document.fonts.load(face, lang === 'zh' ? '雾林岚 Aa' : 'Aa')));
  await document.fonts.ready;
  if (aspect === '4:3' || taglineScale !== 1) fitCover();
  sea = createCharSea(canvas, SEA);
  if (!sea) throw new Error('promo: the sea needs WebGL2');
  sea.refreshTheme();
  sea.setScript(lang);
  sea.setActive(true);
  const box = charSeaWordBox(innerWidth, innerHeight, SEA);
  root.style.setProperty('--word-bottom', `${box.bottom}px`);

  const hero = $('#s-hero');
  const close = $('#s-close');
  const sheets = [['#s-write', T.write, writeCorner], ['#s-build', T.build, studioCorner], ['#s-tend', T.tend, agentCorner]];
  const pillars = sheets.map(([selector, times, corner]) => {
    const el = $(selector);
    // Centred before the corner measures where its sounds come from.
    el.style.transform = 'translate(-50%, -50%)';
    return sheetScene(el, times, corner(el));
  });
  scenes = [
    underScene(hero, [T.taglineIn, T.taglineOut], $$('.pv-rise', hero)),
    ...pillars,
    sheetGlass(pillars),
    underScene(close, [T.closeIn, Infinity], $$('.pv-rise', close)),
  ];
  // As each pillar's sheet comes, stones fall on the sea: one more each time
  // than the last (the opening's one in the middle, then two, three, four),
  // scattered apart from each other, a few hundredths of a second between
  // them. Seeded, so every render scatters them the same way.
  const scatter = (count, seed) => {
    let s = seed;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const spots = [];
    for (let tries = 0; spots.length < count; tries += 1) {
      const x = 0.1 + 0.8 * rand(), y = 0.14 + 0.72 * rand();
      const apart = tries < 400 ? 0.42 : 0.25;
      if (spots.every(([a, b]) => Math.hypot(((a - x) * innerWidth) / innerHeight, b - y) > apart)) spots.push([x, y]);
    }
    return spots;
  };
  // [when, what the sea does, what is heard]
  cues = [
    [T.drop, () => sea.drop(innerWidth / 2, innerHeight * 0.4, 1.4), { kind: 'drop', size: 1 }],
    [T.rain, () => sea.rain(true)],
    [T.rise, () => sea.loading(true), { kind: 'rise' }],
    [T.burst, () => sea.loading(false), { kind: 'burst' }],
    ...sheets.flatMap(([, [open]], n) => scatter(n + 2, 0x51ab + n * 977).map(([x, y], i) => [
      open - STONES + i * 0.055,
      () => sea.drop(x * innerWidth, y * innerHeight, 1),
      { kind: 'drop', size: 0.7, sheet: n, pan: Number((x * 2 - 1).toFixed(3)) },
    ])),
    [T.closeRise, () => sea.loading(true), { kind: 'rise' }],
  ].sort((x, y) => x[0] - y[0]);
  // What render.mjs's sound.mjs plays, in seconds of the video. `section`
  // marks where the score turns: the name, the burst, each pillar, the fold
  // and the close.
  sounds = [
    ...cues.filter((cue) => cue[2]).map(([t, , sound]) => ({ t, ...sound })),
    ...scenes.flatMap((scene) => scene.sounds ?? []),
    ...pillars.flatMap((pillar) => [{ t: pillar.open, kind: 'glass', dir: 1 }, { t: pillar.close + 0.04, kind: 'glass', dir: -1 }]),
    { t: T.closeIn, kind: 'pill' },
    ...[['hero', T.rise], ['burst', T.burst], ['write', T.write[0]], ['build', T.build[0]], ['tend', T.tend[0]], ['fold', T.tend[1]], ['close', T.closeIn]]
      .map(([name, t]) => ({ t, kind: 'section', name })),
  ].map((sound) => ({ pan: 0, ...sound, t: Number(sound.t.toFixed(4)) })).sort((x, y) => x.t - y.t);
  // The glass texture and the sea's glyph atlas settle on real time.
  await new Promise((resolve) => clock.real.setTimeout(resolve, 600));
  // The rain that fell before the first frame.
  for (let t = T.rain; t < 0; t += 1 / 30) step(t);
}

/** Moves the video to `t` seconds (from T.rain on); frames must come in order. */
function step(t) {
  clock.advanceTo((t - T.rain) * 1000);
  while (fired < cues.length && cues[fired][0] <= t) { cues[fired][1](); fired += 1; }
  const shapes = [];
  scenes.forEach((scene) => scene(t, shapes));
  sea.setShapes(shapes);
  clock.flushFrames();
  clock.syncAnimations();
}

const ready = setUp();
// The opening (the rain, the name rising, its burst) and the closing (the name
// again over where to find it), alone: the bookends of a recorded demo.
const bookends = { open: [0, T.burst + 1.3], close: [T.tend[1] + 0.2, T.end] };
window.__promo = { duration: T.end, bookends, ready, step, get sounds() { return sounds; } };

// Opened in a browser: play in real time (from ?t= seconds, reached at 30 fps).
if (!params.has('render')) {
  ready.then(() => {
    const from = Number(params.get('t')) || 0;
    for (let t = 0; t < from; t += 1 / 30) step(t);
    const start = clock.real.now() - from * 1000;
    const tick = () => {
      const t = (clock.real.now() - start) / 1000;
      step(Math.min(t, T.end));
      if (t < T.end) clock.real.requestAnimationFrame(tick);
    };
    clock.real.requestAnimationFrame(tick);
  });
}
