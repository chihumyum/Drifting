# Drifting 开发路线图

## 🎯 MVP 核心目标

**1-2个月内完成可用原型，验证核心价值：离线优先的小说创作工具**

---

## 🚀 Sprint 1: 基础设施 (Week 1-2)

### 客户端
```bash
□ Schema 完善
  ✓ 添加 sync.ts (yjs_updates, sync_state, content_plaintext)
  □ 更新 drizzle.ts (添加 deleted_at, deleted_by 字段)
  □ 运行 migration

□ 同步管理器基础
  □ src/renderer/services/sync/SyncManager.ts
  □ src/renderer/services/sync/YJSProvider.ts
  □ src/renderer/services/sync/MetadataSync.ts

□ YJS 集成
  □ Tiptap + YJS binding
  □ 本地 Y.Doc 持久化到 SQLite
  □ YJS updates 监听与存储
```

### 服务端
```bash
□ 项目初始化
  □ package.json, tsconfig.json
  □ Fastify app 基础结构
  □ Drizzle ORM + PostgreSQL 连接
  
□ Schema 设计
  □ documents 表
  □ yjs_updates 表
  □ users, projects 表
  
□ API Routes
  □ POST /sync/push
  □ POST /sync/pull
  □ GET /health
```

**验收标准**:
- ✅ 客户端可以创建项目和节点
- ✅ YJS 富文本编辑器可用
- ✅ 服务端可以接收和返回数据

---

## 🔄 Sprint 2: YJS 同步核心 (Week 3-4)

### 客户端实现
```typescript
// src/renderer/services/sync/YJSProvider.ts
class YJSProvider {
  private ydoc: Y.Doc;
  private lastSeq: number = 0;
  
  async push() {
    const updates = await db.select().from(yjsUpdates)
      .where(eq(yjsUpdates.synced, false));
    
    for (const update of updates) {
      await api.post('/sync/push', {
        documentType: update.documentType,
        update: update.updateData,
        clientId: this.clientId
      });
      
      // 标记为已同步
      await db.update(yjsUpdates)
        .set({ synced: true })
        .where(eq(yjsUpdates.id, update.id));
    }
  }
  
  async pull() {
    const { updates, maxSeq } = await api.post('/sync/pull', {
      documentType: 'content',
      lastSeq: this.lastSeq
    });
    
    for (const u of updates) {
      Y.applyUpdate(this.ydoc, new Uint8Array(u.data));
    }
    
    this.lastSeq = maxSeq;
    await this.saveSyncState();
  }
}
```

### 服务端实现
```typescript
// src/routes/sync.ts
fastify.post('/sync/push', async (req, reply) => {
  const { documentType, update, clientId } = req.body;
  
  // 直接落库，零计算
  await db.insert(yjsUpdates).values({
    documentId: getDocumentId(req.user.projectId, documentType),
    updateData: Buffer.from(update),
    clientId
  });
  
  return { success: true };
});

fastify.post('/sync/pull', async (req, reply) => {
  const { documentType, lastSeq } = req.body;
  
  // 按 seq 查询增量
  const updates = await db.select()
    .from(yjsUpdates)
    .where(and(
      eq(yjsUpdates.documentId, documentId),
      gt(yjsUpdates.seq, lastSeq),
      eq(yjsUpdates.compacted, false)
    ))
    .orderBy(yjsUpdates.seq)
    .limit(100);
  
  return {
    updates: updates.map(u => ({
      seq: u.seq,
      data: Array.from(u.updateData)
    })),
    maxSeq: updates[updates.length - 1]?.seq || lastSeq
  };
});
```

**验收标准**:
- ✅ 客户端编辑富文本，自动推送到服务端
- ✅ 多个客户端编辑，CRDT 自动合并无冲突
- ✅ 离线编辑，上线后自动同步

---

## 📊 Sprint 3: 元数据同步 (Week 5)

### LWW 同步实现
```typescript
// src/renderer/services/sync/MetadataSync.ts
class MetadataSync {
  async syncStoryNodes() {
    // 1. 拉取服务端数据
    const serverNodes = await api.get('/metadata/story-nodes');
    
    // 2. LWW 冲突解决
    for (const serverNode of serverNodes) {
      const localNode = await db.select()
        .from(storyNodes)
        .where(eq(storyNodes.id, serverNode.id))
        .get();
      
      if (!localNode) {
        // 新节点，直接插入
        await db.insert(storyNodes).values(serverNode);
      } else {
        // 冲突检测
        if (new Date(serverNode.updatedAt) > new Date(localNode.updatedAt)) {
          // 服务端更新
          if (localNode.deletedAt && !serverNode.deletedAt) {
            // 删除-修改冲突
            if (new Date(serverNode.updatedAt) > new Date(localNode.deletedAt)) {
              // 修改时间晚于删除，复活节点
              await this.resurrectNode(serverNode);
            }
          } else {
            await db.update(storyNodes)
              .set(serverNode)
              .where(eq(storyNodes.id, serverNode.id));
          }
        } else {
          // 本地更新，推送到服务端
          await api.put(`/metadata/story-nodes/${localNode.id}`, localNode);
        }
      }
    }
  }
}
```

**验收标准**:
- ✅ 节点标题、摘要等元数据同步
- ✅ 删除-修改冲突正确处理
- ✅ 软删除的节点显示在回收站

---

## 🔐 Sprint 4: 认证系统 (Week 6)

```bash
□ better-auth 集成
  □ 服务端配置
  □ Google OAuth 配置
  □ Token 刷新机制
  
□ 客户端认证流程
  □ 登录/注册界面
  □ Token 存储（keytar）
  □ 自动登录
  
□ API 保护
  □ JWT 验证中间件
  □ 用户权限检查
```

**验收标准**:
- ✅ 用户可以用 Google 登录
- ✅ 未登录无法同步
- ✅ Token 过期自动刷新

---

## 🔍 Sprint 5: FTS5 搜索 (Week 7)

### 简单方案（推荐 MVP）
```typescript
// src/renderer/services/search/ContentExtractor.ts
class ContentExtractor {
  async extractPlaintext(nodeId: string, ydoc: Y.Doc) {
    const yContent = ydoc.getMap('node_contents').get(nodeId);
    
    // 从 ProseMirror JSON 提取纯文本
    const plaintext = this.extractText(yContent);
    
    // 中文分词（可选）
    const segmented = jieba.cut(plaintext).join(' ');
    
    // 存储到 content_plaintext
    await db.insert(contentPlaintext).values({
      id: uuid(),
      nodeId,
      plainContent: segmented,
      updatedAt: new Date().toISOString()
    });
  }
  
  async search(query: string) {
    // FTS5 查询
    const results = await db.execute(sql`
      SELECT node_id, highlight(content_fts, 0, '<mark>', '</mark>') as snippet
      FROM content_fts
      WHERE content_fts MATCH ${query}
      ORDER BY rank
      LIMIT 20
    `);
    
    return results;
  }
}
```

**验收标准**:
- ✅ 全局搜索可用
- ✅ 中文搜索基本可用
- ✅ 高亮搜索结果

---

## 🎨 Sprint 6: UI 优化 (Week 8)

```bash
□ 同步状态指示器
  □ 同步中/已同步/离线 状态显示
  □ 冲突提示
  
□ 回收站 UI
  □ 软删除节点列表
  □ 恢复/永久删除
  
□ 搜索界面
  □ 全局搜索快捷键
  □ 搜索结果预览
  □ 跳转到结果
```

---

## 📦 MVP 完成检查清单

### 核心功能
- [ ] 创建项目和节点
- [ ] 富文本编辑器（Tiptap + YJS）
- [ ] YJS CRDT 同步
- [ ] 元数据 LWW 同步
- [ ] 软删除与回收站
- [ ] 全局搜索
- [ ] 用户认证（Google OAuth）

### 性能指标
- [ ] 离线编辑流畅（无延迟）
- [ ] 同步延迟 < 2s
- [ ] 搜索响应 < 200ms
- [ ] 无明显的同步冲突

### 稳定性
- [ ] 离线→在线切换无数据丢失
- [ ] CRDT 合并无冲突
- [ ] 软删除冲突正确处理

---

## 🚀 Post-MVP (3-6个月)

### P1: 增强功能
```
□ Compaction Worker
  - 定期压缩 YJS updates
  - 生成 snapshots
  
□ Time Machine
  - 版本历史存储
  - 版本对比 UI
  
□ 关系编辑器
  - 可视化编辑 edges
  - YJS Array 同步
```

### P2: 高级功能
```
□ On-device LLM
  - ONNX Runtime 集成
  - 模型下载与缓存
  - AI 写作建议
  
□ Web 版本
  - 服务端渲染元数据
  - 只读分享链接
  
□ 协作功能
  - 实时光标显示
  - 评论系统
```

### P3: 商业化
```
□ Stripe 支付
□ 订阅管理
□ GT 翻译
□ 导出功能（PDF, EPUB）
```

---

## 🎯 当前状态

**✅ 已完成**:
- 架构设计 90%
- 客户端基础 Schema
- 技术选型明确

**🔄 进行中**:
- 完善同步 Schema
- 服务端项目初始化

**⏭️ 下一步**:
1. 运行 Drizzle migration 更新数据库
2. 初始化服务端项目
3. 实现 YJS 同步核心逻辑

---

## 💡 开发建议

1. **先实现，后优化**: MVP 阶段不追求完美，先跑通核心流程
2. **增量开发**: 每个 Sprint 都有可演示的成果
3. **先离线，后在线**: 先确保离线体验完美，再加同步
4. **手动测试**: MVP 阶段不写单元测试，快速迭代
5. **延后优化**: Redis, LLM, Time Machine 等都延后到 Post-MVP

**🚀 现在就可以开始 Sprint 1！**
