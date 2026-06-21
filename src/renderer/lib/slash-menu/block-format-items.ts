import type { Editor } from '@tiptap/core';

export interface BlockFormatItem {
  id: string;
  title: string;
  run: (editor: Editor) => void;
  // Optional "is this format currently applied to the selection?" predicate.
  // Used by the right-click flyout to highlight the active item; the slash menu
  // (caret-triggered) ignores it.
  isActive?: (editor: Editor) => boolean;
}

/**
 * Block-transform commands shared by the slash menu (caret-triggered) and the
 * right-click「格式」flyout (selection-triggered).
 *
 * Every command here goes through ProseMirror's setBlockType / clearNodes,
 * which apply across EVERY block the selection spans — so the same list
 * batch-formats a multi-block selection without touching its text. That's
 * exactly what makes them safe to reuse for the selection-based flyout.
 *
 * Insert-type actions (e.g. 分隔线 / horizontalRule) are intentionally NOT here:
 * inserting a node replaces a non-empty selection, which would delete the
 * selected prose. The slash menu appends those separately for the caret case.
 */
export function getBlockFormatItems(): BlockFormatItem[] {
  return [
    {
      id: 'paragraph',
      title: '正文',
      run: (editor) =>
        // 清除格式但保留 elementLink
        editor
          .chain()
          .focus()
          .clearNodes() // 清除节点格式（heading, blockquote等）
          .unsetBold() // 清除粗体
          .unsetItalic() // 清除斜体
          .unsetStrike() // 清除删除线（如果有）
          .setParagraph() // 设置为段落
          .run(),
      isActive: (editor) => editor.isActive('paragraph'),
    },
    {
      id: 'h1',
      title: '一级标题',
      run: (editor) => editor.chain().focus().setNode('heading', { level: 1 }).run(),
      isActive: (editor) => editor.isActive('heading', { level: 1 }),
    },
    {
      id: 'h2',
      title: '二级标题',
      run: (editor) => editor.chain().focus().setNode('heading', { level: 2 }).run(),
      isActive: (editor) => editor.isActive('heading', { level: 2 }),
    },
    {
      id: 'h3',
      title: '三级标题',
      run: (editor) => editor.chain().focus().setNode('heading', { level: 3 }).run(),
      isActive: (editor) => editor.isActive('heading', { level: 3 }),
    },
    {
      id: 'blockquote',
      title: '引用',
      run: (editor) => editor.chain().focus().toggleBlockquote().run(),
      isActive: (editor) => editor.isActive('blockquote'),
    },
  ];
}

/**
 * Inline mark toggles for the right-click「格式」flyout ONLY — these are
 * deliberately NOT in the slash menu (which is caret-triggered and stays a
 * block-transform menu). toggleMark applies across the whole selection, so they
 * batch-format a multi-block selection just like the block items.
 *
 * Scoped to the marks this editor actually enables: StarterKit ships
 * bold/italic/strike, Underline is added as its own extension; code / link are
 * disabled, so there's nothing else to surface here.
 */
export function getInlineFormatItems(): BlockFormatItem[] {
  return [
    {
      id: 'bold',
      title: '粗体',
      run: (editor) => editor.chain().focus().toggleBold().run(),
      isActive: (editor) => editor.isActive('bold'),
    },
    {
      id: 'italic',
      title: '斜体',
      run: (editor) => editor.chain().focus().toggleItalic().run(),
      isActive: (editor) => editor.isActive('italic'),
    },
    {
      id: 'underline',
      title: '下划线',
      run: (editor) => editor.chain().focus().toggleUnderline().run(),
      isActive: (editor) => editor.isActive('underline'),
    },
    {
      id: 'strike',
      title: '删除线',
      run: (editor) => editor.chain().focus().toggleStrike().run(),
      isActive: (editor) => editor.isActive('strike'),
    },
  ];
}
