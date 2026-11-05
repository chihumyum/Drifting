import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import viteConfiguration from '../../../vite.renderer.config';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');
const repositoryRoot = path.resolve(rendererRoot, '../..');
/** A repository-relative path with '/' separators, as on macOS and Linux. */
const repositoryPath = (file: string) => path.relative(repositoryRoot, file).split(path.sep).join('/');

type DeferredEntry = { id: string; entry: string };

/** The renderer build's deferred entries, read from the plugins it actually registers. */
function deferredEntries(): DeferredEntry[] {
  const config = viteConfiguration({ command: 'serve', mode: 'development' });
  return ((config.plugins ?? []) as unknown[]).flat(8).flatMap((plugin) => {
    const entry = (plugin as { api?: { deferredEntry?: DeferredEntry } } | null)?.api?.deferredEntry;
    return entry ? [entry] : [];
  });
}

/**
 * Static import closures as the production bundle sees them: esbuild elides
 * type-only and unused imports exactly as Vite's transform does. Dynamic
 * import() is not followed (Vite preloads that chunk's CSS itself), and neither
 * is a `virtual:` deferred entry (checked as its own entry).
 */
function staticImportClosures(read: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')) {
  const imports = new Map<string, string[]>();
  const resolveImport = (from: string, specifier: string): string | null => {
    if (specifier.startsWith('virtual:') || specifier.includes('?')) return null;
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return specifier.endsWith('.css') ? `npm:${specifier}` : null;
    const base = specifier.startsWith('@/')
      ? path.join(repositoryRoot, 'src', specifier.slice(2))
      : path.resolve(path.dirname(from), specifier);
    const file = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']
      .map((extension) => path.normalize(base + extension))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!file) throw new Error(`Unresolved import ${specifier} in ${path.relative(repositoryRoot, from)}`);
    return file;
  };
  const importsOf = (file: string): string[] => {
    const known = imports.get(file);
    if (known) return known;
    const found: string[] = [];
    imports.set(file, found);
    const loader = file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : /\.m?js$/.test(file) ? 'js' : null;
    if (!loader) return found;
    const { code } = transformSync(read(file), { loader, jsx: 'preserve', sourcefile: file });
    const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JSX);
    for (const statement of ast.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = resolveImport(file, specifier.text);
      if (resolved) found.push(resolved);
    }
    return found;
  };
  return (start: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [path.resolve(repositoryRoot, start)];
    for (let file = pending.pop(); file; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!file.startsWith('npm:')) pending.push(...importsOf(file));
    }
    return seen;
  };
}

/**
 * Stylesheets a deferred entry needs but the shell does not load. A deferred
 * entry is fetched by an ignored import(), so Vite emits no <link> or preload
 * for its CSS: the shell must already own every stylesheet the entry imports.
 * The shell is the HTML entry plus the project route-code gate, the same
 * closure as `scripts/renderer-feature-loading-closure.mjs`.
 */
function deferredStylesheetsOutsideShell(read?: (file: string) => string): string[] {
  const closure = staticImportClosures(read);
  const shell = shellClosure(closure);
  return deferredEntries().flatMap(({ entry }) => [...closure(entry)]
    .filter((file) => file.endsWith('.css') && !shell.has(file))
    .map((file) => `${entry} -> ${file.startsWith('npm:') ? file : repositoryPath(file)}`));
}

/** The Super View entries (`vite-plugins/deferred-super-views.ts`). */
const superViewEntryIds = ['virtual:graph-ui', 'virtual:story-graph', 'virtual:element-graph', 'virtual:memo-material'];

/**
 * Source modules that two Super View entries import but the shell does not.
 * Rollup splits each into a chunk both entries import statically: outside the
 * shell and outside the entries' retry keys, so a failed fetch of it cannot
 * be retried (`scripts/run-renderer-deferred-graphs.mjs` rejects it as a cold
 * dependency). Such code belongs behind the graph UI facade or with one owner.
 * The settings entries nest by design and have their own entry benchmark.
 */
function superViewModulesSharedOutsideShell(read?: (file: string) => string): string[] {
  const closure = staticImportClosures(read);
  const shell = shellClosure(closure);
  const owners = new Map<string, string[]>();
  const entries = deferredEntries().filter(({ id }) => superViewEntryIds.includes(id));
  expect(entries.map(({ id }) => id).sort()).toEqual([...superViewEntryIds].sort());
  for (const { entry } of entries) {
    for (const file of closure(entry)) {
      if (file.startsWith('npm:') || file.endsWith('.css') || shell.has(file)) continue;
      owners.set(file, [...(owners.get(file) ?? []), entry]);
    }
  }
  return [...owners].filter(([, entries]) => entries.length > 1)
    .map(([file, entries]) => `${repositoryPath(file)} <- ${entries.join(', ')}`);
}

/** The shell: the HTML entry plus the project route-code gate. */
function shellClosure(closure: ReturnType<typeof staticImportClosures>): Set<string> {
  const html = fs.readFileSync(path.join(repositoryRoot, 'index.html'), 'utf8');
  const htmlEntry = /<script type="module" src="\/([^"]+)"/.exec(html)?.[1];
  expect(htmlEntry).toBe('src/renderer/main.tsx');
  return new Set([...closure(htmlEntry!), ...closure('src/renderer/app/project-route-components.tsx')]);
}

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

  it('loads every stylesheet of a deferred entry with the shell, since its ignored import() injects none', () => {
    expect(deferredEntries().map(({ entry }) => entry)).toEqual(expect.arrayContaining([
      'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
      'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx',
      'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx',
      'src/renderer/features/graph/graph-ui-components.ts',
      'src/renderer/features/settings/panels/AgentSettingsPanel.tsx',
    ]));
    expect(deferredStylesheetsOutsideShell()).toEqual([]);
  });

  it('gives every module two Super View entries share to the shell or the graph UI facade', () => {
    expect(superViewModulesSharedOutsideShell()).toEqual([]);
  });

  it('reports a module two Super View entries share outside the shell', () => {
    const story = path.join(rendererRoot, 'shells/desktop/views/DesktopStoryGraphView.tsx');
    const sharedHook = (file: string) => {
      const text = fs.readFileSync(file, 'utf8');
      return file === story ? `${text}\nexport { useCanvasHoverCard } from '../../../features/graph/canvas-hover-card';` : text;
    };
    expect(superViewModulesSharedOutsideShell(sharedHook)).toEqual([
      'src/renderer/features/graph/canvas-hover-card.ts <- src/renderer/features/graph/graph-ui-components.ts, src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
    ]);
  });

  it('reports a deferred view stylesheet the shell stops owning', () => {
    const hoist = path.join(rendererRoot, 'shells/desktop/views/DeferredSuperViews.tsx');
    const withoutHoist = (file: string) => {
      const text = fs.readFileSync(file, 'utf8');
      return file === hoist ? text.replace(/^import '[^']*\/super-(element|memo-material)\.css';$/gm, '') : text;
    };
    expect(deferredStylesheetsOutsideShell(withoutHoist)).toEqual([
      'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx -> src/styles/super-memo-material.css',
      'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx -> src/styles/super-element.css',
    ]);
  });

  it('keeps heavy settings code deferred while basic preferences and Trash stay reachable', () => {
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
        if (['TrashSettingsPanel', 'BasicPreferencePanels'].includes(path.basename(target))) continue;
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
    expect(source('app/AppRoutes.tsx')).toContain('<DeferredProjectRoute view="workspace" />');
    expect(source('app/project-route-components.tsx')).toContain('<DesktopAppShell />');
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
    expect(source('shells/desktop/DesktopRightSidebar.tsx').split('\n').length).toBeLessThan(400);
    expect(source('components/agent/CompanionPanel.tsx').split('\n').length).toBeLessThan(20);
    expect(source('features/settings/desktop/DesktopSettingsModal.tsx').split('\n').length).toBeLessThan(
      500,
    );
    expect(source('features/agent/desktop/DesktopAgentPanel.tsx').split('\n').length).toBeLessThan(1000);
    expect(source('features/stats/EntityStatsContent.tsx').split('\n').length).toBeLessThan(900);
    expect(source('features/stats/AllChaptersStats.tsx').split('\n').length).toBeLessThan(450);
  });
});
