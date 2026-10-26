import { useCallback, useState } from 'react';
import loglevel from 'loglevel';

import { useAgentChatStore } from '../../store/agent-chat-store';
import { showAgentTaskInRightSidebar } from '../../store/desktop-agent-navigation';
import {
  ELEMENT_IMAGE_TOOL_NAME,
  markElementImageConversation,
  rememberElementImageRequest,
} from '../../lib/agent/element-image-requests';
import type { ElementImageGenerationState } from './ElementImageCandidates';

const log = loglevel.getLogger('elementImageTask');
log.setLevel(loglevel.levels.WARN);

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * The background task the element page hands to the Agent. An element can be
 * a person, place, object, group, phenomenon or idea, so the task names the
 * element and its category for the Agent to read and assumes neither.
 */
export function buildElementImageTask(input: {
  elementId: string;
  elementName: string;
  categoryName: string | null;
  count: number;
  extraPrompt: string | null;
  styleText: string | null;
}) {
  const name = oneLine(input.elementName) || input.elementId;
  const category = input.categoryName ? oneLine(input.categoryName) : '';
  const style = input.styleText?.trim() ?? '';
  const title = `设定图：${name.slice(0, 30)}`;
  const lines = [
    `请为写作要素「${name}」（${category ? `分类「${category}」，` : ''}id：${input.elementId}）生成 ${input.count} 张设定图候选。`,
    category
      ? `先用 read_element 读要素「${name}」，再用 read_element_category 读分类「${category}」，弄清这个要素是什么、这一类要素在作品里怎么定位。`
      : `先用 read_element 读要素「${name}」，弄清它是什么；它没有分类。`,
    '要素可以是人物、地点、物件、组织、现象或概念，按它本身的性质决定画什么，不要默认它是人物。设定散在正文里时，用 find_element_appearances 找相关段落。',
    `据此写一段具体的画面描述：画面主体、它的样子、所处环境、构图和氛围。${
      style
        ? '不要写画风，项目画风会自动附在描述后面。'
        : '项目没有设定画风，请按作品气质选一种画风写进描述。'
    }`,
    `然后调用 ${ELEMENT_IMAGE_TOOL_NAME}，elementId 填 ${input.elementId}，count 填 ${input.count}，prompt 填这段描述。`,
    '最后用一两句话说明画面依据了哪些设定。',
  ];
  if (input.extraPrompt) lines.splice(4, 0, `作者这次的补充要求：${input.extraPrompt}`);
  return { title, prompt: lines.join('\n\n') };
}

// element id → the generation conversation launched from its page in this
// app run. While that turn runs, the page opens it instead of starting another.
const generationConversationByElement = new Map<string, string>();

/**
 * Element page's "生成设定图": starts a background read-write Agent session
 * that reads the element and its category, describes an image and calls the
 * image tool, then shows it in the
 * right sidebar; while it runs, the action reveals that session instead.
 */
export function useElementImageGeneration(projectId: string | null, elementId: string | null) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useAgentChatStore((state) => {
    if (!elementId) return false;
    const conversationId = generationConversationByElement.get(elementId);
    return Boolean(conversationId && state.runningTurns[conversationId]);
  });

  const openSession = useCallback(async () => {
    const conversationId = elementId ? generationConversationByElement.get(elementId) : undefined;
    if (conversationId) await showAgentTaskInRightSidebar(conversationId, { force: true });
  }, [elementId]);

  const start = useCallback(
    async (input: {
      elementName: string;
      categoryName: string | null;
      count: number;
      extraPrompt: string | null;
      styleText: string | null;
    }) => {
      if (!projectId || !elementId) return;
      const existing = generationConversationByElement.get(elementId);
      if (existing && useAgentChatStore.getState().runningTurns[existing]) {
        await showAgentTaskInRightSidebar(existing, { force: true });
        return;
      }
      const chat = useAgentChatStore.getState();
      if (chat.boundProjectId !== projectId) {
        chat.bindProject(projectId, { restoreLastConversation: false });
      }
      const task = buildElementImageTask({ elementId, ...input });
      rememberElementImageRequest(elementId, { count: input.count, extraPrompt: input.extraPrompt });
      setStarting(true);
      setError(null);
      try {
        let conversationId: string | null = null;
        await useAgentChatStore.getState().send({
          runtimePrompt: task.prompt,
          background: { title: task.title },
          toolAccess: 'read_write',
          onStarted: (id) => {
            conversationId = id;
            markElementImageConversation(id);
          },
        });
        if (conversationId) {
          generationConversationByElement.set(elementId, conversationId);
          await showAgentTaskInRightSidebar(conversationId);
        } else {
          log.warn('Element image generation did not start', elementId);
          setError('not_started');
        }
      } catch (cause) {
        log.error('Failed to start element image generation', elementId, cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setStarting(false);
      }
    },
    [elementId, projectId],
  );

  const state: ElementImageGenerationState = starting ? 'starting' : running ? 'running' : 'idle';
  return { state, error, start, openSession };
}
