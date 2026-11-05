#!/usr/bin/env node
/**
 * Records the real app writing a story (README.md).
 *
 *   pnpm promo:record --story <file.md> [--take <name>] [--theme light|dark]
 *                     [--model deepseek-v4-pro] [--no-agent] [--keep-open]
 *
 * Seeds the isolated `promo-recording` profile with the screenshot shelf and
 * a new book holding one empty chapter, launches its Debug build with the
 * frontend debug bridge, and records its window with the rig (rig.swift)
 * while the rig types the story with real keystrokes and then works the
 * Agent with the real pointer: asks it to organize the chapter into
 * elements, points at a name it linked, opens the element overview, and
 * starts the chapter-end review. The Agent is the real model, keyed from
 * the checkout's .env.local like every development profile.
 *
 * Writes out/promo-recording/<take>/: raw.mov (the window, Retina pixels, no
 * pointer), events.jsonl (every input the rig posted) and timeline.json
 * (what compose.ts needs). Takes the screen while it runs.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bringToFront, frontmostPid, mainWindow, openDesktopApp, placeWindow, sceneRunner, sleep, type WindowInfo,
} from '../../desktop-app-session';
import { buildSwiftTool, Rig } from './rig-client';
import { parseStory, type Pace, type Story } from './story';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const INSTANCE = 'promo-recording';
const LIBRARY = 'drifting-library.db';
const WINDOW = { width: 1600, height: 1000 };
const LOCALE = 'zh-CN';
/** Keystrokes a second while recording; compose.ts speeds the faster paces up further. */
const TYPING_CPS: Record<Pace, number> = { slow: 4.5, normal: 9, fast: 16 };
const AGENT_START_TIMEOUT = 20_000;
const AGENT_TIMEOUT = 10 * 60_000;

interface Options {
  story: string; take: string; theme: 'light' | 'dark'; model: string; agent: boolean; keepOpen: boolean;
  position: [number, number] | null;
}

function parseArguments(args: string[]): Options {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const options: Options = {
    story: path.join(here, 'sample-story.zh-CN.md'), take: stamp, theme: 'light', model: 'deepseek-v4-pro',
    agent: true, keepOpen: false, position: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === '--') continue;
    else if (argument === '--story') options.story = path.resolve(value());
    else if (argument === '--take') options.take = value();
    else if (argument === '--theme') {
      const theme = value();
      if (theme !== 'light' && theme !== 'dark') throw new Error('--theme is light or dark');
      options.theme = theme;
    } else if (argument === '--model') options.model = value();
    else if (argument === '--no-agent') options.agent = false;
    else if (argument === '--keep-open') options.keepOpen = true;
    else if (argument === '--position') {
      const [x, y] = value().split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('--position is <x>,<y> in screen points');
      options.position = [x, y];
    } else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

// ---------------------------------------------------------------- the library

interface SeededLibrary { main: { projectId: string; name: string; chapters: { id: string; title: string }[] } }

function resetProfile(databaseDirectory: string, appLocalDataDirectory: string) {
  if (!path.basename(appLocalDataDirectory).startsWith('cc.drifting.wt.')) {
    throw new Error(`Not an isolated profile's data directory: ${appLocalDataDirectory}`);
  }
  for (const file of [LIBRARY, `${LIBRARY}-wal`, `${LIBRARY}-shm`]) rmSync(path.join(databaseDirectory, file), { force: true });
  for (const entry of ['assets', 'sync-objects', 'markdown-projections', 'markdown-mirror-instance']) {
    rmSync(path.join(appLocalDataDirectory, entry), { recursive: true, force: true });
  }
}

function seedLibrary(databasePath: string, appLocalDataDirectory: string, story: Story): SeededLibrary {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--conditions=import', 'src/dev-cli/showcase-seed-main.ts',
    '--db', databasePath, '--app-local-data', appLocalDataDirectory, '--locale', LOCALE,
    '--open-book', story.book, '--open-chapter', story.chapter, ...(story.memory ? ['--open-memory', story.memory] : [])], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ') },
  });
  if (result.status !== 0) throw new Error(`Seeding the promo library failed (exit ${result.status ?? result.signal})`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as SeededLibrary;
}

// ---------------------------------------------------------------- recording

interface Rect { x: number; y: number; width: number; height: number }

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('The promo recording drives the macOS desktop app');
  const story = parseStory(readFileSync(options.story, 'utf8'));
  const output = path.join(root, 'out', 'promo-recording', options.take);
  if (existsSync(path.join(output, 'timeline.json'))) throw new Error(`Take ${options.take} already exists in ${path.relative(root, output)}`);
  mkdirSync(output, { recursive: true });
  const marksPath = path.join(output, 'marks.jsonl');
  writeFileSync(marksPath, '');
  const rigBinary = buildSwiftTool('rig');

  let library: SeededLibrary | null = null;
  const session = await openDesktopApp({
    instance: INSTANCE, tag: 'promo', logName: `promo-${options.take}.log`,
    prepare({ databaseDirectory, appLocalDataDirectory }) {
      resetProfile(databaseDirectory, appLocalDataDirectory);
      console.log(`[promo] seeding 《${story.book}》`);
      library = seedLibrary(path.join(databaseDirectory, LIBRARY), appLocalDataDirectory, story);
    },
  });
  const seeded = library as SeededLibrary | null;
  if (!seeded) throw new Error('The library was not seeded');
  const { pid } = session;
  const scenes = sceneRunner(session, path.join(here, 'scenes.js'), '__driftingPromo', (file) => readFileSync(file, 'utf8'));
  const rig = new Rig(rigBinary, path.join(output, 'events.jsonl'));
  const previousFront = frontmostPid();
  let recording = false;
  try {
    placeWindow(pid, WINDOW, options.position);
    await scenes.install();
    await scenes.runReloading('prepare', { locale: LOCALE, theme: options.theme, provider: 'deepseek', model: options.model });
    const openBook = () => scenes.run<{ viewport: { width: number; height: number; dpr: number } }>('open', {
      projectId: seeded.main.projectId, name: seeded.main.name, chapterId: seeded.main.chapters[0].id,
    });
    let opened = await openBook();
    // A first use of a feature can make the development server reload the
    // page; warm everything up until a pass leaves the page alone.
    for (let attempt = 1; ; attempt += 1) {
      let reloaded = false;
      try {
        await scenes.run('warmup');
        await sleep(3000);
        reloaded = await session.evaluate<string>('typeof window.__driftingPromo') !== 'object';
      } catch {
        reloaded = true;
      }
      if (!reloaded) break;
      if (attempt === 4) throw new Error('The page kept reloading while warming up');
      console.log('[promo] the development server reloaded the page; warming up again');
      for (const deadline = Date.now() + 60_000; ;) {
        try {
          if (await session.evaluate<string>('document.readyState') === 'complete' && await scenes.install()) break;
        } catch { /* still reloading */ }
        if (Date.now() > deadline) throw new Error('The renderer did not come back after its reload');
        await sleep(500);
      }
      opened = await openBook();
    }
    bringToFront(pid);
    await sleep(800);
    const window = mainWindow(pid);
    if (!window) throw new Error('The app has no window');
    const offset = { x: (window.width - opened.viewport.width) / 2, y: window.height - opened.viewport.height };

    const clock = await rig.syncClock();
    console.log(`[promo] rig clock synced (round trip ${(clock.roundTrip * 1000).toFixed(1)} ms)`);
    await rig.send('target', { pid });
    await rig.send('seed', { seed: 20_261_105 });
    const source = await rig.send('input.keyboard');
    console.log(`[promo] keyboard layout ${source.source}`);

    const mark = (name: string, data: Record<string, unknown> = {}) =>
      appendFileSync(marksPath, `${JSON.stringify({ ...data, t: rig.now(), type: 'mark', name })}\n`);
    const toWindow = (point: { x: number; y: number }) => ({ x: point.x + offset.x, y: point.y + offset.y });
    const rectToWindow = (rect: Rect) => ({ ...rect, ...toWindow(rect) });
    const centre = (rect: Rect) => toWindow({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const rectOf = async (selector: string, text?: string, timeout = 15_000): Promise<Rect> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const rect = await scenes.run<Rect | null>('rect', { selector, text });
        if (rect) return rect;
        if (Date.now() > deadline) throw new Error(`No ${selector}${text ? ` (${text})` : ''} on screen`);
        await sleep(250);
      }
    };
    const moveTo = async (point: { x: number; y: number }, duration?: number) =>
      rig.send('pointer.move', { ...point, ...(duration ? { duration } : {}) });
    /** Points at a control, lets the hand settle, clicks it. */
    const clickOn = async (rect: Rect, name: string, zoom?: number) => {
      mark('target', { target: name, rect: rectToWindow(rect), ...(zoom ? { zoom } : {}) });
      await moveTo(centre(rect));
      await sleep(180);
      await rig.send('pointer.click');
    };

    // While the rig types, sample where the caret is, for the camera.
    let sampling = false;
    const sampleCaret = async () => {
      while (sampling) {
        const t = rig.now();
        try {
          const caret = await scenes.run<Rect | null>('caret');
          if (caret) appendFileSync(marksPath, `${JSON.stringify({ t, type: 'caret', rect: rectToWindow(caret) })}\n`);
        } catch { /* a sample may miss */ }
        await sleep(90);
      }
    };
    const typeText = async (text: string, pace: Pace, kind: string, typo: { intended: string; typed: string } | null = null, zoom?: number) => {
      const column = await scenes.run<{ text: Rect; paper: Rect } | null>('column');
      mark('type.start', { pace, kind, text, ...(zoom ? { zoom } : {}),
        column: column ? { text: rectToWindow(column.text), paper: rectToWindow(column.paper) } : null });
      sampling = true;
      const sampler = sampleCaret();
      const cps = TYPING_CPS[pace];
      if (typo) {
        const at = text.indexOf(typo.intended);
        await rig.send('key.type', { text: text.slice(0, at), cps });
        await rig.send('key.type', { text: typo.typed, cps, pauses: false });
        await sleep(450);
        for (let index = 0; index < [...typo.typed].length; index += 1) {
          await rig.send('key.press', { key: 'backspace' });
          await sleep(120);
        }
        await sleep(200);
        await rig.send('key.type', { text: text.slice(at), cps });
      } else {
        await rig.send('key.type', { text, cps });
      }
      sampling = false;
      await sampler;
      mark('type.end', { kind });
    };
    /** What the camera should look at from now on: a window rectangle (viewport pixels), or the whole canvas. */
    const shot = (rect: Rect | null, zoom?: number) => mark('shot', { rect: rect ? rectToWindow(rect) : null, ...(zoom ? { zoom } : {}) });
    /** The Agent's transcript in the right sidebar, above its composer. */
    const agentPanel = async (): Promise<Rect> => {
      const composer = await rectOf('.agt-composer');
      const top = opened.viewport.height * 0.3;
      return { x: composer.x - 12, y: top, width: composer.width + 24, height: composer.y + composer.height - top };
    };
    const waitForAgent = async (what: string) => {
      const startDeadline = Date.now() + AGENT_START_TIMEOUT;
      while (!(await scenes.run<{ running: boolean }>('agent')).running) {
        if (Date.now() > startDeadline) throw new Error(`The Agent did not start ${what}`);
        await sleep(300);
      }
      shot(await agentPanel(), 1.55);
      mark('agent.start', { what });
      console.log(`[promo] the Agent is ${what}…`);
      const deadline = Date.now() + AGENT_TIMEOUT;
      while ((await scenes.run<{ running: boolean }>('agent')).running) {
        if (Date.now() > deadline) throw new Error(`The Agent took more than ${AGENT_TIMEOUT / 60_000} minutes ${what}`);
        await sleep(700);
      }
      mark('agent.end', { what });
    };

    // Off camera: the caret into the empty chapter, the pointer to rest on the paper's margin.
    const end = await scenes.run<{ x: number; y: number }>('end');
    await moveTo(toWindow(end), 0.2);
    await rig.send('pointer.click');
    const column = await scenes.run<{ text: Rect; paper: Rect }>('column');
    await moveTo(toWindow({ x: column.paper.x + column.paper.width - 30, y: column.paper.y + 240 }), 0.2);
    await sleep(600);

    await rig.send('record.start', { out: path.join(output, 'raw.mov'), fps: 60 });
    recording = true;
    console.log('[promo] recording');
    await sleep(1500);

    mark('phase', { phase: 'write' });
    for (const [index, paragraph] of story.paragraphs.entries()) {
      const last = index === story.paragraphs.length - 1;
      // The opening line close up; then the whole app, while the writer takes a breath.
      await typeText(last ? paragraph.text : `${paragraph.text}\n`, paragraph.pace, 'prose', paragraph.typo, index === 0 ? 2.6 : undefined);
      if (index === 0) {
        await sleep(1300);
        shot(null);
        await sleep(2400);
      }
    }
    await sleep(1000);

    if (options.agent) {
      mark('phase', { phase: 'organize' });
      await clickOn(await rectOf('.rightbar-tab-tray button', '帮手'), 'agent-tab');
      await sleep(900);
      await clickOn(await rectOf('.agt-composer__text'), 'composer');
      await sleep(300);
      await typeText(story.organize, 'normal', 'prompt');
      await sleep(500);
      await rig.send('key.press', { key: 'return' });
      // A hand leaves the composer once the prompt is sent.
      await sleep(400);
      await moveTo(toWindow({ x: column.paper.x + column.paper.width - 40, y: column.paper.y + 420 }));
      await waitForAgent('organizing');
      // What it changed, listed under its answer.
      const composer = await rectOf('.agt-composer');
      shot({ x: composer.x - 12, y: composer.y - 330, width: composer.width + 24, height: 330 + composer.height }, 1.9);
      await sleep(2200);

      mark('phase', { phase: 'links' });
      const links = await scenes.run<{ text: string; rect: Rect }[]>('links', { names: story.links.length ? story.links : null });
      mark('links', { links: links.map((link) => ({ text: link.text, rect: rectToWindow(link.rect) })) });
      const hovered = links.find((link) => link.text.includes(story.links[0] ?? '')) ?? links[0];
      if (hovered) {
        shot({ x: column.text.x - 40, y: hovered.rect.y - 220, width: column.text.width + 80, height: 520 }, 1.6);
        await sleep(1000);
        mark('target', { target: 'link', rect: rectToWindow(hovered.rect) });
        await moveTo(centre(hovered.rect));
        shot({ x: hovered.rect.x - 160, y: hovered.rect.y - 40, width: 560, height: 360 }, 2.0);
        await sleep(2700);
      } else console.warn('[promo] no linked names in view to point at');

      mark('phase', { phase: 'elements' });
      await clickOn(await rectOf('.workspace-panel-tab-row button', '要素'), 'elements-tab');
      await sleep(900);
      await clickOn(await rectOf('.workspace-super-view-entry'), 'element-overview');
      shot(null);
      await sleep(2600);
      // Closer on the elements and the lines between them, once they settle.
      const cards = await scenes.run<Rect | null>('cards');
      if (cards) shot({ x: cards.x - 90, y: cards.y - 70, width: cards.width + 180, height: cards.height + 140 });
      await sleep(3600);
      await rig.send('key.press', { key: 'escape' });
      await sleep(1200);
      await clickOn(await rectOf('.workspace-panel-tab-row button', '章节'), 'chapters-tab');
      await sleep(800);

      mark('phase', { phase: 'review' });
      let ornament = await rectOf('.page__ornament-trigger');
      const viewportHeight = opened.viewport.height;
      if (ornament.y + ornament.height > viewportHeight - 80 || ornament.y < 80) {
        // Bring the chapter's end into view the way a hand would.
        await moveTo(centre({ ...column.text, height: 1, y: Math.min(viewportHeight - 200, column.text.y + 300) }));
        await rig.send('pointer.scroll', { dy: ornament.y - viewportHeight * 0.55, duration: 0.9 });
        await sleep(700);
        ornament = await rectOf('.page__ornament-trigger');
      }
      mark('target', { target: 'chapter-end', rect: rectToWindow(ornament), zoom: 2.2 });
      await moveTo(centre(ornament));
      await sleep(700);
      await clickOn(await rectOf('.chapter-end-menu__item[data-action="review"]'), 'review');
      await waitForAgent('reviewing');
      await sleep(1200);
      await clickOn(await rectOf('.rightbar-tab-tray button', '审阅'), 'review-tab');
      await sleep(600);
      // Close enough to read the first comment, then the comments anchored in
      // the prose and listed beside it.
      const panel = await agentPanel();
      shot({ x: panel.x, y: 70, width: panel.width, height: 300 }, 2.2);
      await sleep(3400);
      shot({ x: column.paper.x, y: 50, width: opened.viewport.width - column.paper.x - 10, height: opened.viewport.height - 100 });
      await sleep(4200);
    }

    mark('phase', { phase: 'outro' });
    shot(null);
    await sleep(2600);
    const stopped = await rig.send('record.stop');
    recording = false;
    console.log(`[promo] recorded ${stopped.frames} frames (${stopped.dropped} dropped)`);

    writeTimeline(output, {
      story: { file: options.story, book: story.book, chapter: story.chapter },
      theme: options.theme, model: options.model, window, viewport: opened.viewport, offset,
      recording: stopped,
    });
    console.log(`[promo] take ${options.take} in ${path.relative(root, output)}; next: pnpm promo:compose --take ${options.take}`);
  } finally {
    if (recording) await rig.send('record.stop').catch(() => undefined);
    await rig.send('input.restore').catch(() => undefined);
    await rig.quit();
    if (previousFront && previousFront !== pid) {
      try { bringToFront(previousFront); } catch { /* it quit meanwhile */ }
    }
    if (!options.keepOpen) await session.close();
    else console.log(`[promo] left running (instance "${INSTANCE}")`);
  }
}

/** The take's events, the rig's and this script's, on one clock, with what compose.ts needs to know. */
function writeTimeline(output: string, meta: Record<string, unknown> & { window: WindowInfo }) {
  const read = (file: string) => readFileSync(path.join(output, file), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { t: number; type: string });
  const events = [...read('events.jsonl'), ...read('marks.jsonl')].sort((a, b) => a.t - b.t);
  const start = events.find((event) => event.type === 'frames.start');
  if (!start) throw new Error('The recording has no frames');
  const timeline = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ...meta,
    /** Seconds on the host clock of the video's time zero. */
    origin: start.t,
    events: events.map((event) => ({ ...event, t: Math.round((event.t - start.t) * 1e4) / 1e4 })),
  };
  writeFileSync(path.join(output, 'timeline.json'), `${JSON.stringify(timeline, null, 1)}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
