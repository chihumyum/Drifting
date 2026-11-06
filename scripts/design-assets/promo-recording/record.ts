#!/usr/bin/env node
/**
 * Records the real app writing a story (README.md).
 *
 *   pnpm promo:record --story <file.md> [--take <name>] [--theme light|dark]
 *                     [--provider openai] [--model gpt-5.6-sol] [--no-agent] [--keep-open]
 *                     [--tempo 1.5] [--typing-tempo 4]
 *
 * Seeds the isolated `promo-recording` profile with the screenshot shelf,
 * launches its Debug build with the frontend debug bridge, and records its
 * window with the rig (rig.swift) while the rig, with the real pointer and
 * keyboard, creates the story's book from the shelf, its chapter from
 * Project Home, and writes it in immersive writing — asking the Agent
 * mid-chapter to look up a reference on the web — then asks the Agent to
 * organize the chapter into elements, points at a name it linked, opens the
 * element overview and starts the chapter-end review. A story marked
 * `existing: true` writes on in a book already on the shelf (the 阿Q正传
 * sample): it opens the book on the chapter, shows the timeline once written
 * and the material notes before the review. The Agent is the real
 * model, keyed from the checkout's .env.local like every development profile.
 * The take is acted at the pace the video plays it (`--tempo`, `--typing-tempo`),
 * so the app's own animations keep their speed: only the Agent's waits are
 * squeezed afterwards.
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
import { dockSpot } from './plan';
import { buildSwiftTool, Rig } from './rig-client';
import { parseStory, type Pace } from './story';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const INSTANCE = 'promo-recording';
const LIBRARY = 'drifting-library.db';
const WINDOW = { width: 1600, height: 1000 };
const LOCALE = 'zh-CN';
/**
 * Keystrokes a second at the reference pace: a writer who knows what comes
 * next, not a stenographer. A take types `typingTempo` times faster (4 by
 * default), as the video plays it.
 */
const TYPING_CPS: Record<Pace, number> = { slow: 3.4, normal: 5.6, fast: 8.2 };
/** Paragraphs marked quick are typed at a steady 8 a second (times the typing tempo), without resting at punctuation. */
const QUICK_CPS = 8;
const AGENT_START_TIMEOUT = 20_000;
const AGENT_TIMEOUT = 10 * 60_000;

interface Options {
  story: string; take: string; theme: 'light' | 'dark'; provider: string; model: string; agent: boolean; keepOpen: boolean;
  position: [number, number] | null;
  /** How much faster than the reference pace the author acts: holds, pointer moves and scrolls. */
  tempo: number;
  /** How much faster than TYPING_CPS the author types (prose, prompts and fields), with shorter rests. */
  typingTempo: number;
}

function parseArguments(args: string[]): Options {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const options: Options = {
    story: path.join(here, 'sample-story.zh-CN.md'), take: stamp, theme: 'light', provider: 'openai', model: 'gpt-5.6-sol',
    agent: true, keepOpen: false, position: null, tempo: 1.5, typingTempo: 4,
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
    } else if (argument === '--provider') options.provider = value();
    else if (argument === '--model') options.model = value();
    else if (argument === '--no-agent') options.agent = false;
    else if (argument === '--tempo' || argument === '--typing-tempo') {
      const tempo = Number(value());
      if (!(tempo >= 0.5 && tempo <= 4)) throw new Error(`${argument} is between 0.5 and 4`);
      if (argument === '--tempo') options.tempo = tempo;
      else options.typingTempo = tempo;
    }
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

interface SeededBook { projectId: string; name: string; chapters: { id: string; title: string }[] }
interface SeededLibrary { main: SeededBook; aq?: SeededBook }

function resetProfile(databaseDirectory: string, appLocalDataDirectory: string) {
  if (!path.basename(appLocalDataDirectory).startsWith('cc.drifting.wt.')) {
    throw new Error(`Not an isolated profile's data directory: ${appLocalDataDirectory}`);
  }
  for (const file of [LIBRARY, `${LIBRARY}-wal`, `${LIBRARY}-shm`]) rmSync(path.join(databaseDirectory, file), { force: true });
  for (const entry of ['assets', 'sync-objects', 'markdown-projections', 'markdown-mirror-instance']) {
    rmSync(path.join(appLocalDataDirectory, entry), { recursive: true, force: true });
  }
}

function seedLibrary(databasePath: string, appLocalDataDirectory: string): SeededLibrary {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--conditions=import', 'src/dev-cli/showcase-seed-main.ts',
    '--db', databasePath, '--app-local-data', appLocalDataDirectory, '--locale', LOCALE, '--with-a-q'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ') },
  });
  if (result.status !== 0) throw new Error(`Seeding the promo library failed (exit ${result.status ?? result.signal})`);
  return JSON.parse(result.stdout.trim().split('\n').pop()!) as SeededLibrary;
}

// ---------------------------------------------------------------- recording

interface Rect { x: number; y: number; width: number; height: number }

const union = (a: Rect, b: Rect): Rect => {
  const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
  return { x: left, y: top, width: Math.max(a.x + a.width, b.x + b.width) - left, height: Math.max(a.y + a.height, b.y + b.height) - top };
};

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { tempo, typingTempo } = options;
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
      console.log('[promo] seeding the shelf');
      library = seedLibrary(path.join(databaseDirectory, LIBRARY), appLocalDataDirectory);
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
    await scenes.runReloading('prepare', { locale: LOCALE, theme: options.theme, provider: options.provider, model: options.model });
    let shelf = await scenes.run<{ viewport: { width: number; height: number; dpr: number }; card: Rect }>('shelf');
    // A first use of a feature can make the development server reload the
    // page; warm everything up in another book until a pass leaves the page alone.
    for (let attempt = 1; ; attempt += 1) {
      let reloaded = false;
      try {
        await scenes.run('warmupBook', { name: seeded.main.name });
        await sleep(3000);
        reloaded = await session.evaluate<string>('typeof window.__driftingPromo') !== 'object';
      } catch (error) {
        console.warn(`[promo] warming up failed: ${error instanceof Error ? error.message : String(error)}`);
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
    }
    // An existing book's chapter, visited once off camera: Project Home offers it under Continue.
    const existingBook = story.existing ? [seeded.aq, seeded.main].find((book) => book?.name === story.book) : undefined;
    const existingChapter = existingBook?.chapters.find((chapter) => chapter.title === story.chapter);
    if (story.existing) {
      if (!existingBook || !existingChapter) throw new Error(`No 《${story.book}》 ${story.chapter} on the seeded shelf`);
      await scenes.run('visit', { projectId: existingBook.projectId, name: existingBook.name, chapterId: existingChapter.id });
    }
    shelf = await scenes.run('shelf');
    bringToFront(pid);
    await sleep(800);
    const window = mainWindow(pid);
    if (!window) throw new Error('The app has no window');
    const offset = { x: (window.width - shelf.viewport.width) / 2, y: window.height - shelf.viewport.height };

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
    const grow = (rect: Rect, x: number, y = x): Rect => ({ x: rect.x - x, y: rect.y - y, width: rect.width + 2 * x, height: rect.height + 2 * y });
    const rectOf = async (selector: string, text?: string, timeout = 15_000): Promise<Rect> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const rect = await scenes.run<Rect | null>('rect', { selector, text });
        if (rect) return rect;
        if (Date.now() > deadline) throw new Error(`No ${selector}${text ? ` (${text})` : ''} on screen`);
        await sleep(250);
      }
    };
    const until = async <T>(scene: string, what: string, options: Record<string, unknown> = {}, timeout = 30_000): Promise<NonNullable<T>> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await scenes.run<T>(scene, options);
        if (value) return value as NonNullable<T>;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(250);
      }
    };
    /**
     * A pause in the take. One the viewer watches (0.7 s or more) is acted
     * `tempo` times faster, so the video plays the take as recorded; a hand
     * settling or the app catching up keeps its time.
     */
    const hold = (ms: number) => sleep(ms >= 700 ? ms / tempo : ms);
    let hand: { x: number; y: number } | null = null;
    /** Moves the pointer in the rig's own time for the distance (rig.swift `move`), `tempo` times faster. */
    const moveTo = async (point: { x: number; y: number }, duration?: number) => {
      const distance = hand ? Math.hypot(point.x - hand.x, point.y - hand.y) : 600;
      hand = point;
      return rig.send('pointer.move', { ...point, duration: duration ?? Math.min(1.1, Math.max(0.32, 0.28 + distance / 1500)) / tempo });
    };
    /** Points at a control, lets the hand settle, clicks it. The camera moves only if the control is out of its frame. */
    const clickOn = async (rect: Rect, name: string, zoom?: number) => {
      mark('target', { target: name, rect: rectToWindow(rect), ...(zoom ? { zoom } : {}) });
      await moveTo(centre(rect));
      await sleep(180);
      await rig.send('pointer.click');
    };
    const shortcut = (key: string, ...modifiers: string[]) => rig.send('key.press', { key, modifiers });

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
    interface TypeOptions { typo?: { intended: string; typed: string } | null; zoom?: number; focus?: Rect; cps?: number; pauses?: boolean }
    /** Types `text` with real keystrokes; `focus` (viewport) is the box the camera frames for a prompt or a field. */
    const typeText = async (text: string, pace: Pace, kind: 'prose' | 'prompt' | 'field', options: TypeOptions = {}) => {
      mark('type.start', { pace, kind, text, ...(options.zoom ? { zoom: options.zoom } : {}),
        ...(options.focus ? { focus: rectToWindow(options.focus) } : {}) });
      sampling = kind === 'prose';
      const sampler = sampling ? sampleCaret() : Promise.resolve();
      const cps = options.cps ?? TYPING_CPS[pace] * typingTempo;
      const rests = 1 / typingTempo;
      const pauses = options.pauses ?? true;
      const typo = options.typo;
      if (typo) {
        const at = text.indexOf(typo.intended);
        await rig.send('key.type', { text: text.slice(0, at), cps, rests });
        await rig.send('key.type', { text: typo.typed, cps, pauses: false });
        await sleep(650 / typingTempo);
        for (let index = 0; index < [...typo.typed].length; index += 1) {
          await rig.send('key.press', { key: 'backspace' });
          await sleep(160 / typingTempo);
        }
        await sleep(300 / typingTempo);
        await rig.send('key.type', { text: text.slice(at), cps, rests });
      } else {
        await rig.send('key.type', { text, cps, pauses, rests });
      }
      sampling = false;
      await sampler;
      mark('type.end', { kind });
    };
    /** What the camera should look at from now on: a window rectangle (viewport pixels), or the whole canvas. */
    const shot = (rect: Rect | null, zoom?: number, pad?: number, within?: Rect) =>
      mark('shot', { rect: rect ? rectToWindow(rect) : null, ...(zoom ? { zoom } : {}), ...(pad !== undefined ? { pad } : {}),
        ...(within ? { within: rectToWindow(within) } : {}) });
    /** The page column between the sidebars, top to bottom (the tab dock sits 16 points inside it). */
    const pageColumn = async (): Promise<Rect> => {
      const dock = await until<Rect>('tabDock', 'the tab dock');
      return { x: dock.x - 16, y: 0, width: dock.width + 32, height: shelf.viewport.height };
    };
    /** The bottom of the Agent's panel: its newest lines and the composer under them. */
    const agentFoot = async (height = 300): Promise<Rect> => {
      const composer = await rectOf('.agt-composer');
      return { x: composer.x - 12, y: composer.y - height, width: composer.width + 24, height: height + composer.height };
    };
    const waitForAgent = async (what: string) => {
      const startDeadline = Date.now() + AGENT_START_TIMEOUT;
      while (!(await scenes.run<{ running: boolean }>('agent')).running) {
        if (Date.now() > startDeadline) throw new Error(`The Agent did not start ${what}`);
        await sleep(300);
      }
      // Back from the prompt to the conversation, so the answer is seen as it comes in.
      await sleep(500);
      const latest = await scenes.run<Rect | null>('agentLatest');
      shot(latest ?? await agentFoot(Math.min(600, shelf.viewport.height * 0.62)));
      mark('agent.start', { what });
      console.log(`[promo] the Agent is ${what}…`);
      const deadline = Date.now() + AGENT_TIMEOUT;
      while ((await scenes.run<{ running: boolean }>('agent')).running) {
        if (Date.now() > deadline) throw new Error(`The Agent took more than ${AGENT_TIMEOUT / 60_000} minutes ${what}`);
        await sleep(700);
      }
      mark('agent.end', { what });
    };
    /** Shows the right sidebar's tab `label`, clicking it only if it is not showing already (a second click closes it). */
    const rightTab = async (label: string, name: string) => {
      const tab = await rectOf('.rightbar-tab-tray button', label);
      const active = await scenes.run<boolean>('tabActive', { label });
      if (!active) await clickOn(tab, name);
    };
    const immersive = async (on: boolean) => {
      if (await scenes.run<boolean>('immersive') === on) return;
      await shortcut('return', 'cmd', 'shift');
      await sleep(1000);
    };
    /**
     * Writing from here on: immersive, the camera on the paper's column — at
     * once, or (`frame` false) from the first caret the camera tolerates.
     */
    const startWriting = async (frame = true) => {
      await immersive(true);
      const column = await until<{ text: Rect; paper: Rect }>('column', 'the paper');
      const caret = frame ? await scenes.run<Rect | null>('caret') : null;
      mark('writing', { column: { text: rectToWindow(column.text), paper: rectToWindow(column.paper) },
        ...(caret ? { rect: rectToWindow(caret) } : {}) });
    };

    // Off camera: the pointer parked where Drifting's icon will be in the opening's Dock.
    const dock = dockSpot(window);
    await moveTo(dock, 0.2);
    await sleep(600);

    await rig.send('record.start', { out: path.join(output, 'raw.mov'), fps: 60 });
    recording = true;
    console.log('[promo] recording');
    await sleep(600);

    // The opening: Drifting clicked in the Dock (drawn by compose), its window opening on the shelf.
    mark('phase', { phase: 'open' });
    await sleep(1900);
    mark('intro.click', dock);
    await sleep(260);
    mark('intro.open');
    await sleep(1700);

    if (story.existing) {
      // The book from the shelf: it opens where the author left it, on the chapter.
      mark('phase', { phase: 'open-book' });
      await hold(400);
      await clickOn(await until<Rect>('cardRect', `the ${story.book} card`, { name: story.book }), 'book-card');
      const projectId = await until<string>('projectId', 'the book to open');
      console.log(`[promo] opened 《${story.book}》 (${projectId})`);
      await until<Rect>('firstParagraph', 'the chapter to open');
      shot(null);
      await hold(3400);
    } else {
    // A new book, named in the dialog.
    mark('phase', { phase: 'new-book' });
    // The new-book card closes the shelf, below the books: scroll down to it.
    let card = shelf.card;
    if (card.y + card.height > shelf.viewport.height - 40) {
      await moveTo(toWindow({ x: shelf.viewport.width * 0.55, y: shelf.viewport.height * 0.55 }));
      await hold(250);
      await rig.send('pointer.scroll', { dy: card.y + card.height - shelf.viewport.height + 90, duration: 1.1 / tempo });
      await hold(900);
      card = await rectOf('.pp-card--new');
    }
    await clickOn(card, 'new-book');
    const dialog = await until<{ card: Rect; field: Rect; create: Rect }>('newBookDialog', 'the new-book dialog');
    await hold(500);
    await typeText(story.book, 'slow', 'field', { focus: grow(dialog.card, 20), zoom: 1.9 });
    await hold(500);
    // The rig posts keys to the app's process only; make sure they arrive.
    const typed = await scenes.run<{ value: string } | null>('newBookDialog');
    if (typed?.value !== story.book) throw new Error(`The keystrokes did not reach the app (the name field holds "${typed?.value ?? ''}")`);
    await clickOn(dialog.create, 'create');
    shot(null);
    const projectId = await until<string>('projectId', 'the new book to open');
    console.log(`[promo] created 《${story.book}》 (${projectId})`);
    if (story.memory) await scenes.run('remember', { body: story.memory });
    await hold(2600);

    // Its first chapter, from Project Home, and its title.
    mark('phase', { phase: 'new-chapter' });
    await clickOn(await rectOf('.home-create__tile', '章节'), 'new-chapter');
    const title = await until<Rect>('title', 'the new chapter');
    await hold(1400);
    await clickOn(title, 'title');
    await hold(350);
    // The click leaves a caret in 新章节; select it all to type over it.
    await shortcut('a', 'cmd');
    await hold(350);
    await typeText(story.chapter, 'slow', 'field', { focus: grow(title, 60, 40), zoom: 2.2 });
    const titled = await scenes.run<string | null>('titleValue');
    if (titled !== story.chapter) throw new Error(`The chapter title reads "${titled ?? ''}", not "${story.chapter}"`);
    await hold(400);
    await rig.send('key.press', { key: 'return' });
    await hold(700);
    // Fold the timeline away; one chapter has none to speak of (off camera: it is closed in immersive writing anyway).
    await scenes.run('timeline', { hidden: true });
    }

    mark('phase', { phase: 'write' });
    // A question before the first line is asked before writing starts.
    if (story.paragraphs[0]?.ask && story.ask && options.agent) await askAgent(story.ask);
    else if (story.existing) {
      // The caret into the empty chapter.
      await clickOn(await until<Rect>('firstParagraph', 'the chapter text'), 'paper');
      await hold(500);
    }
    // The opening line frames itself, close.
    await startWriting(false);
    await hold(900);
    for (const [index, paragraph] of story.paragraphs.entries()) {
      const last = index === story.paragraphs.length - 1;
      if (paragraph.ask && story.ask && options.agent && index > 0) {
        await askAgent(story.ask);
        await startWriting();
        await hold(700);
      }
      const text = last ? paragraph.text : `${paragraph.text}\n`;
      if (paragraph.quick) {
        await typeText(text, paragraph.pace, 'prose', { cps: QUICK_CPS * typingTempo, pauses: false });
        continue;
      }
      // The opening line, close up (a short one slowly); then the page.
      const opening = index === 0 && [...paragraph.text].length <= 24;
      await typeText(text, opening ? 'slow' : paragraph.pace, 'prose', { typo: paragraph.typo, ...(index === 0 ? { zoom: opening ? 2.5 : 2.2 } : {}) });
      if (index === 0) {
        await hold(1200);
        const caret = await scenes.run<Rect | null>('caret');
        if (caret) mark('writing', { column: await columnMark(), rect: rectToWindow(caret) });
        await hold(600);
      }
    }
    await hold(1400);
    mark('writing.end');
    await immersive(false);
    shot(null);
    await hold(1600);
    if (story.existing) {
      // The book around the chapter: its chapters on their storylines, in the timeline under the page.
      mark('phase', { phase: 'timeline' });
      const band = await scenes.run<Rect | null>('bottomTimeline');
      if (band) {
        // The timeline with the end of the chapter above it: the page column, edge to edge, down to the timeline's foot.
        const column = await pageColumn();
        const height = column.width * 9 / 16;
        shot({ x: column.x, y: band.y + band.height - height, width: column.width, height }, undefined, 0);
        await hold(5200);
        shot(null);
        await hold(1200);
      } else console.warn('[promo] no timeline under the page');
    }

    async function columnMark() {
      const column = await until<{ text: Rect; paper: Rect }>('column', 'the paper');
      return { text: rectToWindow(column.text), paper: rectToWindow(column.paper) };
    }

    /** Mid-chapter: out of immersive writing, asks the Agent to look something up, reads its answer. */
    async function askAgent(question: string) {
      mark('phase', { phase: 'ask' });
      await hold(600);
      mark('writing.end');
      await immersive(false);
      shot(null);
      await hold(700);
      await rightTab('帮手', 'agent-tab');
      await hold(900);
      await clickOn(await rectOf('.agt-composer__text'), 'composer');
      await hold(300);
      await typeText(question, 'normal', 'prompt', { focus: await agentFoot(120), zoom: 2.3 });
      await hold(500);
      await rig.send('key.press', { key: 'return' });
      await hold(400);
      // The hand rests on the paper while the Agent works.
      const column = await until<{ text: Rect; paper: Rect }>('column', 'the paper');
      await moveTo(toWindow({ x: column.paper.x + column.paper.width - 40, y: column.paper.y + 420 }));
      await waitForAgent('looking it up');
      await hold(600);
      type Answer = Rect & { viewTop: number; viewBottom: number; bubbleBottom: number };
      const panel = await agentFoot(Math.min(560, shelf.viewport.height * 0.6));
      // The hand goes to the panel only to scroll it, and back to rest on the paper, off the answer.
      const handOnPanel = () => moveTo(centre({ ...panel, height: panel.height - 120 }));
      const handAtRest = () => moveTo(toWindow({ x: column.paper.x + column.paper.width - 40, y: column.paper.y + 420 }));
      let scrolled = false;
      let answer = await until<Answer>('answer', 'the answer');
      // Its top in view, the way a hand would scroll the panel.
      if (answer.y < answer.viewTop + 4 || answer.y + Math.min(answer.height, 476) > answer.viewBottom) {
        await handOnPanel();
        await hold(300);
        await rig.send('pointer.scroll', { dy: answer.y - answer.viewTop - 24, duration: 0.8 / tempo });
        scrolled = true;
        await hold(800);
        await handAtRest();
        answer = await until<Answer>('answer', 'the answer');
      }
      // First what it searched, above the answer; then the answer itself, whole when it fits.
      const stepsTop = Math.max(answer.viewTop + 4, answer.bubbleBottom + 4, answer.y - 300);
      if (answer.y - stepsTop > 90) {
        shot({ x: answer.x - 6, y: stepsTop, width: answer.width + 12, height: answer.y - stepsTop }, 2.2);
        await hold(3000);
      }
      const whole = answer.height <= 476;
      shot({ x: answer.x - 6, y: answer.y - 8, width: answer.width + 12, height: Math.min(answer.height + 16, whole ? 492 : 330) },
        whole ? undefined : 2.4);
      await hold(whole ? 7600 : 5200);
      if (!whole) {
        await handOnPanel();
        await hold(300);
        await rig.send('pointer.scroll', { dy: Math.min(answer.height - 280, 420), duration: 1.6 / tempo });
        scrolled = true;
        await hold(3600);
      }
      if (scrolled) {
        // Back to the newest line, so the panel follows the Agent again.
        await handOnPanel();
        await rig.send('pointer.scroll', { dy: 4000, duration: 0.6 / tempo });
        await hold(400);
      }
      shot(null);
      await hold(700);
      // Back to the chapter's end.
      await clickOn(await until<{ x: number; y: number; width?: number; height?: number }>('endRect', 'the chapter end') as Rect, 'chapter-end-line');
      await hold(500);
    }

    if (options.agent) {
      mark('phase', { phase: 'organize' });
      await rightTab('帮手', 'agent-tab');
      await hold(700);
      await clickOn(await rectOf('.agt-composer__text'), 'composer');
      await hold(300);
      await typeText(story.organize, 'normal', 'prompt', { focus: await agentFoot(120), zoom: 2.3 });
      await hold(500);
      await rig.send('key.press', { key: 'return' });
      await hold(400);
      const column = await until<{ text: Rect; paper: Rect }>('column', 'the paper');
      await moveTo(toWindow({ x: column.paper.x + column.paper.width - 40, y: column.paper.y + 420 }));
      await waitForAgent('organizing');
      // What it changed, listed under its answer.
      shot(await agentFoot(330), 2.2);
      await hold(4600);

      mark('phase', { phase: 'links' });
      const links = await scenes.run<{ text: string; rect: Rect }[]>('links', { names: story.links.length ? story.links : null });
      mark('links', { links: links.map((link) => ({ text: link.text, rect: rectToWindow(link.rect) })) });
      const hovered = links.find((link) => link.text.includes(story.links[0] ?? '')) ?? links[0];
      if (hovered) {
        // The page around the name: the page column, edge to edge, no higher than the window's top.
        const page = await pageColumn();
        shot({ x: page.x, y: Math.max(0, hovered.rect.y - 220), width: page.width, height: page.width * 9 / 16 }, undefined, 0, page);
        await hold(1200);
        mark('target', { target: 'link', rect: rectToWindow(hovered.rect) });
        await moveTo(centre(hovered.rect));
        const card = await until<Rect>('hoverCard', 'the hover card', {}, 8000).catch(() => null);
        const both = card ? union(hovered.rect, card) : { x: hovered.rect.x - 160, y: hovered.rect.y - 40, width: 560, height: 360 };
        shot(grow(both, 30), 2.3, undefined, await pageColumn());
        await hold(6000);
      } else console.warn('[promo] no linked names in view to point at');

      mark('phase', { phase: 'elements' });
      shot(null);
      await hold(900);
      await clickOn(await rectOf('.workspace-panel-tab-row button', '要素'), 'elements-tab');
      await hold(600);
      // The elements it made, listed on the left.
      const list = await scenes.run<Rect | null>('rect', { selector: '.sidebar-shell__content' });
      if (list) shot({ ...list, height: Math.min(list.height, 520) }, 1.9);
      await hold(2200);

      if (story.elements.length) {
        // Elements as pages: each opened as its own tab (a double click keeps
        // it), read, and the tabs switched between from the dock above the paper.
        mark('phase', { phase: 'element-tabs' });
        type Section = Rect & { pageTop: number; pageBottom: number };
        /** The page column between the sidebars (the tab dock sits 16 points inside it). */
        /**
         * A part of the page as wide as its text. One taller than a frame that
         * wide holds (370 points with the shot's margin) takes the whole column,
         * edge to edge, so the frame never ends on a sidebar or the outline rail.
         */
        const pageWidthShot = async (section: Rect, height: number) => {
          if (height <= 370) { shot({ x: section.x, y: section.y - 24, width: section.width, height }); return; }
          const column = await pageColumn();
          shot({ x: column.x, y: section.y - 24, width: column.width, height: column.width * 9 / 16 }, undefined, 0);
        };
        for (const [index, name] of story.elements.entries()) {
          const row = await until<Rect>('elementRow', `${name} in the element list`, { name });
          mark('target', { target: `element-row`, rect: rectToWindow(row) });
          await moveTo(centre(row));
          // Quick enough that the name's card has not opened yet.
          await sleep(120);
          await rig.send('pointer.click', { count: 2 });
          const opened = await until<Section>('elementSection', `${name}'s page`, { id: 'overview' });
          await hold(500);
          // Off the page, so its card does not open over what is read.
          await moveTo(toWindow({ x: opened.x + opened.width + 30, y: Math.max(opened.y, 100) + 60 }));
          shot(null);
          await hold(1300);
          // Who they are: the name, its aliases and summary, and the story so far, measured
          // once the page has settled (a new tab can open at the last one's scroll, then go to the top).
          const overview = await until<Section>('elementSection', `${name}'s page`, { id: 'overview' });
          const bio = await scenes.run<Section | null>('elementSection', { id: 'bio' });
          await pageWidthShot(overview, Math.min(520, (bio ? bio.y + 150 : overview.y + overview.height) - overview.y + 24));
          await hold(4200);
          if (index === 0) {
            // The first one's relations, further down the page.
            const relations = await scenes.run<Section | null>('elementSection', { id: 'relations' });
            if (relations) {
              const pageBottom = relations.pageBottom;
              if (relations.y > shelf.viewport.height * 0.45) {
                await moveTo(centre({ ...overview, y: overview.y + 120, height: 1 }));
                await rig.send('pointer.scroll', { dy: relations.y - shelf.viewport.height * 0.22, duration: 1.0 / tempo });
                await hold(900);
                await moveTo(toWindow({ x: overview.x + overview.width + 30, y: overview.y + 60 }));
              }
              const shown = await scenes.run<Section | null>('elementSection', { id: 'relations' });
              if (shown) await pageWidthShot(shown, Math.min(520, Math.min(shown.height, pageBottom) + 24));
              await hold(4400);
            }
          }
        }
        // The open documents, spread from their marks above the paper: back to the
        // first element, then to the chapter. One frame holds the tabs and the page
        // under them, so the page changes while the camera stays (the pointer's
        // moves up there mark no target).
        const dock = await until<Rect>('tabDock', 'the tab dock');
        const column = await pageColumn();
        shot({ x: column.x, y: dock.y, width: column.width, height: column.width * 9 / 16 }, undefined, 0);
        await hold(1200);
        await moveTo(centre(dock));
        await sleep(600);
        await hold(1200);
        for (const [step, title] of [story.elements[0], story.chapter].entries()) {
          await moveTo(centre(await until<Rect>('tabPill', `the ${title} tab`, { title })));
          await sleep(180);
          await rig.send('pointer.click');
          await hold(step === 0 ? 2800 : 2000);
        }
        shot(null);
        await hold(900);
      }

      await clickOn(await rectOf('.workspace-super-view-entry'), 'element-overview');
      shot(null);
      await hold(2800);
      // Closer on one person and the people and things around them, once the layout settles.
      const cluster = await scenes.run<Rect | null>('cluster', { name: story.links[0] ?? '', count: 4 });
      if (cluster) shot(grow(cluster, 70, 50), 2.3);
      await hold(5400);
      shot(null);
      await hold(900);
      await rig.send('key.press', { key: 'escape' });
      await hold(1200);
      // Escape closes the overview unless something inside it held the key;
      // then its back button does, as a hand would.
      if (await scenes.run<string>('superView') !== 'none') {
        await clickOn(await rectOf('.super-view-head__back'), 'overview-back');
        await hold(1200);
      }
      if (await scenes.run<string>('superView') !== 'none') throw new Error('The element overview did not close');
      await clickOn(await rectOf('.workspace-panel-tab-row button', '章节'), 'chapters-tab');
      await hold(800);

      // The book's material notes, in the right sidebar.
      mark('phase', { phase: 'materials' });
      await rightTab('素材库', 'library-tab');
      await hold(1000);
      const materials = await scenes.run<Rect | null>('materials');
      if (materials) {
        shot({ ...materials, y: materials.y - 50, height: Math.min(materials.height, 260) + 50 }, 2.0);
        await hold(3400);
      }
      shot(null);
      await hold(700);
      // The review answers in the Agent's panel.
      await rightTab('帮手', 'agent-tab');
      await hold(900);

      mark('phase', { phase: 'review' });
      let ornament = await rectOf('.page__ornament-trigger');
      const viewportHeight = shelf.viewport.height;
      // The page ends where the timeline under it begins.
      const pageBottom = (await scenes.run<Rect | null>('bottomTimeline'))?.y ?? viewportHeight;
      if (ornament.y + ornament.height > pageBottom - 220 || ornament.y < 80) {
        // Bring the chapter's end into view the way a hand would, its menu clear of the timeline.
        await moveTo(centre({ ...column.text, height: 1, y: Math.min(pageBottom - 200, column.text.y + 300) }));
        await rig.send('pointer.scroll', { dy: ornament.y - pageBottom * 0.45, duration: 0.9 / tempo });
        await hold(700);
        ornament = await rectOf('.page__ornament-trigger');
      }
      mark('target', { target: 'chapter-end', rect: rectToWindow(ornament), zoom: 2.2 });
      await moveTo(centre(ornament));
      await hold(700);
      await clickOn(await rectOf('.chapter-end-menu__item[data-action="review"]'), 'review');
      await waitForAgent('reviewing');
      await hold(1200);
      // The sidebar's top: its tabs and where the comments will be.
      const panel = await agentFoot(Math.min(560, viewportHeight * 0.6));
      shot({ x: panel.x, y: 0, width: panel.width, height: 460 }, 1.7);
      await hold(700);
      await rightTab('审阅', 'review-tab');
      await hold(700);
      // Close enough to read the first comment, then the comments anchored in
      // the prose and listed beside it.
      shot({ x: panel.x, y: 70, width: panel.width, height: 300 }, 2.2);
      await hold(3600);
      shot({ x: column.paper.x, y: 50, width: shelf.viewport.width - column.paper.x - 10, height: viewportHeight - 100 });
      await hold(4400);
    }

    mark('phase', { phase: 'outro' });
    shot(null);
    await hold(2400);
    const stopped = await rig.send('record.stop');
    recording = false;
    console.log(`[promo] recorded ${stopped.frames} frames (${stopped.dropped} dropped)`);

    writeTimeline(output, {
      story: { file: options.story, book: story.book, chapter: story.chapter },
      theme: options.theme, provider: options.provider, model: options.model, window, viewport: shelf.viewport, offset,
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
