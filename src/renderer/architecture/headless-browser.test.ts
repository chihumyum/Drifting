import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
function run(code: string) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { spawn } from 'node:child_process';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { resolveHeadlessBrowser, launchHeadlessBrowser, stopBrowserProcess, withDeadline, closeHeadlessSession } from './scripts/renderer-headless-browser.mjs';
    ${code}
  `], { encoding: 'utf8', timeout: 12000 });
}
it('prefers installed Chrome over the Linux Chromium wrappers and honors explicit overrides', () => {
  expect(() => run(`
    assert.equal(resolveHeadlessBrowser(undefined, p => p.startsWith('/usr/bin/')), '/usr/bin/google-chrome');
    assert.equal(resolveHeadlessBrowser('/explicit/browser', () => true), '/explicit/browser');
    assert.throws(() => resolveHeadlessBrowser('/missing', () => false));
  `)).not.toThrow();
});
it('returns immediately for a child already terminated by a signal', () => {
  expect(() => run(`
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
    const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done;
    assert.equal(child.exitCode, null); assert(child.signalCode);
    await withDeadline(stopBrowserProcess(child), 100, 'already-exited cleanup');
  `)).not.toThrow();
});
it('escalates a real SIGTERM-resistant child and observes its SIGKILL exit', () => {
  expect(() => run(`
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)']);
    await new Promise(resolve => child.stdout.once('data', resolve));
    await stopBrowserProcess(child, 100); assert.equal(child.signalCode, 'SIGKILL');
  `)).not.toThrow();
});
it('captures launch errors and bounded stderr, sanitizing the disposable profile path', () => {
  expect(() => run(`
    const profile = path.join(mkdtempSync(path.join(tmpdir(), 'drifting-launch-test-')), 'profile');
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, stderr: new EventEmitter(), kill(signal) { this.signalCode = signal; this.emit('exit', null, signal); return true; } });
    try {
      await assert.rejects(launchHeadlessBrowser({ executable: '/fake/chrome', profile, launchTimeoutMs: 60, spawnProcess() {
        setTimeout(() => child.stderr.emit('data', 'synthetic startup error ' + profile), 5); return child;
      } }), error => error.message.includes('synthetic startup error') && error.message.includes('<isolated-profile>') && !error.message.includes(profile));
      assert.equal(child.signalCode, 'SIGTERM');
    } finally { rmSync(path.dirname(profile), { recursive:true, force:true }); }
  `)).not.toThrow();
});
it('fails promptly on missing executables and bounds ordinary asynchronous phases', () => {
  expect(() => run(`
    const profile = mkdtempSync(path.join(tmpdir(), 'drifting-missing-browser-'));
    try { await assert.rejects(launchHeadlessBrowser({ executable:'/missing/drifting-browser', profile }), /ENOENT/); }
    finally { rmSync(profile, {recursive:true,force:true}); }
    await assert.rejects(withDeadline(new Promise(()=>{}), 10, 'synthetic phase'), /synthetic phase timed out/);
  `)).not.toThrow();
});
it('closes all resources even if one close operation fails', () => {
  expect(() => run(`
    const calls=[]; await assert.rejects(closeHeadlessSession({ client:{close:async()=>{throw Error('client failed')}}, browser:{close:async()=>calls.push('browser')}, server:{httpServer:{close:callback=>{calls.push('server');callback()},closeAllConnections:()=>calls.push('connections')}} }), /client failed/);
    assert.deepEqual(calls, ['browser','server','connections']);
  `)).not.toThrow();
});
