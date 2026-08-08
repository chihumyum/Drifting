import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

export interface MobilePaper {
  key: string;
  target: WorkspaceTarget;
}

export interface MobileWorkspaceSessionState {
  papers: MobilePaper[];
  activeKey: string | null;
}

export type MobileWorkspaceSessionAction =
  | { type: 'open'; target: WorkspaceTarget }
  | { type: 'activate'; target: WorkspaceTarget }
  | { type: 'close'; key: string }
  | { type: 'clear' }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'replace'; state: MobileWorkspaceSessionState };

export const EMPTY_MOBILE_WORKSPACE_SESSION: MobileWorkspaceSessionState = {
  papers: [],
  activeKey: null,
};

const WORKSPACE_ENTITY_TYPES = new Set<WorkspaceTarget['entityType']>([
  'node',
  'storyline',
  'element',
  'category',
  'dashboard',
  'all-chapters',
]);

export function mobilePaperKey(target: WorkspaceTarget): string {
  return `${target.entityType}:${target.id}`;
}

export function normalizeMobileWorkspaceSession(
  candidate: Partial<MobileWorkspaceSessionState> | null | undefined,
): MobileWorkspaceSessionState {
  const seen = new Set<string>();
  const papers: MobilePaper[] = [];
  for (const paper of candidate?.papers ?? []) {
    const target = paper?.target;
    if (
      !target ||
      !WORKSPACE_ENTITY_TYPES.has(target.entityType) ||
      typeof target.id !== 'string' ||
      !target.id
    ) {
      continue;
    }
    const key = mobilePaperKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push({ key, target: { ...target } });
  }
  const requestedActive = candidate?.activeKey ?? null;
  return {
    papers,
    activeKey:
      (requestedActive && papers.some((paper) => paper.key === requestedActive)
        ? requestedActive
        : papers[0]?.key) ?? null,
  };
}

export function mobileWorkspaceSessionReducer(
  state: MobileWorkspaceSessionState,
  action: MobileWorkspaceSessionAction,
): MobileWorkspaceSessionState {
  switch (action.type) {
    case 'open': {
      const key = mobilePaperKey(action.target);
      if (state.papers.some((paper) => paper.key === key)) {
        return { ...state, activeKey: key };
      }
      const activeIndex = state.papers.findIndex((paper) => paper.key === state.activeKey);
      const insertAt = activeIndex < 0 ? state.papers.length : activeIndex + 1;
      const next = state.papers.slice();
      next.splice(insertAt, 0, { key, target: action.target });
      return { papers: next, activeKey: key };
    }
    case 'activate': {
      const key = mobilePaperKey(action.target);
      return state.papers.some((paper) => paper.key === key)
        ? { ...state, activeKey: key }
        : mobileWorkspaceSessionReducer(state, { type: 'open', target: action.target });
    }
    case 'close': {
      const closingIndex = state.papers.findIndex((paper) => paper.key === action.key);
      if (closingIndex < 0) return state;
      const papers = state.papers.filter((paper) => paper.key !== action.key);
      if (state.activeKey !== action.key) return { papers, activeKey: state.activeKey };
      const nextActive = papers[Math.min(closingIndex, papers.length - 1)] ?? null;
      return { papers, activeKey: nextActive?.key ?? null };
    }
    case 'clear':
      return EMPTY_MOBILE_WORKSPACE_SESSION;
    case 'reorder': {
      if (
        action.from === action.to ||
        action.from < 0 ||
        action.to < 0 ||
        action.from >= state.papers.length ||
        action.to >= state.papers.length
      ) {
        return state;
      }
      const papers = state.papers.slice();
      const [paper] = papers.splice(action.from, 1);
      papers.splice(action.to, 0, paper);
      return { ...state, papers };
    }
    case 'replace':
      return normalizeMobileWorkspaceSession(action.state);
  }
}

export function adjacentPaper(
  state: MobileWorkspaceSessionState,
  direction: -1 | 1,
): MobilePaper | null {
  const index = state.papers.findIndex((paper) => paper.key === state.activeKey);
  if (index < 0) return null;
  return state.papers[index + direction] ?? null;
}
