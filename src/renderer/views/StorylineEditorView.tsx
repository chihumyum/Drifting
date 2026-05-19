import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useStoryline } from '../usecase/useStoryline';
import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { useOutlineScrollspy } from '../components/editor/use-outline-scrollspy';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useEntityEditor } from '../hooks/useEntityEditor';
import { usePromoteCurrentTab } from '../store/ui-store';
import loglevel from 'loglevel';

const log = loglevel.getLogger('StorylineEditorView');
log.setLevel(loglevel.levels.WARN);

const STORY_COLORS = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
];

type ChapterFilter = 'all' | 'written' | 'unwritten';

export function StorylineEditorView({
  storylineIdOverride,
}: { storylineIdOverride?: string } = {}) {
  const params = useParams<{ projectId: string; storylineId: string }>();
  const projectId = params.projectId;
  const storylineId = storylineIdOverride ?? params.storylineId;
  const user = useAuthStore((state) => state.user);
  if (!projectId) throw new Error('No projectId in params');
  if (!user) throw new Error('No user in auth store');

  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const { storylines, bookNodes, storylineNodeMapping } = useDataStore();
  const { navigateToStoryline, navigateToHome, navigateToNode } = useProjectNavigation();
  const storylineUsecases = useStoryline({ projectId, userId: user.id });

  const currentStoryline = useMemo(() => {
    if (!storylineId) return null;
    return storylines.find((sl) => sl.id === storylineId) ?? null;
  }, [storylineId, storylines]);

  // Chapters belonging to this storyline, sorted by timeline position.
  const sNodes = useMemo(() => {
    if (!storylineId) return [];
    const ids = storylineNodeMapping[storylineId] ?? [];
    const byId = new Map(bookNodes.map((n) => [n.id, n]));
    return ids
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))
      .sort((a, b) => a.bookOrder - b.bookOrder);
  }, [bookNodes, storylineId, storylineNodeMapping]);

  const totalWc = sNodes.reduce((sum, n) => sum + (n.wordCount || 0), 0);
  const writtenCount = sNodes.filter((n) => (n.wordCount || 0) > 0).length;
  const unwrittenCount = sNodes.length - writtenCount;

  const [chapterFilter, setChapterFilter] = useState<ChapterFilter>('all');
  const filteredNodes = sNodes.filter((n) => {
    if (chapterFilter === 'all') return true;
    const hasContent = (n.wordCount || 0) > 0;
    return chapterFilter === 'written' ? hasContent : !hasContent;
  });

  // Name + summary local drafts
  const currentName = currentStoryline?.name ?? '';
  const currentSummary = currentStoryline?.summary ?? '';
  const [nameDraft, setNameDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [isComposingName, setIsComposingName] = useState(false);
  const [isComposingSummary, setIsComposingSummary] = useState(false);
  const displayedName = isEditingName ? nameDraft : currentName;
  const displayedSummary = isEditingSummary ? summaryDraft : currentSummary;

  const commitName = async () => {
    if (!storylineId || nameDraft === currentName) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, name: nameDraft });
  };
  const commitSummary = async () => {
    if (!storylineId || summaryDraft === currentSummary) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, summary: summaryDraft });
  };
  const commitColor = async (color: string) => {
    if (!storylineId || color === currentStoryline?.color) return;
    promoteCurrentTab();
    await storylineUsecases.updateStoryline({ id: storylineId, color });
  };

  // Scratch body (descriptionJson) — TipTap editor for free-form notes.
  const handlePersist = useCallback(
    (ed: Editor) => {
      if (!storylineId) return;
      promoteCurrentTab();
      void storylineUsecases.updateStoryline({
        id: storylineId,
        descriptionJson: JSON.stringify(ed.getJSON()),
      });
    },
    [storylineId, storylineUsecases, promoteCurrentTab],
  );
  const { editor, outline } = useEntityEditor({
    sourceKind: 'storyline',
    sourceId: currentStoryline?.id ?? '',
    projectId,
    content: currentStoryline?.descriptionJson ?? null,
    onPersist: handlePersist,
    placeholder: '札记 · scratch——本线的速记、浮缀、风格备忘…',
  });

  // Two-block TOC: outer (frameworkItems) = static section anchors —
  // 概述 / 章节序列 / 札记. Inner (bodyOutlineItems) = headings parsed from
  // the 札记 TipTap body at their natural h1/h2/h3 levels. The two render
  // as separate groups in the TOC so the body outline reads as its own
  // hierarchy rather than blurring into the framework.
  const frameworkItems: OutlineEntry[] = [
    { id: 'sl-overview', level: 2, num: '一', text: '概述' },
    ...(sNodes.length > 0 ? [{ id: 'sl-chapters', level: 2 as const, num: '二', text: '章节序列' }] : []),
    { id: 'sl-scratch',  level: 2, num: sNodes.length > 0 ? '三' : '二', text: '札记' },
  ];
  const bodyOutlineItems: OutlineEntry[] = outline.map<OutlineEntry>((h) => ({
    id: h.id,
    level: h.level,
    text: h.text,
  }));
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const activeOutlineId = useOutlineScrollspy(
    scrollEl,
    [...frameworkItems, ...bodyOutlineItems].map((i) => i.id),
  );

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!storylineId || !currentStoryline) return;
      if (action === 'deleteStoryline') {
        const confirmed = window.confirm(`Delete storyline "${currentStoryline.name}"?`);
        if (!confirmed) return;
        try {
          await storylineUsecases.deleteStoryline(storylineId);
          navigateToHome();
        } catch (error) {
          log.error('Failed to delete storyline:', error);
          alert('Failed to delete storyline. Please try again.');
        }
      } else if (action === 'mergeStoryline') {
        alert('Merge storylines is not implemented yet.');
      }
    },
    [storylineId, currentStoryline, storylineUsecases, navigateToHome],
  );

  if (!currentStoryline) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--ink-4))' }}>
        Loading storyline…
      </div>
    );
  }

  const storylineColor = currentStoryline.color || 'hsl(var(--accent))';
  const storylineShortId = currentStoryline.id.slice(0, 6);

  return (
    <div className="editor-shell" style={{ height: '100%', position: 'relative' }}>
      <EditorTopBar
        editorType="storyline"
        onMenuAction={handleContextAction}
        right={
          <>
            <span>{sNodes.length} 章</span>
            {sNodes.length > 0 && (
              <>
                <span className="editor-bar__sep">·</span>
                <span>{(totalWc / 1000).toFixed(1)}k 字</span>
              </>
            )}
          </>
        }
      >
        <EditorCrumb
          dotColor={currentStoryline.color || '#8A2A1E'}
          dropdown={
            storylines.length === 0 ? (
              <div className="crumb-dropdown__empty">No storylines yet</div>
            ) : (
              storylines.map((s) => {
                const isActive = s.id === storylineId;
                return (
                  <div
                    key={s.id}
                    className={`crumb-dropdown__item${isActive ? ' crumb-dropdown__item--active' : ''}`}
                    onClick={() => navigateToStoryline(s.id)}
                  >
                    <span className="crumb-dropdown__dot" style={{ background: s.color || '#8A2A1E' }} />
                    <span>{s.name}</span>
                  </div>
                );
              })
            )
          }
        >
          <span>{currentStoryline.name || 'Untitled storyline'}</span>
        </EditorCrumb>
      </EditorTopBar>

      <div className="editor-body">
        <EditorOutlinePanel
          title={`${currentStoryline.name || 'STORYLINE'} · OUTLINE`}
          items={frameworkItems}
          secondaryItems={bodyOutlineItems}
          activeId={activeOutlineId}
          onItemClick={(id) => scrollToOutlineAnchor(id, scrollEl)}
          footLeft={`s.${storylineShortId}`}
          footRight={`${(totalWc / 1000).toFixed(1)}k 字`}
        />
        <div className="editor-scroll" ref={setScrollEl}>
          <div className="editor__spread">
          <article className="page" style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}>
            <div className="page__folio" aria-hidden="true">
              <span className="page__folio-line">Storyline</span>
              <span className="page__folio-line" style={{ color: storylineColor, fontWeight: 600 }}>
                {currentStoryline.name}
              </span>
              <span className="page__folio-line">s.{storylineShortId}</span>
              <span className="page__folio-line">{sNodes.length} 章</span>
              <span className="page__folio-line">{(totalWc / 1000).toFixed(1)}k 字</span>
            </div>

            {/* 一 · 概述 */}
            <section id="sl-overview">
              <div className="elem-hero">
                <div
                  className="elem-portrait elem-portrait--storyline"
                  style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}
                >
                  <span className="elem-portrait__hint">{currentStoryline.name}</span>
                </div>
                <div className="elem-hero__main">
                  <div className="elem-hero__kicker">
                    <span className="elem-hero__kicker-dot" style={{ background: storylineColor }} />
                    <span>§ STORYLINE</span>
                    <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
                    <span>s.{storylineShortId}</span>
                  </div>

                  <input
                    type="text"
                    className="elem-hero__name"
                    value={displayedName}
                    onFocus={() => { setNameDraft(currentName); setIsEditingName(true); }}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onCompositionStart={() => setIsComposingName(true)}
                    onCompositionEnd={(e) => { setIsComposingName(false); setNameDraft(e.currentTarget.value); }}
                    onBlur={() => { setIsEditingName(false); if (!isComposingName) void commitName(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isComposingName) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                      if (e.key === 'Escape') {
                        setNameDraft(currentName);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Untitled storyline"
                  />

                  <textarea
                    className="elem-hero__summary"
                    value={displayedSummary}
                    onFocus={() => { setSummaryDraft(currentSummary); setIsEditingSummary(true); }}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    onCompositionStart={() => setIsComposingSummary(true)}
                    onCompositionEnd={(e) => { setIsComposingSummary(false); setSummaryDraft(e.currentTarget.value); }}
                    onBlur={() => { setIsEditingSummary(false); if (!isComposingSummary) void commitSummary(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setSummaryDraft(currentSummary);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="一句话概述本线…"
                    rows={2}
                  />

                  <div className="elem-hero__facts">
                    <div className="elem-hero__fact-k">色标</div>
                    <div className="elem-hero__fact-v">
                      <div className="col-pick">
                        {STORY_COLORS.map((c) => (
                          <div
                            key={c}
                            className={`col-pick__sw${c === currentStoryline.color ? ' col-pick__sw--active' : ''}`}
                            style={{ ['--c' as string]: c } as React.CSSProperties}
                            onClick={() => void commitColor(c)}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* DEFERRED: pov / tense / period / place facts, aliases, themes,
                      keyElements, story arc. All require new schema columns; will
                      surface here once added. */}
                </div>
              </div>
            </section>

            {/* 二 · 章节序列 */}
            {sNodes.length > 0 && (
              <>
                <h2 id="sl-chapters" className="page__scene">
                  <span className="page__scene-num">二</span>
                  <span className="page__scene-title">章节序列</span>
                  <span className="page__scene-meta">
                    {sNodes.length} 章 · {(totalWc / 1000).toFixed(1)}k 字
                  </span>
                </h2>

                <div className="mgr-toolbar">
                  <div className="mgr-toolbar__chips">
                    {([
                      ['all',        '全部',    sNodes.length],
                      ['written',    '已写',    writtenCount],
                      ['unwritten',  '未起',    unwrittenCount],
                    ] as const).map(([k, label, n]) => (
                      <div
                        key={k}
                        className={`mgr-toolbar__chip${chapterFilter === k ? ' mgr-toolbar__chip--active' : ''}`}
                        onClick={() => setChapterFilter(k)}
                      >
                        <span>{label}</span>
                        <em>· {n}</em>
                      </div>
                    ))}
                  </div>
                  {/* DEFERRED: search / reorder / batch actions */}
                </div>

                <div className="mgr-list">
                  {filteredNodes.map((n, idx) => {
                    const hasContent = (n.wordCount || 0) > 0;
                    // No `status` enum in schema yet — derive from wordCount.
                    // Once a real status field exists, switch the modifier class.
                    const statusMod = hasContent ? '' : ' mgr-row__status--todo';
                    return (
                      <div
                        key={n.id}
                        className="mgr-row"
                        style={{ ['--s-color' as string]: storylineColor } as React.CSSProperties}
                        onClick={() => navigateToNode(n.id)}
                      >
                        <div className={`mgr-row__status${statusMod}`} />
                        <div className="mgr-row__num">§{String(idx + 1).padStart(2, '0')}</div>
                        <div className="mgr-row__body">
                          <div className="mgr-row__title">
                            <span>{n.title || 'Untitled'}</span>
                          </div>
                          <div className={`mgr-row__summary${n.summary ? '' : ' mgr-row__summary--empty'}`}>
                            {n.summary || '— 尚未填写一句话摘要 —'}
                          </div>
                          <div className="mgr-row__meta">
                            <span><b>{(n.wordCount || 0).toLocaleString()}</b>字</span>
                            <span>{hasContent ? 'written' : 'unwritten'}</span>
                          </div>
                        </div>
                        <div className="mgr-row__wc">
                          <span className="mgr-row__wc-v">
                            {n.wordCount > 0 ? (
                              <>{(n.wordCount / 1000).toFixed(1)}<em>k</em></>
                            ) : '—'}
                          </span>
                          <span className="mgr-row__wc-k">字</span>
                        </div>
                        <div className="mgr-row__open" title="打开章节">→</div>
                      </div>
                    );
                  })}
                  {filteredNodes.length === 0 && (
                    <div className="mgr-empty">— 此筛选下暂无章节 —</div>
                  )}
                </div>
              </>
            )}

            {/* 三 · 札记 (scratch body editor) */}
            <h2 id="sl-scratch" className="page__scene">
              <span className="page__scene-num">{sNodes.length > 0 ? '三' : '二'}</span>
              <span className="page__scene-title">札记 · scratch</span>
            </h2>
            <div className="elem-body">
              <EditorContent editor={editor} />
            </div>
          </article>
          </div>
        </div>
        {/* DEFERRED: right-side margin annotations (no column reserved). */}
      </div>
    </div>
  );
}
