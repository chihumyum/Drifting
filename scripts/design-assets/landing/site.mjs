// What every page of drifting.cc does in its bar and with its sea: the
// language and theme buttons (prefs.js applied the visitor's choices before
// the page painted), the sheets whose glass outline the sea draws, and the
// ripples a pointer leaves. Bundled into landing.js and pages.js.
import enso from '../../../src/assets/design/icons/enso.png';
import inkDisc from '../../../src/assets/design/icons/ink-disc.png';
import taiji from '../../../src/assets/design/icons/taiji.png';
import { DOC_LANG_KEY, LANG_KEY, THEME_KEY, homeFor, readPreference, savePreference } from './locales.mjs';

const THEME_ICONS = { system: taiji, light: enso, dark: inkDisc };
const THEME_LABELS = {
  zh: { system: '跟随系统', light: '浅色', dark: '深色' },
  en: { system: 'System', light: 'Light', dark: 'Dark' },
};
const SHEET_TEXTURE_OFFSETS = [[14, 46], [96, 132], [168, 18], [58, 186]];

// On a narrow window the sea needs a denser sheet of characters.
export const seaDensity = (width) => (width < 600 ? 1.7 : width < 960 ? 1.3 : 1);

// Home pages share a language menu. The information pages have two languages
// and keep their own preference. Theme choices last for the current tab.
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
    const label = themeButton.getAttribute(`data-theme-${theme}`) ?? THEME_LABELS[lang()][theme];
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
    // Return from information pages to the chosen home language when available.
    const savedHome = homeFor(readPreference(LANG_KEY));
    homeLink?.setAttribute('href', savedHome?.path ?? (lang() === 'zh' ? '/zh' : '/'));
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
  const switcher = document.querySelector('.language-switcher');
  if (switcher) {
    switcher.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-locale]');
      if (!link) return;
      savePreference(LANG_KEY, link.dataset.locale);
      switcher.open = false;
    });
    document.addEventListener('pointerdown', (event) => {
      if (!switcher.contains(event.target)) switcher.open = false;
    });
    switcher.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !switcher.open) return;
      switcher.open = false;
      switcher.querySelector('summary').focus();
    });
  }
  const langButton = document.getElementById('lang-btn');
  langButton?.addEventListener('click', () => {
    const next = lang() === 'zh' ? 'en' : 'zh';
    root.dataset.lang = next;
    root.lang = next === 'zh' ? 'zh-CN' : 'en';
    savePreference(DOC_LANG_KEY, next);
    sync();
    onLang(next);
  });
  sync();
  return { lang, isDark, sync };
}

// Every [data-sea] element is a sheet on the sea: the sea draws its glass
// outline and keeps its characters off it. [data-sea-hover] sheets bleed glass
// under the pointer. Returns the function that re-measures them.
// The home page offers the Mac and the Windows installer side by side, Mac
// first. A Windows visitor's Windows button takes the primary glass and leads
// each row, and the header's Download fetches that visitor's installer.
export function isWindowsVisitor(nav = navigator) {
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /^win/i.test(platform) || /Windows NT/.test(nav.userAgent || '');
}

export function leadWithVisitorPlatform(doc = document, nav = navigator) {
  const platform = isWindowsVisitor(nav) ? 'windows' : 'mac';
  for (const row of doc.querySelectorAll('.downloads')) {
    const lead = row.querySelector(`[data-platform="${platform}"]`);
    if (!lead) continue;
    for (const link of row.querySelectorAll('[data-platform]')) {
      link.classList.toggle('glass--primary', link === lead);
      link.classList.toggle('glass--rest', link !== lead);
    }
    row.insertBefore(lead, row.firstElementChild);
  }
  const header = doc.querySelector('.bar-dl');
  const installer = doc.querySelector(`.downloads [data-platform="${platform}"]`);
  if (header && installer) {
    header.href = installer.href;
    header.removeAttribute('target');
    header.removeAttribute('rel');
  }
  return platform;
}

// A download is the moment to ask for a star. Once an installer link is
// clicked (a row's Mac or Windows button, or the header's Download when it
// fetches the installer itself rather than opening the releases page), the
// root takes .downloaded and every .star-note on the page shows (index.html).
export function askForStarOnDownload(doc = document) {
  doc.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('.downloads [data-platform], .bar-dl') : null;
    if (!link || link.matches('.bar-dl[target]')) return;
    doc.documentElement.classList.add('downloaded');
  });
}

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
