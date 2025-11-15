export const isAppClosedForPublic = import.meta.env.MODE === 'production';

export const APP_CLOSED_MESSAGE = 'Drifting 正在内测，暂未开放测试，敬请期待。';

export function withClosedBetaGuard<T>(action: () => Promise<T> | T): Promise<T> | T {
  if (isAppClosedForPublic) {
    throw new Error(APP_CLOSED_MESSAGE);
  }
  return action();
}
