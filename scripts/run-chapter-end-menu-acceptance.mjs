import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';
import { launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/chapter-end-menu.json');
const inputs = [
  'scripts/run-chapter-end-menu-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'scripts/renderer-chapter-end-menu.tsx', 'scripts/renderer-chapter-end-menu.html',
  'src/renderer/components/editor/ChapterEndOrnament.tsx',
  'src/renderer/components/editor/VirtualChapterRow.tsx',
  'src/renderer/features/editor/ChapterEndActions.tsx',
  'src/renderer/features/editor/chapter-agent-review.ts',
  'src/renderer/features/editor/chapter-agent-review.test.ts',
  'src/renderer/features/editor/useChapterInsert.ts',
  'src/renderer/features/editor/chapter-title-focus.ts',
  'src/renderer/domain/chapter-insert.ts', 'src/renderer/domain/chapter-insert.test.ts',
  'src/renderer/components/editor/ChapterEditor.tsx',
  'src/renderer/views/AllChaptersEditorView.tsx', 'src/renderer/views/NodeEditorView.tsx',
  'src/styles/chapter-end-menu.css', 'src/styles/index.css', 'src/styles/materials.css',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
};
const before = fingerprint();
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, before, 'Regenerate chapter-end menu evidence.');
  console.log('Chapter-end menu evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-chapter-end-menu-'));
  let server, browser, client;
  try {
    server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'),
      envDir: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite'),
      server: { host: '127.0.0.1', port: 0, hmr: false, open: false },
    });
    await server.listen();
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'chrome') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({ width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const errors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 600; i++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${expression}; errors: ${errors.join(' | ')}`);
    };
    const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y,
      button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    const click = async (x, y) => {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
    };
    const away = () => mouse('mouseMoved', 5, 5);
    const key = async (name, code, keyCode) => {
      const base = { key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await client.Input.dispatchKeyEvent({ type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : {}) });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', ...base });
    };
    const triggerOf = id => `document.querySelector('[data-chapter-id="${id}"] .page__ornament-trigger')`;
    // Bring a chapter's ⁂ to the middle of the viewport once its prose has
    // loaded (loading changes the row height), then report the mark.
    const trigger = async (id, block = 'center') => {
      await evaluate(`${triggerOf(id)}.scrollIntoView({ block: '${block}' })`);
      await until(`document.querySelector('[data-chapter-id="${id}"][data-content-ready=true]')`);
      await delay(100);
      await evaluate(`${triggerOf(id)}.scrollIntoView({ block: '${block}' })`);
      await delay(50);
      return mark(id);
    };
    // The trigger and its three seals: centre, colour and where each seal sits.
    const seals = host => `Object.fromEntries([...${host}.querySelectorAll('[data-seal]')].map(seal => {
      const box = seal.getBoundingClientRect();
      return [seal.dataset.seal, { x: box.left + box.width / 2, y: box.top + box.height / 2,
        color: getComputedStyle(seal).backgroundColor }];
    }))`;
    const mark = id => evaluate(`(() => {
      const button = ${triggerOf(id)}; const rect = button.getBoundingClientRect(); const style = getComputedStyle(button);
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        label: button.getAttribute('aria-label'), popup: button.getAttribute('aria-haspopup'),
        expanded: button.getAttribute('aria-expanded'), finished: button.dataset.finished,
        color: style.color, background: style.backgroundColor, text: button.textContent,
        seals: ${seals('button')} };
    })()`);
    // Samples the primary action's seal and label inside the page: once the
    // menu's state flips, mid-way through the morph and after it settles.
    const morph = (id, toOpen) => evaluate(`new Promise(resolve => {
      const host = document.querySelector('[data-chapter-id="${id}"] .page__ornament--menu');
      const seal = host.querySelector('[data-seal=insert]');
      const label = host.querySelector('[data-action=insert] .chapter-end-menu__label');
      const read = () => { const box = seal.getBoundingClientRect();
        return { sealX: box.left + box.width / 2, sealY: box.top + box.height / 2,
          label: Number(getComputedStyle(label).opacity), labelFilter: getComputedStyle(label).filter }; };
      const markBackground = getComputedStyle(host.querySelector('.page__ornament-trigger')).backgroundColor;
      const started = performance.now();
      const wait = () => {
        if ((host.dataset.open === 'true') !== ${toOpen}) return requestAnimationFrame(wait);
        const flipped = performance.now() - started;
        setTimeout(() => { const mid = read(); setTimeout(() => resolve({ flipped, markBackground, mid, end: read() }), 200); }, 50);
      };
      wait();
    })`);
    // The open action row, if any: its line and each plain-text action.
    const menu = () => evaluate(`(() => {
      const host = document.querySelector('.page__ornament--menu[data-open="true"]');
      if (!host) return null;
      const row = host.querySelector('[role=menu]'); const box = row.getBoundingClientRect();
      return { chapterId: host.closest('[data-chapter-id]')?.dataset.chapterId,
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        seals: ${seals('host')},
        items: [...row.querySelectorAll('[role=menuitem]')].map(item => {
          const rect = item.getBoundingClientRect(); const style = getComputedStyle(item);
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          return { action: item.dataset.action, label: item.textContent, x, y,
            disabled: item.disabled, focused: document.activeElement === item,
            font: style.fontFamily, border: style.borderTopWidth, background: style.backgroundColor,
            inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
            hitTarget: document.elementsFromPoint(x, y).some(el => el === item || item.contains(el)) };
        }) };
    })()`);
    const item = (state, action) => state.items.find(entry => entry.action === action);
    const transparent = 'rgba(0, 0, 0, 0)';
    const hoverOpen = async id => {
      await away();
      const at = await trigger(id);
      await mouse('mouseMoved', at.x, at.y);
      await delay(450); // 180 ms intent + the cross-fade + the click guard
      const state = await menu();
      assert(state && state.chapterId === id, `Hover should open the ⁂ actions of ${id}.`);
      return { at, state };
    };
    const probeStyle = (property, value) => evaluate(`(() => {
      const probe = document.createElement('span'); probe.style.${property} = '${value}';
      document.body.append(probe); const computed = getComputedStyle(probe).${property}; probe.remove(); return computed;
    })()`);

    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-chapter-end-menu.html` });
    await until('document.querySelectorAll("[data-chapter-id]").length === 3 && document.querySelector("[data-chapter-id=chapter-a][data-content-ready=true]")');
    await evaluate('document.fonts.ready');
    const order = () => evaluate('[...document.querySelectorAll("[data-chapter-id]")].map(row => row.dataset.chapterId)');
    assert.deepEqual(await order(), ['chapter-a', 'chapter-b', 'chapter-c']);
    const monoFont = await probeStyle('fontFamily', 'var(--font-prose-mono)');
    const accent = await probeStyle('color', 'hsl(var(--accent))');

    // Resting page: ⁂ is a menu button drawn as three sand seals set as an
    // asterism (one above, two below) round its centre; the actions are hidden and inert.
    const resting = await trigger('chapter-b');
    assert.equal(resting.popup, 'menu');
    assert.equal(resting.expanded, 'false');
    assert(resting.label, 'The ⁂ trigger needs an accessible name.');
    assert.equal(resting.text, '', 'The mark is drawn, not typed.');
    const restSeal = Object.fromEntries(Object.entries(resting.seals).map(([key, seal]) =>
      [key, { dx: seal.x - resting.x, dy: seal.y - resting.y }]));
    assert.deepEqual(Object.keys(restSeal), ['finish', 'insert', 'review']);
    const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
    assert(near(restSeal.finish.dx, 0) && near(restSeal.finish.dy, -5)
      && near(restSeal.insert.dx, -6) && near(restSeal.insert.dy, 5)
      && near(restSeal.review.dx, 6) && near(restSeal.review.dy, 5), `Seals form the asterism: ${JSON.stringify(restSeal)}`);
    assert.equal(await menu(), null);
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-chapter-id="chapter-b"] [role=menuitem]')]
      .some(el => document.elementsFromPoint(el.getBoundingClientRect().left + 2, el.getBoundingClientRect().top + 2).includes(el))`), false,
      'Hidden actions must not take the pointer.');

    // Hover intent: passing over ⁂ does nothing and never presses it; resting
    // on it lets the seals fall into a column beside the actions.
    await away();
    await mouse('mouseMoved', resting.x, resting.y);
    await mouse('mouseMoved', 5, 5);
    await delay(150);
    assert.equal(await menu(), null, 'A brief pass over ⁂ must not open the actions.');
    // Agile and smooth: after a short intent the switch starts; mid-way the
    // primary's seal is travelling and its word is coming in.
    await mouse('mouseMoved', resting.x, resting.y);
    const opening = await morph('chapter-b', true);
    assert.equal(opening.markBackground, transparent, 'Hover gives ⁂ no pressed wash.');
    assert(opening.flipped >= 30 && opening.flipped < 120, `The switch should start promptly after a short intent: ${JSON.stringify(opening)}`);
    const restInsertX = resting.x + restSeal.insert.dx;
    assert(opening.mid.sealX < restInsertX - 1 && opening.mid.sealX > opening.end.sealX + 1,
      `Mid-morph, the seal is on its way to its row: ${JSON.stringify(opening)}`);
    assert(opening.mid.label > 0 && opening.mid.label < 1, `Mid-morph, the word is partly visible: ${JSON.stringify(opening)}`);
    assert(opening.end.label === 1 && opening.end.labelFilter === 'blur(0px)', 'The morph settles on crisp actions.');
    // Hover follows the next pointer move over the opened list.
    await mouse('mouseMoved', resting.x + 1, resting.y);
    await delay(200);
    const row = await menu();
    assert(row, 'Resting on ⁂ opens the actions.');
    // One column centred on ⁂, top to bottom, the primary on ⁂'s line; each
    // seal has dropped to the left edge of its own row.
    assert.deepEqual(row.items.map(entry => entry.action), ['finish', 'insert', 'review']);
    const [left, centre, right] = row.items;
    assert(left.y < centre.y && centre.y < right.y, JSON.stringify(row.items));
    assert(row.items.every(entry => near(entry.x, resting.x)), 'The actions form one column centred on ⁂.');
    assert(near((row.left + row.right) / 2, resting.x), 'The list is centred where ⁂ stood.');
    assert(near(centre.y, resting.y), 'The primary action sits on ⁂’s line.');
    assert(row.items.every(entry => near(row.seals[entry.action].y, entry.y) && near(row.seals[entry.action].x, row.left + 3)),
      `Each seal falls beside its own action: ${JSON.stringify(row.seals)}`);
    const neutral = row.seals.finish.color;
    assert(row.seals.insert.color !== neutral, 'The seal of the action under the pointer takes the accent.');
    assert(row.seals.review.color === neutral, 'Other seals stay ink.');
    assert(row.items.every(entry => entry.font === monoFont), `Actions use the monospace stack: ${row.items[0].font}`);
    assert(row.items.every(entry => entry.border === '0px' && entry.background === transparent), 'Actions are plain text.');
    assert(row.items.every(entry => entry.inViewport && entry.hitTarget && !entry.disabled), JSON.stringify(row.items));

    // Roaming along the list keeps the actions and moves the accent to the
    // seal of the hovered word; leaving the list upward, downward or past
    // either side gathers the seals straight back.
    await mouse('mouseMoved', left.x, left.y);
    await delay(200);
    const roamed = await menu();
    assert(roamed, 'Moving along the list keeps the actions.');
    assert(roamed.seals.finish.color !== roamed.seals.insert.color && roamed.seals.insert.color === roamed.seals.review.color,
      `The accent follows the pointer: ${JSON.stringify(roamed.seals)}`);
    await mouse('mouseMoved', right.x, right.y);
    await delay(50);
    assert(await menu(), 'Moving along the list keeps the actions.');
    const exits = {};
    for (const [name, x, y] of [
      ['above', centre.x, row.top - 20], ['below', centre.x, row.bottom + 20],
      ['left', row.left - 40, centre.y], ['right', row.right + 40, centre.y],
    ]) {
      if (!(await menu())) await hoverOpen('chapter-b');
      await mouse('mouseMoved', x, y);
      await delay(20);
      exits[name] = (await menu()) === null;
      assert(exits[name], `Leaving the line ${name} closes the actions at once.`);
    }
    // Crisp and smooth on the way back: the seals gather, settled fast.
    await hoverOpen('chapter-b');
    await mouse('mouseMoved', centre.x, row.top - 20);
    const closed = await morph('chapter-b', false);
    assert(closed.flipped < 30, `Leaving the list restores ⁂ at once: ${JSON.stringify(closed)}`);
    assert(closed.mid.label > 0 && closed.mid.label < 1, `Mid-return, the word is fading: ${JSON.stringify(closed)}`);
    assert(near(closed.end.sealX, restInsertX) && near(closed.end.sealY, resting.y + restSeal.insert.dy)
      && closed.end.label === 0 && closed.end.labelFilter === 'blur(2px)', `The asterism is back once settled: ${JSON.stringify(closed)}`);

    // A page scrolling ⁂ under a still pointer does not open the actions.
    await away();
    const scrollAt = await trigger('chapter-a');
    await mouse('mouseMoved', scrollAt.x, scrollAt.y - 120);
    await delay(50);
    await evaluate('document.querySelector("[data-testid=book]").scrollBy(0, 120)');
    await delay(300);
    const underPointer = await evaluate(`(() => {
      const rect = ${triggerOf('chapter-a')}.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - ${scrollAt.y - 120}) < 8;
    })()`);
    assert(underPointer, 'The scroll should have brought ⁂ under the pointer.');
    assert.equal(await menu(), null, 'Scrolling ⁂ under a still pointer does not open the actions.');

    // A click right after hover opened the row was meant for ⁂; later clicks act.
    await away();
    const bAt = await trigger('chapter-b');
    await mouse('mouseMoved', bAt.x, bAt.y);
    await until('document.querySelector(\'[data-chapter-id="chapter-b"] .page__ornament--menu[data-open="true"]\')');
    await click(bAt.x, bAt.y);
    await delay(100);
    assert.equal((await evaluate('window.__CHAPTER_END__.inserts')).length, 0, 'An early click does not trigger the action beneath ⁂.');
    await delay(250);
    await click(bAt.x, bAt.y);
    await until('document.querySelector("[data-chapter-id=inserted-1]")');
    assert.deepEqual(await order(), ['chapter-a', 'chapter-b', 'inserted-1', 'chapter-c']);
    assert.equal(await menu(), null, 'Choosing an action closes the row.');
    const [middle] = await evaluate('window.__CHAPTER_END__.inserts');
    assert.equal(middle.act, 'act-1', 'A chapter inserted before an act boundary stays in its act.');
    assert(middle.bookOrder > 10 && middle.bookOrder < 12, JSON.stringify(middle));

    // Mark finished ↔ back to draft; a finished ⁂ takes the accent colour.
    const draftRow = await hoverOpen('chapter-a');
    const finishLabel = item(draftRow.state, 'finish').label;
    await click(item(draftRow.state, 'finish').x, item(draftRow.state, 'finish').y);
    await until('window.__CHAPTER_END__.statuses.length === 1');
    await away();
    await delay(250);
    const finishedTrigger = await trigger('chapter-a');
    assert.equal(finishedTrigger.finished, 'true');
    assert.equal(finishedTrigger.color, accent, 'A finished chapter shows its ⁂ in the accent colour.');
    assert(Object.values(finishedTrigger.seals).every(seal => seal.color === finishedTrigger.seals.finish.color)
      && finishedTrigger.seals.finish.color !== resting.seals.finish.color, 'All three seals take the accent.');
    assert(finishedTrigger.label !== resting.label, 'The trigger names the finished state.');
    const finishedRow = await hoverOpen('chapter-a');
    const draftLabel = item(finishedRow.state, 'finish').label;
    assert.notEqual(draftLabel, finishLabel, 'A finished chapter offers "back to draft".');
    await click(item(finishedRow.state, 'finish').x, item(finishedRow.state, 'finish').y);
    await until('window.__CHAPTER_END__.statuses.length === 2');
    assert.deepEqual(await evaluate('window.__CHAPTER_END__.statuses'),
      [{ id: 'chapter-a', status: 'finished' }, { id: 'chapter-a', status: 'draft' }]);

    // Agent review dispatches, is disabled while starting, then opens its session.
    const reviewRow = await hoverOpen('chapter-a');
    const reviewIdle = item(reviewRow.state, 'review');
    await click(reviewIdle.x, reviewIdle.y);
    await until('window.__CHAPTER_END__.reviews.length === 1');
    assert.equal(await menu(), null);
    const aAt = await mark('chapter-a');
    await click(aAt.x, aAt.y);
    const starting = item(await menu(), 'review');
    assert(starting.disabled, 'The review action is disabled while it is being dispatched.');
    await delay(400);
    const running = item(await menu(), 'review');
    assert(!running.disabled && running.label !== reviewIdle.label && running.label !== starting.label,
      'A running review offers to open its session.');
    await away();
    assert.equal(await menu(), null);

    // Keyboard: Enter opens on the primary action, arrows move along the list,
    // the pointer does not close it, an outside click or Escape does.
    await trigger('chapter-c');
    await evaluate(`${triggerOf('chapter-c')}.focus()`);
    await key('Enter', 'Enter', 13);
    await delay(100);
    const keyboard = await menu();
    assert(keyboard && item(keyboard, 'insert').focused, JSON.stringify(keyboard));
    await key('ArrowUp', 'ArrowUp', 38);
    assert(item(await menu(), 'finish').focused);
    await key('ArrowDown', 'ArrowDown', 40);
    await key('ArrowDown', 'ArrowDown', 40);
    const focusedRow = await menu();
    assert(item(focusedRow, 'review').focused);
    assert(focusedRow.seals.review.color !== focusedRow.seals.insert.color, 'Keyboard focus also lights its seal.');
    await mouse('mouseMoved', 900, 120);
    assert(await menu(), 'Pointer movement does not close a keyboard-opened row.');
    await click(900, 120);
    assert.equal(await menu(), null, 'Clicking outside dismisses the row.');
    await evaluate(`${triggerOf('chapter-c')}.focus()`);
    await key('Enter', 'Enter', 13);
    await delay(100);
    assert(await menu());
    await key('Escape', 'Escape', 27);
    assert.equal(await menu(), null);
    assert(await evaluate(`document.activeElement === ${triggerOf('chapter-c')}`), 'Escape returns focus to ⁂.');

    // Scrolling moves the page under a still pointer: that leaves the line too.
    const cAt = await trigger('chapter-c');
    await click(cAt.x, cAt.y);
    assert(await menu(), 'A click opens the actions at once.');
    await evaluate('document.querySelector("[data-testid=book]").scrollBy(0, 40)');
    await delay(100);
    assert.equal(await menu(), null, 'Scrolling the page closes the row.');

    const decorative = await evaluate(`(() => {
      const ornament = document.querySelector('[data-testid=decorative] .page__ornament');
      return { hidden: ornament.getAttribute('aria-hidden'), seals: ornament.querySelectorAll('[data-seal]').length,
        controls: ornament.querySelectorAll('button').length };
    })()`);
    assert.deepEqual(decorative, { hidden: 'true', seals: 3, controls: 0 });
    assert.deepEqual(errors, []);

    mkdirSync(path.join(root, '.qa'), { recursive: true });
    await hoverOpen('chapter-b');
    writeFileSync(path.join(root, '.qa/chapter-end-menu.png'), Buffer.from(
      (await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ kind: 'chapter-end-menu', status: 'passed',
      generatedAt: new Date().toISOString(), sourceSha256: before, inputs,
      browser: (await client.Browser.getVersion()).product,
      samples: { resting, restSeal, opening, row, roamed, exits, closed, inserts: [middle], finishedTrigger, monoFont,
        labels: { finishLabel, draftLabel, reviewIdle: reviewIdle.label, reviewStarting: starting.label, reviewRunning: running.label } },
      checks: { markIsThreeSealAsterism: true, hoverIntentDelay: true, noPressedWash: true,
        sealsFallBesideActions: true, verticalListCentredOnMark: true, primaryOnTheMarkLine: true,
        hoveredSealTakesAccent: true, monospacePlainText: true, opensPromptly: true,
        sealsTravelWhileWordsArrive: true, roamingAlongListKeepsOpen: true,
        leavingListClosesAtOnce: true, sealsGatherBackSmoothly: true, scrollUnderStillPointerDoesNotOpen: true,
        earlyClickGuard: true, insertsDirectlyAfterChapter: true, staysInsideAct: true,
        finishedToggleAndAccent: true, reviewDispatchStates: true, keyboardMenu: true,
        outsideClickDismisses: true, scrollClosesRow: true, decorativeVariantHasNoControl: true,
        noUncaughtExceptions: true },
      boundary: 'Chromium renderer with the real VirtualChapterRow, ChapterEndMenu, chapterOrderAfter and styles; insert, status and review handlers act on synthetic in-memory chapters with two acts. Database writes, the Agent runtime session, the live-editor title focus, tab opening and WKWebView pointer behaviour are outside this harness.',
    }, null, 2) + '\n');
    console.log('Chapter-end menu: seal asterism, hover intent, seals falling into a vertical list, accent on the hovered seal, instant close off the list, click guard, insert, finish toggle, review states, keyboard and scroll passed.');
  } finally {
    try { if (client) await client.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
