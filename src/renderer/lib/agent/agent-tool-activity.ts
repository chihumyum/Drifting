type ActivityLanguage = 'zh' | 'en';

export interface AgentPermissionActionDescription {
  summary: string;
  details: readonly string[];
}

/** A streamed card is hidden until its arguments exist, so its domain label
 * never flickers through an invented placeholder target. */
export function shouldDisplayAgentToolActivity(input: {
  phase?: string;
  toolInput: unknown;
  status?: string;
}): boolean {
  return input.status === 'error' || input.phase !== 'arguments' || input.toolInput !== undefined;
}

/** Translate one explicit domain tool into the author-facing progress label. */
export function describeAgentToolActivity(
  toolName: string,
  input: unknown,
  language: string,
): string | null {
  const args = asRecord(input);
  const lang: ActivityLanguage = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const target = firstString(args, [
    'chapter',
    'inspiration',
    'element',
    'storyline',
    'category',
    'entity',
    'material',
    'title',
    'name',
    'relationId',
    'commentId',
    'ruleId',
    'patchId',
  ]);
  const quoted = target ? quote(target, lang) : '';
  const query = stringValue(args.query);

  const labels: Record<string, [string, string]> = {
    get_project_overview: ['了解作品全貌', 'Review the whole project'],
    get_project_facts: ['查看项目设定', 'Review project facts'],
    list_chapters: ['查看章节目录', 'Review chapters'],
    read_chapter: [`阅读章节${quoted}`, `Read chapter${quoted}`],
    list_inspirations: ['查看灵感列表', 'Review inspirations'],
    read_inspiration: [`阅读灵感${quoted}`, `Read inspiration${quoted}`],
    list_element_categories: ['查看写作要素分类', 'Review element categories'],
    read_element_category: [`查看写作要素分类${quoted}`, `Review element category${quoted}`],
    list_elements: ['查看写作要素', 'Review story elements'],
    read_element: [`查看写作要素${quoted}`, `Review story element${quoted}`],
    get_element_patches: [`查看写作要素变化${quoted}`, `Review element evolution${quoted}`],
    find_element_appearances: [`查找写作要素出场${quoted}`, `Find appearances of element${quoted}`],
    list_storylines: ['查看故事线', 'Review storylines'],
    read_storyline: [`查看故事线${quoted}`, `Review storyline${quoted}`],
    list_relations: ['查看实体关系', 'Review relationships'],
    list_entity_relations: [`查看相关实体关系${quoted}`, `Review relationships for${quoted}`],
    list_comments: ['查看批注与待办', 'Review notes and TODOs'],
    list_author_rules: ['查看长期写作规则', 'Review writing rules'],
    list_materials: ['查看参考素材', 'Review reference material'],
    read_material: [`阅读参考素材${quoted}`, `Read reference material${quoted}`],
    search_prose: [
      query ? `检索正文“${query}”` : '检索正文',
      query ? `Search manuscript for “${query}”` : 'Search the manuscript',
    ],
    search_project: [
      query ? `检索项目“${query}”` : '检索项目',
      query ? `Search project for “${query}”` : 'Search the project',
    ],
    create_chapter: [`新建章节${quoted}`, `Create chapter${quoted}`],
    rename_chapter: [`重命名章节${quoted}`, `Rename chapter${quoted}`],
    set_chapter_summary: [`更新章节摘要${quoted}`, `Update chapter summary${quoted}`],
    revise_chapter: [`修改章节正文${quoted}`, `Revise chapter${quoted}`],
    replace_chapter_body: [`重写章节正文${quoted}`, `Replace chapter manuscript${quoted}`],
    delete_chapter: [`删除章节${quoted}`, `Delete chapter${quoted}`],
    create_inspiration: [`新建灵感${quoted}`, `Create inspiration${quoted}`],
    rename_inspiration: [`重命名灵感${quoted}`, `Rename inspiration${quoted}`],
    set_inspiration_summary: [`更新灵感摘要${quoted}`, `Update inspiration summary${quoted}`],
    revise_inspiration: [`修改灵感正文${quoted}`, `Revise inspiration${quoted}`],
    replace_inspiration_body: [`重写灵感正文${quoted}`, `Replace inspiration text${quoted}`],
    delete_inspiration: [`删除灵感${quoted}`, `Delete inspiration${quoted}`],
    create_element: [`新建写作要素${quoted}`, `Create story element${quoted}`],
    update_element: [`更新写作要素${quoted}`, `Update story element${quoted}`],
    revise_element: [`修改写作要素正文${quoted}`, `Revise story element${quoted}`],
    replace_element_body: [`重写写作要素正文${quoted}`, `Replace story element text${quoted}`],
    delete_element: [`删除写作要素${quoted}`, `Delete story element${quoted}`],
    create_element_category: [`新建写作要素分类${quoted}`, `Create element category${quoted}`],
    update_element_category: [`更新写作要素分类${quoted}`, `Update element category${quoted}`],
    replace_element_category_body: [`重写分类说明${quoted}`, `Replace category text${quoted}`],
    delete_element_category: [`删除写作要素分类${quoted}`, `Delete element category${quoted}`],
    create_storyline: [`新建故事线${quoted}`, `Create storyline${quoted}`],
    update_storyline: [`更新故事线${quoted}`, `Update storyline${quoted}`],
    revise_storyline: [`修改故事线正文${quoted}`, `Revise storyline${quoted}`],
    replace_storyline_body: [`重写故事线正文${quoted}`, `Replace storyline text${quoted}`],
    delete_storyline: [`删除故事线${quoted}`, `Delete storyline${quoted}`],
    add_chapter_to_storyline: ['把章节加入故事线', 'Add chapter to storyline'],
    remove_chapter_from_storyline: ['从故事线移除章节', 'Remove chapter from storyline'],
    set_chapter_primary_storyline: ['设置章节主故事线', 'Set chapter primary storyline'],
    replace_storyline_chapters: ['替换故事线章节成员', 'Replace storyline chapters'],
    create_relation: ['新建实体关系', 'Create relationship'],
    update_relation: [`调整实体关系${quoted}`, `Update relationship${quoted}`],
    delete_relation: [`删除实体关系${quoted}`, `Delete relationship${quoted}`],
    create_comment: ['添加批注或待办', 'Add a note or TODO'],
    update_comment: [`更新批注或待办${quoted}`, `Update note or TODO${quoted}`],
    delete_comment: [`删除批注或待办${quoted}`, `Delete note or TODO${quoted}`],
    update_project_facts: ['更新项目设定', 'Update project facts'],
    create_author_rule: ['添加长期写作规则', 'Add writing rule'],
    update_author_rule: [`更新长期写作规则${quoted}`, `Update writing rule${quoted}`],
    delete_author_rule: [`删除长期写作规则${quoted}`, `Delete writing rule${quoted}`],
    create_element_patch: [`记录写作要素变化${quoted}`, `Record element evolution${quoted}`],
    update_element_patch: [`更新写作要素变化${quoted}`, `Update element evolution${quoted}`],
    delete_element_patch: [`删除写作要素变化${quoted}`, `Delete element evolution${quoted}`],
    read_task_plan: ['检查任务进度', 'Review task progress'],
    update_task_plan: ['更新任务计划', 'Update task plan'],
    update_task_step: ['更新任务步骤', 'Update task step'],
    update_task_constraint: ['更新任务约束', 'Update task constraints'],
    ask_user: ['向你确认下一步', 'Ask for guidance'],
    read_tool_result: ['继续查看较长结果', 'Continue reading a long result'],
  };
  return labels[toolName]?.[lang === 'zh' ? 0 : 1] ?? null;
}

/** Render validated arguments as a natural-language action first. Raw JSON is
 * retained by the caller only in the collapsed technical disclosure. */
export function describeAgentPermissionAction(
  toolName: string,
  input: unknown,
  language: string,
): AgentPermissionActionDescription | null {
  const args = asRecord(input);
  const lang: ActivityLanguage = language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const summary =
    describeRelationPermission(toolName, args, lang) ??
    describeMembershipPermission(toolName, args, lang) ??
    describeDestructivePermission(toolName, args, lang) ??
    describeAgentToolActivity(toolName, args, language);
  return summary
    ? { summary, details: describePermissionPayload(args, lang) }
    : null;
}

function describeRelationPermission(
  toolName: string,
  args: Record<string, unknown>,
  lang: ActivityLanguage,
): string | null {
  if (toolName === 'create_relation') {
    const from = stringValue(args.fromName);
    const to = stringValue(args.toName);
    if (!from || !to) return null;
    const source = typedEntityRef(stringValue(args.fromType), from, lang);
    const destination = typedEntityRef(stringValue(args.toType), to, lang);
    const relationType = stringValue(args.relationType) || (lang === 'zh' ? '关联' : 'relates to');
    return lang === 'zh'
      ? `新建实体关系：${source} —${relationType}→ ${destination}`
      : `Create relationship: ${source} —${relationType}→ ${destination}`;
  }
  const relationId = stringValue(args.relationId);
  if (toolName === 'update_relation') {
    const relationType = stringValue(args.relationType);
    return lang === 'zh'
      ? `调整实体关系${quote(relationId, lang)}：${relationType ? `类型改为${quote(relationType, lang)}` : '清空关系类型'}`
      : `Update relationship${quote(relationId, lang)}: ${relationType ? `set type to${quote(relationType, lang)}` : 'clear its type'}`;
  }
  if (toolName === 'delete_relation') {
    return lang === 'zh'
      ? `删除实体关系${quote(relationId, lang)}`
      : `Delete relationship${quote(relationId, lang)}`;
  }
  return null;
}

function describeMembershipPermission(
  toolName: string,
  args: Record<string, unknown>,
  lang: ActivityLanguage,
): string | null {
  const chapter = stringValue(args.chapter);
  const storyline = stringValue(args.storyline);
  if (toolName === 'add_chapter_to_storyline') {
    return lang === 'zh'
      ? `把章节${quote(chapter, lang)}加入故事线${quote(storyline, lang)}`
      : `Add chapter${quote(chapter, lang)} to storyline${quote(storyline, lang)}`;
  }
  if (toolName === 'remove_chapter_from_storyline') {
    return lang === 'zh'
      ? `从故事线${quote(storyline, lang)}移除章节${quote(chapter, lang)}`
      : `Remove chapter${quote(chapter, lang)} from storyline${quote(storyline, lang)}`;
  }
  if (toolName === 'set_chapter_primary_storyline') {
    return lang === 'zh'
      ? `把故事线${quote(storyline, lang)}设为章节${quote(chapter, lang)}的主线`
      : `Make storyline${quote(storyline, lang)} primary for chapter${quote(chapter, lang)}`;
  }
  if (toolName === 'replace_storyline_chapters') {
    const count = Array.isArray(args.chapters) ? args.chapters.length : 0;
    return lang === 'zh'
      ? `用 ${count} 个章节替换故事线${quote(storyline, lang)}的完整成员列表`
      : `Replace the complete membership of storyline${quote(storyline, lang)} with ${count} chapters`;
  }
  return null;
}

function describeDestructivePermission(
  toolName: string,
  args: Record<string, unknown>,
  lang: ActivityLanguage,
): string | null {
  const specs: Readonly<Record<string, { field: string; zh: string; en: string }>> = {
    delete_chapter: { field: 'chapter', zh: '删除章节', en: 'Delete chapter' },
    delete_inspiration: { field: 'inspiration', zh: '删除灵感', en: 'Delete inspiration' },
    delete_element: { field: 'element', zh: '删除写作要素', en: 'Delete story element' },
    delete_element_category: { field: 'category', zh: '删除写作要素分类', en: 'Delete element category' },
    delete_storyline: { field: 'storyline', zh: '删除故事线', en: 'Delete storyline' },
    delete_comment: { field: 'commentId', zh: '删除批注或待办', en: 'Delete note or TODO' },
    delete_author_rule: { field: 'ruleId', zh: '删除长期写作规则', en: 'Delete writing rule' },
    delete_element_patch: { field: 'patchId', zh: '删除写作要素变化', en: 'Delete element evolution' },
  };
  const spec = specs[toolName];
  if (!spec) return null;
  return `${lang === 'zh' ? spec.zh : spec.en}${quote(stringValue(args[spec.field]), lang)}`;
}

function describePermissionPayload(
  args: Record<string, unknown>,
  lang: ActivityLanguage,
): string[] {
  const details: string[] = [];
  const body = stringValue(args.body);
  if (body) {
    details.push(lang === 'zh' ? `正文：${compactText(body, 180)}` : `Body: ${compactText(body, 180)}`);
  }
  const summary = stringValue(args.summary);
  if (summary) {
    details.push(lang === 'zh' ? `摘要：${compactText(summary, 140)}` : `Summary: ${compactText(summary, 140)}`);
  }
  const changes = Array.isArray(args.changes) ? args.changes : [];
  for (const value of changes.slice(0, 3)) {
    const change = asRecord(value);
    const current = stringValue(change.currentText);
    const revised = typeof change.revisedText === 'string' ? change.revisedText : '';
    details.push(
      lang === 'zh'
        ? `把“${compactText(current, 70)}”改为“${compactText(revised, 70)}”`
        : `Replace “${compactText(current, 70)}” with “${compactText(revised, 70)}”`,
    );
  }
  if (changes.length > 3) {
    details.push(lang === 'zh' ? `另有 ${changes.length - 3} 处修改` : `${changes.length - 3} more changes`);
  }
  if (Array.isArray(args.chapters)) {
    const chapters = args.chapters.filter((value): value is string => typeof value === 'string');
    details.push(
      lang === 'zh'
        ? `章节：${chapters.length ? chapters.join('、') : '清空成员'}`
        : `Chapters: ${chapters.length ? chapters.join(', ') : 'clear all members'}`,
    );
  }
  return details;
}

function typedEntityRef(kind: string, name: string, lang: ActivityLanguage): string {
  const labels: Record<string, [string, string]> = {
    chapter: ['章节', 'chapter'],
    inspiration: ['灵感', 'inspiration'],
    element: ['写作要素', 'element'],
    storyline: ['故事线', 'storyline'],
    element_category: ['写作要素分类', 'element category'],
  };
  const label = labels[kind]?.[lang === 'zh' ? 0 : 1] ?? kind;
  return `${label}${quote(name, lang)}`;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function quote(value: string, lang: ActivityLanguage): string {
  if (!value) return '';
  return lang === 'zh' ? `「${value}」` : ` “${value}”`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }
  return '';
}
