import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';
import {
  createInlineMentionRepository,
  type InlineMentionBacklink,
  type InlineMentionRecord,
} from '../../sqlite-repo/inline-mention-repo';
import type { EntityKind, StructuralEntityKind } from '../../domain/entity-kinds';
import { useDataStore } from '../../store/data-store';
import { useAuthStore } from '../../store/auth';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';
import { RelationTypeField } from '../ui/RelationTypeField';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { validateRelationAgainstType } from '../../domain/entity-relation-type';

const log = loglevel.getLogger('ReferencesPanel');
log.setLevel(loglevel.levels.ERROR);

type ReferencesSection = 'relations' | 'incoming' | 'outgoing';

interface ReferencesPanelProps {
  // The entity this panel is showing references for. Both directions are
  // queried — incoming (backlinks) and outgoing (mentions in this entity's
  // content) — plus manual whole-entity relations.
  entityKind: EntityKind;
  entityId: string;
  projectId: string;
  /** Which sections to render, in this order. Default: all three. Lets the
   *  editor keep just 关联 while the stats sidebar hosts 被引用/引用其他. */
  sections?: ReferencesSection[];
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
  // Free-form relation category (e.g. 「宿敌」). Editable inline on the card.
  kind: string | null;
  relationTypeId: string | null;
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

export function ReferencesPanel({
  entityKind,
  entityId,
  projectId,
  sections = ['relations', 'incoming', 'outgoing'],
}: ReferencesPanelProps) {
  const { t } = useTranslation();
  const { navigateToNode, navigateToElement, navigateToCategory, navigateToStoryline } =
    useProjectNavigation();
  const {
    bookElements,
    bookNodes,
    bookElementCategories,
    storylines,
    entityRelations,
    entityRelationTypes,
  } = useDataStore();
  const userId = useAuthStore((s) => s.user?.id);
  // Mutations route through the usecase (store + optimistic + server sync) — the
  // raw repo path used previously skipped both, so panel-authored relations never
  // reached the story-graph or the server.
  const { addRelation, removeRelation, updateRelationType } = useEntityRelations({
    projectId,
    userId: userId ?? '',
  });

  // Inline mention rows for this entity (both directions). Manual relations are
  // derived reactively from the store's `entityRelations` below — so add / remove
  // / kind edits reflect immediately and stay in sync with graph + server.
  const [inlineBacklinks, setInlineBacklinks] = useState<InlineMentionBacklink[]>([]);
  const [inlineOutgoing, setInlineOutgoing] = useState<InlineMentionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerFilter, setPickerFilter] = useState<'all' | EntityKind>('all');
  const [pendingCandidate, setPendingCandidate] = useState<{
    kind: StructuralEntityKind;
    id: string;
    name: string;
  } | null>(null);
  const [pendingTypeId, setPendingTypeId] = useState<string | null>(null);
  const [pendingReversed, setPendingReversed] = useState(false);
  const reloadGenerationRef = useRef(0);

  useEffect(() => {
    reloadGenerationRef.current += 1;
  }, [entityKind, entityId]);

  const loadReferences = useCallback(
    async (targetKind: EntityKind, targetId: string, shouldApply: () => boolean = () => true) => {
      if (!targetId) return;
      try {
        const mentionRepo = createInlineMentionRepository();
        // Inline mentions are constrained to structural target kinds, so skip
        // the inline queries when the panel is open on a memo / material (they
        // never appear as inline-mention targets anyway).
        const isStructural =
          targetKind === 'node' ||
          targetKind === 'element' ||
          targetKind === 'patch' ||
          targetKind === 'category' ||
          targetKind === 'storyline';
        const [ibl, iout] = await Promise.all([
          isStructural
            ? mentionRepo.listBacklinksToTarget(targetKind, targetId)
            : Promise.resolve([] as InlineMentionBacklink[]),
          isStructural
            ? mentionRepo.listMentionsFromSource(targetKind, targetId)
            : Promise.resolve([] as InlineMentionRecord[]),
        ]);
        if (!shouldApply()) return;
        setInlineBacklinks(ibl);
        setInlineOutgoing(iout);
      } catch (error) {
        log.error('Failed to load references:', error);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const reload = useCallback(async () => {
    const generation = reloadGenerationRef.current;
    await loadReferences(entityKind, entityId, () => reloadGenerationRef.current === generation);
  }, [entityKind, entityId, loadReferences]);

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
    if (kind === 'element')
      return bookElements.find((e) => e.id === id)?.name ?? t('referencesPanel.deleted.element');
    if (kind === 'node')
      return bookNodes.find((n) => n.id === id)?.title ?? t('referencesPanel.deleted.node');
    if (kind === 'category')
      return (
        bookElementCategories.find((cat) => cat.id === id)?.name ??
        t('referencesPanel.deleted.category')
      );
    if (kind === 'storyline')
      return (
        storylines.find((storyline) => storyline.id === id)?.name ??
        t('referencesPanel.deleted.storyline')
      );
    return '(patch)';
  };

  const labelForKind = (kind: EntityKind): string => {
    if (kind === 'element') return t('referencesPanel.kind.element');
    if (kind === 'node') return t('referencesPanel.kind.node');
    if (kind === 'category') return t('referencesPanel.kind.category');
    if (kind === 'storyline') return t('referencesPanel.kind.storyline');
    return t('referencesPanel.kind.patch');
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

  // User-curated relations on either side, derived from the store and keyed by
  // the *other* entity. Reactive: a usecase mutation re-renders this list.
  const manualRelations: ManualRelation[] = useMemo(() => {
    const result: ManualRelation[] = [];
    for (const r of entityRelations) {
      const isFrom = r.fromKind === entityKind && r.fromId === entityId;
      const isTo = r.toKind === entityKind && r.toId === entityId;
      if (!isFrom && !isTo) continue;
      // A self-relation lands on both sides; show it once (as outgoing).
      if (isFrom) {
        result.push({
          id: r.id,
          otherKind: r.toKind,
          otherId: r.toId,
          otherTitle: lookupTitle(r.toKind, r.toId),
          kind: r.kind ?? null,
          relationTypeId: r.relationTypeId ?? null,
          direction: 'outgoing',
        });
      } else {
        result.push({
          id: r.id,
          otherKind: r.fromKind,
          otherId: r.fromId,
          otherTitle: lookupTitle(r.fromKind, r.fromId),
          kind: r.kind ?? null,
          relationTypeId: r.relationTypeId ?? null,
          direction: 'incoming',
        });
      }
    }
    // Newest first — uuidv7 ids are time-ordered, so a descending id sort
    // surfaces the most recently added relation at the top of the grid.
    result.sort((a, b) => (a.id < b.id ? 1 : -1));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entityRelations,
    entityKind,
    entityId,
    bookElements,
    bookElementCategories,
    bookNodes,
    storylines,
  ]);

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

  const configuredRelationTypes = useMemo(
    () => entityRelationTypes.filter((type) => type.orientation !== 'unconfigured'),
    [entityRelationTypes],
  );
  const pendingTypeOptions = useMemo(() => {
    if (!pendingCandidate) return configuredRelationTypes;
    const fromKind = pendingReversed ? pendingCandidate.kind : entityKind;
    const toKind = pendingReversed ? entityKind : pendingCandidate.kind;
    if (!isStructuralEntityKind(toKind)) return [];
    return configuredRelationTypes.filter(
      (type) =>
        validateRelationAgainstType(
          type,
          { fromKind, fromId: 'from', toKind, toId: 'to' },
          { allowUnconfigured: false },
        ).ok,
    );
  }, [configuredRelationTypes, entityKind, pendingCandidate, pendingReversed]);

  const relationTypeColor = (name: string) => {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return `hsl(var(--story-${(Math.abs(hash) % 6) + 1}))`;
  };

  const handleNavigate = (kind: EntityKind, id: string) => {
    if (kind === 'element') navigateToElement(id);
    else if (kind === 'node') navigateToNode(id);
    else if (kind === 'category') navigateToCategory(id);
    else if (kind === 'storyline') navigateToStoryline(id);
  };

  const handleAddManual = async () => {
    if (!pendingCandidate || !pendingTypeId) return;
    try {
      const fromKind = pendingReversed ? pendingCandidate.kind : entityKind;
      const fromId = pendingReversed ? pendingCandidate.id : entityId;
      const toKind = pendingReversed ? entityKind : pendingCandidate.kind;
      const toId = pendingReversed ? entityId : pendingCandidate.id;
      if (!isStructuralEntityKind(toKind)) return;
      await addRelation(fromKind, fromId, toKind, toId, {
        relationTypeId: pendingTypeId,
        allowUnconfigured: false,
      });
      events.emit('references:changed', {
        projectId,
        fromKind,
        fromId,
        targetKeys: [`${toKind}:${toId}`],
      });
      setShowLinkPicker(false);
      setPickerQuery('');
      setPendingCandidate(null);
      setPendingTypeId(null);
      setPendingReversed(false);
    } catch (error) {
      log.error('Failed to add manual relation:', error);
    }
  };

  const handleRemoveManual = async (rel: ManualRelation) => {
    try {
      await removeRelation(rel.id);
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
    } catch (error) {
      log.error('Failed to remove manual relation:', error);
    }
  };

  const handleUpdateType = async (
    rel: ManualRelation,
    relationTypeId: string,
    swapEndpoints = false,
  ) => {
    try {
      await updateRelationType(rel.id, relationTypeId, {
        swapEndpoints,
        allowUnconfigured: false,
      });
    } catch (error) {
      log.error('Failed to update relation kind:', error);
    }
  };

  const manualRelationSemantics = (rel: ManualRelation, swapped = false) => {
    const fromKind = rel.direction === 'outgoing' ? entityKind : rel.otherKind;
    const fromId = rel.direction === 'outgoing' ? entityId : rel.otherId;
    const toKind = rel.direction === 'outgoing' ? rel.otherKind : entityKind;
    const toId = rel.direction === 'outgoing' ? rel.otherId : entityId;
    const semanticFromKind = swapped ? toKind : fromKind;
    const semanticFromId = swapped ? toId : fromId;
    const semanticToKind = swapped ? fromKind : toKind;
    const semanticToId = swapped ? fromId : toId;
    if (!isStructuralEntityKind(semanticToKind)) return null;
    return {
      fromKind: semanticFromKind,
      fromId: semanticFromId,
      toKind: semanticToKind,
      toId: semanticToId,
    };
  };

  const relationTypeOptionsFor = (rel: ManualRelation) =>
    configuredRelationTypes.filter((type) => {
      const direct = manualRelationSemantics(rel);
      const reversed = manualRelationSemantics(rel, true);
      return Boolean(
        (direct && validateRelationAgainstType(type, direct).ok) ||
        (reversed && validateRelationAgainstType(type, reversed).ok),
      );
    });

  const relationTypeNeedsSwap = (rel: ManualRelation, relationTypeId: string) => {
    const type = configuredRelationTypes.find((candidate) => candidate.id === relationTypeId);
    const direct = manualRelationSemantics(rel);
    if (!type || !direct) return false;
    return !validateRelationAgainstType(type, direct).ok;
  };

  const relationCanSwap = (rel: ManualRelation) => {
    const type = configuredRelationTypes.find((candidate) => candidate.id === rel.relationTypeId);
    const reversed = manualRelationSemantics(rel, true);
    return Boolean(
      type?.orientation === 'directed' &&
      reversed &&
      validateRelationAgainstType(type, reversed).ok,
    );
  };

  if (loading) {
    return <div className="refs-loading">{t('referencesPanel.loading')}</div>;
  }

  const kindClass = (kind: EntityKind) => `refs-kind-${kind}`;

  return (
    <div className="references-panel">
      {/* 关联 — manual whole-entity links */}
      {sections.includes('relations') && (
        <section className="refs-section">
          <div className="refs-section__header">
            <span className="refs-section__title">{t('referencesPanel.sections.relations')}</span>
            <span className="refs-section__count">{manualRelations.length}</span>
            <button
              type="button"
              onClick={() => setShowLinkPicker((v) => !v)}
              className="refs-section__action"
            >
              {showLinkPicker ? t('common.cancel') : t('referencesPanel.actions.add')}
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
                    {f === 'all' ? t('referencesPanel.filters.all') : labelForKind(f)}
                  </button>
                ))}
              </div>
              <input
                type="text"
                autoFocus
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder={t('referencesPanel.picker.placeholder')}
                className="refs-picker__input"
              />
              {pendingCandidate && (
                <div className="refs-picker__relation-type">
                  <div className="refs-picker__selected-target">{pendingCandidate.name}</div>
                  <button
                    type="button"
                    className="relation-endpoint-swap"
                    disabled={!isStructuralEntityKind(entityKind)}
                    onClick={() => {
                      if (!isStructuralEntityKind(entityKind)) return;
                      setPendingReversed((value) => !value);
                      setPendingTypeId(null);
                    }}
                  >
                    {pendingReversed
                      ? t('relationTypes.pendingIncoming')
                      : t('relationTypes.pendingOutgoing')}{' '}
                    · ⇄
                  </button>
                  <RelationTypeField
                    value={pendingTypeId}
                    onChange={setPendingTypeId}
                    options={pendingTypeOptions}
                    resolveOptionColor={relationTypeColor}
                    placeholder={t('relationTypes.selectConfigured')}
                    ariaLabel={t('relationTypes.ariaLabel')}
                    buttonClassName="relation-type-field__button relation-type-field__button--full"
                  />
                  <button
                    type="button"
                    className="refs-section__action"
                    disabled={!pendingTypeId}
                    onClick={() => void handleAddManual()}
                  >
                    {t('storyGraph.edge.create')}
                  </button>
                </div>
              )}
              <div className="refs-picker__list">
                {pickerCandidates.length === 0 ? (
                  <div className="refs-picker__empty">{t('referencesPanel.picker.empty')}</div>
                ) : (
                  pickerCandidates.map((c) => (
                    <button
                      key={`${c.kind}:${c.id}`}
                      type="button"
                      onClick={() => {
                        setPendingCandidate(c);
                        setPendingTypeId(null);
                        setPendingReversed(false);
                      }}
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

          <div className="refs-rel-grid">
            {manualRelations.map((rel) => (
              <div key={rel.id} className={`refs-rel-card ${kindClass(rel.otherKind)}`}>
                <div className="refs-rel-card__top">
                  <span className="refs-rel-card__kind">
                    <span className="refs-card__kind-dot" />
                    {labelForKind(rel.otherKind)}
                    <span className="refs-rel-card__dir">
                      {rel.direction === 'outgoing' ? '→' : '←'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemoveManual(rel)}
                    className="refs-rel-card__remove"
                    aria-label={t('referencesPanel.actions.remove')}
                  >
                    ×
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => handleNavigate(rel.otherKind, rel.otherId)}
                  className="refs-rel-card__title"
                  title={t('referencesPanel.actions.jump')}
                >
                  {rel.otherTitle}
                </button>
                <div className="refs-rel-card__type-row">
                  <RelationTypeField
                    value={rel.relationTypeId}
                    onChange={(relationTypeId) =>
                      void handleUpdateType(
                        rel,
                        relationTypeId,
                        relationTypeNeedsSwap(rel, relationTypeId),
                      )
                    }
                    options={relationTypeOptionsFor(rel)}
                    resolveOptionColor={relationTypeColor}
                    placeholder={rel.kind || t('referencesPanel.relationKind.empty')}
                    ariaLabel={t('storyGraph.edge.kindLabel')}
                    buttonClassName="refs-rel-card__tag relation-type-field__button"
                  />
                  {rel.relationTypeId && relationCanSwap(rel) && (
                    <button
                      type="button"
                      className="refs-rel-card__swap"
                      title={t('relationTypes.swap')}
                      onClick={() => void handleUpdateType(rel, rel.relationTypeId!, true)}
                    >
                      ⇄
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setShowLinkPicker(true)}
              className="refs-rel-card refs-rel-card--add"
            >
              {t('referencesPanel.actions.linkEntity')}
            </button>
          </div>
        </section>
      )}

      {/* 被引用 — incoming inline mentions */}
      {sections.includes('incoming') && (
        <section className="refs-section">
          <div className="refs-section__header">
            <span className="refs-section__title">{t('referencesPanel.sections.incoming')}</span>
            <span className="refs-section__count">{incomingGroups.length}</span>
          </div>
          {incomingGroups.length === 0 ? (
            <div className="refs-empty">{t('referencesPanel.empty.incoming')}</div>
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
                    {t('referencesPanel.meta.blocksSpans', {
                      blocks: g.blockCount,
                      spans: g.spanCount,
                    })}
                  </span>
                  <span className="refs-card__arrow">↗</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 引用其他 — outgoing inline mentions (element only) */}
      {sections.includes('outgoing') && entityKind === 'element' && (
        <section className="refs-section">
          <div className="refs-section__header">
            <span className="refs-section__title">{t('referencesPanel.sections.outgoing')}</span>
            <span className="refs-section__count">{outgoingGroups.length}</span>
          </div>
          {outgoingGroups.length === 0 ? (
            <div className="refs-empty">{t('referencesPanel.empty.outgoing')}</div>
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
                  <span className="refs-card__meta">
                    {t('referencesPanel.meta.spans', { count: g.spanCount })}
                  </span>
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
