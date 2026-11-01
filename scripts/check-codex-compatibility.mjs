import { readFile, writeFile } from 'node:fs/promises';

const manifestUrl = new URL('../src-tauri/codex-compatibility.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
if (!version.test(manifest.clientVersion) || manifest.clientVersion === '0.0.0'
  || manifest.schemaTag !== `rust-v${manifest.clientVersion}`
  || !/^\d{4}-\d{2}-\d{2}$/u.test(manifest.reviewedOn)
  || manifest.catalogSpec !== 'https://learn.chatgpt.com/docs/model-catalogs') {
  throw new Error('Invalid reviewed Codex compatibility manifest');
}

let upstream = false;
let output;
for (const arg of process.argv.slice(2)) {
  if (arg === '--upstream') upstream = true;
  else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
  else throw new Error(`Unknown argument: ${arg}`);
}

const report = { schemaVersion: 1, ...manifest };
if (upstream) {
  const response = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Drifting-compatibility-check' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Upstream release check failed: HTTP ${response.status}`);
  const release = await response.json();
  const latest = String(release.tag_name).replace(/^rust-v/u, '');
  if (!version.test(latest)) throw new Error('Unrecognized upstream stable release tag');
  const currentParts = manifest.clientVersion.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);
  const different = latestParts.findIndex((part, index) => part !== currentParts[index]);
  Object.assign(report, {
    checkedAt: new Date().toISOString(), upstreamVersion: latest,
    updateAvailable: different !== -1 && latestParts[different] > currentParts[different],
    action: 'Review the matching schema and run catalog/Responses acceptance before changing the manifest.',
  });
}
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, json);
process.stdout.write(json);
// Source remains unchanged; this command never upgrades the compatibility claim.
