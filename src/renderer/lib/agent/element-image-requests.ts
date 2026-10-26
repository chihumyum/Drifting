/**
 * Author requests from the element page's "生成设定图" dialog, kept for this
 * app run. Import-free so the capability manifest can load the tool name in
 * Node. The image tool reads the request by element id so provenance records
 * the author's extra prompt exactly as typed, whatever the Agent passes, and
 * it runs without a prompt only in conversations the page started.
 */

export const ELEMENT_IMAGE_TOOL_NAME = 'generate_element_images' as const;
export const DEFAULT_ELEMENT_IMAGE_COUNT = 2;
export const MAX_ELEMENT_IMAGE_COUNT = 4;

export interface ElementImageRequest {
  count: number;
  extraPrompt: string | null;
}

const pendingRequests = new Map<string, ElementImageRequest>();
const pageConversations = new Set<string>();

export function rememberElementImageRequest(elementId: string, request: ElementImageRequest) {
  pendingRequests.set(elementId, request);
}

export function readElementImageRequest(elementId: string): ElementImageRequest | null {
  return pendingRequests.get(elementId) ?? null;
}

/** Marks a background conversation the element page started for generation. */
export function markElementImageConversation(conversationId: string) {
  pageConversations.add(conversationId);
}

export function isElementImageConversation(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && pageConversations.has(conversationId));
}
