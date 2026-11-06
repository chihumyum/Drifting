#!/usr/bin/env node
// Render the promo video, frame by frame, with headless Chrome and ffmpeg:
//   node scripts/design-assets/promo-video/render.mjs [--lang en,zh] [--fps 60] [--out dir]
//   node scripts/design-assets/promo-video/render.mjs --stills 2.5,8,15   # PNGs at those seconds
//   node scripts/design-assets/promo-video/render.mjs --sound-only        # new sound on the videos already rendered
//   add --modelled to keep the modelled instruments when GarageBand's sound library is installed
//   node scripts/design-assets/promo-video/render.mjs --bookends --lang zh --theme light --size 2160
//     only the opening and the closing, each its own clip with its rain and stones
//     (drifting-bookend-{open,close}-<lang>-<theme>[-2160].mp4), for the ends of a recorded demo
// Builds the page (build.mjs), serves it on 127.0.0.1, and for each language
// steps the page's clock one frame at a time and captures it at 1920×1080.
// Writes to out/promo-video by default, for each language: the silent
// drifting-promo-<lang>.mp4 (H.264, BT.709), its sound (sound.mjs) as
// drifting-promo-<lang>.wav and, without the pad, -effects.wav, both at
// −16 LUFS, and the two together as drifting-promo-<lang>-sound.mp4.
// CHROME overrides the browser.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playOnGarageBand } from './instruments.mjs';
import { RATE, score, synthesize, wav } from './sound.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const langs = option('lang', 'en,zh').split(',');
const fps = Number(option('fps', '60'));
const out = path.resolve(option('out', path.join(root, 'out/promo-video')));
const stills = option('stills', '') ? option('stills').split(',').map(Number) : null;
const soundOnly = args.includes('--sound-only');
// --modelled keeps the modelled piano and strings even when GarageBand's sound library is installed.
const modelled = args.includes('--modelled');
const bookends = args.includes('--bookends');
const theme = option('theme', 'dark') === 'light' ? 'light' : 'dark';
const size = Number(option('size', '1080'));
if (size !== 1080 && size !== 2160) throw new Error('render.mjs: --size is 1080 or 2160');
// --aspect 4:3 (stills only) lays the page out 1152×864 for a 4:3 cover: 1920×1440 (or 3840×2880).
const aspect = option('aspect', '16:9');
if (aspect !== '16:9' && aspect !== '4:3') throw new Error('render.mjs: --aspect is 16:9 or 4:3');
if (aspect === '4:3' && !stills) throw new Error('render.mjs: --aspect 4:3 is for --stills (a cover)');
// --tagline 1.3 (stills only) sets a 16:9 cover's tagline 1.3 times its size.
const tagline = Number(option('tagline', '1'));
if (!(tagline >= 1 && tagline <= 2.5)) throw new Error('render.mjs: --tagline is 1 to 2.5');
if (tagline !== 1 && (!stills || aspect !== '16:9')) throw new Error('render.mjs: --tagline is for --stills at 16:9 (a cover)');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// The page is laid out at 1152×648 CSS px and captured at 1920×1080 (or 3840×2160).
const VIEW = { width: 1152, height: aspect === '4:3' ? 864 : 648, deviceScaleFactor: (size === 2160 ? 3840 : 1920) / 1152 };

const pageDir = path.join(out, 'page');
// The page is built for each language: its corners carry the landing's copy for it.
const buildPage = (lang) => {
  const built = spawnSync(process.execPath, [path.join(here, 'build.mjs'), pageDir, '--lang', lang], { stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
};
buildPage(langs[0]);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const file = path.join(pageDir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(pageDir) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(tmpdir(), 'drifting-promo-'));
const browser = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--hide-scrollbars',
  '--mute-audio', '--force-color-profile=srgb', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore' });
const closed = new Promise((resolve) => browser.on('exit', resolve));
const finish = async (code) => {
  browser.kill();
  server.close();
  await closed;
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
};
process.on('SIGINT', () => finish(130));

// A minimal DevTools Protocol client.
let port = '';
for (let i = 0; i < 100 && !port; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const file = path.join(profile, 'DevToolsActivePort');
  if (existsSync(file)) port = readFileSync(file, 'utf8').split('\n')[0];
}
if (!port) { console.error('render.mjs: Chrome did not start'); finish(1); }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => { socket.onopen = resolve; });
let nextId = 0;
const pending = new Map();
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message));
    else resolve(data.result);
  } else if (data.method === 'Runtime.exceptionThrown') {
    console.error('page:', data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
  } else if (data.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(data.params.type)) {
    console.error('page:', data.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  nextId += 1;
  pending.set(nextId, { resolve, reject });
  socket.send(JSON.stringify({ id: nextId, method, params }));
});
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const capture = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');

// EBU R128 loudness to −16 LUFS (what the feeds play at) by one fixed gain,
// so the rain never pumps: the few peaks the gain would lift past −2 dBFS
// (the hits, the first drop) are held by a look-ahead limiter first. What the
// limiter takes off the hits lowers the loudness a little, so the gain is
// measured again on the result and corrected, twice at most.
function loudness(file) {
  const measured = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(measured.stderr)[0]).input_i);
}
function loudnorm(input, output) {
  let gain = -16 - loudness(input);
  for (let pass = 0; pass < 3; pass += 1) {
    const ceiling = Math.min(1, 10 ** ((-2 - gain) / 20));
    const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-af',
      `alimiter=limit=${ceiling.toFixed(5)}:attack=10:release=250:level=disabled:latency=1,volume=${gain.toFixed(2)}dB`,
      '-ar', String(RATE), '-c:a', 'pcm_s24le', output], { stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`render.mjs: normalizing ${input} failed`);
    const off = -16 - loudness(output);
    if (Math.abs(off) < 0.15) return;
    gain += off;
  }
}

// The page's list of what is heard when, synthesized and normalized.
async function writeSound(lang, duration) {
  const sounds = await evaluate('window.__promo.sounds');
  // The cue list, for cutting other music to the picture.
  writeFileSync(path.join(out, `drifting-promo-${lang}-cues.json`), `${JSON.stringify(sounds.filter((s) => s.kind !== 'key'), null, 1)}\n`);
  const instruments = modelled ? null : playOnGarageBand(score(sounds, duration), duration, profile);
  console.log(`${lang}: the score on ${instruments ? "GarageBand's instruments" : 'the modelled instruments'}`);
  const { mix, effects } = synthesize(sounds, duration, { instruments });
  const files = [];
  for (const [bus, name] of [[mix, `drifting-promo-${lang}.wav`], [effects, `drifting-promo-${lang}-effects.wav`]]) {
    const raw = path.join(profile, `raw-${name}`);
    writeFileSync(raw, wav(bus));
    loudnorm(raw, path.join(out, name));
    files.push(path.join(out, name));
  }
  return files[0];
}

function mux(video, audio, file) {
  const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-movflags', '+faststart', '-shortest', file], { stdio: 'inherit' });
  if (done.status !== 0) throw new Error('render.mjs: muxing the sound failed');
  console.log(file);
  if (path.basename(file) === 'drifting-promo-en-sound.mp4') readmeCut(file);
}

// The English video for the repository's README: GitHub plays a video there
// only as an attachment uploaded through its web editor, and takes at most
// 10 MB from a free account. At 720p and 30 fps (the README is under 900 px
// wide) it is about 7.5 MB.
function readmeCut(file) {
  const readme = path.join(out, 'drifting-promo-en-readme.mp4');
  const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'fps=30,scale=1280:720:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', readme], { stdio: 'inherit' });
  if (done.status !== 0) throw new Error('render.mjs: the README cut failed');
  console.log(readme);
}

function encoderFor(file) {
  const encoder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    // The captures are sRGB; the frames carry BT.709 primaries and transfer (ffmpeg 9 tags only what the frames hold).
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-movflags', '+faststart', file],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const encoded = new Promise((resolve) => encoder.on('close', resolve));
  return {
    write: async (png) => { if (!encoder.stdin.write(png)) await new Promise((resolve) => encoder.stdin.once('drain', resolve)); },
    end: async () => { encoder.stdin.end(); if ((await encoded) !== 0) throw new Error('render.mjs: ffmpeg failed'); },
  };
}

// The opening and the closing alone, each with the rain and stones (no score)
// under it. The sea carries over from frame to frame, so every frame from the
// start is stepped and only the bookends' are captured.
async function renderBookends(lang, duration) {
  const ranges = Object.entries(await evaluate('window.__promo.bookends'));
  const { effects } = synthesize(await evaluate('window.__promo.sounds'), duration, { instruments: null });
  const raw = path.join(profile, `bookends-raw-${lang}.wav`);
  writeFileSync(raw, wav(effects));
  const sound = path.join(profile, `bookends-${lang}.wav`);
  loudnorm(raw, sound);
  const suffix = `${lang}-${theme}${size === 2160 ? '-2160' : ''}`;
  const last = Math.max(...ranges.map(([, [, to]]) => Math.round(to * fps)));
  const open = new Map();
  for (let frame = 0; frame < last; frame += 1) {
    await evaluate(`window.__promo.step(${frame / fps})`);
    for (const [name, [from, to]] of ranges) {
      if (frame < Math.round(from * fps) || frame >= Math.round(to * fps)) continue;
      if (!open.has(name)) open.set(name, encoderFor(path.join(profile, `bookend-${name}.mp4`)));
      await open.get(name).write(await capture());
    }
  }
  for (const [name, [from, to]] of ranges) {
    await open.get(name).end();
    const file = path.join(out, `drifting-bookend-${name}-${suffix}.mp4`);
    const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(profile, `bookend-${name}.mp4`),
      '-ss', String(Math.round(from * fps) / fps), '-t', String((Math.round(to * fps) - Math.round(from * fps)) / fps), '-i', sound,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-movflags', '+faststart', file],
    { stdio: 'inherit' });
    if (done.status !== 0) throw new Error('render.mjs: muxing a bookend failed');
    console.log(file);
  }
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { ...VIEW, mobile: false });
mkdirSync(out, { recursive: true });

try {
  for (const lang of langs) {
    if (lang !== langs[0]) buildPage(lang);
    await send('Page.navigate', { url: `${origin}/index.html?render&lang=${lang}&theme=${theme}&aspect=${aspect}&tagline=${tagline}` });
    for (let i = 0; i < 200 && !(await evaluate('!!window.__promo')); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await evaluate('window.__promo.ready.then(() => true)');
    const duration = await evaluate('window.__promo.duration');
    const frames = Math.round(duration * fps);
    const started = Date.now();
    if (bookends) {
      await renderBookends(lang, duration);
      continue;
    }
    if (stills) {
      // Stills: step every frame up to each wanted second, capture only those.
      const wanted = new Set(stills.map((second) => Math.round(second * fps)));
      const last = Math.max(...wanted);
      for (let frame = 0; frame <= last; frame += 1) {
        await evaluate(`window.__promo.step(${frame / fps})`);
        if (!wanted.has(frame)) continue;
        const file = path.join(out, `still-${lang}-${(frame / fps).toFixed(2)}${aspect === '4:3' ? '-4x3' : ''}${tagline !== 1 ? `-tagline${tagline}` : ''}.png`);
        writeFileSync(file, await capture());
        console.log(file);
      }
      continue;
    }
    const file = path.join(out, `drifting-promo-${lang}.mp4`);
    const sound = await writeSound(lang, duration);
    if (soundOnly) {
      if (!existsSync(file)) throw new Error(`render.mjs: --sound-only needs ${file}; render it first`);
      mux(file, sound, path.join(out, `drifting-promo-${lang}-sound.mp4`));
      continue;
    }
    const encoder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      // The captures are sRGB; the frames carry BT.709 primaries and transfer (ffmpeg 9 tags only what the frames hold).
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-movflags', '+faststart', file],
    { stdio: ['pipe', 'inherit', 'inherit'] });
    const encoded = new Promise((resolve) => encoder.on('close', resolve));
    for (let frame = 0; frame < frames; frame += 1) {
      await evaluate(`window.__promo.step(${frame / fps})`);
      if (!encoder.stdin.write(await capture())) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
      if (frame % (fps * 5) === 0) console.log(`${lang} ${(frame / fps).toFixed(0).padStart(2)}s / ${duration}s`);
    }
    encoder.stdin.end();
    if ((await encoded) !== 0) throw new Error('render.mjs: ffmpeg failed');
    console.log(`${file}  (${frames} frames in ${Math.round((Date.now() - started) / 1000)}s)`);
    mux(file, sound, path.join(out, `drifting-promo-${lang}-sound.mp4`));
  }
} catch (error) {
  console.error(error);
  finish(1);
}
finish(0);
