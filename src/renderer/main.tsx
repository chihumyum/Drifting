import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Buffer } from 'buffer';

// The unified application UI bundles one sans family and remains independent
// from the device-local font selected for chapter prose.
import '@fontsource-variable/inter-tight';
import '../styles/index.css';
import '../styles/comments-review.css';
import '../styles/entity-editors.css';
import '../styles/desktop-shell.css';
import '../styles/ui-controls.css';
import '../styles/workspace-navigation.css';
import '../styles/settings.css';
import '../styles/agent-activity.css';
import './lib/i18n';
import { installAIDevConsole } from './lib/ai';
import { registerCopilotCapability } from './lib/copilot/capability';
import { elementCandidateCapability } from './lib/copilot/capabilities/element-candidate';
import { elementPatchCapability } from './lib/copilot/capabilities/element-patch';
import { hydrateSessionToken } from './lib/session-token';
import { hydratePlatformRuntime } from './platform/runtime';
import { applyInitialThemeBeforeRender } from './lib/initial-theme';
import App from './App';

// Register Copilot capabilities once at app boot. Order doesn't matter —
// the runner reads them via capabilitiesForTrigger(...) on each fire.
registerCopilotCapability(elementCandidateCapability);
registerCopilotCapability(elementPatchCapability);

installAIDevConsole();

// Kept behind both Vite's compile-time DEV branch and an explicit opt-in. The
// dynamic module and its global debug registry are absent from release builds.
if (import.meta.env.DEV && import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG === '1') {
  void import('./lib/frontend-debug/bridge').then(({ installFrontendDebugBridge }) => {
    installFrontendDebugBridge();
  });
}

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

// A debug broker should not need UI automation merely to select its project.
// HashRouter reads this route on first render after auth/session hydration.
if (import.meta.env.DEV) {
  const debugProjectId = import.meta.env.VITE_DRIFTING_AGENT_DEBUG_PROJECT_ID?.trim();
  if (debugProjectId) {
    window.location.hash = `/project/${encodeURIComponent(debugProjectId)}`;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

async function bootstrap() {
  applyInitialThemeBeforeRender();
  await Promise.all([hydrateSessionToken(), hydratePlatformRuntime()]);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
