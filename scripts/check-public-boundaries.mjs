import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const errors = [];
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const metricsPackage = JSON.parse(readFileSync('packages/prose-metrics/package.json', 'utf8'));
const configSource = readFileSync('src/renderer/lib/config.ts', 'utf8');
const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

requireCondition(rootPackage.name === 'drifting', 'root package must be named drifting');
requireCondition(rootPackage.private === true, 'root package must stay private on npm');
requireCondition(
  rootPackage.license === 'AGPL-3.0-or-later',
  'root package must use AGPL-3.0-or-later',
);
requireCondition(
  metricsPackage.license === 'Apache-2.0',
  'packages/prose-metrics must use Apache-2.0',
);
requireCondition(
  configSource.includes('VITE_LOCAL_ONLY_MODE as string | undefined, true'),
  'local-only mode must default to true',
);
requireCondition(
  configSource.includes('VITE_ENABLE_SYNC as string | undefined, false'),
  'sync must default to false',
);
requireCondition(
  configSource.includes('VITE_REQUIRE_AUTH as string | undefined, false'),
  'authentication must default to false',
);
requireCondition(
  !JSON.stringify(tauriConfig).includes('developmentTeam'),
  'public Tauri config must not contain an Apple development team',
);

const tracked = execFileSync('git', ['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const legacyTopLevelDirectories = new Set([
  ['Drifting', 'Core'].join('-'),
  ['Drifting', 'Server'].join('-'),
  'backend',
  'web-old',
  'novel',
  'workflows',
]);

for (const path of tracked) {
  if (legacyTopLevelDirectories.has(path.split('/', 1)[0])) {
    errors.push(`legacy/private top-level path is tracked: ${path}`);
  }
  if (/(?:^|\/)\.env$/u.test(path)) errors.push(`real .env file is tracked: ${path}`);
  if (/\.(?:pem|p12|mobileprovision|jks|keystore)$/iu.test(path)) {
    errors.push(`signing or credential material is tracked: ${path}`);
  }
}

const textFiles = tracked.filter(
  (path) =>
    !path.startsWith('src/assets/') &&
    !path.startsWith('src-tauri/icons/') &&
    !/\.(?:png|jpe?g|gif|ico|icns|woff2?|ttf|pdf|sqlite|db)$/iu.test(path),
);
const claudeTrailerPattern = new RegExp(
  `${['co', 'authored', 'by'].join('-')}:[^\\n]*${['clau', 'de'].join('')}`,
  'iu',
);
const privateSiblingPathPattern = new RegExp(`${['Drifting', 'Server'].join('-')}\\/`, 'u');
const legacyClientPathPattern = new RegExp(`${['Drifting', 'Core'].join('-')}\\/`, 'u');
const forbiddenText = [
  { label: 'personal absolute path', pattern: /\/Users\/(?!example(?:\/|$))[^/\s]+/u },
  { label: 'private sibling repository path', pattern: privateSiblingPathPattern },
  { label: 'legacy nested client path', pattern: legacyClientPathPattern },
  { label: 'Claude co-author trailer', pattern: claudeTrailerPattern },
];

for (const path of textFiles) {
  if (path === 'scripts/check-public-boundaries.mjs') continue;
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (source.includes('\0')) continue;
  for (const { label, pattern } of forbiddenText) {
    if (path === 'docs/public-history.md' && label === 'legacy nested client path') continue;
    if (pattern.test(source)) errors.push(`${label} remains in ${path}`);
  }
}

for (const required of [
  'LICENSE',
  'NOTICE',
  'TRADEMARKS.md',
  'ASSET_PROVENANCE.md',
  'THIRD_PARTY_NOTICES.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CLA.md',
  'pnpm-lock.yaml',
  'packages/prose-metrics/LICENSE',
]) {
  requireCondition(tracked.includes(required), `required public file is not tracked: ${required}`);
}

if (errors.length > 0) {
  console.error(`Public-boundary check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Public-boundary check passed for ${tracked.length} tracked files.`);
