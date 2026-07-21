import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Buffer } from 'buffer';

// Design-system fonts, bundled locally via @fontsource-variable so packaged
// builds render identical weights to dev without depending on an external font
// origin — and work fully offline inside the native webview.
// These replace the old `<link>` to fonts.googleapis.com in index.html. The CDN
// served these as variable fonts, so the variable packages are the faithful
// local equivalent: a managed @font-face with an explicit wght axis renders
// `font-weight: 400` as true Regular, fixing the packaged Noto Serif SC body
// text that previously fell back to the system variable font's ExtraLight
// default. Newsreader italic is included for prose `<em>`; the CDN did not
// request italic for the other families, so we don't bundle it either.
import '@fontsource-variable/newsreader';
import '@fontsource-variable/newsreader/wght-italic.css';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/noto-serif-sc';
import '../styles/index.css';
import '../styles/settings.css';
import '../styles/agent-activity.css';
import './lib/i18n';
import { installAIDevConsole } from './lib/ai';
import { registerCopilotCapability } from './lib/copilot/capability';
import { elementCandidateCapability } from './lib/copilot/capabilities/element-candidate';
import { elementPatchCapability } from './lib/copilot/capabilities/element-patch';
import { hydrateSessionToken } from './lib/session-token';
import { hydratePlatformRuntime } from './platform/runtime';
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

async function bootstrap() {
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

// Fallback for Tauri dev: if React Fast Refresh misses a boundary,
// force a full-page reload so edits are still reflected immediately.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', (payload) => {
    const hasScriptUpdate = payload.updates.some((update) => update.type === 'js-update');
    if (hasScriptUpdate) {
      window.location.reload();
    }
  });
}
