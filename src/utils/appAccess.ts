export const isAppClosedForPublic = import.meta.env.MODE === 'production';

export const APP_CLOSED_MESSAGE = 'Drifting 仍在开发中，敬请期待内测。';

export function withClosedBetaGuard<T>(action: () => Promise<T> | T): Promise<T> | T {
  if (isAppClosedForPublic) {
    throw new Error(APP_CLOSED_MESSAGE);
  }
  return action();
}
