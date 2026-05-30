/**
 * main → renderer tool bridge.
 *
 * The Agent SDK's in-process MCP tools run here in main, but the actual work
 * (reading/writing entities) must happen in the renderer where the data store,
 * usecases and sync outbox live — so agent edits go through the exact same path
 * as manual edits. Electron has no main→renderer `invoke`, so we emit a
 * correlation-id request on `agent:tool-exec` and await the matching
 * `agent:tool-result` reply (same handshake shape as flush-before-quit).
 */
import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';

export interface ToolExecRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ToolExecResult =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let listenerRegistered = false;

/** Register the single `agent:tool-result` listener (idempotent). */
export function registerToolResultListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  ipcMain.on('agent:tool-result', (_event, res: ToolExecResult) => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.data);
    else p.reject(new Error(res.error || 'tool failed'));
  });
}

/** Ask the renderer to execute a tool and await its result. */
export function callRenderer(
  getWindow: () => BrowserWindow | null,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      reject(new Error('No renderer window available for tool execution'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Tool "${name}" timed out`));
      }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const request: ToolExecRequest = { id, name, args };
    win.webContents.send('agent:tool-exec', request);
  });
}
