import { describe, expect, it } from 'vitest';
import {
  createInitialMobileWorkspaceUiState,
  mobileWorkspaceReducer,
  mobileWorkspaceStateIssues,
  resolveMobileWorkspaceBack,
  selectMobileUnifiedBarProjection,
  type MobileWorkspaceAction,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';

function reduce(state: MobileWorkspaceUiState, ...actions: MobileWorkspaceAction[]) {
  return actions.reduce(mobileWorkspaceReducer, state);
}

const paperRoot = () => reduce(createInitialMobileWorkspaceUiState(), { type: 'show-paper' });

describe('paper tool sheets ride the tool overlay as popover transients', () => {
  it.each(['plot', 'timeline'] as const)('keeps the %s tool open under a sheet', (overlay) => {
    const tool = reduce(paperRoot(), { type: 'set-overlay', overlay });
    const sheet = reduce(tool, {
      type: 'set-transient',
      transient: { kind: 'popover', id: `tool:${overlay}-sheet` },
    });
    expect(sheet.overlay).toBe(overlay);
    expect(sheet.transient).toEqual({ kind: 'popover', id: `tool:${overlay}-sheet` });
    expect(mobileWorkspaceStateIssues(sheet)).toEqual([]);

    const back = resolveMobileWorkspaceBack(sheet, 'visible');
    expect(back.layer).toBe('transient');
    expect(back.nextState.overlay).toBe(overlay);
    expect(back.nextState.transient).toEqual({ kind: 'none' });
  });

  it('parks the suspended editing mode while a Plot sheet is open', () => {
    const editing = reduce(paperRoot(), { type: 'sync-editor', editing: true });
    const plot = reduce(editing, { type: 'set-overlay', overlay: 'plot' });
    const cell = reduce(plot, {
      type: 'set-transient',
      transient: { kind: 'popover', id: 'tool:plot-cell' },
    });
    expect(cell.toolReturnTo).toEqual({ kind: 'edit', accessory: 'formatting' });
    const withKeyboard = reduce(cell, { type: 'sync-keyboard', keyboard: 'open' });
    expect(withKeyboard.keyboard).toBe('open');
    expect(mobileWorkspaceStateIssues(withKeyboard)).toEqual([]);
    const closed = reduce(withKeyboard, { type: 'set-transient', transient: { kind: 'none' } });
    expect(closed.overlay).toBe('plot');
    expect(closed.toolReturnTo).toEqual({ kind: 'edit', accessory: 'formatting' });
  });

  it('yields the unified bar to the Plot cell editor only', () => {
    const plot = reduce(paperRoot(), { type: 'set-overlay', overlay: 'plot' });
    expect(selectMobileUnifiedBarProjection(plot).visible).toBe(true);
    const cell = reduce(plot, {
      type: 'set-transient',
      transient: { kind: 'popover', id: 'tool:plot-cell' },
    });
    expect(selectMobileUnifiedBarProjection(cell).visible).toBe(false);
    const header = reduce(plot, {
      type: 'set-transient',
      transient: { kind: 'popover', id: 'tool:plot-header' },
    });
    expect(selectMobileUnifiedBarProjection(header).visible).toBe(true);
  });

  it('still closes a tool-free popover back to the paper root', () => {
    const popover = reduce(paperRoot(), {
      type: 'set-transient',
      transient: { kind: 'popover', id: 'paper-menu' },
    });
    expect(popover.overlay).toBe('none');
    expect(resolveMobileWorkspaceBack(popover, 'visible').nextState).toEqual(paperRoot());
  });
});
