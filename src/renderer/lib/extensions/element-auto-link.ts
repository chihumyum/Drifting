import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface ElementAutoLinkOptions {
  elementNames: Map<string, { id: string; name: string; category: string }>;
  autoDetectEnabled: boolean;
  HTMLAttributes?: Record<string, string>;
  onClick?: (elementId: string) => void;
}

// 创建一个可变的配置对象，供 plugin 和外部共享
export const elementAutoLinkConfig = {
  elementNames: new Map<string, { id: string; name: string; category: string }>(),
  autoDetectEnabled: true,
};

export const ElementAutoLinkPluginKey = new PluginKey('elementAutoLink');

/**
 * Element Link Mark - 持久化的元素链接
 * 类似 Notion/Obsidian 的双向链接
 */
export const ElementAutoLink = Mark.create<ElementAutoLinkOptions>({
  name: 'elementLink',

  // 设置为 false，防止 mark 自动扩展到新输入的文本
  inclusive: false,

  addOptions() {
    return {
      elementNames: new Map(),
      autoDetectEnabled: true,
      HTMLAttributes: {},
      onClick: undefined,
    };
  },

  onCreate() {
    // 初始化共享配置
    elementAutoLinkConfig.elementNames = this.options.elementNames;
    elementAutoLinkConfig.autoDetectEnabled = this.options.autoDetectEnabled;
  },

  addStorage() {
    return {
      elementNames: this.options.elementNames,
      autoDetectEnabled: this.options.autoDetectEnabled,
    };
  },

  addAttributes() {
    return {
      elementId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-element-id'),
        renderHTML: (attributes) => {
          if (!attributes.elementId) {
            return {};
          }
          return {
            'data-element-id': attributes.elementId,
          };
        },
      },
      elementName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-element-name'),
        renderHTML: (attributes) => {
          if (!attributes.elementName) {
            return {};
          }
          return {
            'data-element-name': attributes.elementName,
          };
        },
      },
      category: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-category'),
        renderHTML: (attributes) => {
          if (!attributes.category) {
            return {};
          }
          return {
            'data-category': attributes.category,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-element-id]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const category = HTMLAttributes['data-category'] || 'character';
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes ?? {}, HTMLAttributes, {
        class: `element-link element-link-${category}`,
        style: 'cursor: pointer;',
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    const markType = this.type;
    const extension = this;

    return [
      new Plugin({
        key: ElementAutoLinkPluginKey,
        appendTransaction: (transactions, _oldState, newState) => {
          // 从共享配置读取最新值
          // console.log('[ElementAutoLink Plugin] appendTransaction called:', {
          //   autoDetectEnabled: elementAutoLinkConfig.autoDetectEnabled,
          //   elementNamesSize: elementAutoLinkConfig.elementNames.size,
          // });
          
          // 只有在自动检测开启时才自动添加链接
          if (!elementAutoLinkConfig.autoDetectEnabled || elementAutoLinkConfig.elementNames.size === 0) {
            // console.log('[ElementAutoLink Plugin] Skipping');
            return null;
          }

          // 检查是否有文本内容变化
          const hasContentChange = transactions.some(tr => tr.docChanged);
          if (!hasContentChange) {
            return null;
          }

          const tr = newState.tr;
          let modified = false;

          // 收集所有需要添加 mark 的位置
          const marksToAdd: Array<{from: number; to: number; element: {id: string; name: string; category: string}}> = [];

          // 只处理变化的范围，而不是整个文档
          transactions.forEach((transaction) => {
            if (!transaction.docChanged) return;

            transaction.steps.forEach((_step, index) => {
              const stepMap = transaction.mapping.maps[index];
              
              // 获取这个 step 影响的范围
              stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                // newStart 到 newEnd 是新插入/修改的内容范围
                if (newStart === newEnd) return; // 没有新内容
                
                // console.log('[ElementAutoLink] Processing changed range:', { from: newStart, to: newEnd });

                // 在这个范围内查找匹配的元素
                newState.doc.nodesBetween(newStart, newEnd, (node, pos) => {
                  if (!node.isText || !node.text) {
                    return;
                  }

                  const text = node.text;
                  const nodeStart = pos;
                  const nodeEnd = pos + text.length;
                  
                  // 计算这个节点与变化范围的交集
                  const rangeStart = Math.max(nodeStart, newStart);
                  const rangeEnd = Math.min(nodeEnd, newEnd);
                  
                  if (rangeStart >= rangeEnd) return;
                  
                  // 只检查变化范围内的文本
                  const relevantText = text.substring(rangeStart - nodeStart, rangeEnd - nodeStart);
                  
                  elementAutoLinkConfig.elementNames.forEach((element) => {
                    const regex = new RegExp(escapeRegExp(element.name), 'g');
                    let match;

                    while ((match = regex.exec(relevantText)) !== null) {
                      const matchStart = rangeStart + match.index;
                      const matchEnd = matchStart + element.name.length;

                      // 检查这个位置是否已有 elementLink mark
                      const hasElementLink = node.marks.some(mark => mark.type === markType);

                      if (!hasElementLink) {
                        // console.log('[ElementAutoLink] Found match in changed range:', element.name, matchStart, matchEnd);
                        marksToAdd.push({ from: matchStart, to: matchEnd, element });
                      }
                    }
                  });
                });
              });
            });
          });

          // 批量添加 marks
          marksToAdd.forEach(({ from, to, element }) => {
            tr.addMark(
              from,
              to,
              markType.create({
                elementId: element.id,
                elementName: element.name,
                category: element.category,
              })
            );
            modified = true;
          });

          return modified ? tr : null;
        },
        props: {
          handleClick(_view, _pos, event) {
            const { onClick } = extension.options;
            if (!onClick) return false;

            const target = event.target as HTMLElement;
            if (target.classList.contains('element-link')) {
              const elementId = target.getAttribute('data-element-id');
              if (elementId) {
                onClick(elementId);
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
