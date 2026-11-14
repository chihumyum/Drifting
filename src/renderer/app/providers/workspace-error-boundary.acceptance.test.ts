import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RenderErrorBoundary } from '../components/RenderErrorBoundary';
import { reportError } from '../../services/diagnostics/crash-reporter';

vi.mock('../../services/diagnostics/crash-reporter', () => ({ reportError: vi.fn() }));

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('workspace render failures and the Agent tool bridge', () => {
  it('catches workspace render failures below the project runtime that owns the Agent tools', () => {
    // Smoke: a storage quota error in an editor replaced the whole window,
    // unmounted the tool bridge and failed the running Agent turn on its next
    // tool call. The workspace boundary keeps the provider (and the bridge) up.
    const provider = source('./ProjectRuntimeProvider.tsx');
    const bridge = provider.indexOf('useAgentToolBridge(projectId,');
    const runtime = provider.indexOf('useDriftingAgentRuntime();');
    const boundary = provider.indexOf('<RenderErrorBoundary scope="workspace">{children}</RenderErrorBoundary>');
    expect(bridge).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(bridge);
    expect(boundary).toBeGreaterThan(runtime);
    expect(provider.match(/\{children\}/g)).toHaveLength(1);

    const app = source('../../App.tsx');
    expect(app).toContain('<RenderErrorBoundary scope="app">');
    expect(app).not.toContain('class RootErrorBoundary');
  });

  it('turns a render failure into a retryable stop screen', () => {
    const error = new Error('The quota has been exceeded.');
    expect(RenderErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });

  it('reports which boundary caught the failure and the components it passed through', () => {
    // The update loops of 0.1.0-alpha.10/11 (React #185) reached the service
    // with React's frames alone; the component stack places them.
    const boundary = new RenderErrorBoundary({ scope: 'workspace', children: null });
    const error = new Error('Minified React error #185');
    boundary.componentDidCatch(error, {
      componentStack: '\n    at D (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:88399)\n    at div',
    });
    expect(reportError).toHaveBeenCalledWith('render-failure', error, 'fatal', {
      scope: 'workspace',
      component1: 'at D (http://tauri.localhost/assets/project-route-components-BrUnSqTM.js:32:88399)',
    });
  });
});
