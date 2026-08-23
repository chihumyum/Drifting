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
    expect(routes).toContain(
      'isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />',
    );
    expect(settings).toContain("const active: StandaloneSettingsId = isStandaloneSettingsId");
    expect(settings).toContain(": 'sync';");
    expect(settings).toContain(
      '<SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />',
    );
    expect(settings).not.toContain('TrashRailPanel');
    expect(settings).not.toContain('AgentPanel');
    expect(settings).not.toContain('ProjectRuntimeProvider');
  });
});
