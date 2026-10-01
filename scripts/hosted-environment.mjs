/** One exact service origin for the renderer, CSP and compiled native transport. */
export function normalizeHostedOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
    throw new TypeError('DRIFTING_HOSTED_ORIGIN must be an exact HTTP(S) origin without credentials, path or wildcards.');
  }
  return url.origin;
}

export function hostedEnvironment(shell, local = {}) {
  const configuredOrigin = environment => environment.DRIFTING_HOSTED_ORIGIN
    || environment.VITE_API_BASE_URL || environment.API_BASE_URL;
  const origin = normalizeHostedOrigin(configuredOrigin(shell) || configuredOrigin(local) || 'http://localhost:3000');
  return {
    VITE_LOCAL_ONLY_MODE: 'false', VITE_REQUIRE_AUTH: 'false',
    VITE_AI_TRANSPORT: 'direct', VITE_CLOSED_BETA: 'false',
    DRIFTING_HOSTED_ORIGIN: origin, VITE_API_BASE_URL: origin, API_BASE_URL: origin,
  };
}

export function hostedSecurityOverride(config, origin) {
  const normalized = normalizeHostedOrigin(origin);
  const addOrigin = csp => csp.replace(/\bconnect-src\b[^;]*/, directive =>
    directive.split(/\s+/).includes(normalized) ? directive : `${directive} ${normalized}`);
  return { csp: addOrigin(config.app.security.csp), devCsp: addOrigin(config.app.security.devCsp) };
}
