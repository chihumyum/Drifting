import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ShortcutActionId =
  | 'closeActiveTab'
  | 'findInEditor'
  | 'globalSearch'
  | 'saveCurrentEditor'
  | 'goBack'
  | 'goForward'
  | 'prevTab'
  | 'nextTab';

export interface ShortcutActionDef {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultAccelerator: string;
}

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  {
    id: 'closeActiveTab',
    label: '关闭当前标签页',
    description: '关闭顶部时间轴中当前激活的 entity editor 标签',
    defaultAccelerator: 'Mod+W',
  },
  {
    id: 'findInEditor',
    label: '当前编辑器内查找',
    description: '在当前打开的编辑器中查找文本',
    defaultAccelerator: 'Mod+F',
  },
  {
    id: 'globalSearch',
    label: '全局搜索',
    description: '跨章节、故事线、元素、分类搜索',
    defaultAccelerator: 'Mod+Shift+F',
  },
  {
    id: 'saveCurrentEditor',
    label: '保存当前编辑器',
    description: '强制触发当前编辑器的持久化（写入本地数据库）',
    defaultAccelerator: 'Mod+S',
  },
  {
    id: 'goBack',
    label: '返回上一个页面',
    description: '回到上一个访问过的 editor 页面（类似浏览器后退）',
    defaultAccelerator: 'Mod+[',
  },
  {
    id: 'goForward',
    label: '前进下一个页面',
    description: '回到下一个访问过的 editor 页面（类似浏览器前进）',
    defaultAccelerator: 'Mod+]',
  },
  {
    id: 'prevTab',
    label: '切换到上一个标签页',
    description: '在顶部已打开的 tab 间向左切换',
    defaultAccelerator: 'Mod+Alt+ArrowLeft',
  },
  {
    id: 'nextTab',
    label: '切换到下一个标签页',
    description: '在顶部已打开的 tab 间向右切换',
    defaultAccelerator: 'Mod+Alt+ArrowRight',
  },
];

const DEFAULT_BINDINGS: Record<ShortcutActionId, string> = SHORTCUT_ACTIONS.reduce(
  (acc, action) => {
    acc[action.id] = action.defaultAccelerator;
    return acc;
  },
  {} as Record<ShortcutActionId, string>,
);

interface ShortcutsState {
  bindings: Record<ShortcutActionId, string>;
  setBinding: (id: ShortcutActionId, accelerator: string) => void;
  resetBinding: (id: ShortcutActionId) => void;
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set) => ({
      bindings: { ...DEFAULT_BINDINGS },
      setBinding: (id, accelerator) =>
        set((state) => ({ bindings: { ...state.bindings, [id]: accelerator } })),
      resetBinding: (id) =>
        set((state) => ({
          bindings: { ...state.bindings, [id]: DEFAULT_BINDINGS[id] },
        })),
      resetAll: () => set({ bindings: { ...DEFAULT_BINDINGS } }),
    }),
    {
      name: 'shortcuts-storage',
      storage: createJSONStorage(() => localStorage),
      // Merge persisted bindings on top of defaults so newly-added actions
      // don't end up undefined for existing users.
      merge: (persisted, current) => {
        const persistedState = (persisted ?? {}) as Partial<ShortcutsState>;
        return {
          ...current,
          ...persistedState,
          bindings: {
            ...DEFAULT_BINDINGS,
            ...(persistedState.bindings ?? {}),
          },
        };
      },
    },
  ),
);

export function getDefaultAccelerator(id: ShortcutActionId): string {
  return DEFAULT_BINDINGS[id];
}
