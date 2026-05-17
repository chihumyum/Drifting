import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';
import {
  createReferenceRepository,
  type BacklinkRecord,
  type EntityKind,
  type EntityReferenceRecord,
} from '../../sqlite-repo/reference-repo';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('ReferencesPanel');
log.setLevel(loglevel.levels.ERROR);

interface ReferencesPanelProps {
  // The entity this panel is showing references for. Both directions are
  // queried — incoming (backlinks) and outgoing (mentions in this entity's
  // content) — plus manual whole-entity relations.
  entityKind: EntityKind;
  entityId: string;
  projectId: string;
}

interface IncomingGroup {
  key: string;
  fromKind: EntityKind;
  fromId: string;
  fromTitle: string;
  blockCount: number;
  spanCount: number;
}

interface OutgoingGroup {
  key: string;
  toKind: EntityKind;
  toId: string;
  toTitle: string;
  spanCount: number;
}

interface ManualRelation {
  id: string;
  // Always rendered relative to the panel's entity — the "other" entity is
  // shown.
  otherKind: EntityKind;
  otherId: string;
  otherTitle: string;
  direction: 'outgoing' | 'incoming'; // panel entity is from or to
}

function safeParseSpans(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function ReferencesPanel({ entityKind, entityId, projectId }: ReferencesPanelProps) {
  const { navigateToNode, navigateToElement, navigateToCategory, navigateToStoryline } =
    useProjectNavigation();
  const { bookElements, bookNodes, bookElementCategories, storylines } = useDataStore();

  const [backlinks, setBacklinks] = useState<BacklinkRecord[]>([]);
  const [outgoing, setOutgoing] = useState<EntityReferenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerFilter, setPickerFilter] = useState<'all' | EntityKind>('all');
  const reloadGenerationRef = useRef(0);

  useEffect(() => {
    reloadGenerationRef.current += 1;
  }, [entityKind, entityId]);

  const loadReferences = useCallback(
    async (
      targetKind: EntityKind,
      targetId: string,
      shouldApply: () => boolean = () => true,
    ) => {
      if (!targetId) return;
      try {
        const repo = createReferenceRepository();
        const [b, o] = await Promise.all([
          repo.listBacklinksToTarget(targetKind, targetId),
          repo.listReferencesFromSource(targetKind, targetId),
        ]);
        if (!shouldApply()) return;
        setBacklinks(b);
        setOutgoing(o);
      } catch (error) {
        log.error('Failed to load references:', error);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const reload = useCallback(
    async () => {
      const generation = reloadGenerationRef.current;
      await loadReferences(
        entityKind,
        entityId,
        () => reloadGenerationRef.current === generation,
      );
    },
    [entityKind, entityId, loadReferences],
  );

  useEffect(() => {
    let cancelled = false;
    const generation = reloadGenerationRef.current;
    const timer = window.setTimeout(() => {
      void loadReferences(
        entityKind,
        entityId,
        () => !cancelled && reloadGenerationRef.current === generation,
      );
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [entityKind, entityId, loadReferences]);

  useEffect(() => {
    const handleReferencesChanged = (event: {
      projectId: string;
      fromKind?: EntityKind;
      fromId?: string;
      targetKeys?: string[];
    }) => {
      if (event.projectId !== projectId) return;
      void reload();
    };
    events.on('references:changed', handleReferencesChanged);
    return () => events.off('references:changed', handleReferencesChanged);
  }, [entityId, entityKind, projectId, reload]);

  // Title lookup from the in-memory store. Falls back to a generic label when
  // the entity is gone (deleted but reference row not yet cleaned up).
  const lookupTitle = (kind: EntityKind, id: string): string => {
    if (kind === 'element') return bookElements.find((e) => e.id === id)?.name ?? '(已删除元素)';
    if (kind === 'node') return bookNodes.find((n) => n.id === id)?.title ?? '(已删除章节)';
    if (kind === 'category')
      return bookElementCategories.find((cat) => cat.id === id)?.name ?? '(已删除分类)';
    if (kind === 'storyline')
      return storylines.find((storyline) => storyline.id === id)?.name ?? '(已删除故事线)';
    return '(patch)';
  };

  const labelForKind = (kind: EntityKind): string => {
    if (kind === 'element') return '元素';
    if (kind === 'node') return '章节';
    if (kind === 'category') return '分类';
    if (kind === 'storyline') return '故事线';
    return '补丁';
  };

  // Aggregate inline backlinks by (fromKind, fromId).
  const incomingGroups: IncomingGroup[] = useMemo(() => {
    const map = new Map<string, IncomingGroup>();
    for (const row of backlinks) {
      if (!row.fromBlockId) continue; // manual relations handled separately
      const key = `${row.fromKind}:${row.fromId}`;
      const spans = safeParseSpans(row.fromSpansJson).length || 1;
      const existing = map.get(key);
      if (existing) {
        existing.blockCount += 1;
        existing.spanCount += spans;
      } else {
        map.set(key, {
          key,
          fromKind: row.fromKind,
          fromId: row.fromId,
          fromTitle: row.fromTitle || lookupTitle(row.fromKind, row.fromId),
          blockCount: 1,
          spanCount: spans,
        });
      }
    }
    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backlinks, bookElements, bookElementCategories, bookNodes, storylines]);

  // Aggregate outgoing references by (toKind, toId).
  const outgoingGroups: OutgoingGroup[] = useMemo(() => {
    const map = new Map<string, OutgoingGroup>();
    for (const row of outgoing) {
      if (!row.fromBlockId) continue; // manual whole-entity outgoing handled separately
      const key = `${row.toKind}:${row.toId}`;
      const spans = safeParseSpans(row.fromSpansJson).length || 1;
      const existing = map.get(key);
      if (existing) {
        existing.spanCount += spans;
      } else {
        map.set(key, {
          key,
          toKind: row.toKind,
          toId: row.toId,
          toTitle: lookupTitle(row.toKind, row.toId),
          spanCount: spans,
        });
      }
    }
    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoing, bookElements, bookElementCategories, bookNodes, storylines]);

  // Manual whole-entity relations on either side, keyed by the *other* entity.
  const manualRelations: ManualRelation[] = useMemo(() => {
    const result: ManualRelation[] = [];
    // Manual relations where this entity is the target.
    for (const row of backlinks) {
      if (row.fromBlockId) continue;
      result.push({
        id: row.id,
        otherKind: row.fromKind,
        otherId: row.fromId,
        otherTitle: row.fromTitle || lookupTitle(row.fromKind, row.fromId),
        direction: 'incoming',
      });
    }
    // Manual relations where this entity is the source.
    for (const row of outgoing) {
      if (row.fromBlockId) continue;
      result.push({
        id: row.id,
        otherKind: row.toKind,
        otherId: row.toId,
        otherTitle: lookupTitle(row.toKind, row.toId),
        direction: 'outgoing',
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backlinks, outgoing, bookElements, bookElementCategories, bookNodes, storylines]);

  // Picker exclusion: only existing *manual* relations (and self). Inline
  // mentions don't block manual linking — the two are independent assertions
  // ("this content mentions X" vs "I declare a relation to X"), and conflating
  // them surprised users who saw the picker empty after mentioning everything.
  const linkedKeySet = useMemo(() => {
    const set = new Set<string>();
    manualRelations.forEach((m) => set.add(`${m.otherKind}:${m.otherId}`));
    set.add(`${entityKind}:${entityId}`);
    return set;
  }, [manualRelations, entityKind, entityId]);

  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const elements = bookElements
      .filter((el) => {
        const key = `element:${el.id}`;
        if (linkedKeySet.has(key)) return false;
        if (pickerFilter !== 'all' && pickerFilter !== 'element') return false;
        if (q && !el.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((el) => ({ kind: 'element' as const, id: el.id, name: el.name }));
    const nodes = bookNodes
      .filter((n) => {
        const key = `node:${n.id}`;
        if (linkedKeySet.has(key)) return false;
        if (pickerFilter !== 'all' && pickerFilter !== 'node') return false;
        if (q && !n.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((n) => ({ kind: 'node' as const, id: n.id, name: n.title }));
    const categories = bookElementCategories
      .filter((cat) => {
        const key = `category:${cat.id}`;
        if (linkedKeySet.has(key)) return false;
        if (pickerFilter !== 'all' && pickerFilter !== 'category') return false;
        if (q && !cat.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((cat) => ({ kind: 'category' as const, id: cat.id, name: cat.name }));
    const storylineCandidates = storylines
      .filter((storyline) => {
        const key = `storyline:${storyline.id}`;
        if (linkedKeySet.has(key)) return false;
        if (pickerFilter !== 'all' && pickerFilter !== 'storyline') return false;
        if (q && !storyline.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((storyline) => ({
        kind: 'storyline' as const,
        id: storyline.id,
        name: storyline.name,
      }));
    return [...elements, ...nodes, ...categories, ...storylineCandidates].slice(0, 50);
  }, [
    bookElementCategories,
    bookElements,
    bookNodes,
    linkedKeySet,
    pickerFilter,
    pickerQuery,
    storylines,
  ]);

  const handleNavigate = (kind: EntityKind, id: string) => {
    if (kind === 'element') navigateToElement(id);
    else if (kind === 'node') navigateToNode(id);
    else if (kind === 'category') navigateToCategory(id);
    else if (kind === 'storyline') navigateToStoryline(id);
  };

  const handleAddManual = async (otherKind: EntityKind, otherId: string) => {
    try {
      const repo = createReferenceRepository();
      // Convention: panel entity is the from-side of a manual relation it
      // owns. So "+ Link" inside element X's panel produces (from=element X,
      // to=otherKind/otherId).
      await repo.addManualRelation(projectId, entityKind, entityId, otherKind, otherId);
      events.emit('references:changed', {
        projectId,
        fromKind: entityKind,
        fromId: entityId,
        targetKeys: [`${otherKind}:${otherId}`],
      });
      setShowLinkPicker(false);
      setPickerQuery('');
      void reload();
    } catch (error) {
      log.error('Failed to add manual relation:', error);
    }
  };

  const handleRemoveManual = async (rel: ManualRelation) => {
    try {
      const repo = createReferenceRepository();
      if (rel.direction === 'outgoing') {
        await repo.removeManualRelation(entityKind, entityId, rel.otherKind, rel.otherId);
      } else {
        await repo.removeManualRelation(rel.otherKind, rel.otherId, entityKind, entityId);
      }
      events.emit('references:changed', {
        projectId,
        fromKind: rel.direction === 'outgoing' ? entityKind : rel.otherKind,
        fromId: rel.direction === 'outgoing' ? entityId : rel.otherId,
        targetKeys: [
          rel.direction === 'outgoing'
            ? `${rel.otherKind}:${rel.otherId}`
            : `${entityKind}:${entityId}`,
        ],
      });
      void reload();
    } catch (error) {
      log.error('Failed to remove manual relation:', error);
    }
  };

  if (loading) {
    return (
      <div className="references-panel p-4">
        <div className="text-sm text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="references-panel p-4 space-y-5">
      {/* Manual whole-entity links */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-300">手动关联 ({manualRelations.length})</h3>
          <button
            type="button"
            onClick={() => setShowLinkPicker((v) => !v)}
            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            {showLinkPicker ? '取消' : '+ 关联'}
          </button>
        </div>

        {showLinkPicker && (
          <div className="mb-3 p-2 bg-gray-800 rounded space-y-2">
            <div className="flex gap-1 text-xs">
              {(['all', 'element', 'node', 'category', 'storyline'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setPickerFilter(f)}
                  className={`px-2 py-1 rounded ${
                    pickerFilter === f
                      ? 'bg-gray-600 text-gray-100'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {f === 'all' ? '全部' : labelForKind(f)}
                </button>
              ))}
            </div>
            <input
              type="text"
              autoFocus
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="搜索..."
              className="w-full px-2 py-1 text-sm bg-gray-900 text-gray-100 rounded border border-gray-700 focus:border-gray-500 focus:outline-none"
            />
            <div className="max-h-60 overflow-y-auto">
              {pickerCandidates.length === 0 ? (
                <div className="text-xs text-gray-500 italic py-2">没有可选项</div>
              ) : (
                pickerCandidates.map((c) => (
                  <button
                    key={`${c.kind}:${c.id}`}
                    type="button"
                    // The click handler runs after render; it may trigger a
                    // reload guarded by a generation ref.
                    // eslint-disable-next-line react-hooks/refs
                    onClick={() => handleAddManual(c.kind, c.id)}
                    className="w-full text-left px-2 py-1 text-sm text-gray-200 hover:bg-gray-700 rounded flex items-center gap-2"
                  >
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                      {labelForKind(c.kind)}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {manualRelations.length === 0 ? (
          <div className="text-xs text-gray-500 italic">尚未手动关联任何实体</div>
        ) : (
          <div className="space-y-1">
            {manualRelations.map((rel) => (
              <div
                key={rel.id}
                className="flex items-center gap-2 p-2 bg-gray-800 hover:bg-gray-750 rounded text-sm group"
              >
                <span
                  onClick={() => handleNavigate(rel.otherKind, rel.otherId)}
                  className="flex-1 cursor-pointer truncate text-gray-200 group-hover:text-white"
                >
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 mr-2">
                    {labelForKind(rel.otherKind)}
                  </span>
                  {rel.otherTitle}
                  <span className="text-[10px] text-gray-500 ml-2">
                    {rel.direction === 'outgoing' ? '指向' : '来自'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveManual(rel)}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 text-xs transition-opacity"
                  aria-label="移除关联"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Incoming inline mentions */}
      <section>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">
          被引用 ({incomingGroups.length})
        </h3>
        {incomingGroups.length === 0 ? (
          <div className="text-xs text-gray-500 italic">尚未被任何内容引用</div>
        ) : (
          <div className="space-y-1">
            {incomingGroups.map((g) => (
              <div
                key={g.key}
                onClick={() => handleNavigate(g.fromKind, g.fromId)}
                className="p-2 bg-gray-800 hover:bg-gray-750 rounded cursor-pointer group"
              >
                <div className="flex items-center gap-2 text-sm text-gray-200 group-hover:text-white">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                    {labelForKind(g.fromKind)}
                  </span>
                  <span className="truncate flex-1">{g.fromTitle}</span>
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {g.blockCount} 处 / {g.spanCount} 次
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Outgoing inline mentions */}
      {entityKind === 'element' && (
        <section>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">
            引用其他 ({outgoingGroups.length})
          </h3>
          {outgoingGroups.length === 0 ? (
            <div className="text-xs text-gray-500 italic">本元素正文中尚未引用其他实体</div>
          ) : (
            <div className="space-y-1">
              {outgoingGroups.map((g) => (
                <div
                  key={g.key}
                  onClick={() => handleNavigate(g.toKind, g.toId)}
                  className="p-2 bg-gray-800 hover:bg-gray-750 rounded cursor-pointer group"
                >
                  <div className="flex items-center gap-2 text-sm text-gray-200 group-hover:text-white">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                      {labelForKind(g.toKind)}
                    </span>
                    <span className="truncate flex-1">{g.toTitle}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{g.spanCount} 次</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
