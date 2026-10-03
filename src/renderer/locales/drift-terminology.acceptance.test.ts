import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx']);

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

describe('Ideas / 构想 terminology acceptance', () => {
  it('uses Ideas / 构想 on the principal author-facing surfaces', () => {
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

    expect(zh.driftPanel.tabLabel).toBe('构想');
    expect(zh.leftSidebar.tabs.drifts).toBe('构想');
    expect(zh.leftSidebar.actions.newDrift).toBe('新构想');
    expect(zh.importDialog.targets.inspiration.label).toBe('构想');
    expect(zh.relationPicker.groups.drifts).toBe('构想');
    expect(zh.settings.editor.entity_link_kind_drift).toBe('构想');
    expect(zh.settings.copilot.enableInDrift).toBe('在构想编辑器中启用');
    expect(zh.nodeEditor.folio.drift).toBe('构想');
    expect(zh.editorTopBar.statusSection.drift).toBe('构想状态');

    const en = JSON.parse(source('src/renderer/locales/en.json')) as typeof zh;
    expect(en.driftPanel.tabLabel).toBe('Ideas');
    expect(en.leftSidebar.tabs.drifts).toBe('Ideas');
    expect(en.leftSidebar.actions.newDrift).toBe('New idea');
    expect(en.importDialog.targets.inspiration.label).toBe('Idea');
    expect(en.relationPicker.groups.drifts).toBe('Ideas');
    expect(en.settings.editor.entity_link_kind_drift).toBe('Idea');
    expect(en.settings.copilot.enableInDrift).toBe('Enable in idea editors');
    expect(en.nodeEditor.folio.drift).toBe('Idea');
    expect(en.editorTopBar.statusSection.drift).toBe('Idea status');

    const values = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(values)
          : [];
    expect(values(en).filter((value) => /\b(?:drifts?|inspirations?|floating nodes?)\b/iu.test(value))).toEqual([]);
  });

  it('uses 构想 in Agent-facing labels and teaches the internal-name boundary', () => {
    const activity = source('src/renderer/lib/agent/agent-tool-activity.ts');
    const workspace = source('src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts');
    const prompt = source('src/renderer/lib/agent/runtime/system-prompt.ts');

    expect(activity).toContain("list_inspirations: ['查看构想列表', 'Review ideas']");
    expect(workspace).toContain("'/drifts': '构想'");
    expect(prompt).toContain('Call drift nodes ideas in English and 构想 in Chinese; they are not element categories.');
  });

  it('keeps retired labels out of active product copy while preserving input aliases and archives', () => {
    const previousLabel = ['灵', '感'].join('');
    const inputAliases: Record<string, string[]> = {
      'docs/editor/drift-terminology.md': [`Legacy input aliases \`${previousLabel}\``],
      'src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts': [
        `(?:构想|${previousLabel}|漂移)`,
        `(章节|构想|${previousLabel}|漂移)`,
        `'/${previousLabel}': '/drifts'`,
      ],
      'src/renderer/lib/agent/runtime/drifting-product-composition.ts': [
        `(?:构想|${previousLabel}|漂移)`,
      ],
      'src/renderer/sqlite-repo/agent-runtime-long-task-repo.ts': [
        `(?:构想|${previousLabel}|漂移)`,
      ],
      'src/renderer/lib/agent/runtime/drifting-tool-selection.ts': [
        `漂流节点|构想|${previousLabel}`,
      ],
    };
    const files = ['README.md', 'docs', 'src/renderer'].flatMap((path) =>
      collectTextFiles(resolve(process.cwd(), path)),
    );
    const violations = files
      .filter((path) => {
        let text = readFileSync(path, 'utf8');
        if (text.includes(['浮', '缀'].join(''))) return true;
        const relativePath = relative(process.cwd(), path).replaceAll('\\', '/');
        if (relativePath.startsWith('docs/apple-native/') || relativePath.startsWith('docs/qa/')) {
          return false;
        }
        for (const alias of inputAliases[relativePath] ?? []) text = text.replaceAll(alias, '');
        return text.includes(previousLabel);
      })
      .map((path) => relative(process.cwd(), path));

    expect(violations).toEqual([]);
  });

  it('documents the stable internal contract separately from the Chinese label', () => {
    const contract = source('docs/editor/drift-terminology.md');

    expect(contract).toContain('`Drift` remains the canonical internal domain name');
    expect(contract).toContain('English feature and collection label is **Ideas**');
    expect(contract).toContain('Simplified Chinese product label for a Drift is **构想**');
    expect(contract).toContain('does not migrate persisted data or change API/tool contracts');
  });
});
