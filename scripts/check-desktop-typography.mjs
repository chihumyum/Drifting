import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/qa/desktop-typography.json');
const sources = [
  'scripts/agent-typography-fixture.tsx',
  'src/styles/agent-panel.css',
  'src/renderer/features/agent/AgentMessageViews.tsx',
  'src/renderer/features/agent/desktop/DesktopAgentPanel.tsx',
  'src/renderer/features/agent/desktop/DesktopAgentTranscript.tsx',
  'src/renderer/hooks/useAutosizeTextArea.ts',
  'scripts/desktop-typography-ui.html', 'scripts/desktop-typography-ui.tsx',
  'src/styles/desktop-typography.css', 'src/styles/index.css',
  'src/styles/ui-controls.css', 'src/styles/settings.css', 'src/styles/bottom-status-bar.css',
  'src/renderer/components/ui/PanelTabs.tsx', 'src/renderer/components/ui/ContextMenuSurface.tsx',
  'src/renderer/components/ui/SegmentedControl.tsx',
  'src/renderer/features/settings/SettingsPrimitives.tsx',
  'src/renderer/features/settings/panels/BasicPreferencePanels.tsx',
  'src/renderer/lib/interface-typography.ts', 'src/renderer/store/settings-store.ts',
  'src/renderer/app/effects/AppEffects.tsx', 'src/renderer/main.tsx',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
  'src/renderer/components/leftBars/LeftSidebarHeader.tsx',
  'src/renderer/components/rightBars/RightSidebarHeader.tsx',
  'src/renderer/shells/desktop/DesktopSidebarLayout.tsx',
  'src/renderer/hooks/useSidebarTabMinimumWidth.ts',
  'src/renderer/store/sidebar-metrics-store.ts',
  'src/renderer/lib/layout-geometry.ts',
];
function fingerprint() {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source).update(readFileSync(path.join(root, source)));
  return hash.digest('hex');
}
function validateRun(run) {
  assert.equal(run.status, 'passed');
  assert.equal(run.samples.length, 6);
  for (const dark of ['light', 'dark']) for (const size of ['small', 'standard', 'large']) {
    const key = `${dark}:${size}`;
    for (const check of ['body', 'caption', 'panelTab', 'description', 'heading', 'prose', 'wrapping', 'portal', 'viewport', 'footerInset', 'contrast', 'settingsFit', 'agentConversation', 'sidebarDensity']) {
      assert.equal(run.checks[`${key}:${check}`], true, `${key}:${check}`);
    }
    const sample = run.samples.find((item) => item.key === key);
    const expected = {
      small: ['12.5px', '10px', '11.5px', '12px', '10px'],
      standard: ['14px', '12px', '13px', '13px', '16px'],
      large: ['16px', '14px', '15px', '15px', '18px'],
    }[size];
    assert.deepEqual([sample.body, sample.caption, sample.panelTab, sample.description, sample.heading], expected);
    const agentExpected = { small: [12, 11.5, 10.5, 13.5], standard: [14, 13, 12, 16], large: [16, 15, 14, 18] }[size];
    assert.equal(sample.agent.length, 2);
    assert.equal(sample.sidebars.length, 12);
    for (const sidebar of sample.sidebars) {
      assert(sidebar.passed && sidebar.fits);
      assert.equal(sidebar.threshold, sidebar.min * 2 + 1);
      assert.equal(sidebar.panes, sidebar.width >= sidebar.threshold ? 2 : 1);
    }
    for (const pane of sample.agent) {
      for (const role of ['body', 'user', 'composer', 'code', 'inlineCode']) assert.equal(pane[role], agentExpected[0]);
      for (const role of ['thinking', 'tool']) assert.equal(pane[role], agentExpected[1]);
      assert.equal(pane.caption, agentExpected[2]); assert.equal(pane.heading, agentExpected[3]);
      assert(Math.abs(pane.lineHeight - agentExpected[0] * 1.4) < 0.1);
      assert(Math.abs(pane.composerLineHeight - agentExpected[0] * 1.4) < 0.1);
      for (const check of ['codeScrolls', 'fits', 'composerFits', 'composerResizes']) assert.equal(pane[check], true);
    }
    assert.equal(sample.footerHeight, size === 'large' ? 26 : 24);
    assert(sample.contrast >= 4.5);
  }
  assert.equal(run.checks.mobileFallback, true);
  assert.equal(run.checks.mobileProse, true);
  assert(Object.values(run.checks).every((value) => value === true));
}
const args = process.argv.slice(2);
if (args[0] === '--record') {
  assert.equal(args.length, 3, 'Pass the wide and narrow JSON files exported by the synthetic browser fixture.');
  const runs = args.slice(1).map((file) => JSON.parse(readFileSync(file, 'utf8')));
  runs.forEach(validateRun);
  assert.deepEqual(runs.map((run) => run.viewport), [[1280, 720], [800, 720]]);
  writeFileSync(output, JSON.stringify({ kind: 'desktop-typography', fingerprint: fingerprint(), sources, runs }, null, 2) + '\n');
} else {
  assert.deepEqual(args, ['--check']);
}
const evidence = JSON.parse(readFileSync(output, 'utf8'));
assert.equal(evidence.kind, 'desktop-typography');
assert.equal(evidence.fingerprint, fingerprint(), 'Typography evidence is stale; rerun the browser fixture.');
assert.deepEqual(evidence.runs.map((run) => run.viewport), [[1280, 720], [800, 720]]);
evidence.runs.forEach(validateRun);
console.log('Desktop typography browser evidence passed (two widths, three text sizes, two themes).');
