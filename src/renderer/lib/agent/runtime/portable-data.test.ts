import { describe, expect, it } from 'vitest';
import { createPortableRuntimeId } from './local-transport';
import { clonePortableData } from './portable-data';

describe('portable runtime primitives', () => {
  it('deep-clones JSON data without structuredClone', () => {
    const source = {
      route: { kind: 'chat', projectId: 'project-1' },
      messages: [{ role: 'user', content: 'hello' }],
    };
    const clone = clonePortableData(source);

    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    expect(clone.route).not.toBe(source.route);
    expect(clone.messages).not.toBe(source.messages);
  });

  it('rejects values that cannot cross a JSON/IPC boundary', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => clonePortableData(cyclic)).toThrow('Cyclic data');
    expect(() => clonePortableData({ value: Number.NaN })).toThrow('Non-finite number');
    expect(() => clonePortableData([undefined])).toThrow('Undefined array item');
    expect(() => clonePortableData({ date: new Date() })).toThrow('Non-plain object');
  });

  it('preserves __proto__ as inert data without mutating the clone prototype', () => {
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"value"}',
    ) as Record<string, unknown>;
    const clone = clonePortableData(source);

    expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(clone, '__proto__')).toBe(true);
    expect(clone['__proto__']).toEqual({ polluted: true });
    expect(clone.constructor).toBe('value');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('generates a UUID with getRandomValues when randomUUID is unavailable', () => {
    const id = createPortableRuntimeId('turn', {
      getRandomValues: (array) => {
        for (let index = 0; index < array.length; index += 1) array[index] = index;
        return array;
      },
    });

    expect(id).toBe('turn-00010203-0405-4607-8809-0a0b0c0d0e0f');
  });
});
