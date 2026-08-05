type ActivityLanguage = 'zh' | 'en';

type ActivityVerb = 'browse' | 'read' | 'edit' | 'write' | 'create' | 'delete';

/**
 * A tool card is born before its streamed JSON arguments are complete. Domain
 * labels such as "查看作品结构" would therefore be guesses at that stage (the
 * target helper has to fall back to the project root). Keep the row absent until its real input
 * is available; a short delay is preferable to visibly renaming a placeholder.
 */
export function shouldDisplayAgentToolActivity(input: {
  phase?: string;
  toolInput: unknown;
  status?: string;
}): boolean {
  return (
    input.status === 'error' ||
    input.phase !== 'arguments' ||
    input.toolInput !== undefined
  );
}

/**
 * Translate the runtime's authored-object operations into author-facing domain
 * language. Storage identities never leak into the ordinary progress feed.
 */
export function describeAgentToolActivity(
  toolName: string,
  input: unknown,
  language: string,
): string | null {
  const args = asRecord(input);
  const lang: ActivityLanguage = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  if (toolName === 'search_work' || toolName === 'grep') {
    const query = stringValue(args.query);
    if (!query) return lang === 'zh' ? '检索小说内容' : 'Search the novel';
    return lang === 'zh'
      ? `检索小说内容“${query}”`
      : `Search the novel for “${query}”`;
  }
  if (toolName === 'browse_project' || toolName === 'list_files') {
    return describeWorkspacePath(
      stringValue(args.collection) || stringValue(args.path) || '/',
      'browse',
      lang,
    );
  }
  if (toolName === 'read_object' || toolName === 'read_file') {
    return describeWorkspacePath(
      stringValue(args.target) || stringValue(args.path) || '/',
      'read',
      lang,
    );
  }
  if (toolName === 'revise_object' || toolName === 'edit_file') {
    return describeWorkspacePath(
      stringValue(args.target) || stringValue(args.path) || '/',
      'edit',
      lang,
    );
  }
  if (toolName === 'write_object' || toolName === 'write_file') {
    return describeWorkspacePath(
      stringValue(args.target) || stringValue(args.path) || '/',
      'write',
      lang,
    );
  }
  if (toolName === 'delete_object' || toolName === 'delete_file') {
    return describeWorkspacePath(
      stringValue(args.target) || stringValue(args.path) || '/',
      'delete',
      lang,
    );
  }

  const target = firstString(args, [
    'node',
    'element',
    'storyline',
    'category',
    'target',
    'material',
  ]);
  const quoted = target ? quote(target, lang) : '';
  const direct: Record<string, [string, string]> = {
    get_project_brief: ['了解项目设定', 'Review project context'],
    list_nodes: ['查看章节与灵感', 'Review chapters and inspirations'],
    read_node: [`阅读章节或灵感${quoted}`, `Read chapter or inspiration${quoted}`],
    read_block: ['读取正文段落', 'Read a manuscript paragraph'],
    list_elements: ['查看故事元素', 'Review story elements'],
    read_element: [`检查故事元素${quoted}`, `Review story element${quoted}`],
    get_storyline: [`检查故事线${quoted}`, `Review storyline${quoted}`],
    get_entity_relations: [`检查实体关系${quoted}`, `Review relationships${quoted}`],
    search_prose: ['检索小说正文', 'Search the manuscript'],
    search_project: ['检索项目内容', 'Search project content'],
    list_materials: ['查看参考素材', 'Review reference material'],
    read_material: [`阅读参考素材${quoted}`, `Read reference material${quoted}`],
    edit_block: [`修改正文段落${quoted}`, `Edit manuscript paragraph${quoted}`],
    edit_blocks: [`修改多处正文${quoted}`, `Edit manuscript passages${quoted}`],
    append_paragraph: [`续写正文${quoted}`, `Continue the manuscript${quoted}`],
    insert_blocks: [`插入正文段落${quoted}`, `Insert manuscript passages${quoted}`],
    remove_blocks: [`移除正文段落${quoted}`, `Remove manuscript passages${quoted}`],
    replace_block_range: [`重写正文区间${quoted}`, `Rewrite a manuscript section${quoted}`],
    set_entity_body: [`修改设定正文${quoted}`, `Edit canon text${quoted}`],
    update_element: [`更新故事元素${quoted}`, `Update story element${quoted}`],
    create_element: ['创建故事元素', 'Create a story element'],
    delete_element: [`删除故事元素${quoted}`, `Delete story element${quoted}`],
    update_storyline: [`更新故事线${quoted}`, `Update storyline${quoted}`],
    create_storyline: ['创建故事线', 'Create a storyline'],
    create_category: ['创建元素分类', 'Create an element category'],
    set_node_summary: [`更新章节梗概${quoted}`, `Update chapter summary${quoted}`],
    rename_node: [`重命名章节或灵感${quoted}`, `Rename chapter or inspiration${quoted}`],
    link_chapter_to_storyline: ['调整章节所属故事线', 'Link a chapter to a storyline'],
    unlink_chapter_from_storyline: ['移除章节的故事线归属', 'Unlink a chapter from a storyline'],
    set_primary_storyline: ['调整章节主故事线', 'Change a chapter’s primary storyline'],
    add_relation: ['建立实体关系', 'Add a story relationship'],
    remove_relation: ['移除实体关系', 'Remove a story relationship'],
    update_relation_kind: ['调整实体关系类型', 'Change a story relationship'],
    create_comment: ['添加编辑批注', 'Add an editorial note'],
    delete_comment: ['删除编辑批注', 'Delete an editorial note'],
    update_project_facts: ['更新项目设定', 'Update project facts'],
    forget: ['删除长期写作指南', 'Remove writing guidance'],
    create_element_patch: [`记录元素变化${quoted}`, `Record element evolution${quoted}`],
    update_element_patch: [`更新元素变化${quoted}`, `Update element evolution${quoted}`],
    delete_element_patch: [`删除元素变化记录${quoted}`, `Delete element evolution${quoted}`],
    read_task_plan: ['检查任务进度', 'Review task progress'],
    update_task_plan: ['更新任务计划', 'Update task plan'],
    update_task_step: ['更新任务步骤', 'Update task step'],
    ask_user: ['向你确认下一步', 'Ask for guidance'],
    read_tool_result: ['继续查看较长结果', 'Continue reading a long result'],
  };
  return direct[toolName]?.[lang === 'zh' ? 0 : 1] ?? null;
}

function describeWorkspacePath(
  rawPath: string,
  verb: ActivityVerb,
  lang: ActivityLanguage,
): string {
  if (rawPath.trim() && !rawPath.trim().startsWith('/')) {
    return phrase(verb, rawPath.trim(), lang);
  }
  const path = normalizePath(rawPath);
  if (path === '/') return phrase(verb, lang === 'zh' ? '作品结构' : 'project structure', lang);
  if (path === '/README.md') return lang === 'zh' ? '了解作品' : 'Review the project';
  if (path === '/comments.json') return phrase(verb, lang === 'zh' ? '编辑批注' : 'editorial notes', lang);
  if (path === '/memory.json') return phrase(verb, lang === 'zh' ? '长期写作指南' : 'writing guidance', lang);

  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const root = segments[0] ?? '';
  const roots: Record<string, [string, string]> = {
    chapters: ['章节', 'chapters'],
    drifts: ['灵感', 'inspirations'],
    elements: ['故事元素', 'story elements'],
    storylines: ['故事线', 'storylines'],
    categories: ['元素分类', 'element categories'],
    materials: ['参考素材', 'reference material'],
    project: ['项目设定', 'project facts'],
    comments: ['编辑批注', 'editorial notes'],
    relations: ['实体关系', 'story relationships'],
  };
  if (segments.length === 1 && roots[root]) {
    return phrase(verb, roots[root][lang === 'zh' ? 0 : 1], lang);
  }

  const file = segments[segments.length - 1] ?? '';
  const isFile = /\.[a-z0-9]+$/iu.test(file);
  const subject = workspaceSubject(root, segments, isFile, lang);
  const aspect = isFile ? workspaceAspect(file, lang) : '';
  return phrase(verb, [subject, aspect].filter(Boolean).join(lang === 'zh' ? '' : ' '), lang);
}

function workspaceSubject(
  root: string,
  segments: readonly string[],
  isFile: boolean,
  lang: ActivityLanguage,
): string {
  const names = isFile ? segments.slice(1, -1) : segments.slice(1);
  if (root === 'chapters') {
    return lang === 'zh' ? `章节${quote(names[0] ?? '', lang)}` : `chapter${quote(names[0] ?? '', lang)}`;
  }
  if (root === 'drifts') {
    return lang === 'zh' ? `灵感${quote(names[0] ?? '', lang)}` : `inspiration${quote(names[0] ?? '', lang)}`;
  }
  if (root === 'elements') {
    const category = names[0] ?? '';
    const name = names[1] ?? '';
    if (name) return lang === 'zh' ? `${category}${quote(name, lang)}` : `${category} ${quote(name, lang)}`;
    return lang === 'zh' ? `${category || '故事元素'}` : `${category || 'story elements'}`;
  }
  if (root === 'storylines') {
    return lang === 'zh' ? `故事线${quote(names[0] ?? '', lang)}` : `storyline${quote(names[0] ?? '', lang)}`;
  }
  if (root === 'categories') {
    return lang === 'zh' ? `元素分类${quote(names[0] ?? '', lang)}` : `element category${quote(names[0] ?? '', lang)}`;
  }
  if (root === 'materials') {
    return lang === 'zh' ? `参考素材${quote(names[0] ?? '', lang)}` : `reference${quote(names[0] ?? '', lang)}`;
  }
  if (root === 'project') return lang === 'zh' ? '项目设定' : 'project facts';
  if (root === 'comments') return lang === 'zh' ? '编辑批注' : 'editorial note';
  if (root === 'relations') return lang === 'zh' ? '实体关系' : 'story relationship';
  return lang === 'zh' ? '项目内容' : 'project content';
}

function workspaceAspect(file: string, lang: ActivityLanguage): string {
  const aspects: Record<string, [string, string]> = {
    'prose.md': ['正文', 'manuscript'],
    'body.md': ['设定正文', 'canon'],
    'summary.md': ['梗概', 'summary'],
    'title.txt': ['标题', 'title'],
    'name.txt': ['名称', 'name'],
    'meta.json': ['档案', 'profile'],
    'facts.json': ['事实', 'facts'],
    'aliases.json': ['别名', 'aliases'],
    'group.txt': ['分组', 'group'],
    'category.txt': ['分类', 'category'],
    'chapters.json': ['章节编排', 'chapter membership'],
  };
  return aspects[file]?.[lang === 'zh' ? 0 : 1] ?? (lang === 'zh' ? '内容' : 'content');
}

function phrase(verb: ActivityVerb, target: string, lang: ActivityLanguage): string {
  if (lang === 'zh') {
    const verbs: Record<ActivityVerb, string> = {
      browse: '查看',
      read: '读取',
      edit: '修改',
      write: '写作',
      create: '创建',
      delete: '删除',
    };
    if (verb === 'read' && /正文/u.test(target)) return `阅读${target}`;
    return `${verbs[verb]}${target}`;
  }
  const verbs: Record<ActivityVerb, string> = {
    browse: 'Review',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    create: 'Create',
    delete: 'Delete',
  };
  return `${verbs[verb]} ${target}`;
}

function quote(value: string, lang: ActivityLanguage): string {
  if (!value) return '';
  return lang === 'zh' ? `「${value}」` : ` “${value}”`;
}

function normalizePath(value: string): string {
  const trimmed = value.trim() || '/';
  const rooted = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return rooted.length > 1 ? rooted.replace(/\/+$/u, '') : rooted;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }
  return '';
}
