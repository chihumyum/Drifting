import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { useUiStore } from './ui-store';
import type { LeftSidebarTab, RightSidebarTab, SidebarPaneId } from '../lib/sidebar-tabs';

export interface SidebarPanelScope {
  projectId: string;
  side: 'left' | 'right';
  paneId: SidebarPaneId;
  tab: LeftSidebarTab | RightSidebarTab;
}
export const sidebarPanelKey = ({ projectId, side, paneId, tab }: SidebarPanelScope) =>
  JSON.stringify([projectId, side, paneId, tab]);

export type SidebarPreferences = Pick<ReturnType<typeof useUiStore.getState>,
  'chapterPanelViewMode' | 'chapterGlobalSortMode' | 'chapterStorylineInnerSortMode' |
  'chapterStorylineOuterSortMode' | 'chapterStorylinePrimaryOnly' | 'chapterCellMeta' |
  'elementSortMode' | 'elementCategorySortMode' | 'elementPanelViewMode' |
  'driftSortMode' | 'driftCellMeta' | 'reviewScope' | 'reviewSortMode'>;

interface SidebarPanelStore {
  preferences: Record<string, Partial<SidebarPreferences>>;
  setPreference<K extends keyof SidebarPreferences>(key: string, field: K, value: SidebarPreferences[K]): void;
}

export const useSidebarPanelStore = create<SidebarPanelStore>()(persist((set) => ({
  preferences: {},
  setPreference: (key, field, value) => set(state => ({
    preferences: { ...state.preferences, [key]: { ...state.preferences[key], [field]: value } },
  })),
}), {
  name: 'sidebar-panel-preferences',
  partialize: ({ preferences }) => ({ preferences }),
}));

/** Scroll, folds and drafts survive tab unmounts without serializing on input. */
interface SidebarPanelSession {
  session: Record<string, Record<string, unknown>>;
  setSession<T>(key: string, field: string, update: T | ((previous: T) => T), initial: T): void;
}
export const useSidebarPanelSessionStore = create<SidebarPanelSession>((set) => ({
  session: {},
  setSession: (key, field, update, initial) => set(state => {
    const fields = state.session[key] ?? {};
    const previous = Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] as typeof initial : initial;
    const value = typeof update === 'function' ? (update as (previous: typeof initial) => typeof initial)(previous) : update;
    if (Object.is(previous, value) && Object.prototype.hasOwnProperty.call(fields, field)) return state;
    return { session: { ...state.session, [key]: { ...fields, [field]: value } } };
  }),
}));
