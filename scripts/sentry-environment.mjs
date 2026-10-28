/** Public DSN only. Upload credentials remain in the build process. */
export function sentryOrigin(environment) {
  if (environment.VITE_LOCAL_ONLY_MODE !== 'false' || !environment.VITE_SENTRY_DSN?.trim()) return null;
  let url;
  try { url = new URL(environment.VITE_SENTRY_DSN.trim()); } catch { throw new Error('VITE_SENTRY_DSN must be a valid HTTPS Sentry public DSN'); }
  if (url.protocol !== 'https:' || !/^[a-f0-9]{32}$/i.test(url.username) || url.password
    || !/^\/(?:[a-zA-Z0-9_-]+\/)*\d+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('VITE_SENTRY_DSN must contain only an HTTPS host, public key and numeric project ID');
  }
  return url.origin;
}

export function sentrySecurityOverride(security, environment) {
  const origin = sentryOrigin(environment);
  if (!origin) return security;
  const add = csp => csp.replace(/\bconnect-src\b[^;]*/, directive =>
    directive.split(/\s+/).includes(origin) ? directive : `${directive} ${origin}`);
  return { csp: add(security.csp), devCsp: add(security.devCsp) };
}

export function sentryBuildConfiguration(environment, { command, version, revision }) {
  if (!sentryOrigin(environment)) return null;
  const release = environment.VITE_SENTRY_RELEASE?.trim() || `drifting@${version}+${revision}`;
  const deployment = environment.VITE_SENTRY_ENVIRONMENT?.trim() || (command === 'build' ? 'production' : 'development');
  if (!/^[a-zA-Z0-9@+._-]{1,160}$/.test(release) || !/^[a-zA-Z0-9._-]{1,40}$/.test(deployment)) {
    throw new Error('Sentry release/environment must be bounded machine identifiers');
  }
  if (command === 'build' && ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'].some(key => !environment[key]?.trim())) {
    throw new Error('Sentry builds require SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT to upload matching source maps');
  }
  return { release, environment: deployment };
}
