import mitt from 'mitt';
import { expect, it, vi } from 'vitest';
import type { AppEvents } from '../../lib/events';
import { createSyntheticWorkspaceProjection } from '../../performance/fixture';
import { createProjectElementCreatedRegistry } from './project-element-created-registry';
const event = (projectId: string) => ({ element: createSyntheticWorkspaceProjection(projectId, 0, 1).bookElements[0] });

it('uses one listener and delivers only to matching project owners', () => {
  const bus = mitt<AppEvents>(); const registry = createProjectElementCreatedRegistry(bus);
  const a = vi.fn(); const b = vi.fn();
  const offA = registry.attach('a', a); const offB = registry.attach('b', b);
  expect(bus.all.get('element:element-created')).toHaveLength(1);
  bus.emit('element:element-created', event('a')); expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
  bus.emit('element:element-created', event('absent')); expect(a).toHaveBeenCalledTimes(1);
  offA(); offA(); expect(bus.all.get('element:element-created')).toHaveLength(1);
  offB(); expect(bus.all.get('element:element-created')).toHaveLength(0);
});
it('keeps separate registrations of the same callback independently releasable', () => {
  const bus = mitt<AppEvents>(); const registry = createProjectElementCreatedRegistry(bus); const receive = vi.fn();
  const first = registry.attach('a', receive); const second = registry.attach('a', receive);
  first(); bus.emit('element:element-created', event('a')); expect(receive).toHaveBeenCalledTimes(1);
  second(); expect(bus.all.get('element:element-created')).toHaveLength(0);
});
it('does not invoke an owner disposed during delivery', () => {
  const bus = mitt<AppEvents>(); const registry = createProjectElementCreatedRegistry(bus); const receive = vi.fn();
  let offSecond = () => undefined as void;
  const first = registry.attach('a', () => offSecond()); offSecond = registry.attach('a', receive);
  bus.emit('element:element-created', event('a')); expect(receive).not.toHaveBeenCalled(); first();
});
it('defers an owner attached during delivery until the next event', () => {
  const bus = mitt<AppEvents>(); const registry = createProjectElementCreatedRegistry(bus); const receive = vi.fn();
  let later: (() => void) | undefined;
  const first = registry.attach('a', () => { later ??= registry.attach('a', receive); });
  bus.emit('element:element-created', event('a')); expect(receive).not.toHaveBeenCalled();
  bus.emit('element:element-created', event('a')); expect(receive).toHaveBeenCalledTimes(1); first(); later?.();
});
it('releases owners and the application listener across repeated project cycles', () => {
  const bus = mitt<AppEvents>(); const registry = createProjectElementCreatedRegistry(bus); const receive = vi.fn();
  for (let i = 0; i < 100; i++) {
    const disposers = Array.from({ length: 20 }, (_, n) => registry.attach(`project-${i}-${n % 2}`, receive));
    expect(bus.all.get('element:element-created')).toHaveLength(1);
    for (const dispose of disposers.reverse()) dispose();
    expect(bus.all.get('element:element-created')).toHaveLength(0);
    bus.emit('element:element-created', event(`project-${i}-0`));
  }
  expect(receive).not.toHaveBeenCalled();
});
