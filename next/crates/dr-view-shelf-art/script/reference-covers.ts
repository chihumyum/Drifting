/**
 * The 0.1 client's shelf covers, drawn by its own code (src/renderer/lib/
 * shelf-cover, lib/sand-cover.ts) on Skia through @napi-rs/canvas: the
 * reference the Rust port is compared with. Sand is laid on the paper colour
 * in the storylines' colours, as the port's `art::flatten` does.
 *
 *   node_modules/.bin/esbuild next/crates/dr-view-shelf-art/script/reference-covers.ts \
 *     --bundle --platform=node --format=cjs --external:@napi-rs/canvas --outfile=<tmp>/ref.cjs
 *   NODE_PATH=node_modules node <tmp>/ref.cjs next/crates/dr-view-shelf-art/script/books.json <tmp>/ref
 */
import { createCanvas, Path2D } from '@napi-rs/canvas';
(globalThis as any).Path2D = Path2D;
import * as fs from 'node:fs';
import { ART_STYLES, COVER_STYLES } from '../../../../src/renderer/lib/shelf-cover/styles';
import { readCoverBook } from '../../../../src/renderer/lib/shelf-cover/book';
import { random, COVER_WIDTH, COVER_HEIGHT } from '../../../../src/renderer/lib/shelf-cover/paint';
import { drawSandCover } from '../../../../src/renderer/lib/sand-cover';

const [books, out] = [JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]];
fs.mkdirSync(out, { recursive: true });
for (const book of books) {
  for (const style of COVER_STYLES) {
    const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT);
    const ctx = canvas.getContext('2d') as any;
    let dark = false;
    if (style === 'sand') {
      const masks = drawSandCover(book);
      ctx.fillStyle = 'rgb(253,252,249)';
      ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
      const img = ctx.getImageData(0, 0, COVER_WIDTH, COVER_HEIGHT);
      masks.forEach((alpha: Float32Array, k: number) => {
        const color = book.storylines[k]?.color ?? '#55524E';
        const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
        for (let i = 0; i < alpha.length; i++) {
          const a = alpha[i];
          for (let c = 0; c < 3; c++) img.data[i * 4 + c] = img.data[i * 4 + c] * (1 - a) + rgb[c] * a;
        }
      });
      ctx.putImageData(img, 0, 0);
    } else {
      dark = ART_STYLES[style].draw(ctx, readCoverBook(book), random(book.seed)).dark;
    }
    fs.writeFileSync(`${out}/${book.name}-${style}.png`, canvas.toBuffer('image/png'));
    console.log(book.name, style, dark ? 'dark' : 'light');
  }
}
