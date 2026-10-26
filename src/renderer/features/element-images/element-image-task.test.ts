import { describe, expect, it } from 'vitest';
import { ELEMENT_IMAGE_TOOL_NAME } from '../../lib/agent/element-image-requests';
import { buildElementImageTask } from './element-image-task';

describe('buildElementImageTask', () => {
  it('has the Agent read the element and its category before describing the image', () => {
    const task = buildElementImageTask({
      elementId: 'element-1',
      elementName: '  游荡者   ',
      categoryName: '异常现象',
      count: 3,
      extraPrompt: '雨夜里的样子',
      styleText: '低饱和水彩',
    });
    expect(task.title).toBe('设定图：游荡者');
    expect(task.prompt).toContain('写作要素「游荡者」（分类「异常现象」，id：element-1）生成 3 张');
    expect(task.prompt).toContain('read_element 读要素「游荡者」');
    expect(task.prompt).toContain('read_element_category 读分类「异常现象」');
    expect(task.prompt).toContain('不要默认它是人物');
    expect(task.prompt).toContain(`调用 ${ELEMENT_IMAGE_TOOL_NAME}，elementId 填 element-1，count 填 3`);
    expect(task.prompt).toContain('作者这次的补充要求：雨夜里的样子');
    expect(task.prompt).toContain('不要写画风');
  });

  it('assumes no kind of element', () => {
    const { prompt } = buildElementImageTask({
      elementId: 'e',
      elementName: 'A',
      categoryName: '地点',
      count: 1,
      extraPrompt: null,
      styleText: null,
    });
    for (const characterOnly of ['外貌', '服饰', '神情', '姿态', '全身']) {
      expect(prompt).not.toContain(characterOnly);
    }
  });

  it('skips the category read for an uncategorized element and lets the Agent pick a style', () => {
    const { prompt } = buildElementImageTask({
      elementId: 'e',
      elementName: 'A',
      categoryName: null,
      count: 1,
      extraPrompt: null,
      styleText: '   ',
    });
    expect(prompt).not.toContain('read_element_category');
    expect(prompt).toContain('它没有分类');
    expect(prompt).toContain('项目没有设定画风，请按作品气质选一种画风');
    expect(prompt).not.toContain('补充要求');
  });
});
