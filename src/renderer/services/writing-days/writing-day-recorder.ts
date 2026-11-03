/**
 * Keeps this device's writing day for the open book (docs/writing-days.md).
 *
 * The runtime provider hands it the book's total whenever the chapters'
 * canonical word counts change, and says when a change from another device
 * was applied. It writes the day's row at most once a minute while the words
 * move, and again when the window hides or the book closes; each write is
 * one journaled authored transaction, so the row syncs like any other.
 */
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';

import {
  findDeviceWritingDay,
  insertWritingDay,
  updateWritingDayWords,
  type WritingDayRow,
} from '../../sqlite-repo/writing-day-repo';
import { todayKey, useWritingStatsStore, type ISODate } from '../../store/writing-stats-store';
import { withAtomicSyncTransaction } from '../../usecase/sync-helpers';
import { getWritingDeviceKey } from './device-key';
import { tallyWritingDay, type WritingDayTallyState } from './writing-day-tally';

const log = loglevel.getLogger('writing-days');

/** How long after another device's change arrives a moved total is still its doing. */
export const REMOTE_CHANGE_WINDOW_MS = 8_000;
export const WRITING_DAY_PERSIST_DELAY_MS = 60_000;

export interface WritingDayRecorder {
  observe(total: number): void;
  remoteChanged(): void;
  flush(): Promise<void>;
  dispose(): void;
}

interface RecorderOptions {
  now?: () => Date;
  persistDelayMs?: number;
  remoteWindowMs?: number;
  deviceKey?: () => Promise<string>;
}

/** Words the device's older local history holds for a day it has no row for yet. */
function localHistoryWords(projectId: string, day: ISODate): number {
  const snapshot = useWritingStatsStore.getState().history[projectId]?.[day];
  return snapshot ? Math.max(0, snapshot.latestTotal - snapshot.startTotal) : 0;
}

export function createWritingDayRecorder(projectId: string, options: RecorderOptions = {}): WritingDayRecorder {
  const now = options.now ?? (() => new Date());
  const persistDelayMs = options.persistDelayMs ?? WRITING_DAY_PERSIST_DELAY_MS;
  const remoteWindowMs = options.remoteWindowMs ?? REMOTE_CHANGE_WINDOW_MS;
  const deviceKey = (options.deviceKey ?? getWritingDeviceKey)();
  deviceKey.catch((error) => log.warn('Writing days are not recorded on this device:', error));

  let state: WritingDayTallyState | null = null;
  let remoteUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;
  /** This device's row per day as last read or written; null when it has none. */
  const rows = new Map<ISODate, WritingDayRow | null>();

  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => log.warn('Writing day update failed:', error));
    return queue;
  };

  const persist = async (day: ISODate, words: number) => {
    const key = await deviceKey;
    // Nothing to write: the row already holds these words, or there is no
    // row and nothing was written.
    const known = rows.get(day);
    if (known === undefined ? words <= 0 : (known?.words ?? 0) === words) return;
    const updatedAt = now().toISOString();
    const saved = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
      const current = await findDeviceWritingDay(projectId, day, key, tx);
      if (current) {
        if (current.words === words) return current;
        await updateWritingDayWords(current.id, projectId, words, updatedAt, tx);
        await sync('writingDay', 'update', current.id, projectId, { words, updatedAt });
        return { ...current, words, updatedAt };
      }
      if (words <= 0) return null;
      const row: WritingDayRow = { id: uuidv7(), projectId, day, deviceKey: key, words, createdAt: updatedAt, updatedAt };
      await insertWritingDay(row, tx);
      await sync('writingDay', 'create', row.id, projectId, {
        day,
        deviceKey: key,
        words,
        createdAt: updatedAt,
        updatedAt,
      });
      return row;
    });
    rows.set(day, saved);
  };

  const persistNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Behind the observations already queued, so it writes what they tallied.
    return enqueue(async () => {
      if (state) await persist(state.day, state.words);
    });
  };

  return {
    observe(total) {
      if (disposed) return;
      const remote = now().getTime() < remoteUntil;
      void enqueue(async () => {
        const day = todayKey(now());
        let storedWords = 0;
        if (!state || state.day !== day) {
          if (state) await persist(state.day, state.words);
          const row = await findDeviceWritingDay(projectId, day, await deviceKey);
          rows.set(day, row);
          // The day the table arrived, the morning's words are still only in
          // the older local history.
          storedWords = row ? row.words : localHistoryWords(projectId, day);
        }
        const previous = state?.words;
        state = tallyWritingDay(state, { total, day, storedWords, remote });
        if (state.words !== previous && timer === null) {
          timer = setTimeout(() => {
            timer = null;
            void persistNow();
          }, persistDelayMs);
        }
      });
    },
    remoteChanged() {
      remoteUntil = now().getTime() + remoteWindowMs;
    },
    flush: () => persistNow(),
    dispose() {
      if (disposed) return;
      void persistNow();
      disposed = true;
    },
  };
}
