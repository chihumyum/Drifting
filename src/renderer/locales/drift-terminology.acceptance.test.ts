import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const textExtensions = new Set(['.css', '.js', '.json', '.md', '.mjs', '.ts', '.tsx']);

function collectTextFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return textExtensions.has(extname(path)) ? [path] : [];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? collectTextFiles(child)
      : textExtensions.has(extname(entry.name))
        ? [child]
        : [];
  });
}

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Drift Chinese terminology acceptance', () => {
  it('uses 灵感 on the principal author-facing surfaces', () => {
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as {
      settings: {
        editor: { entity_link_kind_drift: string };
        copilot: { enableInDrift: string };
      };
      driftPanel: { tabLabel: string };
      relationPicker: { groups: { drifts: string } };
      importDialog: { targets: { inspiration: { label: string } } };
      leftSidebar: { tabs: { drifts: string }; actions: { newDrift: string } };
      nodeEditor: { folio: { drift: string } };
      editorTopBar: { statusSection: { drift: string } };
    };

    expect(zh.driftPanel.tabLabel).toBe('灵感');
    expect(zh.leftSidebar.tabs.drifts).toBe('灵感');
    expect(zh.leftSidebar.actions.newDrift).toBe('新灵感');
    expect(zh.importDialog.targets.inspiration.label).toBe('灵感');
    expect(zh.relationPicker.groups.drifts).toBe('灵感');
    expect(zh.settings.editor.entity_link_kind_drift).toBe('灵感');
    expect(zh.settings.copilot.enableInDrift).toBe('在灵感编辑器中启用');
    expect(zh.nodeEditor.folio.drift).toBe('灵感');
    expect(zh.editorTopBar.statusSection.drift).toBe('灵感状态');
  });

  it('uses 灵感 in Agent-facing labels and teaches the internal-name boundary', () => {
    const activity = source('src/renderer/lib/agent/agent-tool-activity.ts');
    const workspace = source('src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts');
    const prompt = source('src/renderer/lib/agent/runtime/system-prompt.ts');

    expect(activity).toContain("list_inspirations: ['查看灵感列表', 'Review inspirations']");
    expect(workspace).toContain("'/drifts': '灵感'");
    expect(prompt).toContain('The Chinese product label for a drift node is 灵感.');
    expect(prompt).toContain('Use 灵感 in Chinese author-facing responses.');
  });

  it('keeps renderer source and durable documentation free of the retired label', () => {
    const retiredLabel = ['浮', '缀'].join('');
    const files = ['README.md', 'docs', 'src/renderer'].flatMap((path) =>
      collectTextFiles(resolve(process.cwd(), path)),
    );
    const violations = files
      .filter((path) => readFileSync(path, 'utf8').includes(retiredLabel))
      .map((path) => relative(process.cwd(), path));

    expect(violations).toEqual([]);
  });

  it('documents the stable internal contract separately from the Chinese label', () => {
    const contract = source('docs/editor/drift-terminology.md');

    expect(contract).toContain('`Drift` remains the canonical internal domain name');
    expect(contract).toContain('Simplified Chinese product label for a Drift is **灵感**');
    expect(contract).toContain('does not migrate persisted data or change API/tool contracts');
  });
});
