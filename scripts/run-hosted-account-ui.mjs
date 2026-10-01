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
  'src/renderer/features/settings/panels/HostedAccountDialog.tsx',
  'src/renderer/features/settings/panels/HostedPasswordDialog.tsx',
  'src/renderer/features/settings/panels/HostedAvatarCropDialog.tsx',
  'src/renderer/components/ui/Modal.tsx',
  'src/renderer/components/ui/DialogContent.tsx',
  'src/styles/ui-controls.css',
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
  assert.equal(report.checks.length, 14);
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
      `(() => { const scope = document.querySelector('.set-account-modal') ?? document; const button = [...scope.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}); button.focus(); button.click(); })()`,
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
  const pressKey = (key, code, keyCode, modifiers = 0) =>
    client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    });
  const screenshot = async (name) => {
    mkdirSync('.local-data/hosted-acceptance', { recursive: true });
    writeFileSync(
      `.local-data/hosted-acceptance/${name}.png`,
      Buffer.from(
        (await client.Page.captureScreenshot({ captureBeyondViewport: true })).data,
        'base64',
      ),
    );
  };
  await evaluate(
    `window.__releasedAvatarUrls = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.__releasedAvatarUrls.push(url); revoke(url); };`,
  );
  const chooseAvatar = () =>
    evaluate(
      `(async () => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400; const context = canvas.getContext('2d'); for (const [x, color] of [[0, '#ff0000'], [200, '#00ff00'], [400, '#0000ff']]) { context.fillStyle = color; context.fillRect(x, 0, 200, 400); } const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const files = new DataTransfer(); files.items.add(new File([blob], 'synthetic.png', { type: 'image/png' })); const input = document.querySelector('input[type=file]'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
  await chooseAvatar();
  await until("document.querySelector('.set-avatar-crop img')?.complete");
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.set-account-modal')).position"),
    'fixed',
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.set-account-modal .modal-card').getBoundingClientRect().width",
    ),
    440,
  );
  assert.equal(await evaluate("document.querySelector('.set-account-fields img')"), null);
  await click('取消');
  await until("!document.querySelector('.set-account-modal')");
  assert.equal(await evaluate('window.__releasedAvatarUrls.length'), 1);
  assert.equal(await evaluate('document.activeElement.textContent'), '选择图片');
  assert.equal(await evaluate("document.querySelector('.set-account-fields img')"), null);
  checks.push(
    'selecting an image opens a draft crop; cancel preserves the avatar, releases its URL and restores focus',
  );
  await chooseAvatar();
  await until("document.querySelector('.set-avatar-crop img')?.complete");
  await setInput('hosted-avatar-zoom', '2');
  await until("document.querySelector('.set-avatar-crop img').style.width === '300%'");
  const box = await evaluate(
    "(() => { const b = document.querySelector('.set-avatar-crop').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width }; })()",
  );
  await client.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await client.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: box.x - box.width,
    y: box.y,
    button: 'left',
    buttons: 1,
  });
  await client.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: box.x - box.width,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await until("document.querySelector('.set-avatar-crop img').style.left === '-200%'");
  await pressKey('ArrowRight', 'ArrowRight', 39);
  await until("parseFloat(document.querySelector('.set-avatar-crop img').style.left) > -200");
  await pressKey('ArrowLeft', 'ArrowLeft', 37);
  await until("document.querySelector('.set-avatar-crop img').style.left === '-200%'");
  await screenshot('avatar-crop-ui');
  checks.push(
    'pointer dragging, zoom slider and keyboard panning adjust the crop without exposing blank edges',
  );
  await click('使用此头像');
  await until("!document.querySelector('.set-account-modal')");
  await until("document.querySelector('.set-account-fields img')?.complete");
  assert.equal(
    await evaluate("document.querySelector('.set-account-fields img').naturalWidth"),
    256,
  );
  assert.equal(await evaluate('window.__releasedAvatarUrls.length'), 2);
  await click('保存资料');
  await until("document.querySelector('.set-rail__who img')?.complete");
  const pixel = await evaluate(
    "(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256; const ctx = canvas.getContext('2d'); ctx.drawImage(document.querySelector('.set-rail__who img'), 0, 0); return [...ctx.getImageData(128, 128, 1, 1).data]; })()",
  );
  assert(
    pixel[2] > 220 && pixel[0] < 30 && pixel[1] < 30,
    'Saved crop must contain the user-selected blue region, not the original green center',
  );
  checks.push('confirmed crop saves the selected image pixels as a bounded 256px JPEG');
  await click('移除');
  await click('保存资料');
  await until("!document.querySelector('.set-rail__who img')");
  checks.push('avatar removal restores initials');
  assert.equal(await evaluate("document.querySelectorAll('input[type=password]').length"), 0);
  await click('修改密码');
  await until("document.querySelector('#hosted-current-password')");
  assert.equal(
    await evaluate("document.querySelector('.set-account-modal').parentElement === document.body"),
    true,
  );
  assert.equal(await evaluate('document.activeElement.id'), 'hosted-current-password');
  await screenshot('password-dialog-ui');
  checks.push(
    'password fields mount only inside a focused portal dialog after clicking Change password',
  );
  await setInput('hosted-current-password', 'discard-on-cancel');
  await click('取消');
  await until("!document.querySelector('input[type=password]')");
  assert.equal(await evaluate('document.activeElement.textContent'), '修改密码');
  await click('修改密码');
  await until("document.querySelector('#hosted-current-password')");
  assert.equal(await evaluate("document.querySelector('#hosted-current-password').value"), '');
  await pressKey('Escape', 'Escape', 27);
  await until("!document.querySelector('.set-account-modal')");
  assert.equal(await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.parentEscapes'), 0);
  assert.equal(await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.passwordWrites'), 0);
  checks.push('cancel and Escape discard passwords and close only the child dialog');
  await click('修改密码');
  await until("document.querySelector('#hosted-current-password')");
  await evaluate(
    "[...document.querySelectorAll('.set-account-modal button')].find(b => b.textContent === '取消').focus()",
  );
  await pressKey('Tab', 'Tab', 9);
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), '关闭');
  await pressKey('Tab', 'Tab', 9, 8);
  assert.equal(await evaluate('document.activeElement.textContent'), '取消');
  checks.push('Tab and Shift-Tab stay within the account dialog');
  await setInput('hosted-current-password', 'old-password');
  await setInput('hosted-new-password', 'new-password');
  await setInput('hosted-confirm-password', 'different-password');
  await click('修改密码');
  await until(
    "document.querySelector('.set-account-modal [role=alert]')?.textContent.includes('不一致')",
  );
  assert.equal(await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.passwordWrites'), 0);
  checks.push('mismatched confirmation is rejected inside the dialog before dispatch');
  await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.failNextPassword = true');
  await setInput('hosted-confirm-password', 'new-password');
  await click('修改密码');
  await until(
    "document.querySelector('.set-account-modal [role=alert]')?.textContent.includes('不正确')",
  );
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('input[type=password]')].map(input => input.value)",
    ),
    ['', '', ''],
  );
  checks.push(
    'server rejection leaves the dialog open with a local error and cleared secret inputs',
  );
  await setInput('hosted-current-password', 'old-password');
  await setInput('hosted-new-password', 'new-password');
  await setInput('hosted-confirm-password', 'new-password');
  await evaluate('window.__HOSTED_ACCOUNT_UI__.observations.holdPassword = true');
  await click('修改密码');
  await until("document.querySelector('.set-account-modal fieldset').disabled");
  await pressKey('Escape', 'Escape', 27);
  assert.equal(await evaluate("Boolean(document.querySelector('.set-account-modal'))"), true);
  await evaluate('window.__HOSTED_ACCOUNT_UI__.releasePassword()');
  await until(
    "!document.querySelector('.set-account-modal') && document.querySelector('[role=status]')?.textContent.includes('密码已修改')",
  );
  assert.equal(await evaluate("document.querySelectorAll('input[type=password]').length"), 0);
  checks.push(
    'pending password writes cannot be dismissed; success closes the dialog and removes secrets',
  );
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
