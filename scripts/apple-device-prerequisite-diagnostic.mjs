import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This consumes a failed attempt's local receipts. It does not sign, install,
// authenticate, query a device, or promote a prerequisite into runtime evidence.
const root = fileURLToPath(new URL('..', import.meta.url));
const script = 'scripts/apple-device-prerequisite-diagnostic.mjs';
const defaultInput = '.local-data/apple-native/device-prerequisites';
const defaultOutput = 'docs/apple-native/acceptance/p2c-device-prerequisites.json';
const args = process.argv.slice(2);
const inputArgument = args.find((arg) => arg.startsWith('--input-dir='))?.slice(12);
const input = path.resolve(root, inputArgument ?? defaultInput);
const output = path.resolve(root, args.find((arg) => arg.startsWith('--output='))?.slice(9) ?? defaultOutput);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const generatorSha256 = hash(readFileSync(path.join(root, script)));
const acceptance = Object.fromEntries(['installation', 'appLaunch', 'hostedUIKitTests', 'deviceUITests',
  'realTouch', 'realIME', 'interruptionRecovery', 'distribution'].map((name) => [name, 'not-run']));
const limitations = [
  'Hardware discovery and signing metadata are prerequisites, not physical-device application acceptance.',
  'A completed Rust target build does not prove the signed iOS app builds or runs.',
  'The failed attempt did not capture a native source fingerprint; the generator hash authenticates only this diagnostic producer.',
  'Not-run fields describe this stopped attempt; no claim is made about unrelated device activity.',
  'Raw local artifacts are hashed, never embedded. Signing identities and profile metadata do not prove an authenticated Xcode account.',
];
const artifactRoles = ['device-list', 'physical-device-details', 'signing-identity-inventory',
  'profile-metadata-inventory', 'device-rust-build-log', 'development-signing-build-log', 'attempt-stop-receipt'];

function exactKeys(value, names) { assert.deepEqual(Object.keys(value).sort(), [...names].sort()); }

function validate(report) {
  exactKeys(report, ['schemaVersion', 'kind', 'status', 'attemptRecordedAt', 'source', 'device',
    'signing', 'deviceRustBuild', 'acceptance', 'artifacts', 'limitations']);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'apple_native_device_prerequisite_diagnostic');
  assert.equal(report.status, 'blocked-at-development-signing');
  exactKeys(report.source, ['generator', 'generatorSha256', 'nativeRuntimeSourceAssociation']);
  assert.equal(report.source.generator, script);
  assert.equal(report.source.generatorSha256, generatorSha256);
  assert.equal(report.source.nativeRuntimeSourceAssociation, 'not-captured; no runtime acceptance claimed');
  assert.deepEqual(report.acceptance, acceptance);
  assert.deepEqual(report.limitations, limitations);
  assert.match(report.attemptRecordedAt, /^[0-9TZ:.,+\-]+$/u);
  assert(Number.isFinite(Date.parse(report.attemptRecordedAt)));
  exactKeys(report.device, ['observedPhysicalDevices', 'model', 'osVersion', 'bootState', 'developerMode',
    'ddiServicesAvailable', 'pairingState', 'transport', 'tunnelState']);
  assert.equal(report.device.observedPhysicalDevices, 1);
  assert.equal(report.device.bootState, 'booted');
  assert(['localNetwork', 'wired', 'usb', 'network'].includes(report.device.transport));
  assert.equal(report.device.developerMode, 'enabled');
  assert.equal(report.device.ddiServicesAvailable, true);
  assert.equal(report.device.pairingState, 'paired');
  assert.equal(report.device.tunnelState, 'connected');
  assert.match(report.device.model, /^i(?:Phone|Pad)[0-9]+,[0-9]+$/u);
  assert.match(report.device.osVersion, /^[0-9]+(?:\.[0-9]+){0,2}$/u);
  const countFields = ['validAppleDevelopmentIdentities', 'recordedProfiles', 'recordedUnexpiredProfiles',
    'profilesWithSomeLocalDevelopmentIdentity', 'nativeBundleMatchingProfiles', 'profilesIncludingPairedDevice',
    'eligibleNativeDeviceProfiles'];
  exactKeys(report.signing, [...countFields, 'status', 'exitCode', 'failures']);
  for (const field of countFields) assert(Number.isSafeInteger(report.signing[field]) && report.signing[field] >= 0);
  assert(report.signing.validAppleDevelopmentIdentities > 0);
  assert.equal(report.signing.status, 'failed');
  assert.equal(report.signing.exitCode, 65);
  assert.equal(report.signing.eligibleNativeDeviceProfiles, 0);
  assert.deepEqual(report.signing.failures, ['no-xcode-account', 'profile-excludes-device', 'profile-certificate-mismatch']);
  exactKeys(report.deviceRustBuild, ['status', 'target', 'profile']);
  assert.equal(report.deviceRustBuild.status, 'build-completed-only');
  assert.equal(report.deviceRustBuild.target, 'aarch64-apple-ios');
  assert.equal(report.deviceRustBuild.profile, 'debug');
  assert.deepEqual(report.artifacts.map((item) => item.role), artifactRoles);
  for (const item of report.artifacts) {
    exactKeys(item, ['role', 'sha256', 'bytes']);
    assert.match(item.sha256, /^[0-9a-f]{64}$/u);
    assert(Number.isSafeInteger(item.bytes) && item.bytes > 0);
  }
  const serialized = JSON.stringify(report);
  assert(!/\/(?:Users|home)\//u.test(serialized));
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(serialized));
}

function generate() {
  const artifacts = [];
  const privateValues = new Set([root, input]);
  function read(file, role) {
    const bytes = readFileSync(path.join(input, file));
    artifacts.push({ role, sha256: hash(bytes), bytes: bytes.length });
    return bytes.toString('utf8');
  }
  function json(file, role) { return JSON.parse(read(file, role)); }
  function rememberDevice(device) {
    for (const value of [device.identifier, device.deviceProperties?.name,
      device.hardwareProperties?.udid, device.hardwareProperties?.serialNumber]) {
      if (typeof value === 'string' && value.length > 3) privateValues.add(value);
    }
  }
  const list = json('devices.json', 'device-list');
  assert.equal(list.info.outcome, 'success');
  const physical = list.result.devices.filter((device) => device.hardwareProperties?.reality === 'physical');
  assert.equal(physical.length, 1, 'This diagnostic requires the audited single-device attempt');
  for (const device of list.result.devices) rememberDevice(device);
  const detailFiles = readdirSync(input).filter((name) => /^physical-[0-9]+-details\.json$/u.test(name));
  assert.equal(detailFiles.length, 1);
  const detail = json(detailFiles[0], 'physical-device-details');
  assert.equal(detail.info.outcome, 'success');
  const device = detail.result.device ?? detail.result;
  rememberDevice(device);
  assert.equal(device.hardwareProperties.udid, physical[0].hardwareProperties.udid);
  const identities = read('signing-identities.log', 'signing-identity-inventory');
  const identityLines = [...identities.matchAll(/^\s*[0-9]+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gmu)];
  const declaredCount = identities.match(/([0-9]+) valid identities found/u);
  assert(declaredCount && identityLines.length === Number(declaredCount[1]));
  for (const identity of identityLines) { privateValues.add(identity[1]); privateValues.add(identity[2]); }
  const validAppleDevelopmentIdentities = identityLines.filter((item) => item[2].startsWith('Apple Development:')).length;
  const profiles = json('signing-profile-metadata.json', 'profile-metadata-inventory');
  assert(Array.isArray(profiles) && profiles.length > 0);
  for (const profile of profiles) {
    for (const name of ['valid', 'development', 'nativeBundleMatches', 'pairedDeviceIncluded', 'hasLocalDevelopmentIdentity']) {
      assert.equal(typeof profile[name], 'boolean');
    }
    for (const value of [profile.path, profile.applicationIdentifier, ...profile.teamIdentifiers]) privateValues.add(value);
    // Validate the export's bundle-match flag without copying its private prefix.
    const bundlePattern = profile.applicationIdentifier.split('.').slice(1).join('.');
    const pattern = new RegExp(`^${bundlePattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u');
    assert.equal(profile.nativeBundleMatches, pattern.test('cc.drifting.native-lab.ios'));
  }
  const rust = read('current-device-rust-build.log', 'device-rust-build-log');
  assert(/Finished `dev` profile \[unoptimized \+ debuginfo\] target\(s\)/u.test(rust));
  assert(/Compiling drifting-apple-bridge/u.test(rust));
  assert(!/^error(?:\[|:)/mu.test(rust));
  const signing = read('signed-device-build.log', 'development-signing-build-log');
  assert(/-scheme DriftingNativeIOS\b/u.test(signing));
  assert(/DRIFTING_RUST_TARGET=aarch64-apple-ios\b/u.test(signing));
  assert(/CODE_SIGNING_ALLOWED=YES\b/u.test(signing));
  assert(/\*\* BUILD FAILED \*\*/u.test(signing) && !/\*\* BUILD SUCCEEDED \*\*/u.test(signing));
  assert(/error: No Accounts: Add a new account in Accounts settings\./u.test(signing));
  assert(/error: Provisioning profile .* doesn't include the currently selected device /u.test(signing));
  assert(/error: Provisioning profile .* doesn't include signing certificate /u.test(signing));
  const receipt = json('device-run-summary.log', 'attempt-stop-receipt');
  assert.equal(receipt.developmentSigning.exitCode, 65);
  for (const field of ['installation', 'appLaunch', 'physicalDeviceBindingTests', 'physicalDeviceUITests', 'realTouchOrIME', 'interruptionRecovery']) {
    assert.equal(receipt[field], 'not-run');
  }
  assert.equal(receipt.accountChanges, 'none');
  assert.equal(receipt.productionIdentityChanges, 'none');
  assert(Number.isFinite(Date.parse(receipt.generatedAt)));
  const props = device.deviceProperties, connection = device.connectionProperties;
  const report = {
    schemaVersion: 1, kind: 'apple_native_device_prerequisite_diagnostic',
    status: 'blocked-at-development-signing', attemptRecordedAt: receipt.generatedAt,
    source: { generator: script, generatorSha256, nativeRuntimeSourceAssociation: 'not-captured; no runtime acceptance claimed' },
    device: { observedPhysicalDevices: physical.length, model: device.hardwareProperties.productType,
      osVersion: props.osVersionNumber, bootState: props.bootState, developerMode: props.developerModeStatus,
      ddiServicesAvailable: props.ddiServicesAvailable, pairingState: connection.pairingState,
      transport: connection.transportType, tunnelState: connection.tunnelState },
    signing: { validAppleDevelopmentIdentities, recordedProfiles: profiles.length,
      recordedUnexpiredProfiles: profiles.filter((p) => p.valid).length,
      profilesWithSomeLocalDevelopmentIdentity: profiles.filter((p) => p.valid && p.development && p.hasLocalDevelopmentIdentity).length,
      nativeBundleMatchingProfiles: profiles.filter((p) => p.nativeBundleMatches).length,
      profilesIncludingPairedDevice: profiles.filter((p) => p.valid && p.pairedDeviceIncluded).length,
      eligibleNativeDeviceProfiles: profiles.filter((p) => p.valid && p.development && p.nativeBundleMatches
        && p.pairedDeviceIncluded && p.hasLocalDevelopmentIdentity).length,
      status: 'failed', exitCode: receipt.developmentSigning.exitCode,
      failures: ['no-xcode-account', 'profile-excludes-device', 'profile-certificate-mismatch'] },
    deviceRustBuild: { status: 'build-completed-only', target: 'aarch64-apple-ios', profile: 'debug' },
    acceptance, artifacts, limitations,
  };
  validate(report);
  const serialized = JSON.stringify(report);
  for (const value of privateValues) if (typeof value === 'string' && value.length > 3) {
    assert(!serialized.includes(value), 'Private input value escaped the report allowlist');
  }
  return report;
}

try {
  assert(args.every((arg) => arg === '--check' || arg.startsWith('--input-dir=') || arg.startsWith('--output=')));
  if (args.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    validate(report);
    if (inputArgument !== undefined || existsSync(input)) {
      assert.deepEqual(report, generate());
      console.log('Device prerequisite diagnostic matches its local evidence; runtime gates remain not-run.');
    } else {
      console.log('Device prerequisite diagnostic schema/producer checked; private raw evidence unavailable in this checkout.');
    }
  } else {
    const report = generate();
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log('Generated redacted device prerequisite diagnostic: blocked at development signing.');
  }
} catch {
  // Parsing/assertion errors can contain private device/profile strings. Keep
  // those inputs local even on malformed input or a mismatched receipt.
  console.error('Device prerequisite diagnostic validation failed; inspect the ignored input artifacts locally.');
  process.exitCode = 1;
}
