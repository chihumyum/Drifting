import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import CDP from 'chrome-remote-interface';
import { launchHeadlessBrowser, withDeadline } from './renderer-headless-browser.mjs';
import { sentrySecurityOverride } from './sentry-environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/acceptance/sentry-browser.json');
const fixture = 'scripts/renderer-sentry-acceptance.ts';
const sources = [
  'scripts/run-sentry-browser.mjs', fixture, 'scripts/renderer-sentry-acceptance.html',
  'scripts/renderer-headless-browser.mjs', 'scripts/sentry-environment.mjs',
  'package.json', 'pnpm-lock.yaml', 'docs/sentry-observability.md',
  'src/renderer/lib/config.ts', 'src/renderer/lib/vite-runtime-env.ts',
  'src/renderer/services/diagnostics/crash-reporter.ts',
  'src/renderer/services/diagnostics/crash-sanitize.ts',
  'src/renderer/services/diagnostics/sentry-policy.ts',
  'src/renderer/services/diagnostics/sentry-reporter.ts',
].sort();
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of sources) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return `sha256:${hash.digest('hex')}`;
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint(), 'Sentry browser evidence is stale');
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.length, 9);
  console.log('Sentry minified-browser evidence matches current source; live Sentry and Mac remain separate gates.');
  process.exit(0);
}

const before = fingerprint();
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-sentry-browser-'));
const originalCwd = process.cwd();
const checks = [];
const attempts = [];
const preflights = [];
let browser, client, collector, server, currentDist, environment;
let responseStatus = 200;
let appOrigin;
let mapping;
const packets = () => attempts.filter(item => item.status === 200).flatMap(item => item.items);
const events = () => packets().filter(item => item.type === 'event').map(item => item.payload);
const parseEnvelope = text => {
  const lines = text.trim().split('\n');
  const envelope = JSON.parse(lines.shift());
  const items = [];
  while (lines.length) {
    const header = JSON.parse(lines.shift());
    const payload = JSON.parse(lines.shift());
    items.push({ type: header.type, payload });
  }
  return { envelope, items };
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = async server => {
  if (!server) return;
  await withDeadline(new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  }), 5000, 'Synthetic HTTP receiver close');
};

try {
  // Synthetic private key exists only in the temporary directory and is removed in finally.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', path.join(temporary, 'receiver.key'), '-out', path.join(temporary, 'receiver.crt')], { stdio: 'ignore' });
  collector = createHttpsServer({ key: readFileSync(path.join(temporary, 'receiver.key')),
    cert: readFileSync(path.join(temporary, 'receiver.crt')) }, (request, response) => {
    if (request.headers.origin !== appOrigin || !request.url.startsWith('/api/42/envelope/')) {
      response.writeHead(403); response.end(); return;
    }
    response.setHeader('Access-Control-Allow-Origin', appOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      preflights.push(request.url);
      response.writeHead(204); response.end(); return;
    }
    let text = '';
    request.on('data', bytes => { text += bytes; if (text.length > 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      attempts.push({ ...parseEnvelope(text), status: responseStatus, headers: request.headers, text });
      response.writeHead(responseStatus, { 'Content-Type': 'application/json' }); response.end('{}');
    });
  });
  await listen(collector);
  const receiverOrigin = `https://127.0.0.1:${collector.address().port}`;
  const dsn = `${receiverOrigin.replace('https://', 'https://00000000000000000000000000000000@')}/42`;
  server = createHttpServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const relative = pathname === '/' ? 'scripts/renderer-sentry-acceptance.html' : pathname.slice(1);
    const file = path.resolve(currentDist ?? temporary, relative);
    if (!currentDist || !file.startsWith(`${currentDist}${path.sep}`) || file.endsWith('.map') || !existsSync(file)) {
      response.writeHead(404); response.end(); return;
    }
    const mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
    const base = { csp: "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'",
      devCsp: "connect-src 'self'" };
    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store',
      'Content-Security-Policy': sentrySecurityOverride(base, environment).csp });
    response.end(readFileSync(file));
  });
  await listen(server);
  appOrigin = `http://127.0.0.1:${server.address().port}`;

  async function buildFixture(localOnly) {
    const outDir = path.join(temporary, localOnly ? 'local' : 'hosted');
    environment = { VITE_LOCAL_ONLY_MODE: String(localOnly), VITE_SENTRY_DSN: dsn };
    const metadata = { ...environment, VITE_API_BASE_URL: appOrigin, VITE_REQUIRE_AUTH: 'false',
      VITE_SENTRY_RELEASE: 'drifting@synthetic-browser+acceptance', VITE_SENTRY_ENVIRONMENT: 'acceptance' };
    // No repository dotenv file or real account token is consumed by the plugin.
    process.chdir(temporary);
    try {
      await build({ root, configFile: false, envDir: false, logLevel: 'error',
        define: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])),
        plugins: localOnly ? [] : [sentryVitePlugin({ org: 'synthetic', project: 'client', url: receiverOrigin,
          authToken: 'synthetic-only', telemetry: false,
          release: { name: metadata.VITE_SENTRY_RELEASE, create: false, finalize: false },
          sourcemaps: { disable: 'disable-upload' }, silent: true,
        })],
        build: { outDir, emptyOutDir: true, sourcemap: localOnly ? false : 'hidden', minify: true,
          rollupOptions: { input: path.join(root, 'scripts/renderer-sentry-acceptance.html') } },
      });
    } finally { process.chdir(originalCwd); }
    currentDist = outDir;
  }
  await buildFixture(false);
  browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'chromium') });
  client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
  await client.Page.enable(); await client.Runtime.enable(); await client.Network.enable(); await client.Security.enable();
  // Only this disposable browser target trusts the ephemeral receiver certificate.
  await client.Security.setIgnoreCertificateErrors({ ignore: true });
  await client.Fetch.enable({ patterns: [{ urlPattern: '*' }] });
  client.Fetch.requestPaused(async ({ requestId, request }) => {
    const origin = new URL(request.url).origin;
    if (origin === appOrigin || origin === receiverOrigin) await client.Fetch.continueRequest({ requestId });
    else await client.Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' });
  });
  const requests = [];
  const unexpectedErrors = [];
  client.Network.requestWillBeSent(({ request }) => requests.push(request.url));
  client.Runtime.exceptionThrown(({ exceptionDetails }) => {
    const description = exceptionDetails.exception?.description ?? exceptionDetails.text;
    if (!/synthetic-browser-(?:failure|rejection)/.test(description)) unexpectedErrors.push(description);
  });
  const evaluate = async expression => {
    const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (condition, label) => {
    for (let index = 0; index < 200; index++) {
      assert.deepEqual(unexpectedErrors, [], 'Unexpected browser exception');
      if (await condition()) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const api = 'window.__SENTRY_BROWSER_ACCEPTANCE__';
  const load = async () => {
    await client.Page.navigate({ url: `${appOrigin}/` });
    await until(() => evaluate(`Boolean(${api}?.ready)`), 'fixture boot');
  };
  await load();
  await evaluate(`${api}.log(); ${api}.crash()`);
  await until(() => events().some(event => event.tags?.kind === 'renderer-error'), 'uncaught JS error HTTP delivery');
  const error = events().find(event => event.tags?.kind === 'renderer-error');
  assert.equal(error.release, 'drifting@synthetic-browser+acceptance');
  assert.equal(events().filter(event => event.tags?.kind === 'renderer-error').length, 1);
  assert(preflights.length > 0, 'Real browser CORS preflight must reach receiver');
  checks.push('uncaught minified JS error reaches loopback HTTPS once through real SDK and CORS');

  const frame = error.exception.values[0].stacktrace.frames.findLast(frame => frame.filename.includes('/assets/'));
  assert(frame, 'Privacy-filtered event must retain bundled frame');
  const asset = path.join(currentDist, new URL(frame.filename).pathname);
  const sourceMap = JSON.parse(readFileSync(`${asset}.map`, 'utf8'));
  const original = originalPositionFor(new TraceMap(sourceMap), { line: frame.lineno, column: frame.colno - 1 });
  const expectedLine = readFileSync(path.join(root, fixture), 'utf8').split('\n').findIndex(line => line.includes('throw new TypeError(')) + 1;
  assert(original.source.endsWith(fixture)); assert.equal(original.line, expectedLine);
  assert(error.debug_meta.images.some(image => image.code_file === frame.filename && image.debug_id === sourceMap.debug_id));
  assert(!readFileSync(asset, 'utf8').includes('sourceMappingURL='), 'Hidden map must not be advertised in JS');
  assert.equal((await fetch(`${appOrigin}${new URL(frame.filename).pathname}.map`)).status, 404);
  mapping = { source: fixture, line: original.line, column: original.column, matchingDebugId: true };
  checks.push('emitted Debug ID and private source map resolve minified frame to exact original TypeScript line');

  await evaluate(`${api}.flush()`);
  await until(() => packets().some(item => item.type === 'log'), 'structured log delivery');
  assert(JSON.stringify(error.breadcrumbs).includes('update-download-completed'));
  assert(JSON.stringify(packets()).includes('update-download-completed'));
  await evaluate(`console.warn('synthetic-private-console-marker'); ${api}.flush()`);
  for (const request of attempts) {
    for (const marker of ['synthetic-private-manuscript-marker', 'synthetic-private-local-storage-marker',
      'synthetic-private-cookie-marker', 'synthetic-bearer-must-not-be-sent', 'synthetic-private-console-marker']) {
      assert(!request.text.includes(marker));
    }
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
  }
  checks.push('real network envelopes omit manuscript, local state, console, cookie, bearer and referrer');
  checks.push('structured operation log and safe error breadcrumbs survive minification');

  await evaluate(`${api}.rejection()`);
  await until(() => events().some(event => event.tags?.kind === 'unhandled-rejection'), 'unhandled rejection');
  checks.push('unhandled promise rejection is captured by the production listener');

  const sentBeforeOptOut = attempts.length;
  await evaluate(`${api}.consent(false); ${api}.integrity('synthetic-opted-out'); ${api}.log(); ${api}.flush()`);
  await delay(100);
  assert.equal(attempts.length, sentBeforeOptOut); assert.equal(await evaluate(`${api}.queueLength()`), 0);
  await evaluate(`${api}.consent(true)`);
  checks.push('opt-out prevents new uploads and queue entries after SDK initialization');

  await client.Network.emulateNetworkConditions({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await until(() => evaluate('navigator.onLine === false'), 'offline browser state');
  await evaluate(`${api}.integrity('synthetic-offline-error')`);
  assert.equal(await evaluate(`${api}.queueLength()`), 1);
  await client.Network.emulateNetworkConditions({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(() => events().some(event => event.fingerprint?.[0] === 'integrity:synthetic-offline-error'), 'online-event retry');
  await until(() => evaluate(`${api}.queueLength() === 0`), 'offline queue drained');
  checks.push('error first observed offline is retained and automatically sent on online event');

  responseStatus = 503;
  await evaluate(`${api}.integrity('synthetic-retry-error'); ${api}.flush()`);
  const failed = attempts.find(item => item.status === 503);
  assert(failed); assert.equal(await evaluate(`${api}.queueLength()`), 1);
  responseStatus = 200;
  await evaluate(`${api}.flush()`);
  assert.equal(await evaluate(`${api}.queueLength()`), 0);
  assert(attempts.some(item => item.status === 200 && item.envelope.event_id === failed.envelope.event_id));
  checks.push('HTTP 503 retains report and successful retry reuses its event ID');

  await buildFixture(true);
  const received = attempts.length;
  const requestOffset = requests.length;
  await load();
  await evaluate(`${api}.crash(); ${api}.log(); ${api}.integrity('synthetic-local-only')`);
  await delay(150);
  assert.equal(attempts.length, received); assert.equal(await evaluate(`${api}.queueLength()`), 0);
  assert(!requests.slice(requestOffset).some(url => /sentry-reporter[^/]*\.js/.test(url)));
  assert.deepEqual(unexpectedErrors, []);
  checks.push('local-only production fixture ignores inherited DSN and never loads reporting SDK');

  assert.equal(fingerprint(), before, 'Sources changed during browser acceptance');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ sourceSha256: before, status: 'passed',
    browser: 'Chromium', build: 'minified-production-fixture', transport: 'real-loopback-https-with-ephemeral-certificate',
    sourceMap: mapping, checks, limitations: ['synthetic receiver; no Sentry account or cloud upload',
      'Chromium evidence does not establish packaged Mac WebView, native crash symbols or email delivery'] }, null, 2)}\n`);
  console.log(`Sentry browser acceptance: ${checks.length} checks passed; original TypeScript source line verified.`);
} finally {
  process.chdir(originalCwd);
  if (client) await client.close().catch(() => {});
  if (browser) await browser.close();
  await close(server); await close(collector);
  rmSync(temporary, { recursive: true, force: true });
}
