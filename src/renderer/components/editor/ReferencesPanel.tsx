import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';
import {
  createInlineMentionRepository,
  type InlineMentionBacklink,
  type InlineMentionRecord,
} from '../../sqlite-repo/inline-mention-repo';
import {
  createEntityRelationRepository,
  type EntityRelationBacklink,
  type EntityRelationRecord,
} from '../../sqlite-repo/entity-relation-repo';
import type { EntityKind, StructuralEntityKind } from '../../domain/entity-kinds';
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

  // Incoming inline mentions + manual relations to this entity.
  const [inlineBacklinks, setInlineBacklinks] = useState<InlineMentionBacklink[]>([]);
  const [relationBacklinks, setRelationBacklinks] = useState<EntityRelationBacklink[]>([]);
  // Outgoing inline mentions + manual relations from this entity.
  const [inlineOutgoing, setInlineOutgoing] = useState<InlineMentionRecord[]>([]);
  const [relationOutgoing, setRelationOutgoing] = useState<EntityRelationRecord[]>([]);
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
        const mentionRepo = createInlineMentionRepository();
        const relationRepo = createEntityRelationRepository();
        // Inline mentions are constrained to structural target kinds, so skip
        // the inline queries when the panel is open on a memo / material (they
        // never appear as inline-mention targets anyway).
        const isStructural =
          targetKind === 'node' ||
          targetKind === 'element' ||
          targetKind === 'patch' ||
          targetKind === 'category' ||
          targetKind === 'storyline';
        const [ibl, rbl, iout, rout] = await Promise.all([
          isStructural
            ? mentionRepo.listBacklinksToTarget(targetKind, targetId)
            : Promise.resolve([] as InlineMentionBacklink[]),
          isStructural
            ? relationRepo.listBacklinksToTarget(targetKind, targetId)
            : Promise.resolve([] as EntityRelationBacklink[]),
          isStructural
            ? mentionRepo.listMentionsFromSource(targetKind, targetId)
            : Promise.resolve([] as InlineMentionRecord[]),
          relationRepo.listRelationsFromSource(targetKind, targetId),
        ]);
        if (!shouldApply()) return;
        setInlineBacklinks(ibl);
        setRelationBacklinks(rbl);
        setInlineOutgoing(iout);
        setRelationOutgoing(rout);
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
    for (const row of inlineBacklinks) {
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
  }, [inlineBacklinks, bookElements, bookElementCategories, bookNodes, storylines]);

  // Aggregate outgoing inline mentions by (toKind, toId).
  const outgoingGroups: OutgoingGroup[] = useMemo(() => {
    const map = new Map<string, OutgoingGroup>();
    for (const row of inlineOutgoing) {
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
  }, [inlineOutgoing, bookElements, bookElementCategories, bookNodes, storylines]);

  // User-curated relations on either side, keyed by the *other* entity.
  const manualRelations: ManualRelation[] = useMemo(() => {
    const result: ManualRelation[] = [];
    for (const row of relationBacklinks) {
      result.push({
        id: row.id,
        otherKind: row.fromKind,
        otherId: row.fromId,
        otherTitle: row.fromTitle || lookupTitle(row.fromKind, row.fromId),
        direction: 'incoming',
      });
    }
    for (const row of relationOutgoing) {
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
  }, [relationBacklinks, relationOutgoing, bookElements, bookElementCategories, bookNodes, storylines]);

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

  const handleAddManual = async (otherKind: StructuralEntityKind, otherId: string) => {
    try {
      const relationRepo = createEntityRelationRepository();
      // Convention: panel entity is the from-side of a relation it owns. So
      // "+ Link" inside element X's panel produces (from=element X,
      // to=otherKind/otherId).
      await relationRepo.addRelation(projectId, entityKind, entityId, otherKind, otherId);
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
      const relationRepo = createEntityRelationRepository();
      await relationRepo.removeRelation(rel.id);
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
    return <div className="refs-loading">加载中…</div>;
  }

  const kindClass = (kind: EntityKind) => `refs-kind-${kind}`;

  return (
    <div className="references-panel">
      {/* 三 · 关联 — manual whole-entity links */}
      <section className="refs-section">
        <div className="refs-section__header">
          <span className="refs-section__num">三</span>
          <span className="refs-section__title">关联</span>
          <span className="refs-section__count">{manualRelations.length}</span>
          <button
            type="button"
            onClick={() => setShowLinkPicker((v) => !v)}
            className="refs-section__action"
          >
            {showLinkPicker ? '取消' : '＋ 新增'}
          </button>
        </div>

        {showLinkPicker && (
          <div className="refs-picker">
            <div className="refs-picker__filters">
              {(['all', 'element', 'node', 'category', 'storyline'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setPickerFilter(f)}
                  className={`refs-picker__filter${
                    pickerFilter === f ? ' refs-picker__filter--active' : ''
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
              placeholder="搜索可关联的实体…"
              className="refs-picker__input"
            />
            <div className="refs-picker__list">
              {pickerCandidates.length === 0 ? (
                <div className="refs-picker__empty">— 没有可选项 —</div>
              ) : (
                pickerCandidates.map((c) => (
                  <button
                    key={`${c.kind}:${c.id}`}
                    type="button"
                    // eslint-disable-next-line react-hooks/refs
                    onClick={() => handleAddManual(c.kind, c.id)}
                    className="refs-picker__item"
                  >
                    <span className={`refs-picker__item-kind ${kindClass(c.kind)}`}>
                      <span className="refs-card__kind-dot" />
                      {labelForKind(c.kind)}
                    </span>
                    <span className="refs-picker__item-name">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {manualRelations.length === 0 && !showLinkPicker ? (
          <div className="refs-chips">
            <button
              type="button"
              onClick={() => setShowLinkPicker(true)}
              className="refs-chip refs-chip--add"
            >
              <span className="refs-chip__name">＋ 关联一个实体…</span>
            </button>
          </div>
        ) : (
          manualRelations.length > 0 && (
            <div className="refs-chips">
              {manualRelations.map((rel) => (
                <div
                  key={rel.id}
                  className={`refs-chip ${kindClass(rel.otherKind)}`}
                  onClick={() => handleNavigate(rel.otherKind, rel.otherId)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="refs-chip__dot" />
                  <span className="refs-chip__name">{rel.otherTitle}</span>
                  <span className="refs-chip__dir">
                    {rel.direction === 'outgoing' ? '→' : '←'}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRemoveManual(rel);
                    }}
                    className="refs-chip__remove"
                    aria-label="移除关联"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </section>

      {/* 四 · 被引用 — incoming inline mentions */}
      <section className="refs-section">
        <div className="refs-section__header">
          <span className="refs-section__num">四</span>
          <span className="refs-section__title">被引用</span>
          <span className="refs-section__count">{incomingGroups.length}</span>
        </div>
        {incomingGroups.length === 0 ? (
          <div className="refs-empty">— 尚未被任何内容引用 —</div>
        ) : (
          <div className="refs-cards">
            {incomingGroups.map((g) => (
              <div
                key={g.key}
                onClick={() => handleNavigate(g.fromKind, g.fromId)}
                className="refs-card"
                role="button"
                tabIndex={0}
              >
                <span className={`refs-card__kind ${kindClass(g.fromKind)}`}>
                  <span className="refs-card__kind-dot" />
                  {labelForKind(g.fromKind)}
                </span>
                <span className="refs-card__title">{g.fromTitle}</span>
                <span className="refs-card__meta">
                  {g.blockCount} 处 · {g.spanCount} 次
                </span>
                <span className="refs-card__arrow">↗</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 五 · 引用其他 — outgoing inline mentions (element only) */}
      {entityKind === 'element' && (
        <section className="refs-section">
          <div className="refs-section__header">
            <span className="refs-section__num">五</span>
            <span className="refs-section__title">引用其他</span>
            <span className="refs-section__count">{outgoingGroups.length}</span>
          </div>
          {outgoingGroups.length === 0 ? (
            <div className="refs-empty">— 正文中尚未引用其他实体 —</div>
          ) : (
            <div className="refs-cards">
              {outgoingGroups.map((g) => (
                <div
                  key={g.key}
                  onClick={() => handleNavigate(g.toKind, g.toId)}
                  className="refs-card"
                  role="button"
                  tabIndex={0}
                >
                  <span className={`refs-card__kind ${kindClass(g.toKind)}`}>
                    <span className="refs-card__kind-dot" />
                    {labelForKind(g.toKind)}
                  </span>
                  <span className="refs-card__title">{g.toTitle}</span>
                  <span className="refs-card__meta">{g.spanCount} 次</span>
                  <span className="refs-card__arrow">↗</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
