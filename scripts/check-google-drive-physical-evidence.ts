import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type AcceptanceResult = 'pass' | 'fail' | 'not-run';

interface EvidenceContract {
  schemaVersion: 1;
  kind: 'drifting.google-drive-physical-acceptance-contract';
  requiredPlatforms: ['desktop', 'ios', 'android'];
  requiredScenarios: string[];
}

interface ArtifactEvidence {
  sourceCommit: string;
  artifactSha256: string;
  systemVersion: string;
  signed: boolean;
  physical: boolean;
}

interface ScenarioEvidence {
  id: string;
  result: AcceptanceResult;
  evidenceSha256: string[];
}

interface PhysicalEvidence {
  schemaVersion: 1;
  kind: 'drifting.google-drive-physical-acceptance';
  recordedAt: string;
  sourceCommit: string;
  appVersion: string;
  artifacts: Record<'desktop' | 'ios' | 'android', ArtifactEvidence>;
  data: {
    classification: 'synthetic' | 'authorized';
    projectCount: number;
  };
  scenarios: ScenarioEvidence[];
}

export interface EvidenceValidationOptions {
  allowOpen?: boolean;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'docs/qa/google-drive-physical-evidence-contract.json');
const templatePath = path.join(root, 'docs/qa/google-drive-physical-evidence.template.json');
const currentAppVersion = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
).version;
const SHA_1 = /^[a-f0-9]{40}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SYSTEM_VERSION = /^\d+(?:\.\d+){0,3}(?: \([0-9A-Za-z._-]{1,20}\))?$/u;
const SCENARIO_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PLACEHOLDER_SHA_1 = '0'.repeat(40);
const PLACEHOLDER_SHA_256 = '0'.repeat(64);

const forbiddenRawPatterns: RegExp[] = [
  /(?:^|["'\s])\/(?:Users|home|private|tmp|var|Volumes)\//iu,
  /[A-Za-z]:\\(?:Users|Documents and Settings)\\/u,
  /\bhttps?:\/\//iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\.apps\.googleusercontent\.com\b/iu,
  /\bya29\.[0-9A-Za-z_-]+\b/u,
  /\b1\/\/[0-9A-Za-z_-]+\b/u,
  /\b(?:eyJ[0-9A-Za-z_-]{10,})\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/u,
  /sync\.google-drive\.credentials\./u,
  /\b(?:access|refresh|authorization)[_-]?token\b/iu,
  /\bclient[_-]?(?:id|secret)\b/iu,
  /\bcredential[_-]?(?:ref|secret)\b/iu,
];

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${location} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${location} has missing or unapproved fields`);
  }
}

function requireString(value: unknown, location: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    fail(`${location} has an invalid value`);
  }
  return value;
}

function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') fail(`${location} must be boolean`);
  return value;
}

function requireInteger(value: unknown, location: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${location} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function readJson(file: string, label: string): unknown {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.length > 256 * 1024) fail(`${label} exceeds the 256 KiB limit`);
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} exceeds`)) throw error;
    fail(`${label} could not be read as JSON`);
  }
}

export function loadGoogleDrivePhysicalEvidenceContract(): EvidenceContract {
  const value = requireRecord(readJson(contractPath, 'acceptance contract'), 'contract');
  requireExactKeys(
    value,
    ['schemaVersion', 'kind', 'requiredPlatforms', 'requiredScenarios'],
    'contract',
  );
  if (value.schemaVersion !== 1) fail('contract.schemaVersion must be 1');
  if (value.kind !== 'drifting.google-drive-physical-acceptance-contract') {
    fail('contract.kind is invalid');
  }
  if (
    !Array.isArray(value.requiredPlatforms) ||
    value.requiredPlatforms.join(',') !== 'desktop,ios,android'
  ) {
    fail('contract.requiredPlatforms is invalid');
  }
  if (!Array.isArray(value.requiredScenarios) || value.requiredScenarios.length === 0) {
    fail('contract.requiredScenarios must be non-empty');
  }
  const requiredScenarios = value.requiredScenarios.map((item, index) =>
    requireString(item, `contract.requiredScenarios[${index}]`, SCENARIO_ID),
  );
  if (new Set(requiredScenarios).size !== requiredScenarios.length) {
    fail('contract.requiredScenarios contains duplicates');
  }
  return value as unknown as EvidenceContract;
}

function validateRawPrivacy(raw: string): void {
  if (raw.length > 256 * 1024) fail('evidence exceeds the 256 KiB limit');
  if (forbiddenRawPatterns.some((pattern) => pattern.test(raw))) {
    fail('evidence contains a forbidden credential, account, URL, or local-path shape');
  }
}

function validateArtifact(
  value: unknown,
  platform: string,
  sourceCommit: string,
  allowOpen: boolean,
): ArtifactEvidence {
  const artifact = requireRecord(value, `artifacts.${platform}`);
  requireExactKeys(
    artifact,
    ['sourceCommit', 'artifactSha256', 'systemVersion', 'signed', 'physical'],
    `artifacts.${platform}`,
  );
  const artifactCommit = requireString(
    artifact.sourceCommit,
    `artifacts.${platform}.sourceCommit`,
    SHA_1,
  );
  const artifactSha256 = requireString(
    artifact.artifactSha256,
    `artifacts.${platform}.artifactSha256`,
    SHA_256,
  );
  requireString(artifact.systemVersion, `artifacts.${platform}.systemVersion`, SYSTEM_VERSION);
  const signed = requireBoolean(artifact.signed, `artifacts.${platform}.signed`);
  const physical = requireBoolean(artifact.physical, `artifacts.${platform}.physical`);
  if (artifactCommit !== sourceCommit) fail(`artifacts.${platform}.sourceCommit does not match`);
  if (!allowOpen && artifactSha256 === PLACEHOLDER_SHA_256) {
    fail(`artifacts.${platform}.artifactSha256 is still a placeholder`);
  }
  if (!allowOpen && (!signed || !physical)) {
    fail(`artifacts.${platform} is not signed physical acceptance evidence`);
  }
  return artifact as unknown as ArtifactEvidence;
}

export function validateGoogleDrivePhysicalEvidence(
  input: unknown,
  options: EvidenceValidationOptions = {},
): PhysicalEvidence {
  const allowOpen = options.allowOpen === true;
  const contract = loadGoogleDrivePhysicalEvidenceContract();
  const report = requireRecord(input, 'report');
  requireExactKeys(
    report,
    [
      'schemaVersion',
      'kind',
      'recordedAt',
      'sourceCommit',
      'appVersion',
      'artifacts',
      'data',
      'scenarios',
    ],
    'report',
  );
  if (report.schemaVersion !== 1) fail('report.schemaVersion must be 1');
  if (report.kind !== 'drifting.google-drive-physical-acceptance') fail('report.kind is invalid');
  const recordedAt = requireString(report.recordedAt, 'report.recordedAt');
  const recordedTime = Date.parse(recordedAt);
  if (!Number.isFinite(recordedTime) || new Date(recordedTime).toISOString() !== recordedAt) {
    fail('report.recordedAt must be an ISO UTC timestamp');
  }
  const sourceCommit = requireString(report.sourceCommit, 'report.sourceCommit', SHA_1);
  const appVersion = requireString(report.appVersion, 'report.appVersion', VERSION);
  if (!allowOpen && appVersion !== currentAppVersion) {
    fail('report.appVersion does not match this checkout');
  }
  if (!allowOpen && sourceCommit === PLACEHOLDER_SHA_1) {
    fail('report.sourceCommit is still a placeholder');
  }

  const artifacts = requireRecord(report.artifacts, 'report.artifacts');
  requireExactKeys(artifacts, contract.requiredPlatforms, 'report.artifacts');
  for (const platform of contract.requiredPlatforms) {
    validateArtifact(artifacts[platform], platform, sourceCommit, allowOpen);
  }

  const data = requireRecord(report.data, 'report.data');
  requireExactKeys(data, ['classification', 'projectCount'], 'report.data');
  if (data.classification !== 'synthetic' && data.classification !== 'authorized') {
    fail('report.data.classification is invalid');
  }
  requireInteger(data.projectCount, 'report.data.projectCount', 3);

  if (!Array.isArray(report.scenarios)) fail('report.scenarios must be an array');
  const seen = new Set<string>();
  for (const [index, candidate] of report.scenarios.entries()) {
    const scenario = requireRecord(candidate, `report.scenarios[${index}]`);
    requireExactKeys(scenario, ['id', 'result', 'evidenceSha256'], `report.scenarios[${index}]`);
    const id = requireString(scenario.id, `report.scenarios[${index}].id`, SCENARIO_ID);
    if (!contract.requiredScenarios.includes(id)) fail(`report.scenarios[${index}].id is unapproved`);
    if (seen.has(id)) fail('report.scenarios contains duplicate IDs');
    seen.add(id);
    if (scenario.result !== 'pass' && scenario.result !== 'fail' && scenario.result !== 'not-run') {
      fail(`report.scenarios[${index}].result is invalid`);
    }
    if (!Array.isArray(scenario.evidenceSha256)) {
      fail(`report.scenarios[${index}].evidenceSha256 must be an array`);
    }
    for (const [digestIndex, digest] of scenario.evidenceSha256.entries()) {
      requireString(
        digest,
        `report.scenarios[${index}].evidenceSha256[${digestIndex}]`,
        SHA_256,
      );
      if (digest === PLACEHOLDER_SHA_256) {
        fail(`report.scenarios[${index}] contains a placeholder evidence digest`);
      }
    }
    if (scenario.result === 'pass' && scenario.evidenceSha256.length === 0) {
      fail(`report.scenarios[${index}] has no evidence digest`);
    }
    if (!allowOpen && scenario.result !== 'pass') {
      fail(`report.scenarios[${index}] is not passed`);
    }
  }
  if (seen.size !== contract.requiredScenarios.length) {
    fail('report.scenarios is missing one or more required IDs');
  }

  return report as unknown as PhysicalEvidence;
}

export function parseAndValidateGoogleDrivePhysicalEvidence(
  raw: string,
  options: EvidenceValidationOptions = {},
): PhysicalEvidence {
  validateRawPrivacy(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('evidence is not valid JSON');
  }
  return validateGoogleDrivePhysicalEvidence(parsed, options);
}

function runCli(): void {
  const argument = process.argv[2];
  const allowOpen = argument === '--contract';
  const target = allowOpen ? templatePath : argument;
  if (!target || process.argv.length > 3) {
    fail('usage: pnpm mobile:google-drive:acceptance -- <sanitized-report.json>');
  }
  let raw: string;
  try {
    raw = readFileSync(path.resolve(target), 'utf8');
  } catch {
    fail('requested evidence could not be read');
  }
  const report = parseAndValidateGoogleDrivePhysicalEvidence(raw, { allowOpen });
  process.stdout.write(
    allowOpen
      ? `Google Drive physical evidence contract verified (${report.scenarios.length} open rows)\n`
      : `Google Drive physical acceptance verified (${report.scenarios.length} passed rows)\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown validation error';
    process.stderr.write(`Google Drive physical evidence rejected: ${message}\n`);
    process.exitCode = 1;
  }
}
