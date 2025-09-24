import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ChevronDown, ChevronRight, PenSquare, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';
import { query, run } from '../lib/db';
import type { Entity, EntityCategory, EntityStage } from '../model/schema';
import { MOCK_ENTITIES, MOCK_ENTITY_CATEGORIES } from '../model/schema';
import { listEntityCategories, ensureEntityCategory } from '../lib/entity';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import { EntityEditor } from './EntityEditor';

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

function getCategoryLabel(name: string) {
  return labelMap[name] ?? name;
}

function getCategoryIcon(name: string) {
  return iconMap[name] ?? fallbackIcon;
}

function getCategoryAccent(name: string) {
  return accentMap[name] ?? fallbackAccent;
}

function dedupeCategories(categories: EntityCategory[]): EntityCategory[] {
  const seen = new Set<string>();
  const result: EntityCategory[] = [];
  categories.forEach((raw) => {
    const id = raw.id;
    if (seen.has(id)) return;
    seen.add(id);
    result.push(raw);
  });
  return result;
}

type EntityPanelActions = {
  createEntity: (categoryOverride?: string) => Promise<void>;
  createCategory: (name?: string) => Promise<void>;
};

interface EntityPanelProps {
  collapsed?: boolean;
  onRegisterActions?: (actions: EntityPanelActions) => void;
}

interface EntityWithStages extends Entity {
  stages: EntityStage[];
}

export function EntityPanel({ collapsed = false, onRegisterActions }: EntityPanelProps) {
  const {
    entities,
    setEntities: setEntries,
    addEntity: addEntry,
    selectedEntityId,
    setSelectedEntityId
  } = useAppStore();

  const [entityCategories, setEntityCategories] = useState<EntityCategory[]>(() => dedupeCategories([...MOCK_ENTITY_CATEGORIES]));
  const [selectedCategory, setSelectedCategory] = useState<EntityCategory>(MOCK_ENTITY_CATEGORIES[0]);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);

  const loadEntities = useCallback(async () => {
    try {
      const rows = await query<Entity>('SELECT * FROM entity ORDER BY type, name');
      setEntries(rows);
    } catch (error) {
      console.error('Failed to load entities', error);
      setEntries([]);
    }
  }, [setEntries]);

  const loadCategories = useCallback(async () => {
    try {
      const rows = await listEntityCategories();
      if (rows.length) {
        setEntityCategories(dedupeCategories([
          ...MOCK_ENTITY_CATEGORIES,
          ...rows,
        ]));
      } else {
        setEntityCategories(dedupeCategories([...MOCK_ENTITY_CATEGORIES]));
      }
    } catch (error) {
      console.error('Failed to load entity categories', error);
    }
  }, []);

  useEffect(() => {
    loadEntities();
    const handleChange = () => {
      loadEntities();
    };
    events.on('entity:entity-created', handleChange);
    events.on('entity:entity-updated', handleChange);
    events.on('entity:entity-deleted', handleChange);
    events.on('entity:category-created', handleChange);
    events.on('entity:category-deleted', handleChange);
    events.on('db:ready', handleChange);
    return () => {
      events.off('entity:entity-created', handleChange);
      events.off('entity:entity-updated', handleChange);
      events.off('entity:entity-deleted', handleChange);
      events.off('entity:category-created', handleChange);
      events.off('entity:category-deleted', handleChange);
      events.off('db:ready', handleChange);
    };
  }, [loadEntities]);

  useEffect(() => {
    loadCategories();
    const handleCategories = () => loadCategories();
    events.on('entity:category-created', handleCategories);
    events.on('entity:category-deleted', handleCategories);
    events.on('db:ready', handleCategories);
    return () => {
      events.off('entity:category-created', handleCategories);
      events.off('entity:category-deleted', handleCategories);
      events.off('db:ready', handleCategories);
    };
  }, [loadCategories]);

  useEffect(() => {
    setEntityCategories((prev) => dedupeCategories([...prev, ...entities.map((entry: Entity) => entry.type)]));
  }, [entities]);

  useEffect(() => {
    const display = dedupeCategories([...entityCategories, ...entities.map((entry: Entity) => entry.type)]);
    setExpandedCategories((prev) => {
      const next: Record<string, boolean> = {};
      display.forEach((cat, idx) => {
        next[cat] = prev[cat] ?? idx === 0;
      });
      return next;
    });
    if (display.length && !display.includes(selectedCategory)) {
      setSelectedCategory(display[0]);
    }
  }, [entityCategories, entities, selectedCategory]);

  const displayCategories = useMemo(
    () => dedupeCategories([...entityCategories, ...entities.map((entry: Entity) => entry.type)]),
    [entityCategories, entities]
  );

  const grouped = useMemo(() => {
    const record: Record<string, EntityWithStages[]> = {};
    displayCategories.forEach((cat) => {
      record[cat] = [];
    });
    entities.forEach((entry: Entity) => {
      if (!record[entry.type]) {
        record[entry.type] = [];
      }
      record[entry.type].push({
        ...entry,
        stages: entryStages.filter((stage) => stage.entity_id === entry.id),
      });
    });
    return record;
  }, [displayCategories, entities, entryStages]);

  const createEntity = useCallback(async (categoryOverride?: string) => {
    const category = categoryOverride || selectedCategory || displayCategories[0] || DEFAULT_entity_CATEGORIES[0];
    const entryId = `entity_${Date.now()}`;
    const now = new Date().toISOString();
    const newEntry: Entity = {
      id: entryId,
      project_id: 'default',
      category_id: getEntityCategoryId(category),
      name: '未命名实体',
      aliases_json: '[]',
      attributes_json: '{}',
      canonical_summary: '',
      created_at: now,
      updated_at: now,
    };
    try {
      await ensureEntityCategory(category);
      await run(`
        INSERT INTO entity (id, project_id, type, name, aliases_json, attributes_json, canonical_summary, created_at, updated_at)
        VALUES ('${entryId}', '${newEntry.project_id}', '${escapeSql(newEntry.type)}', '${escapeSql(newEntry.name)}', '${newEntry.aliases_json}', '${newEntry.attributes_json}', '', '${now}', '${now}')
      `);
      addEntry(newEntry);
      events.emit('entries:changed');
      events.emit('categories:changed');
      setEditingEntityId(entryId);
    } catch (error) {
      console.error('Failed to create entry', error);
    }
  }, [addEntry, selectedCategory, displayCategories]);

  const handleAddCategory = useCallback(async (value?: string) => {
    const source = value ?? newCategoryName;
    const trimmed = source.trim();
    if (!trimmed) return;
    try {
      await ensureEntityCategory(trimmed);
      setEntityCategories((prev) => dedupeCategories([...prev, trimmed]));
      setSelectedCategory(trimmed);
      if (!value) setNewCategoryName('');
      events.emit('categories:changed');
    } catch (error) {
      console.error('Failed to create category', error);
    }
  }, [newCategoryName]);

  useEffect(() => {
    if (!onRegisterActions) return;
    onRegisterActions({
      createEntity: async (category) => {
        await createEntity(category);
      },
      createCategory: async (name) => {
        await handleAddCategory(name);
      }
    });
  }, [onRegisterActions, createEntity, handleAddCategory]);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#faf9fa',
      borderRight: '1px solid #e2dfea'
    }}>
      {!collapsed && (
        <div style={{ padding: '16px', borderBottom: '1px solid #e4e0eb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, textTransform: 'uppercase', color: '#9b8ea8', letterSpacing: '0.08em' }}>Entities</div>
              <h2 style={{ margin: '4px 0 0 0', fontSize: 16, color: '#352f3b' }}>设定库</h2>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
                style={{
                  fontSize: 12,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid #d4c8d4',
                  backgroundColor: '#fff'
                }}
              >
                {displayCategories.map((category) => (
                  <option key={category} value={category}>
                    {getCategoryLabel(category)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void createEntity()}
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
            <input
              type="text"
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleAddCategory();
                }
              }}
              placeholder="新增类别名称"
              style={{
                flex: 1,
                fontSize: 12,
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #d4c8d4',
                backgroundColor: '#fff'
              }}
            />
            <button
              onClick={() => void handleAddCategory()}
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
              添加类别
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: collapsed ? '12px 0 16px 0' : '12px 8px 16px 12px' }}>
        {displayCategories.map((type) => {
          const entriesOfType = grouped[type] || [];
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
                        border: entry.id === selectedEntityId ? `2px solid ${getCategoryAccent(entry.type)}` : '1px solid #e6e0eb',
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
                              {entry.canonical_summary.replace(/<[^>]+>/g, '').slice(0, 80)}{entry.canonical_summary.length > 80 ? '…' : ''}
                            </div>
                          )}
                          {entry.aliases_json !== '[]' && (
                            <div style={{ fontSize: 11, color: '#9990a1', marginTop: 6 }}>
                              别名：{JSON.parse(entry.aliases_json).slice(0, 3).join('、')}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
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

                      <StageTimeline stages={entry.stages} accent={getCategoryAccent(entry.type)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editingEntityId && (
        <EntityEditor entityId={editingEntityId} onClose={() => setEditingEntityId(null)} />
      )}
    </div>
  );
}

function StageTimeline({ stages, accent }: { stages: EntityStage[]; accent: string; }) {
  if (stages.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: '#9b8da7', marginBottom: 6 }}>发展阶段</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stages.map((stage) => (
          <div key={stage.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, color: accent, minWidth: 72 }}>
              {stage.start_order} → {stage.end_order}
            </span>
            <div style={{ flex: 1, fontSize: 11, color: '#6d6073', lineHeight: 1.4 }}>
              {stage.stage_summary || '未填写阶段说明'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function escapeSql(input: string) {
  return input.replaceAll("'", "''");
}

export type { EntityPanelActions };
