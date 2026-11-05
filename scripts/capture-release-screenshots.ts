#!/usr/bin/env node
/**
 * Release screenshots of the macOS desktop app (docs/release-screenshots.md).
 *
 *   pnpm release:screenshots [--readme] [--locale en|zh-CN] [--theme light|dark] [--background]
 *                            [--position <x>,<y>] [--output <dir>] [--keep-open]
 *
 * For each interface language: reseeds the isolated `release-screenshots`
 * profile with the synthetic screenshot library (src/dev-cli/seeds/showcase),
 * launches its Debug build with the frontend debug bridge, drives
 * scripts/release-screenshots-scenes.js (the shelf, the workspace on one
 * chapter, the element overview in 关系) and captures the real window pixels
 * of each scene in each theme with `screencapture -l`. Writes the PNGs and a
 * manifest under out/screenshots/<version>/.
 *
 * WebKit renders nothing in a window other windows cover, so the window is
 * brought to the front for each capture (traffic lights lit, as an author sees
 * them) and the app that was in front is given its place back at the end.
 * --background leaves focus alone: the window must then stay visible where it
 * is (or at --position), and its traffic lights are grey. --keep-open leaves
 * the last language's app running for a look around.
 *
 * --readme captures the light scenes only and also writes them, 2000 pixels
 * wide as WebP, with their manifest: English to docs/screenshots/, which
 * README.md shows, and Chinese to docs/screenshots/zh-CN/, which
 * README.zh-CN.md shows. With --locale it retakes that language's set only.
 * They are retaken only when the author asks (docs/releasing.md).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bringToFront, frontmostPid, mainWindow, movePointerOff, openDesktopApp, placeWindow, sceneRunner, sleep,
} from './desktop-app-session';

const root = fileURLToPath(new URL('..', import.meta.url));
const INSTANCE = 'release-screenshots';
const LIBRARY = 'drifting-library.db';
/** Wide enough for the English element overview's header in one line. */
const WINDOW = { width: 1600, height: 1000 };
const LOCALES = ['en', 'zh-CN'] as const;
const THEMES = ['light', 'dark'] as const;
type Locale = (typeof LOCALES)[number];
type Theme = (typeof THEMES)[number];
/**
 * The READMEs' screenshots: committed, so small (WebP) and no wider than a
 * Retina README needs. Each README shows its own language's set
 * (scripts/check-release.mjs checks both).
 */
const README_DIRECTORIES: Record<Locale, string> = { en: 'docs/screenshots', 'zh-CN': 'docs/screenshots/zh-CN' };
const README_WIDTH = 2000;
const README_SCENES = ['shelf', 'workspace', 'elements'] as const;

/** The chapter each workspace shot opens, and the chapters open beside it as tabs (1-based). */
const WORKSPACE: Record<Locale, { chapter: number; tabs: number[] }> = {
  en: { chapter: 1, tabs: [2, 3, 18] },
  'zh-CN': { chapter: 1, tabs: [2, 3, 5] },
};

interface Options {
  locales: Locale[]; themes: Theme[]; background: boolean; position: [number, number] | null;
  output: string; keepOpen: boolean; readme: boolean;
}

function parseArguments(args: string[]): Options {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const options: Options = {
    locales: [...LOCALES], themes: [...THEMES], background: false, position: null,
    output: path.join(root, 'out', 'screenshots', version), keepOpen: false, readme: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === '--') continue;
    else if (argument === '--background') options.background = true;
    else if (argument === '--keep-open') options.keepOpen = true;
    else if (argument === '--readme') options.readme = true;
    else if (argument === '--output') options.output = path.resolve(value());
    else if (argument === '--locale') {
      const locale = value();
      if (!LOCALES.includes(locale as Locale)) throw new Error(`--locale is one of ${LOCALES.join(', ')}`);
      options.locales = [locale as Locale];
    } else if (argument === '--theme') {
      const theme = value();
      if (!THEMES.includes(theme as Theme)) throw new Error(`--theme is one of ${THEMES.join(', ')}`);
      options.themes = [theme as Theme];
    } else if (argument === '--position') {
      const [x, y] = value().split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('--position is <x>,<y> in screen points');
      options.position = [x, y];
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.readme) options.themes = ['light'];
  return options;
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ---------------------------------------------------------------- the library

interface SeededLibrary {
  main: { projectId: string; name: string; chapters: { id: string; title: string }[]; elements: number };
  projects: { projectId: string; name: string }[];
  writingDays: number;
}

/** This profile's own library and app data, removed so the seed starts from nothing. */
function resetProfile(databaseDirectory: string, appLocalDataDirectory: string) {
  if (!path.basename(appLocalDataDirectory).startsWith('cc.drifting.wt.')) {
    throw new Error(`Not an isolated profile's data directory: ${appLocalDataDirectory}`);
  }
  for (const file of [LIBRARY, `${LIBRARY}-wal`, `${LIBRARY}-shm`]) rmSync(path.join(databaseDirectory, file), { force: true });
  for (const entry of ['assets', 'sync-objects', 'markdown-projections', 'markdown-mirror-instance']) {
    rmSync(path.join(appLocalDataDirectory, entry), { recursive: true, force: true });
  }
}

function seedLibrary(databasePath: string, appLocalDataDirectory: string, locale: Locale): SeededLibrary {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--conditions=import', 'src/dev-cli/showcase-seed-main.ts',
    '--db', databasePath, '--app-local-data', appLocalDataDirectory, '--locale', locale], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ') },
  });
  if (result.status !== 0) throw new Error(`Seeding the ${locale} screenshot library failed (exit ${result.status ?? result.signal})`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as SeededLibrary;
}

// ---------------------------------------------------------------- one language

interface Shot { file: string; locale: Locale; theme: Theme; scene: string; width: number; height: number; sha256: string }

async function captureLocale(locale: Locale, options: Options, shots: Shot[], keepOpen: boolean) {
  let library: SeededLibrary | null = null;
  const session = await openDesktopApp({
    instance: INSTANCE, tag: 'screenshots', logName: `release-screenshots-${locale}.log`,
    prepare({ databaseDirectory, appLocalDataDirectory }) {
      resetProfile(databaseDirectory, appLocalDataDirectory);
      console.log(`[screenshots] ${locale}: seeding the library`);
      library = seedLibrary(path.join(databaseDirectory, LIBRARY), appLocalDataDirectory, locale);
    },
  });
  const { pid } = session;
  const scenes = sceneRunner(session, path.join(root, 'scripts/release-screenshots-scenes.js'), '__driftingShots',
    (file) => readFileSync(file, 'utf8'));
  const scene = scenes.run;

  const previousFront = frontmostPid();
  try {
    placeWindow(pid, WINDOW, options.position);

    // Language, the first theme and the guides, then a reload to start clean.
    // Not a polled job: the reload it schedules would take the job table with it.
    await scenes.install();
    await scenes.runReloading('prepare', { locale, theme: options.themes[0] });

    mkdirSync(options.output, { recursive: true });
    const capture = async (name: string, theme: Theme) => {
      if (!options.background) {
        bringToFront(pid);
        await sleep(700);
      }
      const window = mainWindow(pid);
      if (!window) throw new Error('The app has no window to capture');
      if (!options.background) movePointerOff(window);
      await sleep(300);
      const file = path.join(options.output, `${locale}-${theme}-${name}.png`);
      execFileSync('screencapture', ['-x', '-o', `-l${window.id}`, file]);
      if (!existsSync(file) || statSync(file).size === 0) throw new Error(`screencapture wrote nothing for ${name}`);
      const size = pngSize(file);
      shots.push({ file: path.basename(file), locale, theme, scene: name, ...size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
      console.log(`[screenshots] ${path.relative(root, file)} ${size.width}×${size.height}`);
    };
    const inEachTheme = async (name: string) => {
      for (const [index, theme] of options.themes.entries()) {
        if (index > 0) await scene('theme', { mode: theme });
        await capture(name, theme);
      }
      if (options.themes.length > 1) await scene('theme', { mode: options.themes[0] });
    };

    const seeded = library as SeededLibrary | null;
    if (!seeded) throw new Error('The library was not seeded');
    const chapters = seeded.main.chapters;
    const { chapter, tabs } = WORKSPACE[locale];
    await scene('shelf', { books: seeded.projects.length });
    await inEachTheme('shelf');
    await scene('workspace', {
      projectId: seeded.main.projectId, name: seeded.main.name,
      chapterId: chapters[chapter - 1].id, tabs: tabs.map((number) => chapters[number - 1].id),
    });
    await inEachTheme('workspace');
    await scene('elements', { count: seeded.main.elements });
    await inEachTheme('elements');
  } finally {
    if (!options.background && previousFront && previousFront !== pid) {
      try { bringToFront(previousFront); } catch { /* it quit meanwhile */ }
    }
    if (!keepOpen) await session.close();
    else console.log(`[screenshots] ${locale}: left running (instance "${INSTANCE}")`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('Release screenshots capture the macOS desktop app');
  const shots: Shot[] = [];
  const started = Date.now();
  for (const [index, locale] of options.locales.entries()) {
    await captureLocale(locale, options, shots, options.keepOpen && index === options.locales.length - 1);
  }
  const manifest = {
    schemaVersion: 1,
    version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    recordedAt: new Date().toISOString(),
    source: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    },
    build: 'debug (Rust debug, Vite development renderer)',
    window: { ...WINDOW, focused: !options.background },
    seconds: Math.round((Date.now() - started) / 1000),
    shots,
  };
  writeFileSync(path.join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[screenshots] ${shots.length} screenshots in ${path.relative(root, options.output)} (${manifest.seconds} s)`);
  if (options.readme) {
    for (const locale of options.locales) writeReadmeScreenshots(options.output, locale, manifest);
  }
}

/** One language's light scenes, resized and encoded as WebP for its README, with their manifest. */
function writeReadmeScreenshots(output: string, locale: Locale, manifest: { version: string; recordedAt: string; source: unknown; window: unknown }) {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('The README screenshots are WebP: install cwebp (brew install webp) and run again');
  }
  const directory = path.join(root, README_DIRECTORIES[locale]);
  mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), 'drifting-readme-shots-'));
  const files = [];
  try {
    for (const scene of README_SCENES) {
      const resized = path.join(scratch, `${scene}.png`);
      execFileSync('sips', ['--resampleWidth', String(README_WIDTH), path.join(output, `${locale}-light-${scene}.png`), '--out', resized], { stdio: 'ignore' });
      const file = path.join(directory, `${scene}.webp`);
      execFileSync('cwebp', ['-quiet', '-q', '90', '-metadata', 'none', resized, '-o', file]);
      const bytes = readFileSync(file);
      files.push({ file: `${scene}.webp`, scene, ...pngSize(resized), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const readme = {
    schemaVersion: 1, version: manifest.version, recordedAt: manifest.recordedAt, source: manifest.source,
    window: manifest.window, locale, theme: 'light', files,
  };
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(readme, null, 2)}\n`);
  console.log(`[screenshots] README screenshots (${locale}) for ${manifest.version} in ${README_DIRECTORIES[locale]}: ${files.map((entry) => `${entry.file} ${Math.round(entry.bytes / 1024)} KB`).join(', ')}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
