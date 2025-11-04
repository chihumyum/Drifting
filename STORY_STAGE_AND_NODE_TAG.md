# Story Stage 和 Node Tag 架构说明

## 架构概述

### 数据结构层级

```
Project (书)
  └── StoryStage (故事阶段，可选的高层分组)
       └── Node (章节，基本写作单元)
            └── Content (章节内容，使用 Tiptap 编辑器)
                 └── 用户自定义的 h1, h2, h3 等小节结构
```

### 关键概念

1. **Node (章节)** - 基本写作单元
   - 可以属于一个 StoryStage，也可以不属于任何 StoryStage
   - 使用 `storyStageId` 字段关联到 StoryStage（nullable）

2. **StoryStage (故事阶段)** - 比章节更高层的宏观故事阶段
   - 用户自定义创建
   - 用于归类和组织 Node
   - 与 Node 是一对多关系

3. **NodeTag (节点标签)** - 用户自定义的标签系统
   - 替代原有的 `type` 和 `status` 字段
   - 与 Node 是多对多关系
   - 在项目内可复用
   - 允许用户灵活分类节点

## 数据库表结构

### story_stage 表
```sql
CREATE TABLE story_stage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  order_key INTEGER NOT NULL,      -- 用于排序
  color TEXT,                       -- 可选的颜色标识
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
```

### node_tag 表
```sql
CREATE TABLE node_tag (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(project_id, name)          -- 项目内标签名唯一
);
```

### node_tag_link 表 (多对多关系)
```sql
CREATE TABLE node_tag_link (
  node_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, tag_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES node_tag(id) ON DELETE CASCADE
);
```

### story_node 表更新
```sql
ALTER TABLE story_node ADD COLUMN story_stage_id TEXT;
-- type 和 status 字段标记为 DEPRECATED，但暂时保留以兼容现有数据
```

## API 使用指南

### Story Stage 操作

```typescript
import { useStoryStageUsecases } from '@/hooks/useStoryStageUsecases';

const {
  loadStages,      // 加载所有故事阶段
  getStageById,    // 根据 ID 获取阶段
  createStage,     // 创建新阶段
  updateStage,     // 更新阶段
  deleteStage,     // 删除阶段
  reorderStage,    // 重新排序阶段
} = useStoryStageUsecases();

// 创建故事阶段
const stage = await createStage({
  projectId: 'project-id',
  name: '第一幕：起始',
  description: '故事的开端，介绍主要角色',
  color: '#FF6B6B',
});

// 加载所有阶段
const stages = await loadStages('project-id');

// 更新阶段
await updateStage(stage.id, {
  name: '第一幕：全新的开始',
  description: '更新后的描述',
});

// 重新排序
await reorderStage(stage.id, 'up', 'project-id');

// 删除阶段
await deleteStage(stage.id, 'project-id');
```

### Node Tag 操作

```typescript
import { useNodeTagUsecases } from '@/hooks/useNodeTagUsecases';

const {
  loadTags,              // 加载所有标签
  getTagById,            // 根据 ID 获取标签
  createTag,             // 创建新标签
  deleteTag,             // 删除标签
  getTagsForNode,        // 获取节点的所有标签
  getNodesWithTag,       // 获取拥有某标签的所有节点
  addTagToNode,          // 给节点添加标签
  removeTagFromNode,     // 从节点移除标签
  setNodeTags,           // 设置节点的标签列表
  createAndAddTagToNode, // 创建标签并添加到节点（如已存在则直接添加）
} = useNodeTagUsecases();

// 创建标签
const tag = await createTag({
  projectId: 'project-id',
  name: '重要情节',
  color: '#4ECDC4',
});

// 加载所有标签
const tags = await loadTags('project-id');

// 给节点添加标签
await addTagToNode('node-id', tag.id, 'project-id');

// 获取节点的所有标签
const nodeTags = await getTagsForNode('node-id', 'project-id');

// 一次性设置节点的所有标签
await setNodeTags('node-id', ['tag-id-1', 'tag-id-2'], 'project-id');

// 创建标签并添加到节点（便捷方法）
const newTag = await createAndAddTagToNode('node-id', {
  projectId: 'project-id',
  name: '高潮部分',
  color: '#95E1D3',
});

// 从节点移除标签
await removeTagFromNode('node-id', tag.id, 'project-id');

// 删除标签（会自动删除所有关联）
await deleteTag(tag.id, 'project-id');
```

### Node 与 StoryStage 关联

```typescript
import { useBookNodeUsecases } from '@/hooks/useBookNodeUsecases';

const { createNode, updateNode } = useBookNodeUsecases();

// 创建属于某个故事阶段的节点
const node = await createNode({
  title: '第一章',
  projectId: 'project-id',
  storyStageId: 'stage-id',  // 关联到故事阶段
  type: 'chapter',           // DEPRECATED: 建议使用 tags 代替
});

// 将节点移动到另一个故事阶段
await updateNode(node.id, {
  storyStageId: 'another-stage-id',
});

// 将节点从故事阶段中移除
await updateNode(node.id, {
  storyStageId: null,
});
```

## 完整的代码链路

每个功能都实现了完整的分层架构：

### Story Stage 链路
1. **Schema**: `schema/book_general.ts` - `StoryStageRecord`
2. **Domain**: `domain/story_stage.ts` - `StoryStage`
3. **Repository Interface**: `repositories/story_stage.ts` - `StoryStageRepository`
4. **Repository Implementation**: `repositories/story_stage_sqlite.ts` - `createStoryStageRepository()`
5. **Use Cases**: `usecase/story_stage.ts` - `loadStoryStages`, `createStoryStage`, etc.
6. **React Hook**: `hooks/useStoryStageUsecases.ts` - `useStoryStageUsecases()`

### Node Tag 链路
1. **Schema**: `schema/book_general.ts` - `NodeTagRecord`, `NodeTagLinkRecord`
2. **Domain**: `domain/story_stage.ts` - `NodeTag`, `NodeTagLink`
3. **Repository Interface**: `repositories/story_stage.ts` - `NodeTagRepository`, `NodeTagLinkRepository`
4. **Repository Implementation**: `repositories/story_stage_sqlite.ts` - `createNodeTagRepository()`, `createNodeTagLinkRepository()`
5. **Use Cases**: `usecase/story_stage.ts` - `loadNodeTags`, `createNodeTag`, `addTagToNode`, etc.
6. **React Hook**: `hooks/useNodeTagUsecases.ts` - `useNodeTagUsecases()`

## 迁移说明

### 对现有代码的影响

1. **BookNode 类型更新**
   - 新增 `storyStageId?: string | null` 字段
   - `type` 和 `status` 字段标记为 DEPRECATED
   - 现有代码仍然可以继续使用这些字段，但建议迁移到 tag 系统

2. **数据库更新**
   - 新增三个表：`story_stage`, `node_tag`, `node_tag_link`
   - `story_node` 表新增 `story_stage_id` 列
   - 运行迁移脚本：`migrations/004_node_tags_and_story_stages.sql`

3. **建议的迁移路径**
   - 创建常用的 tag（如"草稿"、"进行中"、"完成"等）替代 status
   - 创建 tag（如"章节"、"场景"、"beat"等）替代 type
   - 逐步将现有 node 的 type 和 status 转换为 tag
   - 根据需要创建 StoryStage 并将 node 关联过去

## 注意事项

1. **Tag 名称唯一性**：同一项目内的 tag 名称必须唯一
2. **StoryStage 可选**：Node 可以不属于任何 StoryStage
3. **多对多关系**：一个 Node 可以有多个 Tag，一个 Tag 可以用于多个 Node
4. **级联删除**：删除 StoryStage 或 Tag 时会自动清理相关联的数据
5. **向后兼容**：`type` 和 `status` 字段暂时保留，现有代码可以继续工作

## 示例使用场景

### 场景 1：组织小说结构
```typescript
// 1. 创建故事阶段
const act1 = await createStage({
  projectId: 'my-novel',
  name: '第一幕：日常',
  color: '#FFD93D',
});

const act2 = await createStage({
  projectId: 'my-novel',
  name: '第二幕：冲突',
  color: '#FF6B6B',
});

// 2. 创建标签
const importantTag = await createTag({
  projectId: 'my-novel',
  name: '重要情节',
  color: '#4ECDC4',
});

const characterDevelopmentTag = await createTag({
  projectId: 'my-novel',
  name: '角色发展',
  color: '#95E1D3',
});

// 3. 创建章节并关联
const chapter1 = await createNode({
  title: '第一章：平凡的早晨',
  projectId: 'my-novel',
  storyStageId: act1.id,
});

// 4. 添加标签
await addTagToNode(chapter1.id, characterDevelopmentTag.id);
```

### 场景 2：按标签筛选章节
```typescript
// 获取所有"重要情节"标签的章节
const importantTag = await findByName('my-novel', '重要情节');
const importantNodeIds = await getNodesWithTag(importantTag.id);

// 获取特定章节的所有标签
const chapter = await getNodeById('chapter-id');
const tags = await getTagsForNode(chapter.id);
console.log(`章节"${chapter.title}"的标签：`, tags.map(t => t.name).join(', '));
```

## 未来扩展

这个架构为以下功能预留了扩展空间：

1. **标签系统增强**
   - 标签分组
   - 标签层级结构
   - 标签统计和可视化

2. **故事阶段增强**
   - 阶段间的依赖关系
   - 阶段进度追踪
   - 阶段可视化视图

3. **高级查询**
   - 按多个标签组合筛选
   - 按故事阶段分组显示
   - 标签热力图
