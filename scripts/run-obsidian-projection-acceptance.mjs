#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = 'docs/agent-runtime/acceptance/obsidian-projection.json';
const sourceFiles = [
  'scripts/run-obsidian-projection-acceptance.mjs',
  'src/renderer/services/export/obsidian-markdown.ts',
  'src/renderer/services/export/readable-markdown-projection.ts',
  'src/renderer/services/export/relational-markdown.prose.ts',
  'src/renderer/domain/book-act.ts',
  'src/renderer/services/export/relational-markdown.service.ts',
  'src/renderer/services/export/relational-markdown.local-source.ts',
  'src/renderer/services/export/relational-markdown.acceptance.test.ts',
  'src/renderer/services/markdown-projection.service.ts',
  'src/renderer/services/asset-store.service.ts',
  'src/renderer/lib/agent/serialize.ts',
  'src/renderer/lib/agent/markdown-prose-adapter.ts',
  'src/renderer/lib/agent/prose-read-view.ts',
  'src/renderer/lib/location-link.ts',
  'src/renderer/platform/contracts.ts', 'src/renderer/platform/types.ts', 'src/renderer/platform/tauri.ts',
  'src-tauri/src/markdown_projection.rs', 'crates/drifting-core/src/asset_store.rs',
  'docs/local-data-export.md', 'docs/location-links.md',
];
function fingerprint() {
  const hash = createHash('sha256');
  for (const file of sourceFiles) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}

async function runObsidian(binary, fixture, mode) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-obsidian-'));
  const profile = path.join(temporary, 'profile');
  const vault = path.join(temporary, 'vault');
  const prefix = mode === 'nested' ? 'Imported/Drifting/' : '';
  const manifest = JSON.parse(readFileSync(path.join(fixture, '.drifting/manifest.json'), 'utf8'));
  const mapped = Object.fromEntries(manifest.documents.map(document => [document.key, document]));
  mkdirSync(profile, { recursive: true });
  mkdirSync(vault, { recursive: true });
  cpSync(fixture, path.join(vault, prefix), { recursive: true });
  // Exercise native-writer permissions, including a writable vault root for Obsidian's own settings.
  function makeReadOnly(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) makeReadOnly(file);
      else chmodSync(file, 0o400);
    }
  }
  makeReadOnly(vault);
  if (prefix) {
    const decoy = path.join(vault, mapped['node:node-update-0002'].path);
    mkdirSync(path.dirname(decoy), { recursive: true });
    writeFileSync(decoy, '# Wrong vault-root target\n');
  }
  writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({
    vaults: { '0123456789abcdef': { path: vault, ts: Date.now(), open: true } },
  }));
  const port = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
  });
  const child = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-gpu'], { stdio: 'ignore' });
  let client;
  try {
    let targets = [];
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error('Isolated Obsidian exited before opening the synthetic vault');
      try { targets = await CDP.List({ port }); } catch { /* The debug endpoint starts after Electron. */ }
      if (targets.some(target => target.type === 'page')) break;
      await delay(250);
    }
    assert(targets.some(target => target.type === 'page'), 'Obsidian debug page unavailable');
    client = await CDP({ target: targets.find(target => target.type === 'page'), port });
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? 'Obsidian evaluation failed');
      return result.result.value;
    };
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate('Boolean(window.app?.vault?.getMarkdownFiles().length && window.app.vault.getMarkdownFiles().every(file => window.app.metadataCache.getFileCache(file)))')) break;
      await delay(250);
    }
    const result = await evaluate(`(async () => {
      const a = window.app, prefix = ${JSON.stringify(prefix)}, mapped = ${JSON.stringify(mapped)};
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const checks = [];
      const pass = (name, details) => checks.push({ name, status: 'passed', ...details });
      const cache = path => a.metadataCache.getFileCache(a.vault.getAbstractFileByPath(path));
      const target = prefix + mapped['node:node-update-0002'].path;
      const body = prefix + mapped['element:element-0001'].path;
      const index = body;
      let links = 0, references = 0;
      const files = a.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix));
      for (const file of files) {
        const metadata = cache(file.path);
        assert(metadata, 'Metadata missing for ' + file.path);
        for (const link of [...(metadata.links ?? []), ...(metadata.embeds ?? [])]) {
          if (/^[a-z]+:/i.test(link.link)) continue;
          const [destination, fragment] = link.link.split('#');
          const found = a.metadataCache.getFirstLinkpathDest(destination, file.path);
          assert(found && found.path.startsWith(prefix), 'Unresolved or misdirected link from ' + file.path + ': ' + link.link);
          links++;
          if (fragment?.startsWith('^')) {
            assert(cache(found.path)?.blocks?.[fragment.slice(1)], 'Missing native block anchor ' + link.link);
            references++;
          }
        }
      }
      assert(links > 15 && references >= 2, 'Synthetic fixture did not exercise enough links');
      pass('relative links and embeds resolve inside the projection', { links, blockReferences: references });
      assert(Object.keys(cache(target).blocks ?? {}).length === 4, 'Paragraph, quote, heading and empty-block anchors must all be recognized');
      pass('paragraph quote heading and empty-block anchors are recognized');
      const aliases = cache(index).frontmatter.aliases;
      assert(Array.isArray(aliases) && aliases.includes('Hero, the first') && aliases.includes('别名[甲]'), 'Aliases are not a native YAML list');
      pass('aliases preserve commas Unicode brackets and colons as separate values');
      assert(/^sha256:[a-f0-9]{64}$/.test(mapped['element:element-0001'].sourceVersion), 'Canonical source version is missing');
      pass('canonical MCP versions and identity maps stay in hidden manifest metadata');
      assert(!cache(body).frontmatter.drifting_id && !cache(body).frontmatter.drifting_source_version, 'Machine metadata leaked into reader properties');
      assert(!files.some(file => /(?:^|[/])(index|prose)[.]md$/.test(file.path)), 'Technical split documents leaked into the reading tree');
      pass('one named document per entity without technical property clutter');
      const citation = cache(body).links.find(link => link.displayText === 'Read the range').link;
      await a.workspace.openLinkText(citation, body, false);
      assert(a.workspace.activeLeaf.view.file.path === target, 'Passage navigation opened the wrong note');
      pass('native passage navigation opens the cited note');
      const leaf = a.workspace.getLeaf(false);
      const wait = async test => { for (let i = 0; i < 80; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Rendered attachment timed out'); };
      await leaf.setViewState({ type: 'markdown', state: { file: index, mode: 'preview' } });
      await wait(() => [...leaf.view.containerEl.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 1));
      pass('read-only PNG attachment renders from a relative embed');
      await leaf.setViewState({ type: 'markdown', state: { file: prefix + mapped['library_item:pdf-note'].path, mode: 'preview' } });
      await wait(() => Boolean(leaf.view.containerEl.querySelector('.pdf-embed .page[data-loaded="true"] canvas')));
      pass('read-only PDF attachment renders a page in the native PDF viewer');
      return { checks, markdownFiles: files.length };
    })()`);
    return { mode, ...result };
  } finally {
    await client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', () => resolve(true)));
      child.kill();
      if (!await Promise.race([stopped, delay(4000).then(() => false)])) { child.kill('SIGKILL'); await stopped; }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint(), 'Obsidian projection acceptance is stale');
  console.log('Obsidian projection evidence matches current source.');
} else {
  const binary = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  assert(existsSync(binary), 'Install Obsidian to run real-application acceptance');
  const before = fingerprint();
  const fixture = path.resolve('.local-data/obsidian-projection/generated');
  rmSync(fixture, { recursive: true, force: true });
  const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', 'src/renderer/services/export/relational-markdown.acceptance.test.ts', '--reporter=dot'], {
    stdio: 'inherit', env: { ...process.env, DRIFTING_OBSIDIAN_FIXTURE: '1' },
  });
  assert.equal(tests.status, 0, 'Synthetic projection generation failed');
  const runs = [];
  for (const mode of ['standalone', 'nested']) runs.push(await runObsidian(binary, fixture, mode));
  assert.equal(before, fingerprint(), 'Projection source changed during acceptance');
  const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Obsidian.app/Contents/Info.plist'], { encoding: 'utf8' }).trim();
  writeFileSync(reportPath, JSON.stringify({ kind: 'obsidian-projection-real-application', generatedAt: new Date().toISOString(),
    sourceSha256: before, status: 'passed', synthetic: true, obsidianVersion: version, runs,
    boundaries: { application: 'isolated installed Obsidian with real metadata cache, navigation and PNG/PDF rendering',
      filesystem: 'read-only fixture; native copy integrity ownership and recovery covered by local-mcp.json',
      personalVault: 'not opened', reverseSync: 'not supported', otherObsidianVersions: 'not tested' },
  }, null, 2) + '\n');
  console.log(`Recorded ${runs.reduce((sum, run) => sum + run.checks.length, 0)} Obsidian ${version} checks.`);
}
