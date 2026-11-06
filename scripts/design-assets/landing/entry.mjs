// The landing page's script: the app's own character sea, the dry frame round
// a selected cell and the sand of a shelf cover, given the page's options, and
// the bar and sheets every page shares (site.mjs).
// build.mjs bundles it to /assets/landing.js; the page reads window.DriftingSea.
import { charSeaSupported, charSeaWordBox, createCharSea } from '../../../src/renderer/lib/char-sea/char-sea';
import { COVER_MASK_WIDTH, COVER_MASK_HEIGHT, coverSeed, drawSandCover } from '../../../src/renderer/lib/sand-cover';
import { SAND_FRAME_PAD, drawSandStroke, paintSandStroke, rgbOfComputedColour } from '../../../src/renderer/lib/sand-frame';
import { askForStarOnDownload, laySheets, leadWithVisitorPlatform, seaDensity, startBar, stirSea } from './site.mjs';

// The app now hands cover files back asynchronously. This static demo keeps
// its one-off alpha-to-PNG conversion here, beside its DOM consumer.
function sandCoverMaskUrl(alpha) {
  const canvas = document.createElement('canvas');
  canvas.width = COVER_MASK_WIDTH;
  canvas.height = COVER_MASK_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < alpha.length; i++) {
    image.data[i * 4] = 255;
    image.data[i * 4 + 1] = 255;
    image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

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
  leadWithVisitorPlatform,
  askForStarOnDownload,
  stirSea,
};
