/**
 * The task a returning author's organize pass hands to a background General
 * Agent: fold what the author wrote last time into the project's elements,
 * element changes and relations. The prompt states principles only; the Agent
 * reads the prose and chooses its own tools.
 */
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { CheckinChangedDocument } from '../checkin/checkin-delta';

const KIND_LABELS: Record<CheckinChangedDocument['objectKind'], string> = {
  chapter: '章节',
  idea: '构想',
  element: '要素',
  storyline: '故事线',
  category: '要素分类',
};

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** True when a digest carries prose rather than only formatting changes. */
export function hasOrganizableChange(document: CheckinChangedDocument): boolean {
  const digest = document.digest.trim();
  return Boolean(digest) && digest !== '（只有格式或空白变化）' && digest !== '（正文为空）';
}

export function buildOrganizeTask(documents: readonly CheckinChangedDocument[]): {
  title: string;
  prompt: string;
} {
  const first = oneLine(documents[0]?.title ?? '') || '上次写的内容';
  const title =
    documents.length > 1
      ? `整理：${first.slice(0, 24)} 等 ${documents.length} 篇`
      : `整理：${first.slice(0, 30)}`;
  const changes = documents.map((document) =>
    [
      `## ${KIND_LABELS[document.objectKind]}「${oneLine(document.title) || '未命名'}」`,
      document.hasBaseline ? '改动：' : '新写的，或此前没有本地版本；节选：',
      document.digest,
    ].join('\n'),
  );
  const prompt = [
    '作者上次在 Drifting 里写了下面这些内容。请把其中新出现或发生变化的设定整理进项目，让要素跟上正文。',
    `改动（+ 新增，- 删除，~ 修改为 [-原-]{+现+}；只是摘录，需要时读全文）：\n\n${changes.join('\n\n')}`,
    [
      '做法：',
      '- 先查已有要素和项目记忆。同一个人物、地点或物件换了称呼也要认出来，不要重复新建。',
      '- 正文里新出现、往后还会用到的人物、地点、物件、组织等，新建要素，写下正文给出的设定。',
      '- 已有要素在正文里有了新信息就更新它；人物或事物的状态在某一章起了变化，就在那一章记一条要素变更。',
      '- 正文里写明的关系也记下来。',
      '- 项目记忆里作者对登记和整理的要求优先。拿不准的事不要替作者决定。',
      '- 不要修改正文，不要删除任何东西。',
      '- 这是一次就能做完的整理，不要建立任务计划。',
    ].join('\n'),
    '完成后用几句话告诉作者：新建、更新了哪些要素，记了哪些变更和关系，以及需要作者确认的事。',
  ].join('\n\n');
  return { title, prompt };
}

export interface OrganizeCounts {
  elementsCreated: number;
  elementsUpdated: number;
  patches: number;
  relations: number;
}

const COUNTED_TOOLS: Record<string, keyof OrganizeCounts> = {
  create_element: 'elementsCreated',
  update_element: 'elementsUpdated',
  revise_element: 'elementsUpdated',
  replace_element_body: 'elementsUpdated',
  create_element_patch: 'patches',
  update_element_patch: 'patches',
  create_relation: 'relations',
  update_relation: 'relations',
};

export const EMPTY_ORGANIZE_COUNTS: OrganizeCounts = Object.freeze({
  elementsCreated: 0,
  elementsUpdated: 0,
  patches: 0,
  relations: 0,
}) as OrganizeCounts;

/** What a finished organize session did: its closing reply and its writes. */
export function summarizeOrganizeTranscript(messages: readonly AgentChatMessage[]): {
  summary: string;
  counts: OrganizeCounts;
} {
  const counts = { ...EMPTY_ORGANIZE_COUNTS };
  let summary = '';
  for (const message of messages) {
    if (message.kind === 'tool' && message.status === 'ok') {
      const key = COUNTED_TOOLS[message.name];
      if (key) counts[key] += 1;
    } else if (message.kind === 'assistant' && message.text.trim()) {
      summary = message.text.trim();
    } else if (message.kind === 'user') {
      summary = '';
    }
  }
  return { summary, counts };
}
