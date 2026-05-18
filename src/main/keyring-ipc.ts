/**
 * Keychain IPC — wraps `@napi-rs/keyring` so the renderer never touches
 * secrets directly. All BYOK API keys flow through this module.
 *
 * Service naming convention: 'Drifting' is the service, the account is the
 * key id (e.g. 'byok.anthropic'). One key per id, last-write-wins.
 */
import { ipcMain } from 'electron';
import { Entry } from '@napi-rs/keyring';

const SERVICE = 'Drifting';

function entry(key: string): Entry {
  return new Entry(SERVICE, key);
}

export function registerKeyringIpc(): void {
  ipcMain.handle('keychain:get', (_event, key: string): string | null => {
    try {
      return entry(key).getPassword();
    } catch {
      // Missing entries throw on some platforms — treat as null.
      return null;
    }
  });

  ipcMain.handle('keychain:set', (_event, key: string, value: string): boolean => {
    try {
      entry(key).setPassword(value);
      return true;
    } catch (err) {
      console.error('[keyring] set failed', key, err);
      return false;
    }
  });

  ipcMain.handle('keychain:delete', (_event, key: string): boolean => {
    try {
      return entry(key).deletePassword();
    } catch (err) {
      console.error('[keyring] delete failed', key, err);
      return false;
    }
  });
}
