/**
 * One cover, drawn on a canvas and handed back as image files: for sand one
 * white PNG mask per stroke (coloured in CSS), for every other style one JPEG
 * of the whole cover and whether its ground is dark under the title. The same
 * code runs in the worker on an OffscreenCanvas and on the page as a fallback.
 */
import { drawSandCover } from '../sand-cover';
import { readCoverBook, type CoverRequest } from './book';
import { COVER_HEIGHT, COVER_WIDTH, random, type Paint } from './paint';
import { ART_STYLES, type CoverStyleId } from './styles';

export interface DrawnCoverFiles {
  files: Blob[];
  dark: boolean;
}

export type CoverCanvas = HTMLCanvasElement | OffscreenCanvas;

function toBlob(canvas: CoverCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The cover canvas gave no image.'))), type, quality);
  });
}

export async function drawCoverFiles(style: CoverStyleId, request: CoverRequest, canvas: CoverCanvas): Promise<DrawnCoverFiles> {
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext('2d') as Paint | null;
  if (!ctx) throw new Error('The cover canvas has no 2D context.');
  if (style === 'sand') {
    const files: Blob[] = [];
    for (const alpha of drawSandCover(request)) {
      const image = ctx.createImageData(COVER_WIDTH, COVER_HEIGHT);
      for (let i = 0; i < alpha.length; i++) {
        image.data[i * 4] = 255;
        image.data[i * 4 + 1] = 255;
        image.data[i * 4 + 2] = 255;
        image.data[i * 4 + 3] = Math.round(alpha[i] * 255);
      }
      ctx.putImageData(image, 0, 0);
      files.push(await toBlob(canvas, 'image/png'));
    }
    return { files, dark: false };
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.clearRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  const { dark } = ART_STYLES[style].draw(ctx, readCoverBook(request), random(request.seed));
  return { files: [await toBlob(canvas, 'image/jpeg', 0.9)], dark };
}
