import type { WorkspaceDataProjection } from '../store/data-store';
import { deriveNodeStorylineState } from '../domain/node-storyline-state';
import { genericAssociationRelationType } from '../domain/entity-relation-type';
import { createSyntheticWorkspaceProjection } from './fixture';

/** Synthetic capture-shaped data, including every workspace slice and nested value shape. */
export function createWorkspaceSharingFixture(projectId: string, nodes = 1_000): WorkspaceDataProjection {
  const at = '2026-09-12T00:00:00.000Z';
  const base = createSyntheticWorkspaceProjection(projectId, nodes, Math.max(1, nodes / 5));
  const nodeId = base.bookNodes[0].id;
  base.storylines = ['main', 'support'].map((id, index) => ({
    id, projectId, name: `合成线${index}`, color: '#123456', summary: '', orderKey: index,
    contentJson: '{}', kvJson: '[]', nodeContentTemplateJson: '{}', createdAt: at, updatedAt: at,
  }));
  Object.assign(base, deriveNodeStorylineState(base.bookNodes.flatMap((node) => [
    { nodeId: node.id, storylineId: 'main', isPrimary: true },
    { nodeId: node.id, storylineId: 'support', isPrimary: false },
  ])));
  base.bookElements = base.bookElements.map((element) => ({ ...element,
    contentJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: `block-${element.id}` },
      content: [{ type: 'text', text: '合成资料正文。'.repeat(128) }] }] }),
  }));
  base.trashedEntityIds = new Set(['node:synthetic-trashed']);
  base.projectAssets = [{ id: 'synthetic-asset', projectId, kind: 'image', sourceMime: 'image/png',
    sourceSizeBytes: 1, sourceSha256: '0'.repeat(64), width: 1, height: 1, createdAt: at }];
  base.libraryItems = [{ id: 'synthetic-library', projectId, kind: 'text', title: '合成资料', notesJson: null,
    orderKey: 0, assetId: null, externalUrl: null, previewImageUrl: null, bodyJson: '{}', createdAt: at, updatedAt: at }];
  base.comments = [{ id: 'synthetic-comment', projectId, kind: 'note', targetKind: 'node', targetId: nodeId,
    targetBlockId: null, anchorJson: '{}', authorKind: 'user', authorId: null, authorName: null,
    bodyJson: '{}', status: 'open', priority: null, source: 'manual', metadataJson: null,
    targetBlockIdsJson: '[]', resolvedAt: null, createdAt: at, updatedAt: at }];
  base.commentActions = [{ id: 'synthetic-action', projectId, commentId: 'synthetic-comment',
    kind: 'accept_suggestion', label: null, payloadJson: '{}', status: 'pending', resultJson: null,
    createdByKind: 'user', createdById: null, createdAt: at, updatedAt: at, appliedAt: null }];
  base.entityRelationTypes = [genericAssociationRelationType(projectId, at)];
  base.entityRelations = [{ id: 'synthetic-relation', projectId, fromKind: 'comment', fromId: 'synthetic-comment',
    toKind: 'node', toId: nodeId, relationTypeId: base.entityRelationTypes[0].id, createdAt: at, updatedAt: at }];
  base.blockSections = [{ id: 'synthetic-section', projectId, chapterId: nodeId,
    blockIds: ['synthetic-block'], blockHashes: { 'synthetic-block': 'synthetic-hash' }, summary: '合成摘要',
    source: 'manual', createdAt: at, updatedAt: at }];
  base.bookActs = [{ id: 'synthetic-act', projectId, name: '合成幕', color: null, startOrder: 0,
    driftNodeId: null, createdAt: at, updatedAt: at }];
  base.driftGroups = [{ id: 'synthetic-group', projectId, name: '合成分组', parentGroupId: null,
    color: null, sortOrder: 0, createdAt: at, updatedAt: at }];
  base.timelineMarkers = [{ id: 'synthetic-marker', projectId, narrativeOrder: 0.125,
    label: '合成标记', driftNodeId: null, createdAt: at, updatedAt: at }];
  return base;
}
