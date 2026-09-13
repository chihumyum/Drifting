/** Module caches contain code only, never credentials or provider instances. */
function shareCode<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => pending ??= Promise.resolve().then(load).catch(error => {
    pending = undefined;
    throw error;
  });
}

// Browser builds replace these imports with same-build URLs carrying retry keys.
// Plain imports remain usable in headless SSR, fixtures and Node tests.
export const loadOpenAIProviders = shareCode(() => import('./openai-compatible-runtime'));
export const loadGoogleProvider = shareCode(() => import('./google-runtime'));
