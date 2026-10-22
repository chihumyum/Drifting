import { useCallback, useState } from 'react';
import loglevel from 'loglevel';

import { useAgentChatStore } from '../../store/agent-chat-store';
import { showAgentTaskInRightSidebar } from '../../store/desktop-agent-navigation';
import type { ChapterEndReviewState } from '../../components/editor/ChapterEndOrnament';

const log = loglevel.getLogger('chapterAgentReview');
log.setLevel(loglevel.levels.WARN);

/** The background task the ⁂ menu hands to the Agent: review in comments. */
export function buildChapterReviewTask(chapterTitle: string) {
  const title = `审阅：${chapterTitle.replace(/\s+/gu, ' ').slice(0, 30)}`;
  const prompt = [
    `请审阅章节《${chapterTitle}》。`,
    '先完整读一遍这一章，再把具体意见用批注写在对应段落上，不要直接修改正文。',
    '最后用几句话总结整体印象和最值得先处理的问题。',
  ].join('\n\n');
  return { title, prompt };
}

// chapter id → the review conversation launched from its ⁂ in this app run.
// While that turn runs, the menu opens it instead of starting a second review.
const reviewConversationByNode = new Map<string, string>();

/**
 * ⁂ menu's "Agent 审阅": starts a background Agent session that reviews the
 * chapter in comments (read-write, like a TODO hand-off) and shows it in the
 * right sidebar's Agent tab, or reveals the one already running for it.
 */
export function useChapterAgentReview(projectId: string, nodeId: string, chapterTitle: string) {
  const [starting, setStarting] = useState(false);
  const running = useAgentChatStore((state) => {
    const conversationId = reviewConversationByNode.get(nodeId);
    return Boolean(conversationId && state.runningTurns[conversationId]);
  });

  const run = useCallback(async () => {
    const existing = reviewConversationByNode.get(nodeId);
    if (existing && useAgentChatStore.getState().runningTurns[existing]) {
      await showAgentTaskInRightSidebar(existing, { force: true });
      return;
    }
    const chat = useAgentChatStore.getState();
    if (chat.boundProjectId !== projectId) chat.bindProject(projectId, { restoreLastConversation: false });
    const task = buildChapterReviewTask(chapterTitle);
    setStarting(true);
    try {
      let conversationId: string | null = null;
      await useAgentChatStore.getState().send({
        runtimePrompt: task.prompt,
        background: { title: task.title },
        toolAccess: 'read_write',
        onStarted: (id) => { conversationId = id; },
      });
      if (conversationId) {
        reviewConversationByNode.set(nodeId, conversationId);
        // Show the new session where the author can follow it.
        await showAgentTaskInRightSidebar(conversationId);
      } else {
        log.warn('Agent review did not start', nodeId);
      }
    } catch (error) {
      log.error('Failed to start Agent review', nodeId, error);
    } finally {
      setStarting(false);
    }
  }, [chapterTitle, nodeId, projectId]);

  const state: ChapterEndReviewState = starting ? 'starting' : running ? 'running' : 'idle';
  return { state, run };
}

