#!/usr/bin/env node
// Real-client acceptance. Session descriptors are private, loopback-only debug
// transports; they must point to independent synthetic desktop/iOS libraries.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const reportPath = 'docs/hosted-sync/acceptance/ios-desktop.json';
function fingerprint() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .trim().split('\n').filter(file => /^(src\/renderer\/(sync\/|platform\/|store\/auth|lib\/(auth-client|session-token|hosted-|config|feature-access)|features\/auth\/|app\/effects\/AppEffects)|src-tauri\/src\/|src-tauri\/build.rs$|src-tauri\/Cargo.(toml|lock)$|src-tauri\/tauri.*json$|scripts\/(hosted-environment|run-hosted|run-mobile-dev|run-worktree-dev|run-desktop-tauri|install-ios-|ios-device-selection)|vite.renderer.config.ts$|package.json$|pnpm-lock.yaml$)/.test(file) && existsSync(file));
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint(), 'iOS/Desktop Hosted evidence is stale');
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every(check => check.status === 'passed'));
  console.log('iOS/Desktop Hosted evidence matches the current integration source.');
  process.exit(0);
}
function option(name) {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], `Required: ${name}`);
  return process.argv[index + 1];
}
const simulator = option('--simulator');
const bundle = option('--ios-bundle');
assert.match(bundle, /^cc\.drifting\.client\.hosted-lab\./, 'Use an isolated iOS lab');
const descriptors = Object.fromEntries(['desktop', 'ios'].map(side => [side, JSON.parse(readFileSync(option(`--${side}-session`), 'utf8'))]));
assert.notEqual(descriptors.desktop.port, descriptors.ios.port);
const sourceSha256 = fingerprint();
const checks = [];
async function command(side, command, input) {
  const session = descriptors[side];
  assert.ok(Number.isSafeInteger(session.port) && session.port > 1024 && session.port < 65536);
  const response = await fetch(`http://127.0.0.1:${session.port}/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, input }), signal: AbortSignal.timeout(35_000),
  });
  const body = await response.json();
  assert.ok(response.ok && body.ok !== false && !body.error, `${side} ${command} failed`);
  return body.result;
}
const evaluate = (side, expression) => command(side, 'evaluate', { expression });
const text = side => evaluate(side, `document.querySelector(${JSON.stringify(side === 'ios' ? '.ProseMirror' : '.page__body .ProseMirror')})?.innerText.trim() ?? null`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// An idle foreground client polls every 60 seconds; allow a complete interval
// plus the real HTTPS transfer, without forcing a manual sync command.
async function waitFor(description, read, accept, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) { lastError = error; }
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}`, { cause: lastError });
}
function passed(name, detail = {}) { checks.push({ name, status: 'passed', ...detail }); console.log(`Passed: ${name}`); }
async function append(side, value) {
  // Use the browser's contenteditable editing operation. Assigning textContent
  // can alter a read-mode mobile DOM without committing an editor transaction.
  const selector = side === 'ios' ? '.ProseMirror' : '.page__body .ProseMirror';
  const inserted = await evaluate(side, `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor?.isContentEditable) return false;
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return document.execCommand('insertText', false, ${JSON.stringify(value)});
  })()`);
  assert.equal(inserted, true, `${side} browser edit rejected`);
  await delay(200);
}
const initialDesktop = await text('desktop');
assert.equal(await evaluate('ios', `Boolean(document.querySelector('script[src*="/assets/"]'))`), true,
  'Use a bundled iOS renderer for cold-start acceptance');
assert.ok(initialDesktop?.startsWith('桌面首段：海风吹过码头，这是跨设备同步的合成测试稿。'), 'Open the synthetic acceptance chapter in both apps');
await waitFor('initial project and prose restoration', () => text('ios'), value => value === initialDesktop);
passed('Desktop project and Chinese prose restored on iOS through Hosted');
// Headless macOS windows can be occluded. Exercise the same foreground wake
// listener as a window focus, without claiming native focus/keyboard input.
for (const side of ['desktop', 'ios']) await evaluate(side, "(() => { window.dispatchEvent(new Event('focus')); return true; })()");
const marker = randomUUID().slice(0, 8);
const desktopAddition = `\n桌面实时追加 ${marker}。`;
await append('desktop', desktopAddition);
const desktopValue = await waitFor('desktop input committed to editor', () => text('desktop'), value => value?.includes(desktopAddition.trim()));
await waitFor('desktop to iOS live sync', () => text('ios'), value => value === desktopValue);
passed('Desktop edits automatically reach the open iOS editor');
const iosAddition = `\niOS 实时追加 ${marker}。`;
await append('ios', iosAddition);
const iosValue = await waitFor('iOS input committed to editor', () => text('ios'), value => value?.includes(iosAddition.trim()));
await waitFor('iOS to desktop live sync', () => text('desktop'), value => value === iosValue);
passed('iOS edits automatically reach the open desktop editor');
// End a real native simulator process, not merely a renderer reload.
execFileSync('xcrun', ['simctl', 'terminate', simulator, bundle]);
const stoppedAddition = `\niOS 关闭期间的桌面追加 ${marker}。`;
await append('desktop', stoppedAddition);
const stoppedValue = await waitFor('desktop edit while iOS stopped', () => text('desktop'), value => value?.includes(stoppedAddition.trim()));
await delay(5000);
execFileSync('xcrun', ['simctl', 'launch', simulator, bundle]);
await waitFor('reopen iOS chapter without login', async () => {
  const current = await text('ios');
  // The mobile home keeps a dormant paper editor mounted with empty content.
  // Continue navigating until the restored chapter actually contains prose.
  if (current) return current;
  const candidates = await evaluate('ios', `Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => b.innerText.trim())`);
  const target = ['托管同步 iOS 验收 1001', 'New Chapter'].find(label => candidates.some(candidate => candidate.includes(label)));
  if (target) await command('ios', 'tap', { locator: { kind: 'role', role: 'button', name: target, exact: false } });
  return null;
}, value => value?.includes(iosAddition.trim()), 180_000);
passed('iOS native cold restart retains its session and previously synced prose');
await waitFor('catch up after native restart', () => text('ios'), value => value === stoppedValue);
passed('Restarted iOS catches up with desktop edits made while it was stopped');
assert.equal(sourceSha256, fingerprint(), 'Integration source changed during acceptance');
const finalText = await text('ios');
writeFileSync(reportPath, `${JSON.stringify({
  kind: 'hosted-ios-desktop-native', generatedAt: new Date().toISOString(), sourceSha256,
  sourceScope: 'Hosted integration, shared platform, native transport, launch and build configuration',
  status: 'passed', synthetic: true, service: 'operator-configured HTTPS VPS',
  clients: ['macOS Tauri isolated worktree build', 'iOS Tauri iPhone Simulator build'], checks,
  finalProse: { sha256: createHash('sha256').update(finalText).digest('hex'), characters: finalText.length },
  boundaries: { transport: 'real HTTPS and native Hosted object transport', input: 'synthetic DOM input through actual ProseMirror editors',
    renderer: 'desktop development renderer; iOS bundled development renderer with private loopback debug instrumentation',
    foregroundWake: 'synthetic DOM focus event',
    storage: 'independent native SQLite/Yjs libraries', iosRestart: 'native process termination and relaunch',
    physicalDevice: 'not claimed', physicalIme: 'not claimed', networkOutage: 'not claimed', backgroundExecution: 'not claimed', releaseSigning: 'not claimed' },
}, null, 2)}\n`);
console.log(`Wrote ${reportPath}`);
