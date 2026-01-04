# Drifting Core - API 完整参考文档

> **版本**: Electron Desktop App  
> **更新日期**: 2026-01-04  
> **架构**: Main Process (Node.js) + Renderer Process (React)

---

## 📋 目录

1. [架构概览](#架构概览)
2. [数据流](#数据流)
3. [数据库层 API](#数据库层-api)
4. [Repository 层 API](#repository-层-api)
5. [Service 层 API](#service-层-api)
6. [组件层 API](#组件层-api)
7. [数据库表结构](#数据库表结构)
8. [常用操作示例](#常用操作示例)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      Renderer Process (React)                │
├─────────────────────────────────────────────────────────────┤
│  Components (Views)                                          │
│    ↓                                                         │
│  Hooks (useBookContentUsecases, etc.)                       │
│    ↓                                                         │
│  Services/UseCases (BookContentService, etc.)               │
│    ↓                                                         │
│  Repositories (BookNodeRepository, ElementRepository, etc.)  │
│    ↓                                                         │
│  Database Interface (lib/db.ts)                             │
│    ↓                                                         │
│  window.electronAPI.db.* (Preload Bridge)                   │
└─────────────────────────────────────────────────────────────┘
                          │ IPC
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      Main Process (Node.js)                  │
├─────────────────────────────────────────────────────────────┤
│  IPC Handlers (ipcMain.handle)                              │
│    ↓                                                         │
│  Database Operations (main/database.ts)                     │
│    ↓                                                         │
│  Better-SQLite3                                             │
│    ↓                                                         │
│  SQLite Database File                                       │
│  ~/Library/Application Support/Drifting/databases/          │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据流

### 查询数据流程

```typescript
// 1. 组件调用
<NodeEditorView nodeId="xxx" />

// 2. Hook 获取数据
const { data: bookContent } = useBookContent(nodeId)

// 3. Service/UseCase
const content = await bookContentService.getByNodeId(nodeId)

// 4. Repository
const record = await bookContentRepo.findByNodeId(nodeId)

// 5. Database Interface
const rows = await query('SELECT * FROM book_content WHERE node_id = ?', [nodeId])

// 6. Preload Bridge
const result = await window.electronAPI.db.query(sql, params)

// 7. IPC Communication
ipcRenderer.invoke('db:query', sql, params)

// 8. Main Process Handler
ipcMain.handle('db:query', (_, sql, params) => {
  const stmt = db.prepare(sql)
  return stmt.all(...params)
})

// 9. SQLite Execution
// Better-SQLite3 执行 SQL 并返回结果
```

---

## 数据库层 API

### 位置
- **Renderer**: `src/renderer/lib/db.ts`
- **Main**: `src/main/database.ts`
- **Preload**: `src/main/preload.ts`

### 核心方法

#### `initDatabase(projectId?: string, userId?: string): Promise<void>`
初始化数据库连接

```typescript
import { initDatabase } from '@/lib/db'

// 使用默认项目
await initDatabase()

// 指定项目和用户
await initDatabase('my-project-id', 'user-123')
```

#### `query<T>(sql: string, params?: any[]): Promise<T[]>`
执行 SELECT 查询，返回所有行

```typescript
import { query } from '@/lib/db'

// 查询所有章节
const nodes = await query<{ id: string; title: string }>(
  'SELECT id, title FROM story_node WHERE project_id = ?',
  ['default-project']
)

// 查询单行
const [node] = await query<NodeRecord>(
  'SELECT * FROM story_node WHERE id = ? LIMIT 1',
  [nodeId]
)
```

#### `get<T>(sql: string, params?: any[]): Promise<T | undefined>`
执行 SELECT 查询，返回第一行

```typescript
import { get } from '@/lib/db'

const node = await get<NodeRecord>(
  'SELECT * FROM story_node WHERE id = ?',
  [nodeId]
)

if (node) {
  console.log(node.title)
}
```

#### `run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>`
执行 INSERT/UPDATE/DELETE 操作

```typescript
import { run } from '@/lib/db'

// 插入
const result = await run(
  'INSERT INTO story_node (id, title, project_id, start, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  [id, title, projectId, start, now, now]
)
console.log(`Inserted ${result.changes} rows`)

// 更新
await run(
  'UPDATE story_node SET title = ?, updated_at = ? WHERE id = ?',
  [newTitle, now, id]
)

// 删除
await run('DELETE FROM story_node WHERE id = ?', [id])
```

#### `resetDatabase(): Promise<void>`
重置数据库连接（用于切换数据库）

```typescript
import { resetDatabase } from '@/lib/db'

await resetDatabase()
```

---

## Repository 层 API

Repository 层负责数据持久化，封装 SQL 操作。

### BookNodeRepository

**位置**: `src/renderer/repositories/book_node_sqlite.ts`

#### `findById(id: string): Promise<BookNode | null>`
根据 ID 查找节点

```typescript
const node = await bookNodeRepo.findById('node-id-123')
if (node) {
  console.log(node.title, node.summary)
}
```

#### `create(data: Omit<BookNode, 'id'>): Promise<BookNode>`
创建新节点

```typescript
const newNode = await bookNodeRepo.create({
  title: '第一章',
  projectId: 'default-project',
  start: 1,
  end: null,
  summary: null,
  storyStageId: null,
  posX: null,
  posY: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})
```

#### `update(id: string, data: Partial<BookNode>): Promise<void>`
更新节点

```typescript
await bookNodeRepo.update('node-id-123', {
  title: '第一章（修订版）',
  summary: '这是摘要',
  updatedAt: new Date(),
})
```

#### `delete(id: string): Promise<void>`
删除节点（软删除）

```typescript
await bookNodeRepo.delete('node-id-123')
```

#### `findByProject(projectId: string): Promise<BookNode[]>`
获取项目的所有节点

```typescript
const nodes = await bookNodeRepo.findByProject('default-project')
```

#### `findByStage(stageId: string): Promise<BookNode[]>`
获取特定阶段的所有节点

```typescript
const nodes = await bookNodeRepo.findByStage('stage-id-123')
```

### ElementRepository

**位置**: `src/renderer/repositories/element_sqlite.ts`

#### `findById(id: string): Promise<Element | null>`
根据 ID 查找元素

#### `create(data: Omit<Element, 'id'>): Promise<Element>`
创建元素（角色/地点/物品）

```typescript
const character = await elementRepo.create({
  projectId: 'default-project',
  categoryId: 'cat_character',
  type: 'character',
  name: '主角',
  contentJson: JSON.stringify({ description: '勇敢的冒险者' }),
  summaryJson: JSON.stringify({}),
  createdAt: new Date(),
  updatedAt: new Date(),
})
```

#### `update(id: string, data: Partial<Element>): Promise<void>`
更新元素

#### `delete(id: string): Promise<void>`
删除元素

#### `findByProject(projectId: string): Promise<Element[]>`
获取项目的所有元素

#### `findByCategory(categoryId: string): Promise<Element[]>`
获取特定类别的元素

#### `findByType(projectId: string, type: string): Promise<Element[]>`
获取特定类型的元素

```typescript
const characters = await elementRepo.findByType('default-project', 'character')
const locations = await elementRepo.findByType('default-project', 'location')
```

### BookContentRepository

**位置**: `src/renderer/repositories/book_content_sqlite.ts`

#### `findByNodeId(nodeId: string): Promise<BookContent | null>`
根据节点 ID 查找内容

```typescript
const content = await bookContentRepo.findByNodeId('node-id-123')
if (content) {
  const doc = JSON.parse(content.pmJson)
  // doc 是 ProseMirror 文档
}
```

#### `create(data: { nodeId: string; pmJson: string; outlineJson: string }): Promise<BookContent>`
创建节点内容

```typescript
const content = await bookContentRepo.create({
  nodeId: 'node-id-123',
  pmJson: JSON.stringify({ type: 'doc', content: [] }),
  outlineJson: JSON.stringify([]),
})
```

#### `update(nodeId: string, data: { pmJson?: string; outlineJson?: string }): Promise<void>`
更新节点内容

```typescript
await bookContentRepo.update('node-id-123', {
  pmJson: JSON.stringify(newDoc),
})
```

#### `delete(nodeId: string): Promise<void>`
删除节点内容

### StoryThreadRepository

**位置**: `src/renderer/repositories/story_thread_sqlite.ts`

#### `findById(id: string): Promise<StoryThread | null>`
查找故事线

#### `create(data: Omit<StoryThread, 'id'>): Promise<StoryThread>`
创建故事线

```typescript
const thread = await threadRepo.create({
  projectId: 'default-project',
  name: '主线剧情',
  color: '#FF5733',
  summary: '主角的成长之路',
  pmJson: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})
```

#### `update(id: string, data: Partial<StoryThread>): Promise<void>`
更新故事线

#### `delete(id: string): Promise<void>`
删除故事线

#### `findByProject(projectId: string): Promise<StoryThread[]>`
获取项目的所有故事线

#### `addNodeToThread(nodeId: string, threadId: string): Promise<void>`
将节点添加到故事线

```typescript
await threadRepo.addNodeToThread('node-id-123', 'thread-id-456')
```

#### `removeNodeFromThread(nodeId: string, threadId: string): Promise<void>`
从故事线移除节点

#### `getThreadsByNode(nodeId: string): Promise<StoryThread[]>`
获取节点关联的所有故事线

```typescript
const threads = await threadRepo.getThreadsByNode('node-id-123')
```

#### `getNodeIdsByThread(threadId: string): Promise<string[]>`
获取故事线包含的所有节点 ID

### NodeTagRepository

**位置**: `src/renderer/repositories/node_tag_sqlite.ts`

#### `findById(id: string): Promise<NodeTag | null>`
查找标签

#### `create(data: { projectId: string; name: string; color?: string }): Promise<NodeTag>`
创建标签

```typescript
const tag = await tagRepo.create({
  projectId: 'default-project',
  name: '重要',
  color: '#FF0000',
})
```

#### `findByProject(projectId: string): Promise<NodeTag[]>`
获取项目的所有标签

#### `addTagToNode(nodeId: string, tagId: string): Promise<void>`
给节点添加标签

#### `removeTagFromNode(nodeId: string, tagId: string): Promise<void>`
移除节点标签

#### `getTagsByNode(nodeId: string): Promise<NodeTag[]>`
获取节点的所有标签

#### `getNodeIdsByTag(tagId: string): Promise<string[]>`
获取标签关联的所有节点 ID

---

## Service 层 API

Service 层封装业务逻辑，协调多个 Repository。

### BookContentService

**位置**: `src/renderer/services/book_content.service.ts`

#### `getByNodeId(nodeId: string): Promise<BookContent | null>`
获取节点内容

#### `create(nodeId: string, pmJson?: string): Promise<BookContent>`
创建节点内容

#### `update(nodeId: string, pmJson: string): Promise<void>`
更新节点内容

#### `delete(nodeId: string): Promise<void>`
删除节点内容

### ElementService

**位置**: `src/renderer/services/element.service.ts`

#### `getById(id: string): Promise<Element | null>`
获取元素

#### `list(projectId: string, filters?: { type?: string; categoryId?: string }): Promise<Element[]>`
列出元素

```typescript
// 获取所有角色
const characters = await elementService.list('default-project', { type: 'character' })

// 获取特定类别的元素
const elements = await elementService.list('default-project', { categoryId: 'cat-123' })
```

#### `create(data: CreateElementInput): Promise<Element>`
创建元素

#### `update(id: string, data: UpdateElementInput): Promise<void>`
更新元素

#### `delete(id: string): Promise<void>`
删除元素

---

## 组件层 API

### 主要组件

#### `<NodeEditorView>`
节点编辑器视图

**Props**:
```typescript
interface NodeEditorViewProps {
  nodeId: string;  // 要编辑的节点 ID
}
```

**使用**:
```tsx
<NodeEditorView nodeId="node-id-123" />
```

#### `<ElementEditorView>`
元素编辑器视图

**Props**:
```typescript
interface ElementEditorViewProps {
  elementId: string;  // 要编辑的元素 ID
}
```

#### `<TimelineChapters>`
时间线章节视图

**使用**:
```tsx
<TimelineChapters />
```

#### `<AppSidebar>`
应用侧边栏

**事件**:
- 创建章节
- 切换视图
- 打开设置

#### `<ElementPanel>`
元素面板

**功能**:
- 显示所有元素
- 按类型筛选
- 创建/编辑/删除元素

### 主要 Hooks

#### `useBookContent(nodeId: string)`
获取节点内容

```typescript
const { data: bookContent, isLoading, error } = useBookContent(nodeId)
```

#### `useBookNode(nodeId: string)`
获取节点信息

```typescript
const { data: node, isLoading, error } = useBookNode(nodeId)
```

#### `useElements(projectId: string, filters?: { type?: string })`
获取元素列表

```typescript
const { data: elements, isLoading } = useElements('default-project', { type: 'character' })
```

#### `useThreads(projectId: string)`
获取故事线列表

```typescript
const { data: threads } = useThreads('default-project')
```

#### `useTags(projectId: string)`
获取标签列表

```typescript
const { data: tags } = useTags('default-project')
```

---

## 数据库表结构

### 核心表

#### `project` - 项目表
```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  project_name TEXT,
  author TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `story_node` - 章节/节点表
```sql
CREATE TABLE story_node (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  start INTEGER NOT NULL,              -- 时间线位置/顺序
  end INTEGER,                          -- 时间线结束位置
  summary TEXT,                         -- 摘要
  story_stage_id TEXT,                  -- 关联的故事阶段
  pos_x REAL,                           -- 画布 X 坐标
  pos_y REAL,                           -- 画布 Y 坐标
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
```

#### `book_content` - 节点内容表
```sql
CREATE TABLE book_content (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  pm_json TEXT NOT NULL DEFAULT '{}',      -- ProseMirror 文档 JSON
  outline_json TEXT NOT NULL DEFAULT '[]', -- 大纲 JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE
);
```

#### `element` - 元素表（角色/地点/物品）
```sql
CREATE TABLE element (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category_id TEXT,                        -- 分类 ID
  type TEXT NOT NULL,                      -- 类型: character/location/object
  name TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}', -- 详细内容 JSON
  summary_json TEXT NOT NULL DEFAULT '{}', -- 摘要 JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
```

#### `element_category` - 元素分类表
```sql
CREATE TABLE element_category (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description_json TEXT NOT NULL DEFAULT '{}',
  color TEXT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
```

#### `story_thread` - 故事线表
```sql
CREATE TABLE story_thread (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  summary TEXT,
  pm_json TEXT,                            -- ProseMirror 富文本描述
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  last_modified INTEGER,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
```

#### `node_thread` - 节点-故事线关联表
```sql
CREATE TABLE node_thread (
  node_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(node_id, thread_id),
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(thread_id) REFERENCES story_thread(id) ON DELETE CASCADE
);
```

#### `node_tag` - 标签表
```sql
CREATE TABLE node_tag (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(project_id, name)
);
```

#### `node_tag_link` - 节点-标签关联表
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

#### `element_node_link` - 元素-节点关联表
```sql
CREATE TABLE element_node_link (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  FOREIGN KEY(node_id) REFERENCES story_node(id) ON DELETE CASCADE,
  FOREIGN KEY(element_id) REFERENCES element(id) ON DELETE CASCADE,
  UNIQUE(node_id, element_id)
);
```

### 辅助表

#### `story_stage` - 故事阶段表
```sql
CREATE TABLE story_stage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  order_key INTEGER NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
```

#### `node_edge` - 节点连接表
```sql
CREATE TABLE node_edge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  src_node_id TEXT NOT NULL,
  dst_node_id TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- chronology/causality/reference/foreshadow
  label TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE
);
```

---

## 常用操作示例

### 创建章节并编辑内容

```typescript
// 1. 创建章节节点
const node = await bookNodeRepo.create({
  title: '第一章：开端',
  projectId: 'default-project',
  start: 1,
  end: null,
  summary: null,
  storyStageId: null,
  posX: null,
  posY: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

// 2. 创建内容
const content = await bookContentRepo.create({
  nodeId: node.id,
  pmJson: JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '这是第一章的内容...' }]
      }
    ]
  }),
  outlineJson: JSON.stringify([]),
})

// 3. 跳转到编辑器
navigate(`/editor/node/${node.id}`)
```

### 创建角色并关联到章节

```typescript
// 1. 创建角色
const character = await elementRepo.create({
  projectId: 'default-project',
  categoryId: 'cat_character',
  type: 'character',
  name: '李明',
  contentJson: JSON.stringify({
    description: '主角，勇敢善良的少年',
    age: 16,
    appearance: '黑发黑眸，身材修长'
  }),
  summaryJson: JSON.stringify({}),
  createdAt: new Date(),
  updatedAt: new Date(),
})

// 2. 关联到章节
await run(
  'INSERT INTO element_node_link (id, node_id, element_id) VALUES (?, ?, ?)',
  [crypto.randomUUID(), nodeId, character.id]
)

// 3. 查询章节的所有关联元素
const elements = await query(
  `SELECT e.* FROM element e
   INNER JOIN element_node_link enl ON enl.element_id = e.id
   WHERE enl.node_id = ?`,
  [nodeId]
)
```

### 创建故事线并添加章节

```typescript
// 1. 创建故事线
const thread = await threadRepo.create({
  projectId: 'default-project',
  name: '主线剧情',
  color: '#FF5733',
  summary: '主角的成长之路',
  pmJson: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

// 2. 添加多个章节到故事线
await threadRepo.addNodeToThread(nodeId1, thread.id)
await threadRepo.addNodeToThread(nodeId2, thread.id)
await threadRepo.addNodeToThread(nodeId3, thread.id)

// 3. 查询故事线的所有章节
const nodeIds = await threadRepo.getNodeIdsByThread(thread.id)
const nodes = await Promise.all(
  nodeIds.map(id => bookNodeRepo.findById(id))
)
```

### 全文搜索

```typescript
// 搜索标题包含关键词的章节
const results = await query<{ id: string; title: string }>(
  `SELECT id, title FROM story_node 
   WHERE title LIKE ? AND is_deleted = 0`,
  [`%${keyword}%`]
)

// 搜索内容包含关键词的章节
const contentResults = await query(
  `SELECT bc.node_id, sn.title, bc.pm_json
   FROM book_content bc
   INNER JOIN story_node sn ON sn.id = bc.node_id
   WHERE bc.pm_json LIKE ? AND bc.is_deleted = 0`,
  [`%${keyword}%`]
)
```

### 批量操作

```typescript
// 批量更新章节顺序
const updates = nodes.map((node, index) => 
  run('UPDATE story_node SET start = ? WHERE id = ?', [index + 1, node.id])
)
await Promise.all(updates)

// 批量删除（软删除）
await run(
  'UPDATE story_node SET is_deleted = 1, updated_at = ? WHERE id IN (?, ?, ?)',
  [new Date().toISOString(), id1, id2, id3]
)
```

---

## 🔐 注意事项

### 1. SQL 注入防护
**始终使用参数化查询**：

```typescript
// ✅ 正确 - 使用参数
await query('SELECT * FROM story_node WHERE id = ?', [nodeId])

// ❌ 错误 - 字符串拼接（SQL 注入风险）
await query(`SELECT * FROM story_node WHERE id = '${nodeId}'`)
```

### 2. 软删除
多数表使用 `is_deleted` 标记删除，而非真正删除：

```typescript
// 软删除
await run('UPDATE story_node SET is_deleted = 1 WHERE id = ?', [id])

// 查询时过滤已删除
await query('SELECT * FROM story_node WHERE is_deleted = 0')
```

### 3. 时间戳格式
使用 ISO 8601 格式字符串：

```typescript
const now = new Date().toISOString()  // "2026-01-04T05:30:00.000Z"
```

### 4. JSON 字段
存储为 JSON 字符串，使用时需要解析：

```typescript
// 存储
const contentJson = JSON.stringify({ description: '...' })

// 读取
const content = JSON.parse(element.contentJson)
```

### 5. 事务处理
目前不支持显式事务，考虑使用单条语句或后续扩展：

```typescript
// 未来可能添加
await db.transaction(async () => {
  await run('INSERT ...')
  await run('UPDATE ...')
})
```

---

## 📚 相关文档

- [DEV_GUIDE.md](./DEV_GUIDE.md) - 开发指南
- [test-offline.md](./test-offline.md) - 离线功能测试清单
- [Better-SQLite3 文档](https://github.com/WiseLibs/better-sqlite3/wiki/API)
- [Electron IPC 文档](https://www.electronjs.org/docs/latest/tutorial/ipc)

---

## 🔄 版本历史

- **v1.0.0** (2026-01-04): 初始版本，从 Web 应用迁移到 Electron
  - 数据库从 wa-sqlite (Web Worker) 迁移到 better-sqlite3 (IPC)
  - 移除认证系统，改为本地优先模式
  - 所有表结构从 Prisma schema 迁移到原生 SQLite

---

**文档维护**: 如有 API 变更，请及时更新此文档。
