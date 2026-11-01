// The information pages' script (/privacy, /terms, /support and the 404):
// the shared bar, and the app's sea under the window with the page's sheet
// lying on it. No word rises here: the sea only rains, its heads and trails
// changing the characters they pass. build.mjs bundles it to /assets/pages.js.
import { charSeaSupported, createCharSea } from '../../../src/renderer/lib/char-sea/char-sea';
import { laySheets, seaDensity, startBar, stirSea } from './site.mjs';

const root = document.documentElement;
const canvas = document.getElementById('sea');
let sea = null;
try {
  if (canvas instanceof HTMLCanvasElement && charSeaSupported()) sea = createCharSea(canvas, { density: seaDensity });
} catch {
  sea = null;
}
if (!sea) root.classList.add('no-sea');

const remeasure = laySheets(sea);
const bar = startBar({
  onTheme: () => sea?.refreshTheme(),
  onLang: (next) => {
    sea?.setScript(next);
    // A #zh or #en link names the language; it follows the switch.
    if (location.hash === '#zh' || location.hash === '#en') history.replaceState(null, '', `#${next}`);
    remeasure();
  },
});
if (sea) {
  sea.refreshTheme();
  sea.setScript(bar.lang());
  sea.setActive(true);
  sea.rain(true);
}
addEventListener('resize', () => sea?.resize());
document.fonts?.ready.then(() => {
  sea?.resize();
  remeasure();
});
stirSea(sea, 'a, button, input, summary');
