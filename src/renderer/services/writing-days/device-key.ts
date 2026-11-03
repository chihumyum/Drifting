/**
 * The key a device signs its writing days with (docs/writing-days.md): a
 * digest of the native installation identity, so the synced rows name the
 * device without carrying the identity itself.
 */
import { getSyncInstallationIdentity } from '../../sync/journal/installation-identity';

let pending: Promise<string> | null = null;

async function digest(installationId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`drifting.writing-day.v1\n${installationId}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `device-${Array.from(hash.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function getWritingDeviceKey(): Promise<string> {
  if (!pending) {
    pending = getSyncInstallationIdentity()
      .then((identity) => digest(identity.installationId))
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

export function resetWritingDeviceKeyForTests(): void {
  pending = null;
}
