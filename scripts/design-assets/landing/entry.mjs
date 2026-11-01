// The landing page's script: the app's own character sea, the dry frame round
// a selected cell and the sand of a shelf cover, given the page's options, and
// the bar and sheets every page shares (site.mjs).
// build.mjs bundles it to /assets/landing.js; the page reads window.DriftingSea.
import { charSeaSupported, charSeaWordBox, createCharSea } from '../../../src/renderer/lib/char-sea/char-sea';
import { coverSeed, drawSandCover, sandCoverMaskUrl } from '../../../src/renderer/lib/sand-cover';
import { SAND_FRAME_PAD, drawSandStroke, paintSandStroke, rgbOfComputedColour } from '../../../src/renderer/lib/sand-frame';
import { laySheets, seaDensity, startBar, stirSea } from './site.mjs';

// The site raises its name instead of "Loading", above the middle of the
// window so the tagline and the buttons fit under it. A word in capitals is a
// plain rectangle until its own characters are heavier and darker, and on a
// narrow window it needs the denser sheet to have cells to rise from.
const SEA = {
  word: 'DRIFTING',
  wordCentreY: 0.4,
  wordSpan: (width) => (width < 720 ? 0.86 : 0.7),
  density: seaDensity,
  wordInk: 1,
};

window.DriftingSea = {
  charSeaSupported,
  createCharSea: (canvas) => createCharSea(canvas, SEA),
  wordBox: (width, height) => charSeaWordBox(width, height, SEA),
  SAND_FRAME_PAD,
  drawSandStroke,
  paintSandStroke,
  rgbOfComputedColour,
  coverSeed,
  drawSandCover,
  sandCoverMaskUrl,
  startBar,
  laySheets,
  stirSea,
};
