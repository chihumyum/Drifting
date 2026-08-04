import { WORKSPACE_COMPLETE_READ_MODEL_MARKER } from './drifting-workspace-tool-contract';

interface WorkspaceDomainWriteResult {
  path: string;
  requestedPath?: string;
  replacements?: number;
  skippedStale?: number;
  operation?: 'created' | 'updated' | 'deleted';
  wordCount?: number;
  summaryInitialized?: true;
  summaryUpdated?: true;
  changeSummary?: string;
  remainingWork?: string;
  authoredReadState?: {
    targetKey: string;
    target: string;
    summary: string;
    completeBodyRead: boolean;
    focusedBodyEdit: boolean;
    currentPassages: string[];
  } | null;
}

/**
 * Convert the virtual workspace identity used by tool calls into the authored
 * object the model should reason about after the operation has completed.
 * Persistence ids and path syntax remain runtime-only provenance.
 */
export function describeWorkspaceDomainTarget(path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map(decodeWorkspaceSegment);
  const field = segments[segments.length - 1] ?? '';
  switch (segments[0]) {
    case 'chapters':
      return describeNodeField('章节', segments[1], field);
    case 'drifts':
      return describeNodeField('灵感', segments[1], field);
    case 'elements':
      return describeNamedField('要素', segments[2], field, {
        'body.md': '设定',
        'summary.md': '摘要',
        'aliases.json': '别名',
        'facts.json': '事实',
        'group.txt': '分组',
        'category.txt': '分类',
      });
    case 'storylines':
      return describeNamedField('故事线', segments[1], field, {
        'body.md': '说明',
        'summary.md': '摘要',
        'facts.json': '事实',
        'chapters.json': '章节关系',
      });
    case 'categories':
      return describeNamedField('要素分类', segments[1], field, {
        'body.md': '说明',
      });
    case 'comments':
      return namedTarget('批注或待办', stripExtension(segments[1]));
    case 'relations':
      return namedTarget('实体关系', stripExtension(segments[1]));
    case 'memory':
      return namedTarget('作者规则', stripExtension(segments[1]));
    case 'materials':
      return namedTarget('素材', stripExtension(segments[1]));
    case 'project':
      return field === 'facts.json' ? '项目规则' : '项目信息';
    default:
      return field === 'README.md' ? '作品说明' : '作品内容';
  }
}

export function describeAgentWriteTarget(
  toolName: string,
  arguments_: unknown,
): string {
  const record = isRecord(arguments_) ? arguments_ : {};
  if (typeof record.path === 'string' && record.path.trim()) {
    return describeWorkspaceDomainTarget(record.path);
  }
  if (/project_facts/u.test(toolName)) return '项目规则';
  if (/element_patch/u.test(toolName)) return '正典演化记录';
  if (/relation/u.test(toolName)) return '实体关系';
  if (/comment|todo/u.test(toolName)) {
    return namedTarget('批注或待办', firstString(record, ['comment', 'body', 'target']));
  }
  if (/storyline/u.test(toolName)) {
    return namedTarget('故事线', firstString(record, ['storyline', 'name', 'entity']));
  }
  if (/element/u.test(toolName)) {
    return namedTarget('要素', firstString(record, ['element', 'name', 'entity']));
  }
  const nodeKind = record.kind === 'drift' ? '灵感' : record.kind === 'chapter' ? '章节' : '作品内容';
  return namedTarget(nodeKind, firstString(record, ['node', 'entity', 'title', 'name']));
}

export function describeWorkspaceDomainWriteResult(
  result: WorkspaceDomainWriteResult,
): string {
  const authoredPath = result.requestedPath ?? result.path;
  const target = describeWorkspaceDomainTarget(authoredPath);
  const targetIsSummary = authoredPath.endsWith('/summary.md');
  let message: string;
  if (result.operation === 'created') {
    message = `${target}已创建。`;
  } else if (result.operation === 'deleted') {
    message = `${target}已删除。`;
  } else if (typeof result.replacements === 'number') {
    message = `${target}已完成 ${result.replacements} 处修改。`;
  } else {
    message = `${target}已更新。`;
  }
  if (typeof result.wordCount === 'number') {
    message += `当前 ${result.wordCount} 字。`;
  }
  if (result.summaryInitialized) {
    message += '摘要已同时建立。';
  } else if (result.summaryUpdated && !targetIsSummary) {
    message += '摘要已同步更新。';
  }
  if (result.changeSummary?.trim()) {
    message += `完成内容：${result.changeSummary.trim().replace(/[。；;\s]+$/u, '')}。`;
  }
  if (result.authoredReadState?.completeBodyRead) {
    const summary = result.authoredReadState.summary.replace(/\s+/gu, ' ').trim();
    message += `${WORKSPACE_COMPLETE_READ_MODEL_MARKER}，之后的修改已计入当前稿件。`;
    message += summary
      ? `当前摘要：${withSentenceTerminal([...summary].slice(0, 1_200).join(''))}`
      : '当前摘要为空。';
    if (result.authoredReadState.focusedBodyEdit) {
      const passages = result.authoredReadState.currentPassages
        .map((passage) => passage.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .slice(0, 8);
      if (passages.length > 0) {
        message += `当前修改后的正文片段：${passages
          .map((passage) => `「${[...passage].slice(0, 320).join('')}」`)
          .join('；')}。`;
      }
    }
  }
  const remainingWork = modelFacingRemainingWork(result.remainingWork);
  if (remainingWork) {
    message += `仍待完成：${remainingWork}。`;
  }
  if (result.operation === 'created' && result.path.startsWith('/categories/')) {
    message += '现在可以在该分类中新建要素。';
  }
  return `${message}这一步已经完成；直接继续剩余任务，不要为了确认写入而重读。`;
}

function withSentenceTerminal(value: string): string {
  return /[。！？…!?]$/u.test(value) ? value : `${value}。`;
}

function modelFacingRemainingWork(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const compact = value.replace(/\s+/gu, ' ').trim().slice(0, 240);
  if (
    /(?:局部修改|正文已变化|目标已不在|重新定位|跳过|未重复执行)/u.test(compact) ||
    /\b(?:stale|skipped|not found|already changed|local edit)\b/iu.test(compact) ||
    /\b(?:json|path|revision|receipt|writeref|yjs|sqlite|write_file|edit_file)\b/iu.test(
      compact,
    )
  ) {
    return null;
  }
  return compact.replace(/[。；;\s]+$/u, '');
}

function describeNodeField(kind: '章节' | '灵感', name: string | undefined, field: string): string {
  return describeNamedField(kind, name, field, {
    'prose.md': '正文',
    'summary.md': '摘要',
    'title.txt': '标题',
  });
}

function describeNamedField(
  kind: string,
  name: string | undefined,
  field: string,
  fields: Readonly<Record<string, string>>,
): string {
  const target = namedTarget(kind, name);
  const suffix = fields[field];
  return suffix ? `${target}${suffix}` : target;
}

function namedTarget(kind: string, name: string | undefined): string {
  return name?.trim() ? `${kind}「${name.trim()}」` : kind;
}

function firstString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stripExtension(value: string | undefined): string | undefined {
  return value?.replace(/\.[^.]+$/u, '');
}

function decodeWorkspaceSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
