// node write-layers.mjs <dumped page> <Assets directory> <out directory>:
// write the layers that layers.html printed as PNG files, and the flattened
// square as square.png in the out directory.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [page, assets, out] = process.argv.slice(2);
const text = readFileSync(page, 'utf8').match(/<pre id="layers">([^<]*)<\/pre>/)?.[1];
if (!text) throw new Error(`no layers in ${page}`);
const { layers, square } = JSON.parse(text.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
const write = (file, url) => {
  writeFileSync(file, Buffer.from(url.split(',', 2)[1], 'base64'));
  console.log(file);
};
for (const [name, url] of Object.entries(layers)) write(path.join(assets, name), url);
write(path.join(out, 'square.png'), square);
