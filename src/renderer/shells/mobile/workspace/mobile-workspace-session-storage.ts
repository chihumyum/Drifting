import {
  EMPTY_MOBILE_WORKSPACE_SESSION,
  normalizeMobileWorkspaceSession,
  type MobileWorkspaceSessionState,
} from './mobile-workspace-session';

const MOBILE_WORKSPACE_STORAGE_VERSION = 1;

export interface MobileWorkspaceSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function mobileWorkspaceSessionStorageKey(projectId: string): string {
  return `drifting:mobile-workspace:${MOBILE_WORKSPACE_STORAGE_VERSION}:${projectId}`;
}

export function readMobileWorkspaceSession(
  storage: Pick<MobileWorkspaceSessionStorage, 'getItem'> | null,
  projectId: string,
): MobileWorkspaceSessionState {
  if (!storage) return EMPTY_MOBILE_WORKSPACE_SESSION;
  try {
    const raw = storage.getItem(mobileWorkspaceSessionStorageKey(projectId));
    return raw ? normalizeMobileWorkspaceSession(JSON.parse(raw)) : EMPTY_MOBILE_WORKSPACE_SESSION;
  } catch {
    return EMPTY_MOBILE_WORKSPACE_SESSION;
  }
}

export function writeMobileWorkspaceSession(
  storage: Pick<MobileWorkspaceSessionStorage, 'setItem'> | null,
  projectId: string,
  state: MobileWorkspaceSessionState,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(mobileWorkspaceSessionStorageKey(projectId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
