/**
 * Clone the runtime's JSON/IPC-safe data without relying on structuredClone,
 * which is unavailable in older WKWebViews still supported by the mobile app.
 */
export function clonePortableData<T>(value: T): T {
  return cloneValue(value, '$', new WeakSet<object>()) as T;
}

function cloneValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`Cyclic data at ${path}`);
    ancestors.add(value);
    try {
      return value.map((item, index) => {
        if (item === undefined) throw new TypeError(`Undefined array item at ${path}[${index}]`);
        return cloneValue(item, `${path}[${index}]`, ancestors);
      });
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object') {
    const objectValue = value as object;
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }
    if (ancestors.has(objectValue)) throw new TypeError(`Cyclic data at ${path}`);
    ancestors.add(objectValue);
    try {
      const clone: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(objectValue)) {
        if (item === undefined) continue;
        clone[key] = cloneValue(item, `${path}.${key}`, ancestors);
      }
      return clone;
    } finally {
      ancestors.delete(objectValue);
    }
  }
  throw new TypeError(`Unsupported ${typeof value} at ${path}`);
}
