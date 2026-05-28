/**
 * AI request-log IPC — file-writing surface for the renderer's request
 * logger. Dev-only by design: the renderer is the source of truth for what
 * gets logged; the main process just persists the markdown body and exposes
 * the resulting directory in Finder/Explorer for the user.
 *
 * Files land inside the repo at `<package-cwd>/ai-log/` — much easier to
 * open from VSCode than the buried Electron userData path. Production
 * builds run from inside an app bundle where `process.cwd()` isn't writable,
 * so we fall back to `app.getPath('userData')/ai-log/` there. The renderer-
 * side CaptureInterceptor only registers in DEV builds, so in practice
 * only the repo path is exercised.
 *
 * One markdown file per request, named `${ISO_TIMESTAMP}_${promptId}_${shortId}.md`
 * so a plain `ls` sorts chronologically.
 */
import { app, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const AI_LOG_DIRNAME = 'ai-log';

function logDir(): string {
  // In dev (electron-forge start), cwd ===  — drop logs next
  // to the source so they show up in the VSCode tree. Packaged builds have
  // no writable cwd; route to userData instead.
  if (!app.isPackaged) {
    return path.join(process.cwd(), AI_LOG_DIRNAME);
  }
  return path.join(app.getPath('userData'), AI_LOG_DIRNAME);
}

function ensureDir(): string {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerAiLogIpc(): void {
  ipcMain.handle(
    'ai-log:write',
    (
      _event,
      payload: { filename: string; content: string },
    ): { ok: true; filePath: string } | { ok: false; error: string } => {
      try {
        const dir = ensureDir();
        // Defense-in-depth: refuse path traversal even though the renderer
        // shouldn't send it. Only basename portion is allowed.
        const safeName = path.basename(payload.filename);
        if (!safeName || safeName.startsWith('.')) {
          return { ok: false, error: 'invalid filename' };
        }
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, payload.content, 'utf8');
        return { ok: true, filePath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle('ai-log:openDir', async (): Promise<string> => {
    const dir = ensureDir();
    await shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('ai-log:getDir', (): string => logDir());
}
