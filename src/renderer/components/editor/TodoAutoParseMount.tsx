/**
 * TodoAutoParseMount — hosts useTodoAutoParse for one chapter editor. Returns
 * null; it only exists so the hook runs after userId and editor are known
 * (useComment throws on an empty userId). Drift editors are scratch space and
 * stay without TODO projections.
 */
import type { Editor } from '@tiptap/core';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { isDrift } from '../../domain/book-node';
import { useTodoAutoParse } from '../../hooks/useTodoAutoParse';

interface TodoAutoParseMountProps {
  editor: Editor | null;
  projectId: string;
  nodeId: string;
}

export function TodoAutoParseMount({ editor, projectId, nodeId }: TodoAutoParseMountProps) {
  const userId = useAuthStore((s) => s.user?.id);
  // `.find` returns the stored node object, so this selector does not churn.
  const node = useDataStore((s) => s.bookNodes.find((n) => n.id === nodeId));

  if (!editor || !userId || !projectId || !nodeId) return null;
  if (node && isDrift(node)) return null;

  return <TodoAutoParseInner editor={editor} projectId={projectId} nodeId={nodeId} userId={userId} />;
}

function TodoAutoParseInner(props: {
  editor: Editor;
  projectId: string;
  nodeId: string;
  userId: string;
}): null {
  useTodoAutoParse(props);
  return null;
}
