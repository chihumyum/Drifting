import { text, integer, blob, sqliteTable } from 'drizzle-orm/sqlite-core';

/**
 * YJS 增量更新存储表
 * 用于本地缓存 YJS updates，离线时继续工作
 */
export const yjsUpdates = sqliteTable('yjs_updates', {
  id: text('id').primaryKey(),
  documentType: text('document_type').notNull(), // 'content', 'edges', 'relationships'
  seq: integer('seq').notNull(), // 本地序列号
  updateData: blob('update_data').notNull(), // YJS update 二进制数据
  clientId: text('client_id').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * 同步状态跟踪表
 * 记录每个 document type 的同步进度
 */
export const syncState = sqliteTable('sync_state', {
  documentType: text('document_type').primaryKey(),
  lastServerSeq: integer('last_server_seq').default(0), // 服务端最后同步的 seq
  lastSyncedAt: text('last_synced_at'), // 最后同步时间
  isDirty: integer('is_dirty').default(0), // 是否有未同步的本地更改
  conflictCount: integer('conflict_count').default(0), // 冲突计数
  lastError: text('last_error'), // 最后一次同步错误
});

/**
 * 纯文本提取表
 * 从 YJS 富文本提取纯文本用于 FTS5 搜索
 */
export const contentPlaintext = sqliteTable('content_plaintext', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  plainContent: text('plain_content'), // 提取的纯文本
  updatedAt: text('updated_at').notNull(),
});

/**
 * 软删除日志表（可选）
 * 记录所有软删除操作，用于回收站和冲突解决
 */
export const deletionLog = sqliteTable('deletion_log', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(), // 'story_node', 'element', etc.
  entityId: text('entity_id').notNull(),
  deletedAt: text('deleted_at').notNull(),
  deletedBy: text('deleted_by').notNull(), // user_id
  reason: text('reason'), // 可选的删除原因
});
