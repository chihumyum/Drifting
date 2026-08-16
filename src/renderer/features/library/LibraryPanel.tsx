import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Link2Off, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { useAuthStore } from '../../store/auth';
import { useLibraryItem } from '../../usecase/useLibraryItem';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import type { LibraryItem } from '../../domain/library-item';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { assetStoreService } from '../../services/asset-store.service';
import { platform } from '../../platform';
import { FilterChip } from '../../components/ui/FilterChip';
import { EmptyState } from '../../components/ui/EmptyState';
import { LibraryItemCard } from './LibraryItemCard';
import { ComposeLibraryItemDialog } from './LibraryDialogs';
import { LibraryItemFullscreenPreview, TextSnippetPopover } from './LibraryItemPreview';

export interface FocusedEntity {
  kind: EntityKind | null;
  id: string | null;
}

interface Props {
  /** The currently-focused entity (for the "仅当前条目相关" filter mode). */
  focused: FocusedEntity;
}

type ViewFilter = 'all' | 'related';

/**
 * Right-sidebar Library panel. Renders library_item rows (formerly material)
 * covering image / pdf / url / text references and free-form notes.
 *
 * Image / pdf hand off to the OS default app; url opens externally; text
 * opens an inline snippet popover that can escalate to fullscreen.
 *
 * The `related` filter narrows the list to items whose entity_relation row
 * points at `focused`. The relations toggle hides/shows relation chips
 * across all cards.
 *
 * TODOs live in the sibling TodoPanel, not here.
 */
export function LibraryPanel({ focused }: Props) {
  const { t } = useTranslation();
  const { projectId } = useWorkspaceNavigator();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const libraryItems = useDataStore((s) => s.libraryItems);
  const entityRelations = useDataStore((s) => s.entityRelations);
  const genericRelationTypeId = genericAssociationRelationTypeId(projectId);
  const genericRelations = useMemo(
    () =>
      entityRelations.filter(
        (relation) => relation.relationTypeId === genericRelationTypeId,
      ),
    [entityRelations, genericRelationTypeId],
  );
  const projectAssets = useDataStore((s) => s.projectAssets);

  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [filter, setFilter] = useState<ViewFilter>('all');
  const [showRelations, setShowRelations] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewLibraryItemId, setPreviewLibraryItemId] = useState<string | null>(null);
  // Two-stage preview for text snippets: clicking the inline body opens this
  // popover first; the popover itself escalates to the fullscreen preview.
  // Mirrors StoryGraphView's NodeCardPopover default → upgrade flow.
  const [textPopoverId, setTextPopoverId] = useState<string | null>(null);

  // Index entityRelations by from-entity so cards can render their relation
  // chips and the filter can pick out items related to `focused`.
  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof genericRelations>();
    genericRelations.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [genericRelations]);

  const isRelatedToFocus = useCallback(
    (kind: EntityKind, id: string) => {
      if (!focused.kind || !focused.id) return true;
      const refs = refsByFrom.get(`${kind}:${id}`) ?? [];
      return refs.some((r) => r.toKind === focused.kind && r.toId === focused.id);
    },
    [refsByFrom, focused.kind, focused.id],
  );

  const filteredLibraryItems = useMemo(() => {
    return libraryItems.filter(
      (mat) => filter !== 'related' || isRelatedToFocus('library_item', mat.id),
    );
  }, [libraryItems, filter, isRelatedToFocus]);

  const previewLibraryItem = useMemo(
    () => libraryItems.find((mat) => mat.id === previewLibraryItemId) ?? null,
    [libraryItems, previewLibraryItemId],
  );

  const textPopoverLibraryItem = useMemo(
    () => libraryItems.find((mat) => mat.id === textPopoverId) ?? null,
    [libraryItems, textPopoverId],
  );

  const openLibraryItemInSystem = async (m: LibraryItem) => {
    // text snippets are edited inline on the card — no popover / OS hand-off.
    if (m.kind === 'text') return;
    if (m.kind === 'url') {
      await platform.material.openExternal(m.externalUrl);
      return;
    }
    const asset = projectAssets.find((item) => item.id === m.assetId);
    if (!asset) return;
    let path: string;
    try {
      path = (await assetStoreService.requireVariant(projectId, asset, 'source')).filePath;
    } catch (error) {
      alert(t('memoMaterial.error.openFile', { error: String(error) }));
      return;
    }
    const res = await platform.material.openLocal(path);
    if (!res.ok) {
      alert(t('memoMaterial.error.openFile', { error: res.error }));
    }
  };

  const openLibraryItemInApp = (m: LibraryItem) => {
    if (m.kind === 'url') {
      void openLibraryItemInSystem(m);
      return;
    }
    if (m.kind === 'text') {
      // First stage of the two-step preview — open the floating popover
      // instead of jumping straight to fullscreen. The popover renders a
      // 全屏 ↗ control that does the actual escalation.
      setTextPopoverId(m.id);
      return;
    }
    setPreviewLibraryItemId(m.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        focusedKind={focused.kind}
        onCompose={() => setComposeOpen(true)}
        libraryItemTotal={libraryItems.length}
        showRelations={showRelations}
        onToggleShowRelations={() => setShowRelations((v) => !v)}
      />

      <div
        className="scroll-no-bar workspace-list"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 12px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {filteredLibraryItems.length === 0 && (
          <EmptyState
            density="compact"
            message={
              filter === 'related'
                ? t('memoMaterial.empty.noRelated')
                : t('memoMaterial.empty.noMaterials')
            }
          />
        )}

        {filteredLibraryItems.map((mat) => (
          <LibraryItemCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`library_item:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            showRelations={showRelations}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpenInSystem={() => openLibraryItemInSystem(mat)}
            onOpenInApp={() => openLibraryItemInApp(mat)}
            onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
            onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => {
              const ref = genericRelations.find(
                (r) =>
                  r.fromKind === 'library_item' &&
                  r.fromId === mat.id &&
                  r.toKind === t.kind &&
                  r.toId === t.id,
              );
              if (ref) relationUsecases.removeRelation(ref.id);
            }}
          />
        ))}
      </div>

      {composeOpen && (
        <ComposeLibraryItemDialog
          focused={focused}
          onCancel={() => setComposeOpen(false)}
          onCreate={async (input, relations) => {
            const mat = await libraryItemUsecases.createLibraryItem(input);
            const relationResults = await Promise.allSettled(
              relations.map((t) =>
                relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id),
              ),
            );
            const failedRelations = relationResults.filter(
              (result) => result.status === 'rejected',
            );
            if (failedRelations.length > 0) {
              console.warn(
                '[material] material created, but some relations failed:',
                failedRelations,
              );
            }
          }}
        />
      )}

      {previewLibraryItem && (
        <LibraryItemFullscreenPreview
          key={previewLibraryItem.id}
          material={previewLibraryItem}
          onClose={() => setPreviewLibraryItemId(null)}
          onUpdate={(updates) =>
            libraryItemUsecases.updateLibraryItem(previewLibraryItem.id, updates)
          }
        />
      )}

      {textPopoverLibraryItem && (
        <TextSnippetPopover
          key={textPopoverLibraryItem.id}
          material={textPopoverLibraryItem}
          onClose={() => setTextPopoverId(null)}
          onExpand={() => {
            setTextPopoverId(null);
            setPreviewLibraryItemId(textPopoverLibraryItem.id);
          }}
          onUpdate={(updates) =>
            libraryItemUsecases.updateLibraryItem(textPopoverLibraryItem.id, updates)
          }
        />
      )}
    </div>
  );
}


function Toolbar({
  filter,
  onFilterChange,
  focusedKind,
  onCompose,
  libraryItemTotal,
  showRelations,
  onToggleShowRelations,
}: {
  filter: ViewFilter;
  onFilterChange: (f: ViewFilter) => void;
  focusedKind: EntityKind | null;
  onCompose: () => void;
  libraryItemTotal: number;
  showRelations: boolean;
  onToggleShowRelations: () => void;
}) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // Two-step compaction:
  //   showCount goes off first (~ 230px) — least informational signal.
  //   compact (short pill labels) flips a bit later (~ 200px).
  const [showCount, setShowCount] = useState(true);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const update = () => {
      const w = node.clientWidth;
      setShowCount(w >= 230);
      setCompact(w < 200);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={toolbarRef}
      className="workspace-panel-header-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: '12px 10px',
        gap: 6,
        flexShrink: 0,
        // Pin the toolbar to the top of the scroll container so the filter
        // chips + "+" button don't slide away when the cards list scrolls.
        position: 'sticky',
        top: 0,
        zIndex: 4,
        background: 'var(--workspace-ui-bg)',
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <FilterPill active={filter === 'all'} onClick={() => onFilterChange('all')}>
          {compact ? t('memoMaterial.toolbar.allShort') : t('memoMaterial.toolbar.all')}
        </FilterPill>
        <FilterPill
          active={filter === 'related'}
          disabled={!focusedKind}
          onClick={() => onFilterChange('related')}
        >
          {compact ? t('memoMaterial.toolbar.currentShort') : t('memoMaterial.toolbar.current')}
        </FilterPill>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.08em',
        }}
      >
        {showCount && <span>{t('memoMaterial.toolbar.count', { count: libraryItemTotal })}</span>}
        <button
          onClick={onToggleShowRelations}
          title={
            showRelations
              ? t('memoMaterial.toolbar.hideRelations')
              : t('memoMaterial.toolbar.showRelations')
          }
          aria-pressed={showRelations}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            border: 'none',
            background: 'transparent',
            color: showRelations ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
            cursor: 'pointer',
            padding: 0,
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {showRelations ? (
            <Link2 size={12} strokeWidth={1.6} />
          ) : (
            <Link2Off size={12} strokeWidth={1.6} />
          )}
        </button>
        <button
          onClick={onCompose}
          title={t('memoMaterial.toolbar.newMaterial')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            padding: 0,
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            e.currentTarget.style.color = 'hsl(var(--ink-1))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'hsl(var(--ink-4))';
          }}
        >
          <Plus size={12} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

export function FilterPill({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <FilterChip
      size="sm"
      active={active}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </FilterChip>
  );
}
