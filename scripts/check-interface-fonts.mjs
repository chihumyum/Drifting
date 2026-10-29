import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const output = 'docs/qa/interface-fonts.json';
const sources = [
  'scripts/check-interface-fonts.mjs',
  'scripts/interface-fonts-ui.tsx', 'scripts/interface-fonts-ui.html',
  'src/styles/interface-fonts.css', 'src/styles/desktop-typography.css',
  'src/styles/index.css', 'src/styles/ui-controls.css', 'src/styles/comments-review.css',
  'src/styles/bottom-timeline.css', 'src/renderer/main.tsx',
  'src/renderer/components/leftBars/GroupHeaderCell.tsx',
  'src/renderer/components/leftBars/ElementPanel.tsx',
  'src/renderer/components/leftBars/LeftSidebarSubHeader.tsx',
  'src/renderer/components/leftBars/LeftSidebarHeader.tsx',
  'src/renderer/components/rightBars/RightSidebarHeader.tsx',
  'src/renderer/components/rightBars/ReviewPanel.tsx',
  'src/assets/fonts/sarasa-mono-sc/SarasaMonoSC-Regular.woff2',
  'src/assets/fonts/sarasa-mono-sc/LICENSE',
  'src/assets/fonts/sarasa-mono-sc/provenance.json',
  'package.json', 'pnpm-lock.yaml',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source).update(readFileSync(source));
  return hash.digest('hex');
};
function validate(run) {
  assert.equal(run.status, 'passed');
  assert(run.viewport[0] >= 600 && run.viewport[1] >= 600);
  assert.equal(run.fontFaces.length, 5);
  assert(run.fontFaces.every(face => face.loaded));
  assert.equal(run.mobileFallback, true);
  assert.equal(run.samples.length, 24);
  for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
    for (const size of ['small', 'standard', 'large']) for (const panel of ['nodes', 'elements']) {
      const sample = run.samples.find(item => item.locale === locale && item.theme === theme && item.size === size && item.panel === panel);
      assert(sample, `${locale}/${theme}/${size}/${panel}`);
      assert(Object.values(sample.checks).every(value => value === true));
      const expected = { tabs: 'Newsreader Variable', structure: 'Noto Serif SC Variable', subheader: 'Sarasa Mono SC', filters: 'Sarasa Mono SC', entities: 'Noto Sans SC Variable', review: 'Source Sans 3 Variable' };
      if (panel === 'elements') expected.groups = 'Sarasa Mono SC';
      for (const [role, family] of Object.entries(expected)) {
        assert(sample.roles[role].length > 0);
        assert(sample.roles[role].every(item => item.fontFamily.includes(family)), `${role}: ${family}`);
      }
      assert(Math.abs(sample.monoAdvances[0] - sample.monoAdvances[1]) < 0.2);
    }
  }
}
const args = process.argv.slice(2);
if (args[0] === '--record') {
  assert.equal(args.length, 3, 'Pass the unmodified wide and narrow browser reports.');
  const runs = args.slice(1).map(file => JSON.parse(readFileSync(file, 'utf8')));
  runs.forEach(validate);
  assert(runs[0].viewport[0] >= 1000 && runs[1].viewport[0] < 900);
  assert.deepEqual(runs[0].prose, runs[1].prose);
  writeFileSync(output, JSON.stringify({ kind: 'interface-font-roles', fingerprint: fingerprint(), sources, runs }, null, 2) + '\n');
} else assert.deepEqual(args, ['--check']);
const evidence = JSON.parse(readFileSync(output, 'utf8'));
assert.equal(evidence.kind, 'interface-font-roles');
assert.equal(evidence.fingerprint, fingerprint(), 'Interface font evidence is stale; rerun the browser fixture.');
evidence.runs.forEach(validate);
const provenance = JSON.parse(readFileSync('src/assets/fonts/sarasa-mono-sc/provenance.json', 'utf8'));
assert.equal(sha256(readFileSync('src/assets/fonts/sarasa-mono-sc/SarasaMonoSC-Regular.woff2')), provenance.bundledWoff2Sha256);
console.log('Interface fonts passed: 48 real-component samples, both locales/themes/widths, three UI sizes and independent prose.');
