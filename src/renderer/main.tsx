import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../styles/index.css';
import App from './App';

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
      <BrowserRouter>
        <App />
      </BrowserRouter>
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
