import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const errors = [];
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release-alpha.yml', 'utf8');

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) errors.push(message);
}

requireMatch(ci, /^\s{4}branches: \[main\]$/mu, 'ordinary CI must run for main pushes');
requireMatch(ci, /^\s{2}pull_request:\s*$/mu, 'ordinary CI must run for pull requests');
if (/^\s{4}tags:/mu.test(ci)) {
  errors.push('ordinary CI must not duplicate the exact-SHA release workflow on tags');
}

for (const job of ['client-checks', 'client-tests', 'client', 'native']) {
  requireMatch(ci, new RegExp(`^  ${job}:\\s*$`, 'mu'), `CI is missing the ${job} job`);
}
requireMatch(ci, /^\s{4}name: client\s*$/mu, 'CI must preserve the required client context');
requireMatch(
  ci,
  /^\s{4}needs: \[client-checks, client-tests\]\s*$/mu,
  'client must aggregate checks and test shards',
);
requireMatch(ci, /pnpm exec vitest run --shard="\$TEST_SHARD"/u, 'CI must run sharded Vitest');

for (const command of [
  'pnpm ci:contract:check',
  'pnpm public:check',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm agent:capabilities:check',
  'pnpm exec vite build --config vite.renderer.config.ts',
]) {
  if (!ci.includes(command)) errors.push(`client checks are missing: ${command}`);
}

requireMatch(
  release,
  /^\s{4}tags: \['app-v0\.1\.\*-alpha\.\*'\]\s*$/mu,
  'the release workflow must remain the owner of Alpha tags',
);
if (!release.includes('pnpm ci:contract:check')) {
  errors.push('the exact-SHA release validation must enforce the CI contract');
}

const testFiles = execFileSync('git', [
  'ls-files',
  '*.test.ts',
  '*.test.tsx',
  '*.test.js',
  '*.test.mjs',
  '*.spec.ts',
  '*.spec.tsx',
])
  .toString('utf8')
  .split('\n')
  .filter(Boolean);
const mutableVersionAssertion = /\.toContain\(\s*['"`]version:\s*\d+,?['"`]\s*\)/u;
for (const path of testFiles) {
  const source = readFileSync(path, 'utf8');
  if (mutableVersionAssertion.test(source)) {
    errors.push(
      `${path} locks an acceptance test to a mutable current store version; test migration behavior instead`,
    );
  }
}

if (errors.length > 0) {
  console.error(`CI contract check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`CI contract check passed for ${testFiles.length} tracked test files.`);
