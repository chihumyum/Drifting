import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? '.local-data/source-publication/evidence.json';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
const files = [...new Set(run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(file => file && existsSync(file)))].sort();
const inputs = files.filter(file => /^(src\/|src-tauri\/|packages\/|patches\/|scripts\/|\.github\/|package.json$|pnpm-)/.test(file));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => hash(inputs.map(file => `${file}\0${hash(readFileSync(file))}`).join('\n'));
const source = { commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: Boolean(run('git', ['status', '--porcelain']).trim()),
  fingerprint: fingerprint(), fingerprintScope: 'src, src-tauri, packages, patches, scripts, .github, package.json and pnpm files' };
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-publication-evidence-'));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function audit(extra) {
  const result = spawnSync(pnpm, ['audit', '--json', ...extra], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  if (result.error || result.signal) throw new Error('Dependency audit did not complete');
  const report = JSON.parse(result.stdout);
  if (report.error || !report.metadata?.vulnerabilities) throw new Error('Dependency advisory service did not return a usable audit');
  return { vulnerabilities: report.metadata.vulnerabilities, advisories: Object.values(report.advisories ?? {}).map(item => ({
    module: item.module_name, severity: item.severity, url: item.url, patchedVersions: item.patched_versions,
  })) };
}
function secretScan(args, name) {
  const reportPath = path.join(temporary, `${name}.json`);
  const result = spawnSync('gitleaks', [...args, '--no-banner', '--redact', '--timeout', '120', '--report-format', 'json', '--report-path', reportPath],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 150000 });
  if (result.status !== 0) throw new Error(`${name} secret scan failed; inspect locally with redaction before publication`);
  const findings = JSON.parse(readFileSync(reportPath, 'utf8')).length;
  if (findings) throw new Error(`${name} secret scan found candidates requiring review`);
  return { passed: true, findings };
}
try {
  const allDependencies = audit([]), productionDependencies = audit(['--prod']);
  const tree = path.join(temporary, 'tree');
  for (const file of files) { const target = path.join(tree, file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(file, target); }
  const secrets = { tool: run('gitleaks', ['version']).trim(),
    currentTree: secretScan(['dir', tree], 'current-tree'),
    reachableHistory: { ...secretScan(['git', '--log-opts=--all', '.'], 'reachable-history'), commits: Number(run('git', ['rev-list', '--all', '--count']).trim()) } };
  run('git', ['fsck', '--full', '--no-dangling']);
  run(pnpm, ['public:check']);
  run(process.execPath, ['scripts/check-alpha-release.mjs']);
  const signing = process.platform === 'darwin'
    ? spawnSync(process.execPath, ['scripts/check-macos-dev-signing.mjs'], { encoding: 'utf8', timeout: 120000 }) : null;
  const localDevelopmentSigning = signing ? { status: signing.status === 0 ? 'passed' : 'failed',
    scope: 'Certificate/runner preflight only; native app was not launched' } : { status: 'not-applicable' };
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  const versions = Object.fromEntries(['@tiptap/core', '@tiptap/pm', '@tiptap/react', '@tiptap/extension-bubble-menu',
    '@tiptap/extension-floating-menu', '@xmldom/xmldom', 'vitest', 'js-yaml'].map(name => [name,
    [...new Set([...lock.matchAll(/^  '?([^'\n]+)@([\d.]+)'?:$/gm)].filter(match => match[1] === name).map(match => match[2]))] ]));
  let github;
  if (process.argv.includes('--github')) {
    const repo = JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility,isArchived,defaultBranchRef']));
    const api = (endpoint, query) => JSON.parse(run('gh', ['api', `repos/${repo.nameWithOwner}/${endpoint}`, ...(query ? ['--jq', query] : [])]));
    const rulesets = api('rulesets');
    github = { repository: repo.nameWithOwner, visibility: repo.visibility, archived: repo.isArchived, defaultBranch: repo.defaultBranchRef.name,
      actions: api('actions/permissions/workflow'),
      rulesets: rulesets.map(rule => api(`rulesets/${rule.id}`, '{name,enforcement,bypass_actors,conditions,rules}')),
      repositorySecretCount: api('actions/secrets', '.total_count'), repositoryVariableCount: api('actions/variables', '.total_count'),
      environmentCount: api('environments', '.total_count'), webhookCount: api('hooks', 'length'),
      automaticSecurityFixes: api('automated-security-fixes'),
      privateVulnerabilityReporting: repo.visibility === 'PRIVATE' ? 'enable immediately after public visibility change' : api('private-vulnerability-reporting'),
    };
  }
  if (source.fingerprint !== fingerprint()) throw new Error('Source changed while collecting publication evidence');
  const hasAlerts = [allDependencies, productionDependencies].some(audit => Object.values(audit.vulnerabilities).some(count => count > 0));
  const glib = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/name = "glib"\nversion = "([^"]+)"/)?.[1];
  if (glib !== '0.18.5') throw new Error('Re-review the GTK3 advisory decision for the changed Rust dependency tree');
  const report = { schemaVersion: 1, kind: 'source_publication_preparation', generatedAt: new Date().toISOString(), source,
    status: hasAlerts ? 'dependency-review-required' : signing && signing.status !== 0 ? 'local-signing-review-required' : 'automated-preparation-passed', versions,
    allDependencies, productionDependencies, secrets, gitIntegrity: 'passed', sourceBoundaries: 'passed', releaseContract: 'passed', localDevelopmentSigning, github,
    remainingRustAdvisory: { id: 'GHSA-wrw7-89jp-8q8g', package: 'glib', version: '0.18.5', severity: 'moderate',
      decision: 'Keep alert open; existing accepted Linux GTK3 transitive risk. See docs/source-publication-readiness.md.' },
    manualAcceptance: 'Not performed by this generator. See docs/qa/native-acceptance-2026-09-23.md for scoped native/device observations and remaining gaps.',
    nativeAcceptanceReference: { path: 'docs/qa/native-acceptance-2026-09-23.md',
      sha256: hash(readFileSync('docs/qa/native-acceptance-2026-09-23.md')),
      scope: 'Human-readable observations; not an automated all-platform acceptance result' },
    publication: 'Repository visibility unchanged; publication requires a separate maintainer decision',
    limitations: ['Secret scanners do not establish absence of all confidential material.', 'npm audit does not cover Rust; the documented GTK3 advisory is reviewed separately.',
      'GitHub settings are a read-only snapshot; recheck on the publication SHA and after visibility changes.'] };
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, status: report.status, source, versions, allDependencies: allDependencies.vulnerabilities, productionDependencies: productionDependencies.vulnerabilities }));
  if (report.status !== 'automated-preparation-passed') process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
