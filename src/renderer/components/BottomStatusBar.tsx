import { useMemo } from 'react';
import { useMatch } from 'react-router-dom';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import '../../styles/bottom-status-bar.css';

// BottomStatusBar — always-visible 24px footer that surfaces "what entity
// am I in?" context plus the toggle for the BottomTimeline dock. Replaces
// the old collapsed-strip mode of the timeline: instead of a thin compressed
// dock taking permanent space, the timeline is either fully open or fully
// hidden, and the status bar is the persistent UI affordance the user
// keeps to summon it back.
//
// What we surface depends on the active route. Node editor shows the
// chapter's storyline + position. Storyline editor shows the storyline's
// name + chapter count. Element / category editors show their respective
// names. Dashboard / project picker shows the project name.

export function BottomStatusBar() {
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const elementMatch = useMatch('/project/:projectId/element/:elementId');
  const categoryMatch = useMatch('/project/:projectId/category/:categoryId');
  const homeMatch = useMatch('/project/:projectId/home');

  const nodeId = editorMatch?.params.nodeId;
  const routeStorylineId = storylineMatch?.params.storylineId;
  const elementId = elementMatch?.params.elementId;
  const categoryId = categoryMatch?.params.categoryId;

  const {
    bookNodes,
    storylines,
    storylineNodeMapping,
    nodeStorylineMapping,
    bookElements,
    bookElementCategories,
  } = useDataStore();

  const bottomTimelineHidden = useUiStore((s) => s.bottomTimelineHidden);
  const toggleBottomTimelineHidden = useUiStore((s) => s.toggleBottomTimelineHidden);

  // Resolve the segment to render based on the route. We compute it lazily
  // so the bar doesn't pay for storyline lookups when there's no chapter
  // active.
  const context = useMemo(() => {
    if (nodeId) {
      const node = bookNodes.find((n) => n.id === nodeId);
      if (!node) return { label: '加载中…', segments: [] as string[] };
      // Prefer the node's main storyline; fall back to the first listed.
      const ownerStorylineIds = nodeStorylineMapping[node.id] ?? [];
      const fallback = ownerStorylineIds[0] ?? null;
      const mainId = node.mainStorylineId && ownerStorylineIds.includes(node.mainStorylineId)
        ? node.mainStorylineId
        : fallback;
      const storyline = mainId ? storylines.find((s) => s.id === mainId) ?? null : null;
      // Position within the main storyline: 1-indexed rank by bookOrder.
      let positionLabel: string | null = null;
      if (storyline) {
        const ids = storylineNodeMapping[storyline.id] ?? [];
        const sorted = ids
          .map((id) => bookNodes.find((n) => n.id === id))
          .filter((n): n is typeof node => Boolean(n))
          .sort((a, b) => a.bookOrder - b.bookOrder);
        const idx = sorted.findIndex((n) => n.id === node.id);
        if (idx >= 0) positionLabel = `${idx + 1}/${sorted.length}`;
      }
      const segments = [
        storyline ? storyline.name || 'Untitled' : '漂浮章节',
        positionLabel ? `第 ${positionLabel}` : null,
        node.title || '未命名',
      ].filter((s): s is string => Boolean(s));
      return { kind: 'node' as const, segments };
    }
    if (routeStorylineId) {
      const storyline = storylines.find((s) => s.id === routeStorylineId);
      if (!storyline) return { kind: 'unknown' as const, segments: ['加载中…'] };
      const count = (storylineNodeMapping[storyline.id] ?? []).length;
      return {
        kind: 'storyline' as const,
        segments: [storyline.name || 'Untitled', `${count} 章`],
      };
    }
    if (elementId) {
      const el = bookElements.find((e) => e.id === elementId);
      if (!el) return { kind: 'unknown' as const, segments: ['加载中…'] };
      const cat = bookElementCategories.find((c) => c.id === el.categoryId);
      return {
        kind: 'element' as const,
        segments: [cat?.name || '未分类', el.name || 'Untitled'],
      };
    }
    if (categoryId) {
      const decoded = (() => {
        try {
          return decodeURIComponent(categoryId);
        } catch {
          return categoryId;
        }
      })();
      const cat = bookElementCategories.find((c) => c.id === decoded);
      return { kind: 'category' as const, segments: [cat?.name || decoded] };
    }
    if (homeMatch) {
      return { kind: 'home' as const, segments: ['项目首页'] };
    }
    return { kind: 'unknown' as const, segments: [] as string[] };
  }, [
    nodeId,
    routeStorylineId,
    elementId,
    categoryId,
    homeMatch,
    bookNodes,
    storylines,
    storylineNodeMapping,
    nodeStorylineMapping,
    bookElements,
    bookElementCategories,
  ]);

  const kindLabel = (() => {
    switch (context.kind) {
      case 'node':
        return '章节';
      case 'storyline':
        return '故事线';
      case 'element':
        return '元素';
      case 'category':
        return '分类';
      case 'home':
        return '项目';
      default:
        return '';
    }
  })();

  return (
    <div className="bsb">
      {kindLabel && <div className="bsb__kind">{kindLabel}</div>}
      <div className="bsb__breadcrumb">
        {context.segments.length === 0 ? (
          <span className="bsb__breadcrumb-empty">—</span>
        ) : (
          context.segments.map((seg, i) => (
            <span key={i} className="bsb__crumb">
              {i > 0 && <span className="bsb__sep" aria-hidden>·</span>}
              <span className="bsb__crumb-text">{seg}</span>
            </span>
          ))
        )}
      </div>
      <div className="bsb__spacer" />
      <button
        type="button"
        className={`bsb__seg bsb__timeline-toggle${bottomTimelineHidden ? '' : ' is-open'}`}
        onClick={toggleBottomTimelineHidden}
        title={bottomTimelineHidden ? '展开 Storyline Timeline' : '收起 Storyline Timeline'}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <line x1="1.5" y1="7" x2="14.5" y2="7" />
          <line x1="4" y1="10.5" x2="9" y2="10.5" />
        </svg>
        <span>Timeline · {bottomTimelineHidden ? '已收起' : '展开'}</span>
      </button>
    </div>
  );
}
