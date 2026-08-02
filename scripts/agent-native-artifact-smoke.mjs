import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosArchive = path.join(core, 'src-tauri/gen/apple/build/drifting_iOS.xcarchive');
const iosApp = path.join(iosArchive, 'Products/Applications/Drifting.app');
const iosBinary = path.join(iosApp, 'Drifting');
const iosInfo = path.join(iosApp, 'Info.plist');
const androidApk = path.join(core, 'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');
const output = path.join(core, 'docs/agent-runtime/acceptance/milestone-j-native-build.json');

const [archiveStat, binaryStat, apkStat, binaryKind, bundleId, apkEntries] = await Promise.all([
  stat(iosArchive),
  stat(iosBinary),
  stat(androidApk),
  exec('/usr/bin/file', ['-b', iosBinary]),
  exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', iosInfo]),
  exec('/usr/bin/unzip', ['-l', androidApk]),
]);
const assertions = {
  iosArchiveDirectory: archiveStat.isDirectory(),
  iosArm64Executable: binaryStat.isFile() && /Mach-O 64-bit executable arm64/u.test(binaryKind),
  iosBundleIdentifier: bundleId.trim() === 'cc.drifting.client',
  androidApkFile: apkStat.isFile(),
  androidArm64RustLibrary: apkEntries.includes('lib/arm64-v8a/libdrifting_lib.so'),
  androidTauriConfig: apkEntries.includes('assets/tauri.conf.json'),
};
const report = {
  suite: 'milestone-j-native-build-smoke',
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  builds: {
    iosSimulator: {
      command: 'tauri ios build --debug --target aarch64-sim --no-sign --archive-only --ci',
      artifact: path.relative(core, iosArchive),
      executableBytes: binaryStat.size,
      executableSha256: await hash(iosBinary),
    },
    androidArm64: {
      command: 'tauri android build --debug --target aarch64 --apk --ci',
      artifact: path.relative(core, androidApk),
      apkBytes: apkStat.size,
      apkSha256: await hash(androidApk),
    },
  },
  assertions,
  interactiveDeviceLaunch: 'not-run-by-contract; user-owned visual acceptance',
  passed: Object.values(assertions).every(Boolean),
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

function exec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function hash(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => digest.update(chunk))
      .once('error', reject)
      .once('end', () => resolve(`sha256:${digest.digest('hex')}`));
  });
}
