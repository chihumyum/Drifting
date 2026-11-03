import { useEffect, useState } from 'react';
import loglevel from 'loglevel';

import { events } from '../../lib/events';
import { readShelfWritingDays } from '../../sqlite-repo/writing-day-repo';
import { backfillWritingDays } from '../../services/writing-days/backfill';
import {
  deriveWritingYear,
  todayKey,
  writingYearStart,
  type WritingYear,
} from '../../store/writing-stats-store';

const log = loglevel.getLogger('shelf-writing-year');

/**
 * The shelf's year of writing days (docs/writing-days.md): the library's
 * older local history is written in once, then one read for every book.
 * Read again when the books change (`refresh`) and when another device's
 * days arrive.
 */
export function useShelfWritingYear(enabled: boolean, refresh: unknown): WritingYear | null {
  const [year, setYear] = useState<WritingYear | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      await backfillWritingDays().catch((error) => log.warn('Writing history backfill failed:', error));
      const today = todayKey();
      const rows = await readShelfWritingDays(writingYearStart(today));
      if (active) setYear(deriveWritingYear(rows, today));
    };
    const reload = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load().catch((error) => log.warn('Writing days could not be read:', error));
      }, 300);
    };
    void load().catch((error) => log.warn('Writing days could not be read:', error));
    events.on('sync:project-changed', reload);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      events.off('sync:project-changed', reload);
    };
  }, [enabled, refresh]);
  return year;
}
