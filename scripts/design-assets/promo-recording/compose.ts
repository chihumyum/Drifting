#!/usr/bin/env node
/**
 * Turns a recorded take into the finished video (README.md).
 *
 *   pnpm promo:compose --take <name> [--size 1080|1440|2160] [--music <file>] [--no-badge]
 *
 * Plans the frames from out/promo-recording/<take>/timeline.json (plan.ts),
 * renders them from raw.mov with compose.swift, synthesizes the keystrokes
 * and clicks (sound.ts) and encodes everything into <take>/promo.mp4 (H.264
 * with x264, AAC).
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

function parseArguments(args: string[]) {
  const options = { take: '', size: 1080 as keyof typeof SIZES, music: null as string | null, badge: true };
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
    } else if (argument === '--music') options.music = path.resolve(value());
    else if (argument === '--no-badge') options.badge = false;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.take) throw new Error('Usage: pnpm promo:compose --take <name> [--size 1080|1440|2160] [--music <file>] [--no-badge]');
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const directory = path.join(root, 'out', 'promo-recording', options.take);
  const timelinePath = path.join(directory, 'timeline.json');
  if (!existsSync(timelinePath)) throw new Error(`No take ${options.take} (missing ${path.relative(root, timelinePath)})`);
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8')) as Timeline & { theme?: 'light' | 'dark' };
  const [width, height] = SIZES[options.size];
  const plan = planVideo(timeline, { fps: 60, width, height, agentWaitSeconds: 4.5, badgeFrom: options.badge ? 2.5 : Infinity });
  const planPath = path.join(directory, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
  console.log(`[compose] ${plan.frames.length} frames, ${plan.duration.toFixed(1)} s, ${plan.sounds.length} sounds`);

  const binary = buildSwiftTool('compose');
  const silent = path.join(directory, `video-${options.size}.mov`);
  const result = spawnSync(binary, ['--plan', planPath, '--source', path.join(directory, 'raw.mov'), '--out', silent,
    '--theme', timeline.theme ?? 'light'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Rendering failed (exit ${result.status ?? result.signal})`);

  const effects = path.join(directory, 'effects.wav');
  renderSound(plan, effects);
  const final = path.join(directory, options.size === 1080 ? 'promo.mp4' : `promo-${options.size}.mp4`);
  const inputs = ['-i', silent, '-i', effects, ...(options.music ? ['-i', options.music] : [])];
  const fadeOut = Math.max(0, plan.duration - 2.5).toFixed(2);
  const filter = options.music
    ? `[2:a]volume=-14dB,afade=t=out:st=${fadeOut}:d=2.5[m];[1:a][m]amix=inputs=2:duration=first:normalize=0[a]`
    : '[1:a]anull[a]';
  // x264 at a near-lossless quality: the screen's flat paper and still text
  // make the file a seventh of the render's while the text stays crisp.
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
  console.log(`[compose] ${path.relative(root, final)}`);
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
