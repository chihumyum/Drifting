import type { JSONContent } from '@tiptap/core';

const EMPTY_TIPTAP_DOC: JSONContent = {
  type: 'doc',
  content: [],
};

export function createEmptyTiptapDoc(): JSONContent {
  return {
    type: 'doc',
    content: [],
  };
}

export function isTiptapDoc(value: unknown): value is JSONContent {
  if (!value || typeof value !== 'object') return false;
  const maybeDoc = value as { type?: unknown; content?: unknown };
  return maybeDoc.type === EMPTY_TIPTAP_DOC.type && Array.isArray(maybeDoc.content);
}

export function parseTiptapDocJson(
  contentJson: string | null | undefined,
  onParseError?: (error: unknown) => void,
): JSONContent {
  if (!contentJson) return createEmptyTiptapDoc();

  try {
    const parsed = JSON.parse(contentJson);
    if (isTiptapDoc(parsed)) {
      return parsed;
    }
  } catch (error) {
    onParseError?.(error);
  }

  return createEmptyTiptapDoc();
}
