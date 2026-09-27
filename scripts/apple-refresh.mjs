// Regenerate only the Apple native evidence whose sources changed, in dependency
// order, then rewrite the inventory and rerun macOS acceptance when runtime
// sources changed. Every generator's --check is the staleness test, so a
// report is either rerun or verified current; nothing is skipped silently.
//
//   pnpm apple:refresh          refresh stale evidence
//   pnpm apple:refresh --list   only report what is stale
//   pnpm apple:refresh --all    regenerate everything
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const listOnly = process.argv.includes('--list');
const all = process.argv.includes('--all');
const directory = `.local-data/apple-native/refresh-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(directory, { recursive: true });

// TypeScript oracle fixtures and the Yrs diagnostic feed the reports after
// them; native acceptance validates the binding report. The device diagnostic
// needs a physical-device input directory, so it is only checked.
const node = script => [process.execPath, [`scripts/${script}`]];
const tsx = script => ['pnpm', ['exec', 'tsx', '--conditions=import', `scripts/${script}`]];
const evidence = [
  ['prose-journal-fixture', tsx('apple-prose-journal-oracle.ts')],
  ['original-operation-fixture', tsx('apple-original-operation-oracle.ts')],
  ['original-body-archive-fixture', tsx('apple-original-body-archive-oracle.ts')],
  ['event-order-fixture', tsx('apple-native-event-order-oracle.ts')],
  ['journal-fixture', tsx('apple-native-journal-oracle.ts')],
  ['document-fixture', node('generate-apple-fixtures.mjs')],
  ['yrs-diagnostic', node('apple-yrs-diagnostic.mjs')],
  ['document', node('apple-document-acceptance.mjs')],
  ['durability', node('apple-prose-durability-acceptance.mjs')],
  ['original-operation', node('apple-original-operation-acceptance.mjs')],
  ['authoring', node('apple-native-authoring-acceptance.mjs')],
  ['workspace', node('apple-workspace-acceptance.mjs')],
  ['remote-prose', node('apple-remote-prose-acceptance.mjs')],
  ['workspace-remote', node('apple-workspace-remote-acceptance.mjs')],
  ['trash', node('apple-workspace-trash-acceptance.mjs')],
  ['act', node('apple-workspace-act-acceptance.mjs')],
  ['comments', node('apple-workspace-comment-acceptance.mjs')],
  ['elements', node('apple-workspace-element-acceptance.mjs')],
  ['links', node('apple-workspace-link-acceptance.mjs')],
  ['storylines', node('apple-workspace-storyline-acceptance.mjs')],
  ['drifts', node('apple-workspace-drift-acceptance.mjs')],
  ['metadata', node('apple-workspace-metadata-acceptance.mjs')],
  ['relations', node('apple-workspace-relation-acceptance.mjs')],
  ['metrics', node('apple-workspace-metrics-acceptance.mjs')],
  ['binding', node('apple-binding-acceptance.mjs')],
  ['device-prerequisite', node('apple-device-prerequisite-diagnostic.mjs'), { checkOnly: true }],
];
const nativeReport = 'docs/apple-native/acceptance/p2b-native.json';
const started = Date.now();
const seconds = since => `${Math.round((Date.now() - since) / 1000)}s`;

function run(label, [command, args]) {
  const since = Date.now();
  const logPath = `${directory}/${label}.log`;
  const log = openSync(logPath, 'w');
  let result;
  try { result = spawnSync(command, args, { stdio: ['ignore', log, log] }); }
  finally { closeSync(log); }
  return { ok: !result.error && result.status === 0, logPath, took: seconds(since) };
}
function regenerate(label, invocation) {
  const result = run(label, invocation);
  if (!result.ok) {
    const tail = readFileSync(result.logPath, 'utf8').trim().split('\n').slice(-25).join('\n');
    console.error(`✗ ${label} failed after ${result.took}; full log: ${result.logPath}\n${tail}`);
    process.exit(1);
  }
  console.log(`✓ ${label} regenerated (${result.took})`);
}

const stale = [];
for (const [label, [command, args], options = {}] of evidence) {
  const fresh = !all && run(`${label}-check`, [command, [...args, '--check']]).ok;
  if (fresh) continue;
  stale.push(label);
  if (listOnly) continue;
  if (options.checkOnly) {
    console.error(`✗ ${label} is stale and needs its device input; see ${args.at(-1)}`);
    process.exit(1);
  }
  regenerate(label, [command, args]);
}

const runtimeFingerprint = () => spawnSync(process.execPath, ['scripts/check-apple-migration.mjs', '--runtime-fingerprint'],
  { encoding: 'utf8' }).stdout.trim();
const native = JSON.parse(readFileSync(nativeReport, 'utf8'));
const nativeStale = all || native.status !== 'passed' || native.source.runtimeFingerprint !== runtimeFingerprint();
if (nativeStale) stale.push('native');
if (listOnly) {
  console.log(stale.length ? `Stale: ${stale.join(', ')}` : 'All Apple evidence is current.');
  process.exit(0);
}

// Writing the inventory also runs every evidence --check.
const inventoryWrite = [process.execPath, ['scripts/check-apple-migration.mjs', '--write']];
regenerate('inventory', inventoryWrite);
if (nativeStale) regenerate('native', [process.execPath, ['scripts/apple-native-acceptance.mjs', `--output=${nativeReport}`]]);
// Rewrite again to absorb documentation edits made while tests ran.
regenerate('inventory-final', inventoryWrite);
const inventory = JSON.parse(readFileSync('docs/apple-native/acceptance/inventory.json', 'utf8'));
const final = JSON.parse(readFileSync(nativeReport, 'utf8'));
assert.equal(final.status, 'passed', 'macOS native acceptance did not pass');
assert.equal(final.source.runtimeFingerprint, inventory.source.runtimeFingerprint,
  'Runtime sources changed during refresh; run pnpm apple:refresh again');
console.log(`Apple evidence current (${stale.length ? `refreshed ${stale.join(', ')}` : 'nothing stale'}) in ${seconds(started)}.`);
