# 自动元素链接功能使用指南

## 📖 功能概述

自动元素链接功能会在您编辑章节内容时，自动识别并高亮文本中出现的元素名称（如角色、地点、道具等），并建立双向链接关系。这类似于 Notion 或 Obsidian 的自动链接功能。

## ✨ 主要特性

### 1. 自动识别
- 当您在章节中输入元素名称时（例如"德古拉"），系统会自动识别并高亮显示
- 使用去抖机制（1秒延迟），避免频繁触发解析

### 2. 视觉反馈
- 元素名称会有虚线下划线和淡色背景
- 不同类别的元素有不同的颜色：
  - 角色（character）：绿色
  - 地点（location）：紫色
  - 道具（item）：橙色
  - 其他：蓝色
- 鼠标悬停时颜色会加深

### 3. 点击跳转
- 点击高亮的元素名称，可以直接跳转到该元素的详情页面

### 4. 反向链接
- 在元素编辑页面，可以看到"被引用于"面板
- 显示该元素在哪些章节中被引用
- 显示每个章节中出现的次数
- 点击章节名称可以直接跳转

## 🎯 使用方法

### 启用/禁用功能

功能默认是开启的，您可以通过以下方式关闭：

1. 在应用的设置中找到"编辑器设置"
2. 切换"自动元素链接"开关

或者在代码中：
```typescript
import { useAppStore } from '../store';

const { autoElementLinkEnabled, setAutoElementLinkEnabled } = useAppStore();

// 禁用功能
setAutoElementLinkEnabled(false);

// 启用功能
setAutoElementLinkEnabled(true);
```

### 使用示例

假设您有以下元素：
- 角色：德古拉、范海辛
- 地点：特兰西瓦尼亚城堡

当您在章节中写道：

> "德古拉站在特兰西瓦尼亚城堡的阳台上，凝视着远方的村庄。范海辛正在村庄中寻找线索。"

系统会自动：
1. 识别出"德古拉"、"特兰西瓦尼亚城堡"、"范海辛"
2. 在这些名称下添加虚线和背景色
3. 记录到数据库中，建立章节与元素的关联

在"德古拉"元素的详情页面，您会看到：
- **被引用于 (1)**
  - 第一章：失踪的村民（出现 1 次）

## 🛠️ 技术实现

### 核心组件

1. **ElementAutoLink Extension** (`element-auto-link.ts`)
   - Tiptap 扩展，负责在编辑器中高亮元素名称
   - 使用 ProseMirror 的 Decoration API

2. **ElementParserService** (`element-parser.service.ts`)
   - 解析 Tiptap JSON 内容，提取元素匹配
   - 支持正则表达式匹配

3. **ElementOccurrenceRepository** (`element-occurrence.repository.ts`)
   - 数据库操作，保存和查询元素出现记录
   - 使用事务确保数据一致性

4. **BacklinksPanel** (`BacklinksPanel.tsx`)
   - UI 组件，显示反向链接列表

### 数据结构

```typescript
// element_occurrence 表
interface ElementOccurrenceRecord {
  id: string;
  element_id: string;      // 元素 ID
  node_id: string;         // 章节 ID
  block_id: string;        // 文本块 ID（可选）
  spans_json: string;      // 匹配位置信息（JSON 数组）
  created_at: string;
}

// spans_json 格式
type Spans = Array<{
  text: string;       // 匹配的文本
  position: number;   // 在文档中的位置
  length: number;     // 长度
}>;
```

### 性能优化

1. **去抖处理**：1秒延迟，避免频繁解析
2. **增量更新**：只在内容变化时重新解析
3. **事务批处理**：使用数据库事务批量保存
4. **索引优化**：在 `element_id` 和 `node_id` 上建立索引

## ⚙️ 配置选项

### Store 配置

```typescript
// 在 store/index.ts 中
type SettingsSlice = {
  autoElementLinkEnabled: boolean;
  setAutoElementLinkEnabled: (enabled: boolean) => void;
};
```

### Extension 配置

```typescript
ElementAutoLink.configure({
  elementNames: elementNamesMap,  // 元素名称映射表
  enabled: autoElementLinkEnabled, // 是否启用
  onClick: handleElementClick,     // 点击处理函数
})
```

## 🎨 样式自定义

在 `styles/index.css` 中自定义样式：

```css
.element-auto-link-decoration {
  background-color: rgba(59, 130, 246, 0.1);
  border-bottom: 2px dotted rgba(59, 130, 246, 0.5);
  /* ... */
}

/* 按类别自定义颜色 */
.element-auto-link-decoration[data-element-category="character"] {
  border-bottom-color: rgba(34, 197, 94, 0.5);
  background-color: rgba(34, 197, 94, 0.1);
}
```

## 🐛 故障排除

### 数据库表不存在

如果遇到 "no such table: element_occurrence" 错误：

1. 停止应用
2. 删除旧的数据库文件（在 `~/.config/drifting-electron/databases/` 或类似路径）
3. 重新启动应用，数据库会自动重建

### 元素未被识别

1. 确认功能已启用：`autoElementLinkEnabled === true`
2. 检查元素名称是否完全匹配（区分大小写）
3. 等待1秒让去抖完成

### 反向链接不显示

1. 确认数据库已初始化：`window.api.database.db` 存在
2. 检查 `element_occurrence` 表是否有数据
3. 查看浏览器控制台是否有错误

### 样式不生效

1. 确认 CSS 文件已导入
2. 检查 Tailwind 配置
3. 清除浏览器缓存

## 📝 未来改进

- [ ] 支持模糊匹配（如"德古拉伯爵" 匹配 "德古拉"）
- [ ] 支持别名（如"吸血鬼" 也链接到 "德古拉"）
- [ ] 批量更新：修改元素名称时自动更新所有引用
- [ ] 统计面板：显示元素使用频率
- [ ] 时间轴视图：显示元素在不同章节的出现顺序
