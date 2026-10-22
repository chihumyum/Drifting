import { useEffect } from 'react';
import { create } from 'zustand';

// Which chapter of 通览全书 the author is typing in, per project. The footer
// shows that chapter's words instead of the book's while it is set.
interface WholeBookEditingState {
  chapterByProject: Record<string, string | null>;
  setEditingChapter: (projectId: string, chapterId: string | null) => void;
}

export const useWholeBookEditingStore = create<WholeBookEditingState>((set) => ({
  chapterByProject: {},
  setEditingChapter: (projectId, chapterId) =>
    set((state) =>
      (state.chapterByProject[projectId] ?? null) === chapterId
        ? state
        : { chapterByProject: { ...state.chapterByProject, [projectId]: chapterId } },
    ),
}));

interface FocusCandidate {
  isContentEditable: boolean;
  tagName: string;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The chapter being edited is the row holding keyboard focus in an editable
 * field — its prose, title or summary. Focus on ⁂ or anywhere outside the
 * whole-book scroller is not editing.
 */
export function editingChapterIdFor(
  active: FocusCandidate | null,
  root: { contains(node: unknown): boolean } | null,
): string | null {
  if (!active || !root || !root.contains(active)) return null;
  const editable = active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT';
  if (!editable) return null;
  return active.closest('[data-chapter-id]')?.getAttribute('data-chapter-id') ?? null;
}

// Leaving is published a moment late, so moving the caret from one chapter
// to another (the next row's live editor mounts first) does not flash the
// book's total in between.
const LEAVE_DELAY_MS = 200;

/**
 * Publishes the edited chapter while focus moves inside 通览全书. Losing focus
 * to another app keeps the chapter: the author has not left it.
 */
export function useWholeBookEditingChapter(projectId: string, getRoot: () => HTMLElement | null) {
  useEffect(() => {
    let leaveTimer: number | undefined;
    const publish = () => {
      if (!document.hasFocus()) return;
      const chapterId = editingChapterIdFor(document.activeElement as HTMLElement | null, getRoot());
      const store = useWholeBookEditingStore.getState();
      window.clearTimeout(leaveTimer);
      if (chapterId) store.setEditingChapter(projectId, chapterId);
      else leaveTimer = window.setTimeout(() => store.setEditingChapter(projectId, null), LEAVE_DELAY_MS);
    };
    // focusout fires before the next element takes focus.
    const publishAfterFocusMoves = () => {
      window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(publish, 0);
    };
    document.addEventListener('focusin', publish);
    document.addEventListener('focusout', publishAfterFocusMoves);
    publish();
    return () => {
      window.clearTimeout(leaveTimer);
      document.removeEventListener('focusin', publish);
      document.removeEventListener('focusout', publishAfterFocusMoves);
      useWholeBookEditingStore.getState().setEditingChapter(projectId, null);
    };
  }, [getRoot, projectId]);
}
