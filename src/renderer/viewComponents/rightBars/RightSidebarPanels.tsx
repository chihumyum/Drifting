import { useUiStore } from '../../store/ui-store';

export function RightSidebarPanels() {
  const activeRightPanel = useUiStore((state) => state.activeRightPanel);

  if (activeRightPanel === 'references') {
    return (
      <PlaceholderPanel
        title="参考资料"
        description="这里会展示你在当前项目中收藏的文档、链接和引用内容。"
        items={['文档链接（待接入）', '相关章节引用（待接入）', '素材附件（待接入）']}
      />
    );
  }

  if (activeRightPanel === 'inspirations') {
    return (
      <PlaceholderPanel
        title="灵感片段"
        description="这里可以记录临时想法、对话片段和场景火花，后续可一键转为正式内容。"
        items={['临时笔记区（待接入）', '片段收藏夹（待接入）', '快速插入编辑器（待接入）']}
      />
    );
  }

  return (
    <PlaceholderPanel
      title="AI功能"
      description="这里将提供润色、改写、扩写和总结等写作辅助能力。"
      items={['选中文本操作（待接入）', '章节摘要生成（待接入）', '设定一致性检查（待接入）']}
    />
  );
}

function PlaceholderPanel({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: string[];
}) {
  return (
    <div
      style={{
        height: '100%',
        padding: 12,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          border: '1px solid rgba(184, 153, 104, 0.25)',
          borderRadius: 10,
          background: 'rgba(255, 255, 255, 0.65)',
          padding: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: '#57462f' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#6b6257', marginTop: 8, lineHeight: 1.5 }}>{description}</div>
        <ul style={{ margin: '10px 0 0 18px', padding: 0, color: '#7a6f61', fontSize: 12, lineHeight: 1.8 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
