import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import CDP from 'chrome-remote-interface';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = 'docs/hosted-sync/acceptance/account-ui.json';
const sources = [
  'scripts/run-hosted-account-ui.mjs',
  'scripts/renderer-hosted-account-ui.html',
  'scripts/renderer-hosted-account-ui.tsx',
  'src/renderer/features/settings/panels/HostedAccountDetails.tsx',
  'src/renderer/lib/hosted-account.ts',
  'src/renderer/components/ui/AccountAvatar.tsx',
  'src/renderer/features/settings/SettingsPrimitives.tsx',
  'src/styles/settings.css',
  'src/renderer/locales/en.json',
  'src/renderer/locales/zh-CN.json',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of sources) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint());
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.length, 8);
  console.log('Hosted account browser evidence matches current source.');
  process.exit(0);
}
const before = fingerprint();
const chrome =
  process.env.DRIFTING_PERF_CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync);
assert(chrome);
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-account-ui-'));
let browser, server, client;
try {
  Object.assign(process.env, {
    VITE_LOCAL_ONLY_MODE: 'true',
    VITE_REQUIRE_AUTH: 'false',
    VITE_API_BASE_URL: 'http://localhost:3000',
  });
  server = await createServer({
    root,
    configFile: path.join(root, 'vite.renderer.config.ts'),
    envDir: false,
    logLevel: 'error',
    cacheDir: path.join(temporary, 'vite'),
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      hmr: false,
      open: false,
      warmup: { clientFiles: [] },
    },
  });
  await server.listen();
  const profile = path.join(temporary, 'chrome');
  browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) {
    assert.equal(browser.exitCode, null);
    await delay(100);
  }
  assert(existsSync(portFile));
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  client = await CDP({ port, target: await CDP.New({ port }) });
  await client.Page.enable();
  await client.Runtime.enable();
  const errors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => {
    errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  await client.Emulation.setDeviceMetricsOverride({
    width: 1000,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 500; i++) {
      assert.deepEqual(errors, []);
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(20);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const setInput = (id, value) =>
    evaluate(
      `(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const click = (label) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`,
    );
  const checks = [];
  await client.Page.navigate({
    url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-hosted-account-ui.html`,
  });
  await until("document.querySelector('#hosted-name')");
  await setInput('hosted-name', '修改后的昵称');
  await click('保存资料');
  await until("document.querySelector('#saved-name').textContent === '修改后的昵称'");
  checks.push('saved name immediately updates account display');
  await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.failNext = true');
  await setInput('hosted-name', '未保存草稿');
  await click('保存资料');
  await until("document.querySelector('[role=alert]')");
  assert.equal(await evaluate("document.querySelector('#saved-name').textContent"), '修改后的昵称');
  assert.equal(await evaluate("document.querySelector('#hosted-name').value"), '未保存草稿');
  await click('取消');
  checks.push('failed save preserves the saved profile and editable draft; cancel restores it');
  await evaluate(
    `(async () => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400; const context = canvas.getContext('2d'); context.fillStyle = '#6480a0'; context.fillRect(0, 0, 600, 400); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const files = new DataTransfer(); files.items.add(new File([blob], 'synthetic.png', { type: 'image/png' })); const input = document.querySelector('input[type=file]'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await until("document.querySelector('.set-account-fields img')?.complete");
  assert.equal(
    await evaluate("document.querySelector('.set-account-fields img').naturalWidth"),
    256,
  );
  await click('保存资料');
  await until("document.querySelector('.set-rail__who img')?.complete");
  checks.push('real PNG decoding, square crop, bounded JPEG encoding, preview and saved avatar');
  await click('移除');
  await click('保存资料');
  await until("!document.querySelector('.set-rail__who img')");
  checks.push('avatar removal restores initials');
  await setInput('hosted-current-password', 'old-password');
  await setInput('hosted-new-password', 'new-password');
  await setInput('hosted-confirm-password', 'different-password');
  await click('修改密码');
  await until("document.querySelector('[role=alert]')?.textContent.includes('不一致')");
  assert.equal(await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.passwordWrites'), 0);
  checks.push('mismatched confirmation is rejected before dispatch');
  await setInput('hosted-confirm-password', 'new-password');
  await click('修改密码');
  await until("document.querySelector('[role=status]')?.textContent.includes('密码已修改')");
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('input[type=password]')].map(input => input.value)",
    ),
    ['', '', ''],
  );
  checks.push('successful password change clears all secret inputs');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  mkdirSync('.local-data/hosted-acceptance', { recursive: true });
  writeFileSync(
    '.local-data/hosted-acceptance/account-ui.png',
    Buffer.from(
      (await client.Page.captureScreenshot({ captureBeyondViewport: true })).data,
      'base64',
    ),
  );
  checks.push('desktop form fits its viewport');
  await evaluate('window.__HOSTED_ACCOUNT_UI__.offline()');
  await until("document.querySelector('fieldset').disabled");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('input, button')].every(node => node.matches(':disabled'))",
    ),
    true,
  );
  checks.push('offline account controls cannot submit mutations');
  assert.equal(fingerprint(), before, 'Source changed during UI acceptance');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        kind: 'hosted-account-browser-ui',
        generatedAt: new Date().toISOString(),
        sourceSha256: before,
        status: 'passed',
        synthetic: true,
        checks,
        boundary:
          'Real React forms and browser image pipeline with synthetic account actions; HTTP, native interaction and production deployment are separate gates.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`${checks.length} Hosted account browser checks passed.`);
} finally {
  if (client) await client.close();
  if (server) await server.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await delay(200);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  rmSync(temporary, { recursive: true, force: true });
}
