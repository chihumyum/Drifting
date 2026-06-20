import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Buffer } from 'buffer';
import '../styles/index.css';
import '../styles/settings.css';
import '../styles/agent-activity.css';
import './lib/i18n';
import { installAIDevConsole } from './lib/ai';
import { registerCopilotCapability } from './lib/copilot/capability';
import { elementCandidateCapability } from './lib/copilot/capabilities/element-candidate';
import { elementPatchCapability } from './lib/copilot/capabilities/element-patch';
import App from './App';

// Register Copilot capabilities once at app boot. Order doesn't matter —
// the runner reads them via capabilitiesForTrigger(...) on each fire.
registerCopilotCapability(elementCandidateCapability);
registerCopilotCapability(elementPatchCapability);

installAIDevConsole();

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Fallback for Electron dev: if React Fast Refresh misses a boundary,
// force a full-page reload so edits are still reflected immediately.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', (payload) => {
    const hasScriptUpdate = payload.updates.some((update) => update.type === 'js-update');
    if (hasScriptUpdate) {
      window.location.reload();
    }
  });
}
