import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppNotification } from '../../../store/notification-store';
import { latestRunningGoogleDriveNotification } from './mobile-google-drive-progress';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('mobile Google Drive transfer progress acceptance', () => {
  it('selects the newest material Drive transfer without surfacing other tasks', () => {
    const notification = (input: Partial<AppNotification>): AppNotification => ({
      id: 'task',
      source: 'copilot',
      state: 'running',
      title: 'Task',
      startedAt: 1,
      updatedAt: 1,
      read: false,
      ...input,
    });
    const olderDrive = notification({
      id: 'drive-1',
      source: 'google-drive',
      updatedAt: 2,
      progress: {
        value: 0.25,
        transferredBytes: 1,
        totalBytes: 4,
        completedObjects: 0,
        totalObjects: 1,
      },
    });
    const newerDrive = notification({
      id: 'drive-2',
      source: 'google-drive',
      updatedAt: 3,
      progress: {
        value: null,
        transferredBytes: 2,
        totalBytes: 0,
        completedObjects: 1,
        totalObjects: 1,
      },
    });

    expect(
      latestRunningGoogleDriveNotification([
        notification({ id: 'copilot' }),
        olderDrive,
        notification({ ...newerDrive, state: 'completed', id: 'completed-drive' }),
        newerDrive,
      ]),
    ).toBe(newerDrive);
  });

  it('projects only material running Drive transfers across the mobile project shell', () => {
    const shell = source('shells/mobile/MobileAppShell.tsx');
    const progress = source('shells/mobile/workspace/MobileGoogleDriveProgress.tsx');
    const progressModel = source('shells/mobile/workspace/mobile-google-drive-progress.ts');

    expect(shell).toContain('useNotificationFeed();');
    expect(shell).toContain('<MobileGoogleDriveProgress />');
    expect(progressModel).toContain("item.source !== 'google-drive'");
    expect(progressModel).toContain("item.state !== 'running'");
    expect(progress).toContain('latestRunningGoogleDriveNotification(state.items)');
    expect(progress).toContain('notification.progress.value');
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-valuenow={percent ?? undefined}');
  });

  it('stays below safe-area chrome without capturing unified-bar input', () => {
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');
    const mobileContract = fs.readFileSync(
      path.join(repoRoot, 'docs/mobile-ui-foundation.md'),
      'utf8',
    );
    const productEvidence = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, 'docs/sync-engine/acceptance/phase6-product-controls.json'),
        'utf8',
      ),
    ) as { controls: Record<string, boolean> };

    expect(css).toContain('.m-drive-progress {');
    expect(css).toContain('top: calc(env(safe-area-inset-top) + 54px);');
    expect(css).toContain('pointer-events: none;');
    expect(css).toContain(".m-drive-progress[data-determinate='false']");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(mobileContract).toContain('non-interactive status');
    expect(mobileContract).toContain('Empty background polls do not create the capsule');
    expect(productEvidence.controls.mobileSafeAreaTransferProgress).toBe(true);
    expect(productEvidence.controls.mobileTransferProgressDoesNotCaptureInput).toBe(true);
  });
});
