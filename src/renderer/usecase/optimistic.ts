import LogLevel from 'loglevel';
const log = LogLevel.getLogger("optimistic-update");
log.setLevel(LogLevel.levels.WARN);

export type OptimisticUpdateOptions<T> = {
  apply: () => void;
  rollback: () => void;
  effect: () => Promise<T>;
  onSuccess?: (result: T) => void;
  /** Fire-and-forget: enqueue server sync after local effect succeeds */
  sync?: (result: T) => void;
};

export async function withOptimisticUpdate<T>({
  apply,
  rollback,
  effect,
  onSuccess,
  sync,
}: OptimisticUpdateOptions<T>): Promise<T> {
  apply();

  try {
    const result = await effect();
    if (onSuccess) onSuccess(result);
    if (sync) {
      try { sync(result); } catch (e) {
        log.warn("Sync enqueue failed (non-fatal):", e);
      }
    }
    return result;
  } catch (error) {
    log.error("Optimistic update failed, rolling back.", error);
    rollback();
    throw error;
  }
}
