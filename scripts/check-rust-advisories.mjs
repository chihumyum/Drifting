// Audits every tracked Cargo.lock against the RustSec advisory database, the
// Rust counterpart of `pnpm security:dependencies`. A vulnerability fails;
// unmaintained, unsound and yanked notices are listed for review and do not.
// An advisory database that cannot be fetched fails too.
// Needs cargo-audit: `cargo install cargo-audit --locked`.
import { execFileSync, spawnSync } from 'node:child_process';

const lockfiles = execFileSync('git', ['ls-files', '*Cargo.lock'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
if (lockfiles.length === 0) {
  console.error('No tracked Cargo.lock to audit.');
  process.exit(1);
}

let vulnerable = 0;
for (const lockfile of lockfiles) {
  const result = spawnSync('cargo', ['audit', '--file', lockfile, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error(`cargo audit did not run for ${lockfile}. Install it with \`cargo install cargo-audit --locked\`.`);
    if (result.error) console.error(String(result.error));
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  const vulnerabilities = report.vulnerabilities.list;
  const notices = Object.entries(report.warnings ?? {}).flatMap(([kind, list]) =>
    list.map((notice) => `${kind} ${notice.advisory?.id ?? ''} ${notice.package.name} ${notice.package.version}`.replace(/\s+/gu, ' ')),
  );
  console.log(`${lockfile}: ${vulnerabilities.length} vulnerabilities, ${notices.length} notices`);
  for (const item of vulnerabilities) {
    const patched = item.versions.patched.join(', ') || 'no patched version';
    console.error(`  ${item.advisory.id} ${item.package.name} ${item.package.version}: ${item.advisory.title} (fixed in ${patched})`);
  }
  for (const notice of notices) console.log(`  notice: ${notice}`);
  vulnerable += vulnerabilities.length;
}

if (vulnerable > 0) {
  console.error(`Rust advisory check failed: ${vulnerable} vulnerabilities.`);
  process.exit(1);
}
console.log(`Rust advisory check passed for ${lockfiles.length} lockfiles.`);
