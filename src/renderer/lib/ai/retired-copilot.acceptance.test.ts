import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

import { useSettingsStore } from '../../store/settings-store';

const core = process.cwd();
const read = (path: string) => readFileSync(resolve(core, path), 'utf8');

describe('retired Copilot product boundary', () => {
  it('removes the Copilot runtime, structured-prompt substrate and author-facing entry points', () => {
    for (const path of [
      'src/renderer/lib/copilot',
      'src/renderer/components/copilot',
      'src/renderer/hooks/useCopilot.ts',
      'src/renderer/hooks/useSegmentMergeOnFinalize.ts',
      'src/renderer/store/copilot-inline-store.ts',
      'src/renderer/domain/copilot-suggestion.ts',
      'src/renderer/lib/ai/run-structured.ts',
      'src/renderer/lib/ai/prompts',
      'src/renderer/lib/ai/copilot-route.ts',
      'src/styles/copilot-surface.css',
      'docs/copilot',
    ]) {
      expect(existsSync(resolve(core, path)), path).toBe(false);
    }

    const settings = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const mobileSettings = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    const userMenu = read('src/renderer/components/topBars/UserMenu.tsx');
    const chapterEditor = read('src/renderer/components/editor/ChapterEditor.tsx');
    const entityEditor = read('src/renderer/hooks/useEntityEditor.ts');
    const models = read('src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx');
    expect(settings).not.toContain("id: 'copilot'");
    expect(mobileSettings).not.toContain("'copilot'");
    expect(userMenu).not.toContain('Copilot');
    expect(chapterEditor).not.toContain('Copilot');
    expect(entityEditor).not.toContain('Copilot');
    expect(models).not.toContain('provider="google"');
    expect(read('AGENTS.md')).toContain('Copilot (element extraction and patch suggestions');
  });

  it('keeps typed TODO markers projecting into todos without the Copilot switch', () => {
    const chapterEditor = read('src/renderer/components/editor/ChapterEditor.tsx');
    const todoParser = read('src/renderer/hooks/useTodoAutoParse.ts');
    expect(chapterEditor).toContain('<TodoAutoParseMount');
    expect(todoParser).not.toContain('copilotAutoTrigger');
    expect(todoParser).not.toContain("authorKind: 'copilot'");
  });

  it('keeps stored Copilot data readable', () => {
    const kernel = read('src/renderer/sync/reducer/production-domain-kernel.ts');
    const schema = read('src/renderer/schema/drizzle.ts');
    expect(kernel).toContain("authorKind: oneOf('user', 'ai', 'copilot', 'external')");
    expect(kernel).toContain("source: oneOf('manual', 'copilot', 'api')");
    expect(schema).toContain("sqliteTable(\n  'block_section'");
  });

  it('drops persisted Copilot preferences on migration', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const migrated = (await migrate(
      {
        copilotAutoTrigger: false,
        copilotByokProvider: 'google',
        copilotByokModel: 'gemini-2.5-flash',
        copilotTaskConfigs: { elementExtract: { enabled: true } },
        copilotOutputLangByProject: { project: 'en' },
        agentProvider: 'deepseek',
        agentModel: 'deepseek-v4-flash',
      },
      31,
    )) as Record<string, unknown>;
    expect(Object.keys(migrated).filter((key) => key.startsWith('copilot'))).toEqual([]);
    expect(migrated.agentProvider).toBe('deepseek');
  });
});
