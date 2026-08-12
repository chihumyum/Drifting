// Gate the app behind a closed-beta wall. Default: closed in production builds.
// Override with VITE_CLOSED_BETA ('false' opens a prod build for invited testers,
// 'true' force-closes). Set in .env.production for the test deployment.
import { runtimeViteEnv } from '../lib/vite-runtime-env';

export const isAppClosedForPublic =
  runtimeViteEnv.VITE_CLOSED_BETA != null
    ? runtimeViteEnv.VITE_CLOSED_BETA === 'true'
    : runtimeViteEnv.MODE === 'production';

export const APP_CLOSED_MESSAGE = 'Drifting 仍在开发中，敬请期待内测。';

export function withClosedBetaGuard<T>(action: () => Promise<T> | T): Promise<T> | T {
  if (isAppClosedForPublic) {
    throw new Error(APP_CLOSED_MESSAGE);
  }
  return action();
}
