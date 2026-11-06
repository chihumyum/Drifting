#!/usr/bin/env node
/**
 * Turns a recorded take into the finished video (README.md).
 *
 *   pnpm promo:compose --take <name> [--size 1080|1440|2160] [--pace <x>] [--typing-pace <x>]
 *                      [--bookends] [--music <file>] [--no-badge] [--no-end-card]
 *
 * Plans the frames from out/promo-recording/<take>/timeline.json (plan.ts),
 * renders them from raw.mov with compose.swift, synthesizes the keystrokes
 * and clicks (sound.ts) and encodes everything into <take>/promo.mp4 (H.264
 * with x264, AAC); with --pace other than 1, into promo[-<size>]-<x>x.mp4.
 * --bookends opens on the character sea raising DRIFTING and closes on it
 * again (the promo video's opening and closing, rendered for the take's theme
 * by `promo-video/render.mjs --bookends`), cross-faded, instead of the card.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planVideo, type Timeline } from './plan';
import { buildSwiftTool } from './rig-client';
import { renderSound } from './sound';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const SIZES = { 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] } as const;
/** The closing card, in the language of the recorded interface (README.zh-CN.md's line). */
const CARD = {
  title: 'Drifting',
  line: 'Markdown 的轻快，传统写作软件的脚手架，再加一个照看整本书的 Agent。',
  url: 'drifting.cc',
};

/** Seconds the sea cross-fades into the recording, and the recording into the sea. */
const BOOKEND_IN = 0.7;
const BOOKEND_OUT = 1.0;

function parseArguments(args: string[]) {
  const options = {
    take: '', size: 1080 as keyof typeof SIZES, pace: 1, typingPace: null as number | null, bookends: false,
    music: null as string | null, badge: true, endCard: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === '--') continue;
    else if (argument === '--take') options.take = value();
    else if (argument === '--size') {
      const size = Number(value());
      if (!(size in SIZES)) throw new Error('--size is 1080, 1440 or 2160');
      options.size = size as keyof typeof SIZES;
    } else if (argument === '--pace') {
      const pace = Number(value());
      if (!(pace >= 0.5 && pace <= 4)) throw new Error('--pace is between 0.5 and 4');
      options.pace = pace;
    } else if (argument === '--typing-pace') {
      const pace = Number(value());
      if (!(pace >= 0.5 && pace <= 6)) throw new Error('--typing-pace is between 0.5 and 6');
      options.typingPace = pace;
    } else if (argument === '--bookends') options.bookends = true;
    else if (argument === '--music') options.music = path.resolve(value());
    else if (argument === '--no-badge') options.badge = false;
    else if (argument === '--no-end-card') options.endCard = false;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.take) {
    throw new Error('Usage: pnpm promo:compose --take <name> [--size 1080|1440|2160] [--pace <x>] [--typing-pace <x>] [--bookends] [--music <file>] [--no-badge] [--no-end-card]');
  }
  // The sea closes the video; the card would come before it.
  if (options.bookends) options.endCard = false;
  return options;
}

const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

/** The rendered opening and closing for this size and theme, or how to render them. */
function bookendClips(size: keyof typeof SIZES, theme: string) {
  if (size === 1440) throw new Error('--bookends is rendered at 1080 or 2160');
  const name = (end: string) => path.join(root, 'out', 'promo-video', `drifting-bookend-${end}-zh-${theme}${size === 2160 ? '-2160' : ''}.mp4`);
  const clips = { open: name('open'), close: name('close') };
  if (!existsSync(clips.open) || !existsSync(clips.close)) {
    throw new Error(`No bookends for ${size} ${theme}: node scripts/design-assets/promo-video/render.mjs --bookends --lang zh --theme ${theme} --size ${size}`);
  }
  return clips;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const directory = path.join(root, 'out', 'promo-recording', options.take);
  const timelinePath = path.join(directory, 'timeline.json');
  if (!existsSync(timelinePath)) throw new Error(`No take ${options.take} (missing ${path.relative(root, timelinePath)})`);
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8')) as Timeline & { theme?: 'light' | 'dark' };
  const [width, height] = SIZES[options.size];
  const bookends = options.bookends ? bookendClips(options.size, timeline.theme ?? 'light') : null;
  const plan = planVideo(timeline, {
    fps: 60, width, height, agentWaitSeconds: 4.5, badgeFrom: options.badge ? 2.5 : Infinity, endCard: options.endCard ? 3.4 : 0,
    pace: options.pace, typingPace: options.typingPace ?? options.pace,
  });
  const planPath = path.join(directory, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ ...plan, ...(options.endCard ? { card: CARD } : {}) }));
  console.log(`[compose] ${plan.frames.length} frames, ${plan.duration.toFixed(1)} s, ${plan.sounds.length} sounds`);

  const binary = buildSwiftTool('compose');
  const silent = path.join(directory, `video-${options.size}.mov`);
  const result = spawnSync(binary, ['--plan', planPath, '--source', path.join(directory, 'raw.mov'), '--out', silent,
    '--theme', timeline.theme ?? 'light', '--icon', path.join(root, 'src', 'assets', 'icon.png')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Rendering failed (exit ${result.status ?? result.signal})`);

  const effects = path.join(directory, 'effects.wav');
  renderSound(plan, effects);
  const final = path.join(directory, `${options.size === 1080 ? 'promo' : `promo-${options.size}`}${options.pace === 1 ? '' : `-${options.pace}x`}.mp4`);
  const inputs = ['-i', silent, '-i', effects, ...(options.music ? ['-i', options.music] : [])];
  const fadeOut = Math.max(0, plan.duration - 2.5).toFixed(2);
  let filter = options.music
    ? `[2:a]volume=-14dB,afade=t=out:st=${fadeOut}:d=2.5[m];[1:a][m]amix=inputs=2:duration=first:normalize=0[a]`
    : '[1:a]anull[a]';
  let mapVideo = '0:v';
  let mapAudio = '[a]';
  if (bookends) {
    // The sea, the recording and the sea again, each cross-faded into the next, picture and sound.
    const first = inputs.length / 2;
    inputs.push('-i', bookends.open, '-i', bookends.close);
    const opening = duration(bookends.open);
    const same = `fps=60,format=yuv420p,setsar=1,scale=${width}:${height},settb=AVTB`;
    filter += `;[0:v]${same}[demo];[${first}:v]${same}[open];[${first + 1}:v]${same}[close]`
      + `;[open][demo]xfade=transition=fade:duration=${BOOKEND_IN}:offset=${(opening - BOOKEND_IN).toFixed(3)}[into]`
      + `;[into][close]xfade=transition=fade:duration=${BOOKEND_OUT}:offset=${(opening - BOOKEND_IN + plan.duration - BOOKEND_OUT).toFixed(3)}[v]`
      + `;[a]aresample=48000[demoSound];[${first}:a]aresample=48000[openSound];[${first + 1}:a]aresample=48000[closeSound]`
      + `;[openSound][demoSound]acrossfade=d=${BOOKEND_IN}[intoSound];[intoSound][closeSound]acrossfade=d=${BOOKEND_OUT}[sound]`;
    mapVideo = '[v]';
    mapAudio = '[sound]';
  }
  // x264 at a near-lossless quality: the screen's flat paper and still text
  // make the file a seventh of the render's while the text stays crisp.
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', mapVideo, '-map', mapAudio,
    // 4K takes a long time at `slow`; `medium` costs it little at CRF 18.
    '-c:v', 'libx264', '-preset', options.size === 2160 ? 'medium' : 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
  console.log(`[compose] ${path.relative(root, final)}`);
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
