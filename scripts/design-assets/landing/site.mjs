// What every page of drifting.cc does in its bar and with its sea: the
// language and theme buttons (prefs.js applied the visitor's choices before
// the page painted), the sheets whose glass outline the sea draws, and the
// ripples a pointer leaves. Bundled into landing.js and pages.js.
import enso from '../../../src/assets/design/icons/enso.png';
import inkDisc from '../../../src/assets/design/icons/ink-disc.png';
import taiji from '../../../src/assets/design/icons/taiji.png';

const LANG_KEY = 'drifting.landing.lang';
const THEME_KEY = 'drifting.landing.theme';
const THEME_ICONS = { system: taiji, light: enso, dark: inkDisc };
const THEME_LABELS = {
  zh: { system: '跟随系统', light: '浅色', dark: '深色' },
  en: { system: 'System', light: 'Light', dark: 'Dark' },
};
const SHEET_TEXTURE_OFFSETS = [[14, 46], [96, 132], [168, 18], [58, 186]];

// On a narrow window the sea needs a denser sheet of characters.
export const seaDensity = (width) => (width < 600 ? 1.7 : width < 960 ? 1.3 : 1);

// The language button keeps the choice. On the home page it is a link to the
// page in the other language; on the information pages it switches the page
// between its zh and en copy. The theme button steps system → light → dark; a
// pick lasts only for this tab, so the next visit follows the system again.
export function startBar({ onTheme = () => {}, onLang = () => {} } = {}) {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const themeButton = document.getElementById('theme-btn');
  const themeIcon = document.getElementById('theme-ic');
  const homeLink = document.querySelector('a.brand[href="/"]');
  const lang = () => (root.dataset.lang === 'en' ? 'en' : 'zh');
  const pick = () => {
    const theme = root.getAttribute('data-theme');
    return theme === 'light' || theme === 'dark' ? theme : 'system';
  };
  const isDark = () => (pick() === 'system' ? system.matches : pick() === 'dark');
  function sync() {
    root.classList.toggle('dark', isDark());
    const theme = pick();
    themeIcon.style.setProperty('--i', `url(${THEME_ICONS[theme]})`);
    themeButton.setAttribute('aria-label', THEME_LABELS[lang()][theme]);
    themeButton.title = THEME_LABELS[lang()][theme];
    // An information page's name in the bar leads to the home page in the language it shows.
    homeLink?.setAttribute('href', lang() === 'zh' ? '/zh' : '/');
    onTheme();
  }
  themeButton.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(pick()) + 1) % order.length];
    try {
      if (next === 'system') sessionStorage.removeItem(THEME_KEY);
      else sessionStorage.setItem(THEME_KEY, next);
    } catch {}
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
  });
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  system.addEventListener('change', sync);
  const langButton = document.getElementById('lang-btn');
  if (langButton instanceof HTMLAnchorElement) {
    langButton.addEventListener('click', () => {
      try {
        localStorage.setItem(LANG_KEY, langButton.hreflang);
      } catch {}
    });
  } else langButton.addEventListener('click', () => {
    const next = lang() === 'zh' ? 'en' : 'zh';
    root.dataset.lang = next;
    root.lang = next === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {}
    sync();
    onLang(next);
  });
  sync();
  return { lang, isDark, sync };
}

// Every [data-sea] element is a sheet on the sea: the sea draws its glass
// outline and keeps its characters off it. [data-sea-hover] sheets bleed glass
// under the pointer. Returns the function that re-measures them.
export function laySheets(sea) {
  const sheets = [...document.querySelectorAll('[data-sea]')];
  const hovering = new Set();
  let queued = false;
  function push() {
    queued = false;
    if (!sea) return;
    const height = innerHeight;
    const shapes = [];
    sheets.forEach((sheet, index) => {
      const box = sheet.getBoundingClientRect();
      if (box.bottom < -40 || box.top > height + 40) return;
      const [textureX, textureY] = SHEET_TEXTURE_OFFSETS[index % SHEET_TEXTURE_OFFSETS.length];
      shapes.push({ id: index + 1, x: box.left, y: box.top, width: box.width, height: box.height, radius: 2, rest: 0.85, hover: hovering.has(sheet), textureX, textureY });
    });
    sea.setShapes(shapes);
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(push);
  }
  for (const sheet of sheets) {
    if (!sheet.hasAttribute('data-sea-hover')) continue;
    sheet.addEventListener('pointerenter', () => { hovering.add(sheet); schedule(); });
    sheet.addEventListener('pointerleave', () => { hovering.delete(sheet); schedule(); });
  }
  // A scroll is measured at once: its event comes before the frame's callbacks,
  // so the sea's next draw already has the sheets where they are. Waiting for
  // a frame of our own would land after the sea had drawn them where they were.
  addEventListener('scroll', push, { passive: true });
  addEventListener('resize', schedule);
  push();
  return schedule;
}

// A mouse wakes the water it passes over; a press anywhere but on a control
// drops a stone.
export function stirSea(sea, controls) {
  if (!sea) return;
  addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') sea.wake(event.clientX, event.clientY);
  }, { passive: true });
  addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest(controls)) return;
    sea.drop(event.clientX, event.clientY);
  });
}
