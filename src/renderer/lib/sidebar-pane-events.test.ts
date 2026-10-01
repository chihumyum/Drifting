import { describe, expect, it, vi } from 'vitest';
import { events } from './events';
import { subscribeSidebarCollapse } from './sidebar-pane-events';

describe('duplicate sidebar panel controls', () => {
  it('collapses only the targeted instance and unsubscribes when its tab closes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const stopFirst = subscribeSidebarCollapse('elements', 'primary', first);
    const stopSecond = subscribeSidebarCollapse('elements', 'secondary', second);
    const stopOther = subscribeSidebarCollapse('drift', 'primary', other);
    try {
      events.emit('left-sidebar:collapse-all', { panel: 'elements', paneId: 'primary' });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
      stopFirst();
      events.emit('left-sidebar:collapse-all', { panel: 'elements', paneId: 'primary' });
      expect(first).toHaveBeenCalledTimes(1);
      events.emit('left-sidebar:collapse-all', { panel: 'elements', paneId: 'secondary' });
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      stopFirst(); stopSecond(); stopOther();
    }
  });
});
