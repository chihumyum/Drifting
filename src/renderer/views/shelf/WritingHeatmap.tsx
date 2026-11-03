import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useCharSeaShape } from '../../components/char-sea/useCharSea';
import { HoverCardHeading, HoverCardShell } from '../../components/ui/HoverCard';
import { HEAT_CELL, HEAT_STEP, paintHeatmap, sandMaskURL } from '../../lib/sand-heat';
import {
  summarizeWritingDays,
  writingDayLevel,
  writingDayThresholds,
  type WritingYear,
} from '../../store/writing-stats-store';
import { formatShelfDay, formatShelfMonth, formatShelfWords } from './shelf-format';

export interface HeatmapBook {
  id: string;
  name: string;
  /** A CSS colour: the book's story colour. */
  color: string;
}

interface Masks {
  dabs: string;
  loose: string;
}

/** One pair of masks per book shown, kept while the year stays the same. */
const MASKS = new WeakMap<WritingYear, Map<string, Masks>>();

function masksFor(year: WritingYear, key: string, paint: () => Masks): Masks {
  let byBook = MASKS.get(year);
  if (!byBook) {
    byBook = new Map();
    MASKS.set(year, byBook);
  }
  let masks = byBook.get(key);
  if (!masks) {
    masks = paint();
    byBook.set(key, masks);
  }
  return masks;
}

/**
 * The library's year on the shelf (docs/writing-days.md): 53 weeks, Monday
 * at the top, one dab of sand for each day written, larger and fuller the
 * more words, a few loose grains for a day without. The levels are the
 * quartiles of the days written. Beside it, the year's words, the days
 * written, the streak and today. While the pointer is on a book's card the
 * map shows that book alone, in its colour, and the numbers are its own.
 * Pointing at a day opens a hover card with its words, book by book.
 */
export function WritingHeatmap({ year, books, focusId }: {
  year: WritingYear;
  books: readonly HeatmapBook[];
  focusId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { attach, drawn } = useCharSeaShape<HTMLElement>({ rest: 0.85, radius: 2, hover: false });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const [hotElement, setHotElement] = useState<HTMLElement | null>(null);

  const columns = Math.ceil(year.days.length / 7);
  const width = columns * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
  const height = 7 * HEAT_STEP - (HEAT_STEP - HEAT_CELL);
  const focus = (focusId && books.find((book) => book.id === focusId)) || null;
  const zeros = useMemo(() => year.days.map(() => 0), [year]);
  const daily = focus ? (year.byProject[focus.id] ?? zeros) : year.total;
  const thresholds = useMemo(() => writingDayThresholds(year.total), [year]);

  const shown = typeof document === 'undefined'
    ? null
    : masksFor(year, focus?.id ?? '', () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const painted = paintHeatmap(daily.map((words) => writingDayLevel(words, thresholds)), columns, dpr);
        return { dabs: sandMaskURL(painted.dabs), loose: sandMaskURL(painted.loose) };
      });

  const months = useMemo(() => {
    const labels: { column: number; text: string }[] = [];
    let last = -9;
    year.days.forEach((day, i) => {
      const column = Math.floor(i / 7);
      if (!day.endsWith('-01') || column - last < 3 || column > columns - 2) return;
      labels.push({ column, text: formatShelfMonth(day, locale) });
      last = column;
    });
    return labels;
  }, [year, columns, locale]);

  // A narrow window scrolls the map, and opens on today.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [columns]);

  const summary = summarizeWritingDays(daily);
  const wordsUnit = t('projectPicker.desk.wordsUnit');
  const daysUnit = t('projectPicker.heat.daysUnit');

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left + 1.5) / HEAT_STEP);
    const row = Math.floor((event.clientY - rect.top + 1.5) / HEAT_STEP);
    const index = column * 7 + row;
    setHot(column >= 0 && row >= 0 && row < 7 && index < year.days.length ? index : null);
  };

  const hotDay = hot === null ? null : year.days[hot];
  const hotRows = hot === null || focus
    ? []
    : books
        .map((book) => ({ book, words: year.byProject[book.id]?.[hot] ?? 0 }))
        .filter((row) => row.words > 0)
        .sort((left, right) => right.words - left.words);

  return (
    <section
      ref={attach}
      className={`pp-heat glass glass--rest glass--still${drawn ? ' pp-heat--sea' : ''}`}
      aria-label={t('projectPicker.heat.label')}
    >
      <div ref={scrollRef} className="pp-heat__scroll">
        <div className="pp-heat__months" style={{ width }} aria-hidden="true">
          {months.map((month) => (
            <span key={month.column} style={{ left: month.column * HEAT_STEP }}>{month.text}</span>
          ))}
        </div>
        <div className="pp-heat__body">
          <div className="pp-heat__weekdays" aria-hidden="true">
            <span>{t('projectPicker.heat.mon')}</span>
            <span />
            <span>{t('projectPicker.heat.wed')}</span>
            <span />
            <span>{t('projectPicker.heat.fri')}</span>
          </div>
          <div
            className="pp-heat__cells"
            style={{ width, height }}
            role="img"
            aria-label={t('projectPicker.heat.summary', {
              words: formatShelfWords(summary.words, locale),
              days: summary.daysWritten,
            })}
            onPointerMove={point}
            onPointerLeave={() => setHot(null)}
          >
            {shown && (
              <>
                <i className="sand pp-heat__layer" style={{ '--sand-mask': `url(${shown.loose})` } as CSSProperties} />
                <i
                  className="sand pp-heat__layer"
                  style={{ '--sand-mask': `url(${shown.dabs})`, '--sand-c': focus?.color } as CSSProperties}
                />
              </>
            )}
            {hot !== null && (
              <i
                ref={setHotElement}
                className="pp-heat__hot"
                style={{ left: Math.floor(hot / 7) * HEAT_STEP - 1, top: (hot % 7) * HEAT_STEP - 1 }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </div>
      <dl className="pp-heat__nums">
        <div>
          {focus ? (
            <dt className="pp-heat__book">
              <i className="sand sand--blob-1 pp-heat__mark" style={{ '--sand-c': focus.color } as CSSProperties} />
              <span>{focus.name}</span>
            </dt>
          ) : (
            <dt>{t('projectPicker.heat.year')}</dt>
          )}
          <dd><b>{formatShelfWords(summary.words, locale)}</b>{wordsUnit}</dd>
        </div>
        <div>
          <dt>{t('projectPicker.heat.daysWritten')}</dt>
          <dd><b>{summary.daysWritten}</b>{daysUnit}</dd>
        </div>
        <div>
          <dt>{t('projectPicker.heat.streak')}</dt>
          <dd><b>{summary.streakDays}</b>{daysUnit}</dd>
        </div>
        <div>
          <dt>{t('projectPicker.heat.today')}</dt>
          <dd><b>{summary.todayWords.toLocaleString(locale)}</b>{wordsUnit}</dd>
        </div>
      </dl>
      {hot !== null && hotDay && hotElement && (
        <HoverCardShell anchor={hotElement} placement="top-center" width={216} label={formatShelfDay(hotDay, locale)}>
          <HoverCardHeading
            title={formatShelfDay(hotDay, locale)}
            index={`${daily[hot].toLocaleString(locale)} ${wordsUnit}`}
          />
          {hotRows.length > 0 && (
            <div className="pp-heat__books">
              {hotRows.map(({ book, words }) => (
                <div key={book.id} className="pp-heat__books-row">
                  <i className="sand sand--blob-1 pp-heat__mark" style={{ '--sand-c': book.color } as CSSProperties} />
                  <span>{book.name}</span>
                  <b>{words.toLocaleString(locale)}</b>
                </div>
              ))}
            </div>
          )}
        </HoverCardShell>
      )}
    </section>
  );
}
