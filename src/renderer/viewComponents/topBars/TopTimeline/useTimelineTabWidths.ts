import { useMemo } from 'react';
import type { BookNode } from '../../../domain/book-node';
import type { BookElement } from '../../../domain/book-element';

const textMeasureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

interface UseTimelineTabWidthsOptions {
  timelineItems: Array<BookNode | BookElement>;
  containerWidth: number;
  selectedItemId: string | null | undefined;
  gap: number;
  minWidth?: number;
  maxWidth?: number;
  padding?: number;
}

export function useTimelineTabWidths({
  timelineItems,
  containerWidth,
  selectedItemId,
  gap,
  minWidth = 40,
  maxWidth = 180,
  padding = 20,
}: UseTimelineTabWidthsOptions) {
  const widths = useMemo(() => {
    if (timelineItems.length === 0 || containerWidth === 0) {
      return timelineItems.map(() => maxWidth);
    }

    const selectedIndex = timelineItems.findIndex((item) => item.id === selectedItemId);
    const hasSelected = selectedIndex !== -1;

    const measureTextWidth = (text: string, fontSize: number, fontWeight: number): number => {
      if (!textMeasureCanvas) return Math.ceil(text.length * fontSize * 0.58);
      const ctx = textMeasureCanvas.getContext('2d');
      if (!ctx) return 0;
      ctx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      return Math.ceil(ctx.measureText(text).width);
    };

    const idealWidths = timelineItems.map((item) => {
      const title = 'title' in item ? item.title : item.name;
      const titleWidth = measureTextWidth(
        title || ('title' in item ? 'Untitled Chapter' : 'Untitled Element'),
        13,
        400
      );
      return Math.min(Math.max(titleWidth + padding, minWidth), maxWidth);
    });

    const selectedIdealWidth = hasSelected ? idealWidths[selectedIndex] : 0;
    const unselectedMinTotal = timelineItems.reduce((sum, _, idx) => {
      if (idx === selectedIndex) return sum;
      return sum + minWidth;
    }, 0);
    const minRequiredTotalWidth = (hasSelected ? selectedIdealWidth : 0) + unselectedMinTotal;
    const totalGaps = gap * timelineItems.length;

    let expansionFactor = 1;
    let targetAvailableWidth = 0;
    while (expansionFactor <= 64) {
      const targetContainerWidth = containerWidth * expansionFactor;
      targetAvailableWidth = targetContainerWidth - totalGaps - 16;
      if (targetAvailableWidth >= minRequiredTotalWidth) {
        break;
      }
      expansionFactor *= 2;
    }

    if (targetAvailableWidth < minRequiredTotalWidth) {
      return idealWidths;
    }

    const currentSelectedWidth = hasSelected ? idealWidths[selectedIndex] : 0;
    const availableForUnselected = targetAvailableWidth - currentSelectedWidth;
    const totalIdealUnselected = idealWidths.reduce((sum, width, idx) => {
      if (idx === selectedIndex) return sum;
      return sum + width;
    }, 0);

    if (totalIdealUnselected <= availableForUnselected) {
      return timelineItems.map((_, idx) => {
        if (idx === selectedIndex) return currentSelectedWidth;
        return idealWidths[idx];
      });
    }

    return timelineItems.map((_, idx) => {
      if (idx === selectedIndex) return currentSelectedWidth;
      return availableForUnselected / Math.max(timelineItems.length - 1, 1);
    });
  }, [timelineItems, containerWidth, selectedItemId, gap, minWidth, maxWidth, padding]);

  const getNodeWidth = (index: number) => {
    return widths[index] ?? minWidth;
  };

  return { widths, getNodeWidth };
}

