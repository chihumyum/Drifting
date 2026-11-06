import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('desktop standalone settings', () => {
  it('lets a project-less user open Google sign-in and sync controls from the shelf menu', () => {
    const menu = read('src/renderer/components/topBars/UserMenu.tsx');
    const routes = read('src/renderer/app/AppRoutes.tsx');
    const settings = read(
      'src/renderer/features/settings/desktop/DesktopStandaloneSettingsView.tsx',
    );

    expect(menu).toContain("scope === 'shelf'");
    expect(menu).toContain("navigate('/settings?section=sync', { state: { from: '/' } })");
    expect(routes).not.toContain('<DeferredProjectRoute view="settings" />');
    expect(routes).toContain(
      'isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />',
    );
    expect(settings).toContain("const active: StandaloneSettingsId = isStandaloneSettingsId");
    expect(settings).toContain(": 'sync';");
    expect(read('src/renderer/features/settings/StandaloneSettingsPanel.tsx')).toContain(
      '<SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />',
    );
    expect(settings).not.toContain('TrashRailPanel');
    expect(settings).not.toContain('AgentPanel');
    expect(settings).not.toContain('ProjectRuntimeProvider');
  });

  it('offers every setting that does not belong to the open book, each loaded on selection', () => {
    const settings = read(
      'src/renderer/features/settings/desktop/DesktopStandaloneSettingsView.tsx',
    );
    const panels = read('src/renderer/features/settings/StandaloneSettingsPanel.tsx');
    const rail = settings.slice(
      settings.indexOf('const STANDALONE_SETTINGS_GROUPS'),
      settings.indexOf('const STANDALONE_SETTINGS_IDS'),
    );
    const ids = [...rail.matchAll(/\{ id: '([a-z]+)'/g)].map((match) => match[1]);

    expect(ids).toEqual([
      'account', 'appearance', 'editor', 'language', 'models', 'proactive', 'mcp',
      'keys', 'sync', 'updates', 'privacy', 'about',
    ]);
    expect(rail).toContain("labelKey: 'settings.groups.intelligence'");
    // The trash and the Agent panel read the open book; they stay in the project.
    expect(ids).not.toContain('trash');
    expect(ids).not.toContain('agent');

    expect(panels).toContain("await import('./panels/PreferenceSettingsPanels')");
    expect(panels).toContain("await import('./panels/IntelligenceSettingsPanels')");
    expect(panels).toContain("case 'keys': return <KeysPanel registerRef={REGISTER_NOOP} />;");
    expect(panels).not.toContain('AgentSettingsPanel');
    expect(panels).not.toContain('TrashSettingsPanel');
  });

  it('changes the one 主动建议 switch that every book Home shows', () => {
    const settings = read(
      'src/renderer/features/settings/desktop/DesktopStandaloneSettingsView.tsx',
    );
    const panels = read('src/renderer/features/settings/StandaloneSettingsPanel.tsx');
    const home = read('src/renderer/views/ProjectDashboard.tsx');

    expect(settings).toContain(
      "{ id: 'proactive', icon: 'tea', labelKey: 'projectHome.settings.proactive' }",
    );
    expect(home).toContain("t('projectHome.settings.proactive')");
    // Loaded with the panel, so the shelf's settings entry stays small.
    expect(panels).toContain("await import('../../store/project-checkin-store')");
    expect(panels).not.toMatch(/^import .*project-checkin-store/m);
    expect(panels).toContain('useProjectCheckinStore((state) => state.enabled)');
    expect(panels).toContain('useProjectCheckinStore((state) => state.setEnabled)');
    expect(home).toContain('useProjectCheckinStore((s) => s.enabled)');
  });
});
