import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RenderErrorBoundary } from '../components/RenderErrorBoundary';

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
});
