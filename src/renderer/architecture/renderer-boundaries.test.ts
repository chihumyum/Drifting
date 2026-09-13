import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');
}

function sourceFiles(relativeDirectory: string): string[] {
  const root = path.join(rendererRoot, relativeDirectory);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

describe('renderer ownership boundaries', () => {
  it('keeps super view bodies and shared graph UI behind their owned deferred entries', () => {
    const deferred = [
      'shells/desktop/views/DesktopStoryGraphView',
      'shells/desktop/views/DesktopSuperElementView',
      'shells/desktop/views/DesktopSuperMemoMaterialView',
      'features/graph/graph-ui-components',
    ].map((relative) => path.join(rendererRoot, relative));
    for (const file of sourceFiles('')) {
      const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const imported = specifier.text.startsWith('@/')
          ? path.resolve(rendererRoot, '..', specifier.text.slice(2))
          : path.resolve(path.dirname(file), specifier.text);
        expect(deferred, `${path.relative(rendererRoot, file)} bypasses a graph loader`)
          .not.toContain(imported.replace(/\.(ts|tsx)$/, ''));
      }
    }
  });

  it('keeps settings code behind its deferred entry while Trash stays independently reachable', () => {
    const settingsRoot = path.join(rendererRoot, 'features/settings');
    const facade = path.join(settingsRoot, 'settings-panels');
    for (const file of sourceFiles('')) {
      const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const imported = specifier.text.startsWith('@/')
          ? path.resolve(rendererRoot, '..', specifier.text.slice(2))
          : path.resolve(path.dirname(file), specifier.text);
        const target = imported.replace(/\.(ts|tsx)$/, '');
        expect(target, `${path.relative(rendererRoot, file)} eagerly imports settings`).not.toBe(facade);
        if (!target.startsWith(path.join(settingsRoot, 'panels') + path.sep)) continue;
        if (target.endsWith('/TrashSettingsPanel')) continue;
        expect(
          file === `${facade}.ts` || file.startsWith(path.join(settingsRoot, 'panels') + path.sep),
          `${path.relative(rendererRoot, file)} bypasses the deferred settings entry`,
        ).toBe(true);
      }
    }
  });

  it('requires explicit workspace fields or selectors in product consumers', () => {
    for (const directory of ['app', 'components', 'features', 'hooks', 'shells', 'views']) {
      for (const file of sourceFiles(directory)) {
        const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useDataStore') {
            expect(node.arguments.length, `${path.relative(rendererRoot, file)} subscribes to the entire workspace`).toBeGreaterThan(0);
          }
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
    }
  });

  it('keeps shared features independent from the desktop shell and desktop navigation store', () => {
    for (const file of sourceFiles('features')) {
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(/from ['"][^'"]*shells\/desktop/);
      expect(contents, file).not.toMatch(/from ['"][^'"]*hooks\/useProjectNavigation/);
      expect(contents, file).not.toMatch(/from ['"][^'"]*store\/ui-store/);
    }
  });

  it('keeps mobile shell code independent from desktop shell and desktop navigation state', () => {
    for (const file of sourceFiles('shells/mobile')) {
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents, file).not.toMatch(/from ['"][^'"]*shells\/desktop/);
      expect(contents, file).not.toMatch(/from ['"][^'"]*store\/ui-store/);
    }
  });

  it('keeps the app entry small and delegates project UI to DesktopAppShell', () => {
    const app = source('App.tsx');
    expect(app.split('\n').length).toBeLessThanOrEqual(120);
    expect(source('app/AppRoutes.tsx')).toContain('<DesktopAppShell />');
    expect(source('shells/desktop/DesktopAppShell.tsx')).toContain(
      '<DesktopWorkspaceNavigationBoundary',
    );
  });

  it('contains child-route subscriptions inside the desktop navigation boundary', () => {
    const compatibilityHook = source('hooks/useProjectNavigation.ts');
    expect(compatibilityHook).toContain('useWorkspaceNavigator()');
    expect(compatibilityHook).not.toMatch(/useLocation|useNavigate|useParams/u);

    const boundary = source(
      'shells/desktop/navigation/DesktopWorkspaceNavigationBoundary.tsx',
    );
    expect(boundary).toContain('useDesktopWorkspaceNavigator(projectId)');
    expect(boundary).toContain('useSyncSplitFocusedUrl(navigator)');
    expect(boundary).toContain('<WorkspaceNavigationProvider navigator={navigator}>');

    const adapter = source('shells/desktop/navigation/useDesktopWorkspaceNavigator.ts');
    expect(adapter).toContain('const pathnameRef = useRef(location.pathname)');
    expect(adapter).toContain('const navigateRef = useRef(routerNavigate)');
    expect(adapter).toContain('useLayoutEffect(() =>');
    expect(adapter).toContain('useMemo<WorkspaceNavigator>');

    const shell = source('shells/desktop/DesktopAppShell.tsx');
    expect(shell).toContain('projectId={projectId}');
    expect(shell).not.toMatch(/useLocation|useNavigate|useSyncSplitFocusedUrl/u);
  });

  it('keeps compatibility barrels thin after feature extraction', () => {
    expect(source('components/rightBars/MemoMaterialPanel.tsx').split('\n').length).toBeLessThan(20);
    expect(source('components/BottomTimeline/BottomTimeline.tsx').split('\n').length).toBeLessThan(20);
    expect(source('views/StoryGraphView.tsx').split('\n').length).toBeLessThan(20);
    expect(source('views/SuperViews/SuperElementView.tsx').split('\n').length).toBeLessThan(20);
    expect(source('views/SuperViews/SuperMemoMaterialView.tsx').split('\n').length).toBeLessThan(20);
    expect(source('views/SuperViews/ElementCardPopover.tsx').split('\n').length).toBeLessThan(20);
    expect(source('components/ui/EntityHoverCard.tsx').split('\n').length).toBeLessThan(20);
    expect(source('components/ui/entity-hover-card-model.ts').split('\n').length).toBeLessThan(20);
    expect(source('components/modals/SettingsModal.tsx').split('\n').length).toBeLessThan(20);
    expect(source('components/rightBars/RightSidebarPanels.tsx').split('\n').length).toBeLessThan(20);
    expect(source('shells/desktop/DesktopRightSidebar.tsx').split('\n').length).toBeLessThan(400);
    expect(source('components/agent/CompanionPanel.tsx').split('\n').length).toBeLessThan(20);
    expect(source('features/settings/desktop/DesktopSettingsModal.tsx').split('\n').length).toBeLessThan(
      500,
    );
    expect(source('features/agent/desktop/DesktopAgentPanel.tsx').split('\n').length).toBeLessThan(1000);
    expect(source('features/stats/EntityStatsContent.tsx').split('\n').length).toBeLessThan(900);
    expect(source('features/stats/AllChaptersStats.tsx').split('\n').length).toBeLessThan(450);
    expect(source('components/editor/StickyNoteRail.tsx').split('\n').length).toBeLessThan(1200);
  });
});
