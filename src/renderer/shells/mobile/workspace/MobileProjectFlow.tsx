import { useMemo, type ReactNode } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { useProjectStore } from '../../../store/project-store';
import { useRecentEntitiesStore } from '../../../store/recent-entities-store';
import { useWritingStatsStore } from '../../../store/writing-stats-store';
import { canonicalWordCount, isChapter, isDrift, type BookNode } from '../../../domain/book-node';

const STORY_TOKENS = [
  '--story-1',
  '--story-2',
  '--story-3',
  '--story-4',
  '--story-5',
  '--story-6',
] as const;

function hashToToken(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i) * (i + 7)) >>> 0;
  return STORY_TOKENS[h % STORY_TOKENS.length];
}

function resolveColor(rawColor: string | undefined, fallbackKey: string): string {
  if (rawColor && rawColor.trim().length > 0) return rawColor;
  return `hsl(var(${hashToToken(fallbackKey)}))`;
}

const ROMAN = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
] as const;

function toRoman(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  let rest = Math.floor(n);
  let out = '';
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

function formatWords(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/u, '')}k`;
  return String(count);
}

/** Ownership-colored entity pill. The glyph is the workspace tab character
 * for the entity type (chapter §, drift ❦, storyline ¶, element ◆,
 * category ⌘, all-chapters ☰); border and wash carry the owning storyline
 * or category color, text stays ink. */
function EntityPill({
  glyph,
  label,
  color,
  onClick,
}: {
  glyph: string;
  label: string;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="m-flow__pill"
      style={
        color
          ? {
              borderColor: color,
              background: `color-mix(in srgb, ${color} 12%, transparent)`,
            }
          : undefined
      }
      onClick={onClick}
    >
      <span className="m-flow__pill-glyph" aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

interface MobileProjectFlowProps {
  onOpenChapters(): void;
  projectActions?: ReactNode;
}

/** The project home as one downward flow of the author's material: a dense
 * first screen with chapters, drifts, and elements together, storylines and
 * quiet entries below. Chrome stays in the corners; content fills the page. */
export function MobileProjectFlow({ onOpenChapters, projectActions }: MobileProjectFlowProps) {
  const { t } = useTranslation();
  const { projectId, openEntity } = useProjectNavigation();
  const currentProject = useProjectStore((s) => s.currentProject);
  const { bookNodes, storylines, bookElements, bookElementCategories, storylineNodeMapping } =
    useDataStoreFields(
    'bookNodes',
    'storylines',
    'bookElements',
    'bookElementCategories',
    'storylineNodeMapping',
  );
  const recentItems = useRecentEntitiesStore((s) => s.items);
  const writingPlans = useWritingStatsStore((s) => s.plans);

  const chapters = useMemo(
    () => bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );
  const drifts = useMemo(() => bookNodes.filter(isDrift), [bookNodes]);

  const totalWords = useMemo(
    () => chapters.reduce((sum, node) => sum + (canonicalWordCount(node) ?? 0), 0),
    [chapters],
  );
  const wordTarget = projectId
    ? (writingPlans[projectId]?.projectWordTarget ?? 120000)
    : 120000;

  const continueNode = useMemo<BookNode | null>(() => {
    const recentNodeIds = recentItems
      .filter((r) => r.projectId === projectId && r.entityType === 'node')
      .map((r) => r.entityId);
    for (const id of recentNodeIds) {
      const node = chapters.find((n) => n.id === id);
      if (node) return node;
    }
    return chapters[0] ?? null;
  }, [recentItems, chapters, projectId]);

  const categoryGroups = useMemo(() => {
    const groups = bookElementCategories.map((category) => ({
      category,
      color: resolveColor(category.color, category.id),
      elements: bookElements.filter((element) => element.categoryId === category.id),
    }));
    const loose = bookElements.filter(
      (element) => !bookElementCategories.some((c) => c.id === element.categoryId),
    );
    return { groups, loose };
  }, [bookElementCategories, bookElements]);

  const storylineRows = useMemo(
    () =>
      storylines.map((storyline) => {
        const nodeIds = storylineNodeMapping[storyline.id] ?? [];
        const span = chapters
          .filter((node) => nodeIds.includes(node.id))
          .map((node) => node.title || t('common.untitled'))
          .join(' → ');
        return { storyline, color: resolveColor(storyline.color, storyline.id), span };
      }),
    [storylines, storylineNodeMapping, chapters, t],
  );

  const openNode = (id: string) => openEntity({ entityType: 'node', id });

  return (
    <div className="m-flow" data-debug-id="mobile-project-flow">
      <div className="m-flow__masthead">
        <strong className="m-flow__title">
          {currentProject?.name || t('common.untitled')}
        </strong>
        <span className="m-flow__meta">
          {t('mobileWorkspace.flow.meta', {
            defaultValue: '{{chapters}} 章 · 已写 {{written}} / {{target}}',
            chapters: chapters.length,
            written: formatWords(totalWords),
            target: formatWords(wordTarget),
          })}
        </span>
        {projectActions}
      </div>
      <span className="m-flow__progress" aria-hidden="true">
        <span
          style={{
            width: `${wordTarget > 0 ? Math.min(100, (totalWords / wordTarget) * 100) : 0}%`,
          }}
        />
      </span>

      <span className="m-flow__label">
        {t('mobileWorkspace.flow.chapters', { defaultValue: '章节' })} · {chapters.length}
      </span>
      <div className="m-flow__section">
        {chapters.map((node, index) => (
          <div key={node.id} className="m-flow__chapter-group">
            <button type="button" className="m-flow__chapter" onClick={() => openNode(node.id)}>
              <span className="m-flow__roman">§ {toRoman(index + 1)}</span>
              <span className="m-flow__chapter-title">
                {node.title || t('common.untitled')}
              </span>
              {node.summary ? <span className="m-flow__snippet">{node.summary}</span> : null}
              <span className="m-flow__count">
                {canonicalWordCount(node) == null
                  ? t('common.counting')
                  : formatWords(canonicalWordCount(node)!)}
              </span>
            </button>
            {continueNode?.id === node.id && (
              <button
                type="button"
                className="m-flow__continue"
                onClick={() => openNode(node.id)}
              >
                <span>{t('mobileWorkspace.flow.continue', { defaultValue: '从这里继续' })}</span>
                <ArrowRight size={12} strokeWidth={2.2} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {chapters.length === 0 && (
          <button type="button" className="m-flow__create" onClick={onOpenChapters}>
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
            <span>{t('dashboard.structure.newChapter', { defaultValue: '新章节' })}</span>
          </button>
        )}
      </div>

      {drifts.length > 0 && (
        <>
          <span className="m-flow__label">
            {t('leftSidebar.tabs.drifts', { defaultValue: '漂流' })} · {drifts.length}
          </span>
          <div className="m-flow__section">
            {drifts.map((node) => (
              <button
                key={node.id}
                type="button"
                className="m-flow__drift"
                onClick={() => openNode(node.id)}
              >
                <span className="m-flow__glyph" aria-hidden="true">❦</span>
                <span>{node.title || node.summary || t('common.untitled')}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {(categoryGroups.groups.length > 0 || categoryGroups.loose.length > 0) && (
        <>
          <span className="m-flow__label">
            {t('leftSidebar.tabs.elements', { defaultValue: '元素' })} · {bookElements.length}
          </span>
          <div className="m-flow__section m-flow__section--pills">
            {categoryGroups.groups.map(({ category, color, elements }) => (
              <div key={category.id} className="m-flow__pills">
                <EntityPill glyph="⌘" label={category.name} color={color} />
                {elements.map((element) => (
                  <EntityPill
                    key={element.id}
                    glyph="◆"
                    label={element.name}
                    color={color}
                    onClick={() => openEntity({ entityType: 'element', id: element.id })}
                  />
                ))}
              </div>
            ))}
            {categoryGroups.loose.length > 0 && (
              <div className="m-flow__pills">
                {categoryGroups.loose.map((element) => (
                  <EntityPill
                    key={element.id}
                    glyph="◆"
                    label={element.name}
                    onClick={() => openEntity({ entityType: 'element', id: element.id })}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {storylineRows.length > 0 && (
        <>
          <span className="m-flow__label">
            {t('dashboard.structure.storylines', { defaultValue: '故事线' })} ·{' '}
            {storylines.length}
          </span>
          <div className="m-flow__section">
            {storylineRows.map(({ storyline, color, span }) => (
              <button
                key={storyline.id}
                type="button"
                className="m-flow__storyline"
                onClick={() => openEntity({ entityType: 'storyline', id: storyline.id })}
              >
                <EntityPill glyph="¶" label={storyline.name} color={color} />
                {span ? <span className="m-flow__span">{span}</span> : null}
              </button>
            ))}
          </div>
        </>
      )}

    </div>
  );
}
