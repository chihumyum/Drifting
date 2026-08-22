import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const errors = [];
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const metricsPackage = JSON.parse(readFileSync('packages/prose-metrics/package.json', 'utf8'));
const configSource = readFileSync('src/renderer/lib/config.ts', 'utf8');
const developmentGuide = readFileSync('DEV_GUIDE.md', 'utf8');
const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const agentGuidance = readFileSync('AGENTS.md', 'utf8');
const syncSettingsSource = readFileSync(
  'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
  'utf8',
);
const onboardingSource = readFileSync(
  'src/renderer/components/modals/PreAlphaOnboardingDialog.tsx',
  'utf8',
);
const platformContractsSource = readFileSync('src/renderer/platform/contracts.ts', 'utf8');
const tauriHostSource = readFileSync('src-tauri/src/lib.rs', 'utf8');

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
  !configSource.includes('VITE_ENABLE_SYNC') &&
    !configSource.includes('isSyncEnabled') &&
    configSource.includes('canUsePersonalCloud'),
  'retired hosted sync switch must stay absent while personal-cloud capability remains explicit',
);
requireCondition(
  configSource.includes('VITE_REQUIRE_AUTH as string | undefined, false'),
  'authentication must default to false',
);
requireCondition(
  !JSON.stringify(tauriConfig).includes('developmentTeam'),
  'public Tauri config must not contain an Apple development team',
);
requireCondition(
  !tauriConfig.app.security.csp.includes('api.drifting.cc'),
  'public production CSP must not allow the Drifting hosted-service origin',
);
requireCondition(
  developmentGuide.includes('Tauri 2 + Rust + React + Vite'),
  'DEV_GUIDE.md must describe the current Tauri client',
);
requireCondition(
  developmentGuide.includes('VITE_LOCAL_ONLY_MODE=true') &&
    developmentGuide.includes('VITE_AI_TRANSPORT=direct'),
  'DEV_GUIDE.md must record the current local-only build boundary',
);
requireCondition(
  developmentGuide.includes('external-content') &&
    developmentGuide.includes('agent-extension'),
  'DEV_GUIDE.md must record the auditable non-hosted network purposes',
);
requireCondition(
  agentGuidance.includes('## Public Alpha compatibility policy') &&
    agentGuidance.includes('0.1.0-alpha.1') &&
    agentGuidance.includes('Published migrations are immutable'),
  'AGENTS.md must preserve the frozen public Alpha compatibility policy',
);
requireCondition(
  !syncSettingsSource.includes('BackupService') &&
    !syncSettingsSource.includes('replace-same-identity') &&
    !onboardingSource.includes("preAlphaGuide.backup"),
  'ordinary Settings and onboarding must not expose a whole-library backup/restore workflow',
);
requireCondition(
  !platformContractsSource.includes('library_backup_') &&
    !tauriHostSource.includes('library_backup'),
  'public renderer/native contracts must not expose the retired library backup archive',
);
for (const retiredGuideText of ['Electron', 'src/main', 'backend/', 'out/']) {
  requireCondition(
    !developmentGuide.includes(retiredGuideText),
    `DEV_GUIDE.md contains retired guidance: ${retiredGuideText}`,
  );
}

const tracked = execFileSync('git', ['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
// Public-readiness is commonly run before staging a change. Include every
// unignored local addition so a new source/doc cannot evade the credential and
// private-path scan merely because it is still untracked.
const publishCandidates = execFileSync('git', [
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
])
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

for (const path of publishCandidates) {
  if (legacyTopLevelDirectories.has(path.split('/', 1)[0])) {
    errors.push(`legacy/private top-level path is tracked: ${path}`);
  }
  if (/(?:^|\/)\.env$/u.test(path)) errors.push(`real .env file is tracked: ${path}`);
  if (/\.(?:pem|p12|mobileprovision|jks|keystore)$/iu.test(path)) {
    errors.push(`signing or credential material is tracked: ${path}`);
  }
}

const textFiles = publishCandidates.filter(
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

const cleanAssetRuntimePatterns = [
  { label: 'retired asset upload table', pattern: /asset_upload_job/u },
  { label: 'retired provider object coordinate', pattern: /(?:source|display|thumbnail)_object_key/u },
  { label: 'retired asset-cache runtime', pattern: /asset[-_]cache|assetCache|AssetCache/u },
  { label: 'retired R2 transport', pattern: /r2\.cloudflarestorage\.com/u },
  { label: 'retired data migrator', pattern: /DRIFTING_LEGACY_USER_DATA_DIR|DRIFTING_COMPAT_DB|data_migration/u },
];
const cleanAssetRuntimeFiles = textFiles.filter(
  (path) =>
    (path.startsWith('src/') || path.startsWith('src-tauri/src/') || path.startsWith('drizzle/')) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
    !path.includes('.acceptance.'),
);
for (const path of cleanAssetRuntimeFiles) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const { label, pattern } of cleanAssetRuntimePatterns) {
    if (pattern.test(source)) errors.push(`${label} remains in runtime source ${path}`);
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

console.log(
  `Public-boundary check passed for ${publishCandidates.length} tracked and untracked publish candidates.`,
);
