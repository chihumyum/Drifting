import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportPath = path.join(root, 'docs/agent-runtime/acceptance/todo-agent-handoff.json');
const suites = [
  'src/renderer/store/agent-todo-background.integration.test.ts',
  'src/renderer/features/comments/todo-agent-task.test.ts',
  'src/renderer/lib/agent/runtime/system-prompt.test.ts',
];
const sourceFiles = [
  'src/renderer/domain/comment.ts',
  'src/renderer/features/comments/ReviewItemCard.tsx',
  'src/renderer/features/comments/CommentBodyEditor.tsx',
  'src/renderer/features/comments/TodoStatusToggle.tsx',
  'src/renderer/features/comments/CommentSourceHoverCard.tsx',
  'src/renderer/features/comments/use-comment-source-hover.ts',
  'src/renderer/features/comments/comment-source-preview.ts',
  'src/renderer/components/rightBars/EntityRelationPicker.tsx',
  'src/renderer/features/comments/todo-agent-task.ts',
  'src/renderer/lib/agent/runtime/chat-run-projection.ts',
  'src/renderer/lib/agent/runtime/chat-start-owner.ts',
  'src/renderer/lib/agent/runtime/system-prompt.ts',
  'src/renderer/store/agent-chat-store.ts',
  'src/renderer/usecase/useComment.ts',
  'src/renderer/components/rightBars/ReviewPanel.tsx',
  'src/renderer/components/leftBars/SortMenu.tsx',
  'src/renderer/store/ui-store.ts',
  'src/renderer/components/editor/StickyNoteRail.tsx',
  'src/renderer/shells/desktop/DesktopRightSidebar.tsx',
  'src/renderer/shells/mobile/workspace/MobileRightSidebar.tsx',
  'src/styles/comments-review.css',
  'src/renderer/locales/zh-CN.json',
  'src/renderer/locales/en.json',
  ...suites,
  'scripts/run-agent-todo-handoff-acceptance.mjs',
];
const hash = () => {
  const digest = createHash('sha256');
  for (const file of sourceFiles) {
    digest.update(file);
    digest.update(readFileSync(path.join(root, file)));
  }
  return digest.digest('hex');
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.kind, 'todo_agent_handoff_acceptance');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.suites, suites);
  assert.equal(report.sourceSha256, hash(), 'Todo Agent handoff evidence is stale');
  assert(report.tests.length >= 12 && report.tests.every((test) => test.status === 'passed'));
  console.log(`Todo Agent handoff evidence matches source: ${report.tests.length} synthetic checks.`);
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-todo-agent-'));
  try {
    const output = path.join(temporary, 'vitest.json');
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${output}`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const data = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(data.numFailedTests, 0);
    assert.equal(data.numPendingTests, 0);
    const tests = data.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({
      name: test.fullName,
      status: test.status,
    })));
    const report = {
      kind: 'todo_agent_handoff_acceptance',
      status: 'passed',
      generatedAt: new Date().toISOString(),
      sourceSha256: hash(),
      suites,
      tests,
      boundary: { level: 'E1', provider: 'synthetic', nativeInteraction: 'not_run' },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Todo Agent handoff acceptance: ${tests.length} synthetic checks passed.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
