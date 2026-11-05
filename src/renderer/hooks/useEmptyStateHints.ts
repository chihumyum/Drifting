import { useTranslation } from 'react-i18next';
import type { EmptyStateHint } from '../components/ui/EmptyState';
import { formatAccelerator } from '../lib/shortcuts';
import { useShortcutsStore, type ShortcutActionId } from '../store/shortcuts-store';

/**
 * The rows an empty view writes under its sentence on the desktop. Each names
 * an action and shows the shortcut the author has bound to it now.
 */
export function useEmptyStateHints() {
  const { t } = useTranslation();
  const bindings = useShortcutsStore((state) => state.bindings);
  const shortcut = (action: ShortcutActionId) => formatAccelerator(bindings[action]);
  return {
    /**
     * An empty paper: the Markdown for the three heading levels, then the two
     * ways around the book. H1–H3 are named only by level; what a level means
     * is the author's to decide.
     */
    paper: [
      { label: 'H1', keys: '#' },
      { label: 'H2', keys: '##' },
      { label: 'H3', keys: '###' },
      { label: t('guide.hints.search'), keys: shortcut('globalSearch') },
      { label: t('guide.hints.timeline'), keys: shortcut('toggleBottomTimeline') },
    ] satisfies EmptyStateHint[],
    driftRipens: { label: t('guide.hints.driftRipens') } satisfies EmptyStateHint,
    todo: { label: t('guide.hints.todo'), keys: 'TODO' } satisfies EmptyStateHint,
  };
}
