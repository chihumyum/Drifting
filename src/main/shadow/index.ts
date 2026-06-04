import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { enqueueShadowJob, runShadowJob, cancelShadowJob, initShadowWorker } from './worker';
import type { ShadowJobInput } from './types';

export { enqueueShadowJob, runShadowJob, cancelShadowJob };
export type {
  ShadowJobInput,
  ShadowJobResult,
  ShadowDeps,
  ReviewContext,
  Finding,
  ShadowDecision,
} from './types';

// Wire the shadow engine: store the window for the bridge + expose run/enqueue
// IPC to the renderer. Call once at startup, after registerAgentIpc (the shadow
// deps reuse the agent bridge's tool-result listener).
export function registerShadowIpc(getWindow: () => BrowserWindow | null): void {
  initShadowWorker(getWindow);
  ipcMain.handle('shadow:run', (_event, job: ShadowJobInput) => runShadowJob(job));
  ipcMain.on('shadow:enqueue', (_event, job: ShadowJobInput) => enqueueShadowJob(job));
  ipcMain.on('shadow:cancel', (_event, job: { chapterId: string }) =>
    cancelShadowJob(job.chapterId),
  );
}
