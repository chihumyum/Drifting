import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, ChevronRight, PenSquare, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';
import type { Entity, EntityCategory } from '../schema/table';
import { query, run } from '../lib/db';
import * as EntityOps from '../lib/book_entity';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import { EntityCreateModal, type NewEntityPayload } from './modals/ElementCreateModal';
import { EntityCategoryModal, type NewCategoryPayload } from './modals/ElementCategoryModal';
import { EntityEditModal } from './modals/ElementEditModal';

const labelMap: Record<string, string> = {
  character: '角色',
  location: '地点',
  object: '物品',
  faction: '组织',
  concept: '概念',
};

const iconMap: Record<string, typeof User> = {
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

const accentMap: Record<string, string> = {
  character: '#e75a5c',
  location: '#4c82b3',
  object: '#c47c2b',
  faction: '#3c8f70',
  concept: '#7a5ca0',
};

const fallbackAccent = '#6c5b7e';
const fallbackIcon = Lightbulb;




export function EntityPanel() {
  const {
    entities,
    setEntities,
    addEntity,
    updateEntity,
    removeEntity,

    entityCategories,
    setEntityCategories,
    addEntityCategory,
    updateEntityCategory,
    removeEntityCategory,

    selectedEntityId,
    setSelectedEntityId,
    selectedEntity,
    setSelectedEntity,
    selectedEntityCategory,
    setSelectedEntityCategory,

  } = useAppStore();

  const [categories, setCategories] = useState<EntityCategory[]>([]);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showNewEntityModal, setShowNewEntityModal] = useState(false);
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [pendingCategoryName, setPendingCategoryName] = useState<string | null>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);

  const editingEntity = useMemo(
    () => entities.find((entityItem) => entityItem.id === editingEntityId) ?? null,
    [entities, editingEntityId]
  );

  const loadEntities = useCallback(
    async () => {
      const allEntities = await EntityOps.getAllEntities();
      setEntities(allEntities);
    }, [setEntities]);

  const loadCategories = useCallback(async () => {
    const rows = await EntityOps.getEntityCategories();
    setCategories(rows);
  }, []);

  useEffect(() => {
    loadEntities().catch((error) => console.error('Failed to load entities', error));
    const reload = () => {
      loadEntities().catch((error) => console.error('Failed to reload entities', error));
    };
    events.on('db:ready', reload);
    events.on('entity:entity-created', reload);
    events.on('entity:entity-updated', reload);
    events.on('entity:entity-deleted', reload);
    return () => {
      events.off('db:ready', reload);
      events.off('entity:entity-created', reload);
      events.off('entity:entity-updated', reload);
      events.off('entity:entity-deleted', reload);
    };
  }, [loadEntities]);

  useEffect(() => {
    loadCategories().catch((error) => console.error('Failed to load categories', error));
    const reload = () => {
      loadCategories().catch((error) => console.error('Failed to reload categories', error));
    };
    events.on('db:ready', reload);
    events.on('entity:category-created', reload);
    events.on('entity:category-updated', reload);
    events.on('entity:category-deleted', reload);
    return () => {
      events.off('db:ready', reload);
      events.off('entity:category-created', reload);
      events.off('entity:category-updated', reload);
      events.off('entity:category-deleted', reload);
    };
  }, [loadCategories]);

  const categoryNames = useMemo(() => {
    const names = new Set<string>();
    categories.forEach((cat) => names.add(cat.name));
    entities.forEach((entity) => {
      if (entity.category_id) {
        names.add(entity.category_id);
      }
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [categories, entities]);

  useEffect(() => {
    if (!selectedCategory && categoryNames.length) {
      setSelectedCategory(categoryNames[0]);
    }
  }, [categoryNames, selectedCategory]);

  useEffect(() => {
    setExpandedCategories((prev) => {
      const next: Record<string, boolean> = {};
      categoryNames.forEach((name, index) => {
        next[name] = prev[name] ?? index === 0;
      });
      return next;
    });
  }, [categoryNames]);


  const groupedEntities = useMemo(() => {
    const record: Record<string, Entity[]> = {};
    categoryNames.forEach((name) => {
      record[name] = [];
    });
    entities.forEach((entity) => {
      const key = entity.category_id || '未分类';
      if (!record[key]) record[key] = [];
      record[key].push(entity);
    });
    return record;
  }, [entities, categoryNames]);

  const handleCreateEntity = useCallback(async (payload: NewEntityPayload) => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();
    addEntity({
      id: entityId,
      project_id: '', // Will be set in createEntity
      name: payload.name,
      category_id: payload.category,
      aliases_json: JSON.stringify(payload.aliases || []),
      canonical_summary: payload.summary || '',
      created_at: now,
      updated_at: now,
    });
    await EntityOps.ensureEntityCategory(payload.category);
    const created =
      await EntityOps.createEntity(entityId, now, payload.category, payload.content || '', payload.tags || []);
    await loadEntities();
    await loadCategories();
    events.emit('entity:entity-created', { entity: created });
    setSelectedEntityId(entityId);
  }, [loadEntities, loadCategories, setSelectedEntityId]);

  const handleCreateCategory = useCallback(async (payload: NewCategoryPayload) => {
    const name = payload.name.trim();
    if (!name) return;
    await ensureEntityCategory(name);
    if (payload.color) {
      await run(`UPDATE entity_category SET color='${escapeSql(payload.color)}' WHERE name='${escapeSql(name)}'`);
    }
    await loadCategories();
    events.emit('entity:category-created', { categoryId: name });
    setSelectedCategory(name);
  }, [loadCategories]);

  const handleUpdateEntity = useCallback(async (payload: NewEntityPayload & { id: string }) => {
    await ensureEntityCategory(payload.category);
    const now = new Date().toISOString();
    const aliasesJson = JSON.stringify(payload.aliases);
    const summary = payload.summary.trim();

    await run(`
      UPDATE entity SET
        name='${escapeSql(payload.name)}',
        type='${escapeSql(payload.category)}',
        aliases_json='${escapeSql(aliasesJson)}',
        canonical_summary='${escapeSql(summary)}',
        updated_at='${escapeSql(now)}'
      WHERE id='${escapeSql(payload.id)}'
    `);

    await loadEntities();
    await loadCategories();
    events.emit('entity:entity-updated', {
      entityId: payload.id,
      updates: {
        name: payload.name,
        category_id: payload.category,
        aliases_json: aliasesJson,
        canonical_summary: summary,
      },
    });
    setSelectedEntityId(payload.id);
    setEditingEntityId(null);
  }, [loadEntities, loadCategories, setSelectedEntityId]);

  const renderHeader = () => (
    <div style={{ padding: '16px', borderBottom: '1px solid #e4e0eb' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', color: '#9b8ea8', letterSpacing: '0.08em' }}>Entities</div>
          <h2 style={{ margin: '4px 0 0 0', fontSize: 16, color: '#352f3b' }}>设定库</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={selectedCategory ?? ''}
            onChange={(event) => setSelectedCategory(event.target.value)}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #d4c8d4',
              backgroundColor: '#fff'
            }}
          >
            {categoryNames.map((category) => (
              <option key={category} value={category}>
                {getCategoryLabel(category)}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowNewEntityModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              backgroundColor: '#3a855a',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: 999,
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            <Plus size={13} />
            新建实体
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => setShowNewCategoryModal(true)}
          style={{
            border: 'none',
            backgroundColor: '#ded3f0',
            color: '#4d3f59',
            padding: '6px 12px',
            borderRadius: 999,
            fontSize: 12,
            cursor: 'pointer'
          }}
        >
          新增类别
        </button>
      </div>
    </div>
  );

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#faf9fa',
      borderRight: '1px solid #e2dfea'
    }}>
      {!collapsed && renderHeader()}

      <div style={{ flex: 1, overflow: 'auto', padding: collapsed ? '12px 0 16px 0' : '12px 8px 16px 12px' }}>
        {categoryNames.map((type) => {
          const entriesOfType = groupedEntities[type] || [];
          const expanded = expandedCategories[type] ?? false;
          const Icon = getCategoryIcon(type);
          const accent = getCategoryAccent(type);
          return (
            <div key={type} style={{ marginBottom: 16 }}>
              <button
                onClick={() => setExpandedCategories((prev) => ({ ...prev, [type]: !prev[type] }))}
                style={{
                  width: '100%',
                  border: 'none',
                  background: 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  cursor: 'pointer'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {expanded ? <ChevronDown size={14} color="#8a7d92" /> : <ChevronRight size={14} color="#8a7d92" />}
                  <Icon size={16} color={accent} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#423947' }}>{getCategoryLabel(type)} ({entriesOfType.length})</span>
                </div>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedCategory(type);
                    setShowNewEntityModal(true);
                  }}
                  style={{
                    border: 'none',
                    backgroundColor: '#ece7f6',
                    color: '#51415f',
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    cursor: 'pointer'
                  }}
                >
                  <Plus size={12} />
                </button>
              </button>

              {expanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
                  {entriesOfType.length === 0 && (
                    <div style={{ fontSize: 12, color: '#a598aa', padding: '6px 12px' }}>暂无记录</div>
                  )}

                  {entriesOfType.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        borderRadius: 14,
                        border: entry.id === selectedEntityId ? `2px solid ${getCategoryAccent(entry.category_id)}` : '1px solid #e6e0eb',
                        backgroundColor: '#fff',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                        padding: '12px 14px',
                        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
                        cursor: 'pointer'
                      }}
                      onClick={() => setSelectedEntityId(entry.id)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#332b37' }}>{entry.name}</div>
                          {entry.canonical_summary && (
                            <div style={{ fontSize: 12, color: '#756d7a', marginTop: 4 }}>
                              {stripHtml(entry.canonical_summary).slice(0, 80)}{entry.canonical_summary.length > 80 ? '…' : ''}
                            </div>
                          )}
                          {entry.aliases_json !== '[]' && (
                            <div style={{ fontSize: 11, color: '#9990a1', marginTop: 6 }}>
                              别名：{safeParseAliases(entry.aliases_json).slice(0, 3).join('、')}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingEntityId(entry.id);
                          }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: '#8c7f96',
                            cursor: 'pointer'
                          }}
                          title="编辑"
                        >
                          <PenSquare size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showNewEntityModal && (
        <EntityCreateModal
          categories={categoryNames}
          defaultCategory={selectedCategory ?? categoryNames[0]}
          onClose={() => setShowNewEntityModal(false)}
          onSubmit={async (payload) => {
            await handleCreateEntity(payload);
            setShowNewEntityModal(false);
          }}
          renderCategoryLabel={getCategoryLabel}
        />
      )}

      {showNewCategoryModal && (
        <EntityCategoryModal
          key={pendingCategoryName ?? 'default'}
          existingNames={categoryNames}
          initialName={pendingCategoryName ?? ''}
          onClose={() => {
            setShowNewCategoryModal(false);
            setPendingCategoryName(null);
          }}
          onSubmit={async (payload) => {
            await handleCreateCategory(payload);
            setShowNewCategoryModal(false);
            setPendingCategoryName(null);
          }}
        />
      )}

      {editingEntity && (
        <EntityEditModal
          entity={editingEntity}
          categories={categoryNames}
          onClose={() => setEditingEntityId(null)}
          onSubmit={async (payload) => {
            await handleUpdateEntity(payload);
          }}
          renderCategoryLabel={getCategoryLabel}
        />
      )}
    </div>
  );
}

function getCategoryLabel(name: string) {
  return labelMap[name] ?? name;
}

function getCategoryIcon(name: string) {
  return iconMap[name] ?? fallbackIcon;
}

function getCategoryAccent(name: string) {
  return accentMap[name] ?? fallbackAccent;
}

function safeParseAliases(raw: string) {
  try {
    const parsed = JSON.parse(raw) as string[];
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function stripHtml(raw: string) {
  return raw.replace(/<[^>]+>/g, '');
}

function escapeSql(input: string) {
  return input.replaceAll("'", "''");
}

export type { EntityPanelActions };
