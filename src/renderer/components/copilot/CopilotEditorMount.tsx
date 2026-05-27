/**
 * CopilotEditorMount — bridges ChapterEditor (which has editor + projectId +
 * nodeId in scope) to useCopilot (which additionally requires a non-null
 * userId from auth). Returns null; its only purpose is to host the hook.
 *
 * The inner component pattern (CopilotMountInner) is what lets us call
 * useCopilot only after asserting userId and editor are non-null — useCopilot
 * uses useManuscriptComment, which throws on empty userId, so it can't be
 * conditionally called from a component that may have userId === undefined.
 */
import type { Editor } from '@tiptap/core';
import { useAuthStore } from '../../store/auth';
import { useCopilot } from '../../hooks/useCopilot';

interface CopilotEditorMountProps {
  editor: Editor | null;
  projectId: string;
  nodeId: string;
}

export function CopilotEditorMount({
  editor,
  projectId,
  nodeId,
}: CopilotEditorMountProps) {
  const userId = useAuthStore((s) => s.user?.id);

  if (!editor || !userId || !projectId || !nodeId) return null;

  return (
    <CopilotMountInner
      editor={editor}
      projectId={projectId}
      nodeId={nodeId}
      userId={userId}
    />
  );
}

function CopilotMountInner({
  editor,
  projectId,
  nodeId,
  userId,
}: {
  editor: Editor;
  projectId: string;
  nodeId: string;
  userId: string;
}): null {
  useCopilot({ editor, projectId, nodeId, userId });
  return null;
}
