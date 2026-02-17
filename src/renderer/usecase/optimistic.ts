import LogLevel from 'loglevel';
const log = LogLevel.getLogger("optimistic-update");
log.setLevel(LogLevel.levels.WARN);

export type OptimisticUpdateOptions<T> = {
  apply: () => void;
  rollback: () => void;
  effect: () => Promise<T>;
  onSuccess?: (result: T) => void;
};

export async function withOptimisticUpdate<T>({
  apply,
  rollback,
  effect,
  onSuccess,
}: OptimisticUpdateOptions<T>): Promise<T> {
  apply();

  try {
    const result = await effect();
    if (onSuccess) onSuccess(result);
    return result;
  } catch (error) {
    log.error("Optimistic update failed, rolling back.", error);
    rollback();
    throw error;
  }
}
