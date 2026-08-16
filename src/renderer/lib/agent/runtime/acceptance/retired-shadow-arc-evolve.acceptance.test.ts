import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const core = process.cwd();
const read = (path: string) => readFileSync(resolve(core, path), 'utf8');

describe('retired Shadow, Element Arc, and Goal Evolve product boundary', () => {
  it('removes the three feature runtimes and author-facing entry points', () => {
    for (const path of [
      'src/renderer/lib/shadow',
      'src/renderer/lib/goal',
      'src/renderer/components/rightBars/ShadowPanel.tsx',
      'src/renderer/components/ShadowQuickMenu.tsx',
      'src/renderer/components/editor/ArcSection.tsx',
      'src/renderer/components/editor/EvolveSection.tsx',
      'src/renderer/lib/ai/output-language.ts',
    ]) {
      expect(existsSync(resolve(core, path)), path).toBe(false);
    }

    const settings = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const sidebar = read('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const agentGuidance = read('AGENTS.md');
    expect(settings).not.toContain('function ShadowPanel(');
    expect(sidebar).not.toContain('id="shadow"');
    expect(agentGuidance).not.toContain('eval:shadow');
    expect(agentGuidance).toContain('## Retired Agent Products');
  });

  it('removes feature-only tools and tables while retaining General Agent writes', () => {
    const registry = read('src/renderer/lib/agent/tool-registry.ts');
    const schema = read('src/renderer/schema/drizzle.ts');
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(registry).not.toContain('shadow_read_');
    expect(registry).not.toContain('shadow_eval_');
    expect(registry).not.toContain('shadow_commit_');
    expect(registry).not.toContain('shadow-internal');
    expect(registry).toContain("name: 'edit_block'");
    expect(registry).toContain("name: 'edit_blocks'");
    expect(registry).toContain("name: 'create_element_patch'");

    expect(schema).not.toContain("sqliteTable('project_rule'");
    expect(schema).not.toContain("'shadow_job'");
    expect(schema).not.toContain("'element_arc'");
    expect(schema).not.toContain("'ai_usage'");
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith('eval:shadow'))).toBe(
      false,
    );
    expect(packageJson.dependencies).not.toHaveProperty('zod');
  });

  it('keeps retired product objects out of the current local-first baseline', () => {
    const baseline = read('drizzle/0000_local_first_baseline.sql');
    expect(baseline).toContain('CREATE TABLE `book_node`');
    expect(baseline).toContain('CREATE TABLE `comment`');
    expect(baseline).not.toMatch(
      /CREATE TABLE [`"]?(?:element_arc|shadow_job|project_rule|ai_usage)[`"]?/,
    );
  });
});
