import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, PenSquare, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';

import { useAppStore } from '../store';
import * as EntityOps from '../lib/book_entity';
import { events } from '../lib/events';
import type { Entity } from '../model/domain';
import type { EntityCategory } from '../schema/table';
import { EntityCreateModal, type NewEntityPayload } from '../components/modals/ElementCreateModal';
import { EntityEditModal } from '../components/modals/ElementEditModal';

const iconMap: Record<string, typeof User> = {
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

const colorMap: Record<string, string> = {
  character: 'bg-blue-50 border-blue-200 text-blue-900',
  location: 'bg-green-50 border-green-200 text-green-900',
  object: 'bg-orange-50 border-orange-200 text-orange-900',
  faction: 'bg-red-50 border-red-200 text-red-900',
  concept: 'bg-purple-50 border-purple-200 text-purple-900',
};

const fallbackIcon = Lightbulb;
const fallbackColor = 'bg-neutral-200 border-neutral-300 text-neutral-700';
const uncategorizedKey = 'uncategorized';

function getCategoryIcon(name: string) {
  return iconMap[name] ?? fallbackIcon;
}

function getCategoryColor(name: string) {
  if (name === uncategorizedKey) {
    return 'bg-neutral-100 border-neutral-200 text-neutral-600';
  }
  return colorMap[name] ?? fallbackColor;
}

function normalizeCategory(entity: Entity) {
  const trimmed = entity.category.trim();
  return trimmed ? trimmed : uncategorizedKey;
}

function summarize(entity: Entity) {
  if (!entity.canonicalSummary) return '';
  const plain = entity.canonicalSummary.replace(/<[^>]+>/g, '');
  return plain.length > 120 ? `${plain.slice(0, 117)}…` : plain;
}

export function EntityView() {
  const {
    entities,
    setEntities,
    selectedEntityId,
    setSelectedEntityId,
    searchQuery,
    setSearchQuery,
  } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<EntityCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null);

  const loadEntities = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await EntityOps.getAllEntities();
      setEntities(rows);
    } catch (error) {
      console.error('Failed to load entities', error);
    } finally {
      setLoading(false);
    }
  }, [setEntities]);

  const loadCategories = useCallback(async () => {
    try {
      const rows = await EntityOps.getEntityCategories();
      setCategories(rows);
    } catch (error) {
      console.error('Failed to load categories', error);
    }
  }, []);

  useEffect(() => {
    loadEntities().catch((error) => console.error(error));
    loadCategories().catch((error) => console.error(error));
  }, [loadEntities, loadCategories]);

  useEffect(() => {
    const reload = () => {
      loadEntities().catch((error) => console.error('Failed to reload entities', error));
      loadCategories().catch((error) => console.error('Failed to reload categories', error));
    };
    events.on('db:ready', reload);
    events.on('entity:entity-created', reload);
    events.on('entity:entity-updated', reload);
    events.on('entity:entity-deleted', reload);
    events.on('entity:category-created', reload);
    events.on('entity:category-updated', reload);
    events.on('entity:category-deleted', reload);
    return () => {
      events.off('db:ready', reload);
      events.off('entity:entity-created', reload);
      events.off('entity:entity-updated', reload);
      events.off('entity:entity-deleted', reload);
      events.off('entity:category-created', reload);
      events.off('entity:category-updated', reload);
      events.off('entity:category-deleted', reload);
    };
  }, [loadEntities, loadCategories]);

  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    categories.forEach((cat) => names.add(cat.name));
    entities.forEach((entity) => names.add(normalizeCategory(entity)));
    return ['all', ...Array.from(names).sort((a, b) => a.localeCompare(b))];
  }, [categories, entities]);

  const filteredEntities = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    return entities.filter((entity) => {
      if (selectedCategory !== 'all' && normalizeCategory(entity) !== selectedCategory) {
        return false;
      }
      if (!trimmedQuery) return true;
      const haystack = [entity.name, entity.canonicalSummary, entity.aliases.join(' ')].join(' ').toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [entities, searchQuery, selectedCategory]);

  const handleCreateEntity = useCallback(async (payload: NewEntityPayload) => {
    const created = await EntityOps.createEntity({
      category: payload.category,
      name: payload.name,
      aliases: payload.aliases ?? [],
      canonicalSummary: payload.summary ?? '',
    });
    await loadEntities();
    await loadCategories();
    setShowCreateModal(false);
    setSelectedEntityId(created.id);
  }, [loadCategories, loadEntities, setSelectedEntityId]);

  const handleUpdateEntity = useCallback(async (payload: NewEntityPayload & { id: string }) => {
    await EntityOps.updateEntity(payload.id, {
      name: payload.name,
      category: payload.category,
      aliases: payload.aliases ?? [],
      canonicalSummary: payload.summary ?? '',
    });
    await loadEntities();
    setEditingEntity(null);
  }, [loadEntities]);

  return (
    <div className="h-full flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-lg font-semibold">实体库</h1>
          <p className="text-sm text-neutral-500">管理角色、地点、组织等设定。</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={16} /> 新建实体
        </button>
      </header>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索名称、简介或别名"
            className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {categoryOptions.map((option) => (
            <button
              key={option}
              onClick={() => setSelectedCategory(option)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${selectedCategory === option
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
            >
              {option === 'all' ? '全部' : option === uncategorizedKey ? '未分类' : option}
            </button>
          ))}
        </div>
      </div>

      <section className="flex-1 overflow-auto rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        {loading && (
          <div className="py-10 text-center text-sm text-neutral-500">加载中…</div>
        )}
        {!loading && filteredEntities.length === 0 && (
          <div className="py-10 text-center text-sm text-neutral-500">暂无符合条件的实体</div>
        )}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredEntities.map((entity) => {
            const category = normalizeCategory(entity);
            const Icon = getCategoryIcon(category);
            const colorClass = getCategoryColor(category);
            return (
              <article
                key={entity.id}
                className={`group cursor-pointer rounded-xl border bg-white p-4 transition hover:-translate-y-0.5 hover:shadow ${selectedEntityId === entity.id ? 'border-blue-400 shadow' : 'border-neutral-200'
                  } ${colorClass}`}
                onClick={() => setSelectedEntityId(entity.id)}
              >
                <header className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Icon size={16} />
                      <span className="text-xs uppercase tracking-wide text-neutral-600">
                        {category === uncategorizedKey ? '未分类' : category}
                      </span>
                    </div>
                    <h2 className="mt-2 text-base font-semibold text-neutral-900">{entity.name}</h2>
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingEntity(entity);
                    }}
                    className="rounded-full p-1 text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800"
                    aria-label="编辑实体"
                  >
                    <PenSquare size={16} />
                  </button>
                </header>
                {entity.aliases.length > 0 && (
                  <div className="mt-3 text-xs text-neutral-600">
                    别名：{entity.aliases.slice(0, 3).join('、')}
                  </div>
                )}
                {entity.canonicalSummary && (
                  <p className="mt-3 text-sm text-neutral-700">{summarize(entity)}</p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {showCreateModal && (
        <EntityCreateModal
          categories={categoryOptions.filter((option) => option !== 'all')}
          defaultCategory={selectedCategory !== 'all' ? selectedCategory : undefined}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateEntity}
          renderCategoryLabel={(value) => (value === uncategorizedKey ? '未分类' : value)}
        />
      )}

      {editingEntity && (
        <EntityEditModal
          entity={editingEntity}
          categories={categoryOptions.filter((option) => option !== 'all')}
          onClose={() => setEditingEntity(null)}
          onSubmit={async (payload) => {
            await handleUpdateEntity(payload);
            setSelectedEntityId(payload.id);
          }}
          renderCategoryLabel={(value) => (value === uncategorizedKey ? '未分类' : value)}
        />
      )}
    </div>
  );
}
