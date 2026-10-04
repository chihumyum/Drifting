import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { closeHeadlessSession, launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/qa/todo-edit.json');
const sources = [
  'src/renderer/features/library/TodoCard.tsx',
  'src/renderer/features/comments/ReviewItemCard.tsx',
  'src/renderer/features/comments/CommentBodyEditor.tsx',
  'src/renderer/features/comments/TodoStatusToggle.tsx',
  'src/renderer/features/comments/CommentSourceHoverCard.tsx',
  'src/renderer/features/comments/use-comment-source-hover.ts',
  'src/renderer/features/comments/comment-source-preview.ts',
  'src/renderer/features/entities/hover/entity-hover-card-model.ts',
  'src/renderer/components/ui/entity-hover-card-position.ts',
  'src/renderer/domain/comment.ts',
  'src/renderer/components/rightBars/EntityRelationPicker.tsx',
  'src/renderer/components/rightBars/ReviewPanel.tsx',
  'src/renderer/components/leftBars/SortMenu.tsx',
  'src/renderer/store/ui-store.ts',
  'src/styles/comments-review.css',
  'src/styles/desktop-typography.css',
  'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx',
  'src/renderer/usecase/useComment.ts',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
  'scripts/todo-edit-ui.html', 'scripts/todo-edit-ui.tsx', 'scripts/run-todo-edit-acceptance.mjs',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source).update(readFileSync(path.join(root, source)));
  return hash.digest('hex');
};
function validate(report) {
  assert.equal(report.status, 'passed');
  assert.equal(report.fingerprint, fingerprint(), 'TODO editing evidence is stale.');
  assert.equal(Object.keys(report.checks).length, 148);
  assert(Object.values(report.checks).every(value => value === true));
  assert.deepEqual(report.uncaughtErrors, []);
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-todo-edit-'));
  let browser, client, server;
  try {
    const before = fingerprint();
    const outDir = path.join(temporary, 'dist');
    await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.VITE_LOCAL_ONLY_MODE': '"true"' },
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/todo-edit-ui.html') } } });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const uncaughtErrors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => uncaughtErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/todo-edit-ui.html' }); await loaded;
    const result = await client.Runtime.evaluate({ expression: 'window.__TODO_EDIT__.run()', awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    assert.equal(fingerprint(), before, 'Sources changed during acceptance.');
    const report = { ...result.result.value, fingerprint: before, sources, uncaughtErrors };
    validate(report);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    const screenshot = process.argv.find((arg) => arg.startsWith('--screenshot='))?.slice(13);
    if (screenshot) writeFileSync(screenshot, Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
  } finally {
    await closeHeadlessSession({ client, browser, server });
    rmSync(temporary, { recursive: true, force: true });
  }
}
console.log('Review and TODO cards: 148 synthetic browser checks passed.');
