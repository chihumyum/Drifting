export type TraceContext = {
  syncTraceId: string | null;
};

const context: TraceContext = {
  syncTraceId: null,
};

export const createTraceId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }

  // Fallback: reasonably-unique string
  const rnd = Math.random().toString(16).slice(2);
  return `t_${Date.now().toString(16)}_${rnd}`;
};

export const getActiveTraceId = (): string => {
  return context.syncTraceId ?? createTraceId();
};

export const runWithSyncTraceId = async <T>(traceId: string, fn: () => Promise<T>): Promise<T> => {
  const previous = context.syncTraceId;
  context.syncTraceId = traceId;
  try {
    return await fn();
  } finally {
    context.syncTraceId = previous;
  }
};
