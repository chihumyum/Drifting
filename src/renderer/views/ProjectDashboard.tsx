import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../store/data-store';
import { useProject } from '../usecase/useProject';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useUiStore } from '../store/ui-store';
import { useShortcutsStore } from '../store/shortcuts-store';
import { useProjectCheckinStore } from '../store/project-checkin-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useRecentEntitiesStore } from '../store/recent-entities-store';
import { useWritingStatsStore, deriveWritingStats } from '../store/writing-stats-store';
import { useEditorSurfaceLifecycle } from '../components/editor/editor-surface-lifecycle-context';
import { KvEditor } from '../components/editor/KvEditor';
import { ProjectMemoryEditor } from '../features/agent/ProjectMemoryEditor';
import { HomeCreateFloat, HomeCreateTiles } from '../shells/desktop/project-home/HomeCreate';
import { lastHomeCreateKind, useHomeCreate } from '../shells/desktop/project-home/useHomeCreate';
import { HomeAgentFloat, HomeAgentFlow } from '../shells/desktop/project-home/HomeAgent';
import { useHomeAgent } from '../shells/desktop/project-home/useHomeAgent';
import {
  canonicalWordCount,
  deriveStatus,
  isChapter,
  isDrift,
  sumCanonicalChapterWordCounts,
  type BookNode,
} from '../domain/book-node';
import { formatAccelerator } from '../lib/shortcuts';
import { BrushIcon } from '../components/ui/BrushIcon';
import { EmptyState } from '../components/ui/EmptyState';
import { GlassSlider } from '../components/ui/GlassSlider';
import { KindMark } from '../components/ui/KindMark';
import { Switch } from '../components/ui/Switch';
import '../../styles/dashboard.css';

type HomeView = 'overview' | 'settings';
type Floating = 'new' | 'agent' | null;

/** Where a floating section rests above the foot of the page (dashboard.css). */
const FLOAT_INSET = 26;

function relativeTime(iso: string | number, locale: string): string {
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const zh = locale.startsWith('zh');
  if (seconds < 60) return zh ? '刚刚' : 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return zh ? `${days} 天前` : `${days} days ago`;
  return new Date(then).toLocaleDateString(locale);
}

/** 86,000 → 「8.6 万」 / 「86k」. */
function shortWords(count: number, locale: string): string {
  if (locale.startsWith('zh')) {
    return count >= 10000 ? `${(count / 10000).toFixed(1).replace(/\.0$/, '')} 万` : count.toLocaleString(locale);
  }
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : count.toLocaleString(locale);
}

/**
 * Project Home on the desktop: the page the stage shows when no tab is
 * active, one page-white plane like the editors. Its flow is the work (the
 * title and counts, where to continue, the whole book), then the create row,
 * then the Agent; 设定 is the other view. Arriving from the dock's + (or ⌘N)
 * floats the create row at the foot of the page, any other arrival floats the
 * Agent, each a leaner set of its own; once the page is scrolled to where that
 * section sits, the floating set fades out for the one in the flow and stays
 * gone until the next arrival. A section already in view never floats.
 */
export const ProjectDashboard = memo(function ProjectDashboard() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { isVisible } = useEditorSurfaceLifecycle();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const projectName = currentProject?.name ?? projects.find((p) => p.id === projectId)?.name ?? '';
  const create = useHomeCreate();
  const { hush } = create;
  const agent = useHomeAgent(projectId ?? '', projectName);

  const [view, setView] = useState<HomeView>('overview');
  const [floating, setFloating] = useState<Floating>(null);
  // Read by scroll and resize handlers; written beside every setFloating.
  const floatingRef = useRef<Floating>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const newRef = useRef<HTMLElement | null>(null);
  const agentRef = useRef<HTMLElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  const agentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const memoryRef = useRef<HTMLElement | null>(null);

  /** Lands a floating section once its place in the flow is in view. */
  const dock = useCallback(() => {
    const kind = floatingRef.current;
    const scroller = scrollRef.current;
    const section = kind === 'new' ? newRef.current : kind === 'agent' ? agentRef.current : null;
    if (!kind || !scroller || !section) return;
    const limit = scroller.getBoundingClientRect().bottom - FLOAT_INSET;
    if (section.getBoundingClientRect().bottom > limit + 0.5) return;
    const hadFocus = Boolean(floatRef.current?.contains(document.activeElement));
    floatingRef.current = null;
    setFloating(null);
    if (!hadFocus) return;
    // The section in the flow is already laid out under its floating set.
    if (kind === 'agent') {
      const input = agentInputRef.current;
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    newRef.current
      ?.querySelector<HTMLButtonElement>(`[data-kind="${lastHomeCreateKind()}"] [data-home-kind]`)
      ?.focus({ preventScroll: true });
  }, []);

  // Every arrival starts at the top with one section floating: the create row
  // after the dock's + or ⌘N, otherwise the Agent.
  const entry = useUiStore((s) => s.projectHomeEntry);
  const consumedSeq = useRef(entry.seq);
  const arrivedFromPlus = useRef(false);
  const wasVisible = useRef(false);
  const [arrival, setArrival] = useState(0);
  useLayoutEffect(() => {
    const fresh = entry.seq !== consumedSeq.current;
    const arrived = isVisible && (!wasVisible.current || fresh);
    wasVisible.current = isVisible;
    if (!arrived) return;
    consumedSeq.current = entry.seq;
    const intent = fresh ? entry.intent : 'home';
    arrivedFromPlus.current = intent === 'new';
    setView('overview');
    const next: Floating = intent === 'new' ? 'new' : 'agent';
    floatingRef.current = next;
    setFloating(next);
    scrollRef.current?.scrollTo({ top: 0 });
    setArrival((n) => n + 1);
  }, [entry.intent, entry.seq, isVisible]);

  useLayoutEffect(() => {
    if (arrival === 0) return;
    dock();
    if (!arrivedFromPlus.current) return;
    // After the dock's + the focus waits on the kind used last, floating or
    // not; it stays quiet and opens nothing until the author moves it.
    const scope = floatingRef.current === 'new' ? floatRef.current : newRef.current;
    const kind = scope?.querySelector<HTMLButtonElement>(`[data-kind="${lastHomeCreateKind()}"] [data-home-kind]`);
    if (!kind) return;
    hush();
    kind.focus({ preventScroll: true });
  }, [arrival, dock, hush]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => dock());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [dock]);

  const showView = (next: HomeView) => {
    floatingRef.current = null;
    setFloating(null);
    setView(next);
  };

  const openMemory = () => {
    showView('settings');
    requestAnimationFrame(() => memoryRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  return (
    <div className="dash-stage">
      <div className="dash" ref={scrollRef} onScroll={dock}>
        <div className="dash__inner">
          <HomeTitle view={view} onView={showView} />
          {view === 'overview' ? (
            <>
              <HomeWork />
              <section
                ref={newRef}
                className={`dash-sec dash-sec--create${floating === 'new' ? ' is-ghost' : ''}`}
                aria-hidden={floating === 'new' || undefined}
              >
                <CreateHead />
                <HomeCreateTiles model={create} />
              </section>
              {projectId && (
                <section
                  ref={agentRef}
                  className={`dash-sec dash-sec--agent${floating === 'agent' ? ' is-ghost' : ''}`}
                  aria-hidden={floating === 'agent' || undefined}
                >
                  <HomeAgentFlow agent={agent} inputRef={agentInputRef} onOpenMemory={openMemory} />
                </section>
              )}
            </>
          ) : (
            <HomeSettings memoryRef={memoryRef} />
          )}
        </div>
      </div>
      {floating && (
        <div
          ref={floatRef}
          className={`dash-float dash-float--${floating}`}
          aria-label={floating === 'new' ? t('projectHome.create.title') : t('projectAgent.title')}
          role="region"
        >
          {floating === 'new' ? <HomeCreateFloat model={create} /> : <HomeAgentFloat agent={agent} />}
        </div>
      )}
      {create.dialog}
    </div>
  );
});

function CreateHead() {
  const { t } = useTranslation();
  const accelerator = useShortcutsStore((state) => state.bindings.newEntity);
  return (
    <div className="dash-sec__head">
      <h2 className="dash-sec__title">{t('projectHome.create.title')}</h2>
      <span className="dash-sec__spacer" />
      <span className="dash-ro">{formatAccelerator(accelerator)}</span>
    </div>
  );
}

function HomeTitle({ view, onView }: { view: HomeView; onView: (view: HomeView) => void }) {
  const { t, i18n } = useTranslation();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const { updateProject } = useProject({ userId: userId ?? '' });
  const storylines = useDataStore((s) => s.storylines);
  const bookElements = useDataStore((s) => s.bookElements);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const writingHistory = useWritingStatsStore((s) => s.history[projectId ?? ''] ?? undefined);
  const plan = useWritingStatsStore((s) => (projectId ? s.plans[projectId] : undefined));
  const projectTarget = plan?.projectWordTarget ?? 120000;
  const dailyGoal = plan?.dailyWordGoal ?? 1500;

  const chapters = useMemo(() => bookNodes.filter(isChapter), [bookNodes]);
  const total = useMemo(() => sumCanonicalChapterWordCounts(chapters), [chapters]);
  const stats = useMemo(() => deriveWritingStats(writingHistory, total.count), [writingHistory, total.count]);

  const editableId = currentProject?.id ?? projectId ?? null;
  const name = currentProject?.name ?? projects.find((p) => p.id === projectId)?.name ?? '';
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState(false);
  const commitName = async () => {
    const next = draft.trim();
    // Persist before leaving edit mode, so the old name never flashes back
    // while the write lands.
    if (editableId && next && next !== name) await updateProject(editableId, { name: next });
    setEditing(false);
  };

  const since = currentProject?.createdAt
    ? new Date(currentProject.createdAt).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long' })
    : null;
  const words = !total.ready
    ? t('common.counting')
    : projectTarget > 0
      ? t('projectHome.wordsOfTarget', {
          words: shortWords(total.count, i18n.language),
          target: shortWords(projectTarget, i18n.language),
        })
      : t('projectHome.words', { words: shortWords(total.count, i18n.language) });
  const progress = total.ready && projectTarget > 0 ? Math.min(100, (total.count / projectTarget) * 100) : 0;

  return (
    <header className="dash-title">
      <div className="dash-title__top">
        <div className="dash-title__main">
          <p className="dash-ro">
            {since ? t('projectHome.since', { date: since }) : t('projectHome.kicker')}
          </p>
          <input
            type="text"
            className="dash-title__name"
            value={editing ? draft : name}
            readOnly={!editableId}
            placeholder="Drifting"
            aria-label={t('dashboard.hero.projectName')}
            title={t('dashboard.hero.renameProject')}
            onFocus={() => {
              setDraft(name);
              setEditing(true);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              setComposing(false);
              setDraft(e.currentTarget.value);
            }}
            onBlur={() => {
              if (composing) setEditing(false);
              else void commitName();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !composing) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setDraft(name);
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        <GlassSlider
          className="dash-title__views"
          ariaLabel={t('projectHome.kicker')}
          value={view}
          onChange={onView}
          options={[
            { value: 'overview', label: t('projectHome.views.overview') },
            { value: 'settings', label: t('projectHome.views.settings') },
          ]}
        />
      </div>
      {view === 'overview' && (
        <div className="dash-title__readouts">
          <p className="dash-ro">
            {t('projectHome.readout', {
              chapters: chapters.length,
              storylines: storylines.length,
              elements: bookElements.length,
            })}
            {' · '}
            {words}
          </p>
          <div className="dash-progress">
            {projectTarget > 0 && (
              <span className="sand-track dash-progress__track">
                <span className="sand-stroke" style={{ width: `${progress}%` }} />
              </span>
            )}
            <span className="dash-ro">
              {total.ready
                ? dailyGoal > 0
                  ? t('projectHome.today', {
                      today: stats.todayWords.toLocaleString(i18n.language),
                      goal: dailyGoal.toLocaleString(i18n.language),
                      streak: stats.streakDays,
                    })
                  : t('projectHome.todayNoGoal', {
                      today: stats.todayWords.toLocaleString(i18n.language),
                      streak: stats.streakDays,
                    })
                : t('common.counting')}
            </span>
          </div>
        </div>
      )}
    </header>
  );
}

function HomeWork() {
  const { t, i18n } = useTranslation();
  const { projectId, openEntity, navigateToAllChapters } = useProjectNavigation();
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const storylines = useDataStore((s) => s.storylines);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookElements = useDataStore((s) => s.bookElements);
  const categories = useDataStore((s) => s.bookElementCategories);
  const mapping = useDataStore((s) => s.storylineNodeMapping);
  const primaryStorylineByNode = useDataStore((s) => s.primaryStorylineByNode);
  const recentItems = useRecentEntitiesStore((s) => s.items);

  const storylineOf = useCallback(
    (node: BookNode) => {
      const id = primaryStorylineByNode[node.id] ?? null;
      return id ? (storylines.find((s) => s.id === id) ?? null) : null;
    },
    [primaryStorylineByNode, storylines],
  );

  const recents = useMemo(() => {
    const items = recentItems
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.usedAt - a.usedAt);
    const resolved: Array<
      | { kind: 'node'; node: BookNode; usedAt: number }
      | { kind: 'element'; id: string; name: string; color?: string; usedAt: number }
    > = [];
    for (const item of items) {
      if (item.entityType === 'node') {
        const node = bookNodes.find((n) => n.id === item.entityId);
        if (node) resolved.push({ kind: 'node', node, usedAt: item.usedAt });
      } else {
        const element = bookElements.find((e) => e.id === item.entityId);
        if (!element) continue;
        const category = categories.find((c) => c.id === element.categoryId);
        resolved.push({
          kind: 'element',
          id: element.id,
          name: element.name,
          color: category?.color?.trim() || undefined,
          usedAt: item.usedAt,
        });
      }
    }
    return resolved;
  }, [bookElements, bookNodes, categories, projectId, recentItems]);

  // Where to continue: the chapter or drift opened last, else the chapter
  // touched last.
  const continueNode = useMemo(() => {
    const recent = recents.find((item) => item.kind === 'node');
    if (recent?.kind === 'node') return recent.node;
    return [...bookNodes].filter(isChapter).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
  }, [bookNodes, recents]);
  const others = recents
    .filter((item) => !(item.kind === 'node' && item.node.id === continueNode?.id))
    .slice(0, 3);

  const storylineRows = useMemo(
    () =>
      [...storylines]
        .sort((a, b) => a.orderKey - b.orderKey)
        .map((storyline) => {
          const nodes = (mapping[storyline.id] ?? [])
            .map((id) => bookNodes.find((n) => n.id === id))
            .filter((n): n is BookNode => Boolean(n) && isChapter(n as BookNode));
          const done = nodes.filter((n) => deriveStatus(n) === 'done').length;
          const counts = nodes.map(canonicalWordCount);
          const words = counts.every((c) => c != null)
            ? counts.reduce<number>((sum, c) => sum + (c ?? 0), 0)
            : null;
          return { storyline, total: nodes.length, done, words, color: storyline.color || 'hsl(var(--ink-4))' };
        }),
    [bookNodes, mapping, storylines],
  );

  const continueStoryline = continueNode ? storylineOf(continueNode) : null;
  const continueWords = continueNode ? canonicalWordCount(continueNode) : null;

  return (
    <>
      <section className="dash-sec">
        <div className="dash-sec__head">
          <h2 className="dash-sec__title">{t('projectHome.continue.title')}</h2>
          <span className="dash-sec__spacer" />
          <button type="button" className="dash-text-button" onClick={() => navigateToAllChapters()}>
            <KindMark kind="all" />
            {t('dashboard.actions.allChapters')}
          </button>
        </div>
        {continueNode ? (
          <button
            type="button"
            className="sand-cell dash-continue"
            style={{ '--cell-c': continueStoryline?.color || undefined } as CSSProperties}
            onClick={() => openEntity({ entityType: 'node', id: continueNode.id })}
          >
            <span className="dash-continue__head">
              <KindMark
                kind={isDrift(continueNode) ? 'drift' : 'chapter'}
                seed={continueNode.id}
                color={continueStoryline?.color || undefined}
              />
              <span className="dash-continue__title">{continueNode.title || t('common.untitled')}</span>
              <span className="dash-sec__spacer" />
              {continueStoryline && (
                <KindMark kind="storyline" color={continueStoryline.color || 'hsl(var(--ink-4))'} />
              )}
              <span className="dash-ro">
                {[
                  continueStoryline?.name,
                  relativeTime(continueNode.updatedAt, i18n.language),
                  continueWords != null ? t('dashboard.wordCount', { count: continueWords.toLocaleString() }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {continueNode.summary && <span className="dash-continue__summary">{continueNode.summary}</span>}
            <i className="cell-ring" aria-hidden="true" />
          </button>
        ) : (
          <EmptyState mark="chapter" message={t('projectHome.continue.empty')} />
        )}
        {others.length > 0 && (
          <div className="dash-cells">
            {others.map((item) =>
              item.kind === 'node' ? (
                <button
                  key={item.node.id}
                  type="button"
                  className="sand-cell dash-cell"
                  style={{ '--cell-c': storylineOf(item.node)?.color || undefined } as CSSProperties}
                  onClick={() => openEntity({ entityType: 'node', id: item.node.id })}
                >
                  <KindMark
                    kind={isDrift(item.node) ? 'drift' : 'chapter'}
                    seed={item.node.id}
                    color={storylineOf(item.node)?.color || undefined}
                  />
                  <span className="dash-cell__name">{item.node.title || t('common.untitled')}</span>
                  <span className="dash-ro">{relativeTime(item.usedAt, i18n.language)}</span>
                  <i className="cell-ring" aria-hidden="true" />
                </button>
              ) : (
                <button
                  key={item.id}
                  type="button"
                  className="sand-cell dash-cell"
                  style={{ '--cell-c': item.color } as CSSProperties}
                  onClick={() => openEntity({ entityType: 'element', id: item.id })}
                >
                  <KindMark kind="element" color={item.color} />
                  <span className="dash-cell__name">{item.name || t('common.untitled')}</span>
                  <span className="dash-ro">{relativeTime(item.usedAt, i18n.language)}</span>
                  <i className="cell-ring" aria-hidden="true" />
                </button>
              ),
            )}
          </div>
        )}
      </section>

      <section className="dash-sec">
        <div className="dash-sec__head">
          <h2 className="dash-sec__title">{t('projectHome.book.title')}</h2>
          <span className="dash-sec__spacer" />
          <button type="button" className="dash-text-button" onClick={() => setActiveSuperView('graph')}>
            <BrushIcon name="branch" size={13} inline />
            {t('dashboard.actions.storyGraph')}
          </button>
          <button type="button" className="dash-text-button" onClick={() => setActiveSuperView('element')}>
            <KindMark kind="element" />
            {t('dashboard.actions.elementOverview')}
          </button>
        </div>
        {storylineRows.length > 0 ? (
          <div className="dash-lines">
            {storylineRows.map(({ storyline, total, done, words, color }) => (
              <button
                key={storyline.id}
                type="button"
                className="sand-cell dash-line"
                style={{ '--cell-c': color } as CSSProperties}
                onClick={() => openEntity({ entityType: 'storyline', id: storyline.id })}
              >
                <KindMark kind="storyline" color={color} />
                <span className="dash-line__name">{storyline.name || t('common.untitled')}</span>
                <span className="sand-track dash-line__track">
                  <span
                    className="sand-stroke"
                    style={{ width: `${total ? (done / total) * 100 : 0}%`, '--sand-c': color } as CSSProperties}
                  />
                </span>
                <span className="dash-ro dash-line__count">
                  {t('projectHome.book.storylineCount', { done, total })}
                  {words != null && ` · ${t('projectHome.words', { words: shortWords(words, i18n.language) })}`}
                </span>
                <i className="cell-ring" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <p className="ui-section-empty">{t('projectHome.book.noStorylines')}</p>
        )}
        {categories.length > 0 && (
          <div className="dash-cells">
            {[...categories]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((category) => {
                const color = category.color?.trim() || undefined;
                return (
                  <button
                    key={category.id}
                    type="button"
                    className="sand-cell dash-cell"
                    style={{ '--cell-c': color } as CSSProperties}
                    onClick={() => openEntity({ entityType: 'category', id: category.id })}
                  >
                    <KindMark kind="category" color={color} />
                    <span className="dash-cell__name">{category.name}</span>
                    <span className="dash-ro">
                      {bookElements.filter((element) => element.categoryId === category.id).length}
                    </span>
                    <i className="cell-ring" aria-hidden="true" />
                  </button>
                );
              })}
          </div>
        )}
      </section>
    </>
  );
}

function ProfileEditor({ summary, onPersist }: { summary: string; onPersist: (next: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(summary);
  const [dirty, setDirty] = useState(false);
  const [synced, setSynced] = useState(summary);
  if (synced !== summary) {
    setSynced(summary);
    if (!dirty) setDraft(summary);
  }
  return (
    <label className="ui-field ui-field--area glass glass--rest glass--field dash-profile">
      <textarea
        value={draft}
        rows={4}
        placeholder={t('dashboard.profilePlaceholder')}
        aria-label={t('dashboard.sections.projectProfile')}
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        onBlur={() => {
          setDirty(false);
          const next = draft.trim();
          if (next !== summary) onPersist(next);
        }}
      />
    </label>
  );
}

function HomeSettings({ memoryRef }: { memoryRef: RefObject<HTMLElement | null> }) {
  const { t, i18n } = useTranslation();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const currentProject = useProjectStore((s) => s.currentProject);
  const { updateProject } = useProject({ userId: userId ?? '' });
  const bookNodes = useDataStore((s) => s.bookNodes);
  const writingHistory = useWritingStatsStore((s) => s.history[projectId ?? ''] ?? undefined);
  const plan = useWritingStatsStore((s) => (projectId ? s.plans[projectId] : undefined));
  const setProjectWordTarget = useWritingStatsStore((s) => s.setProjectWordTarget);
  const setDailyWordGoal = useWritingStatsStore((s) => s.setDailyWordGoal);
  const checkinEnabled = useProjectCheckinStore((s) => s.enabled);
  const setCheckinEnabled = useProjectCheckinStore((s) => s.setEnabled);
  const projectTarget = plan?.projectWordTarget ?? 120000;
  const dailyGoal = plan?.dailyWordGoal ?? 1500;
  const total = useMemo(() => sumCanonicalChapterWordCounts(bookNodes.filter(isChapter)), [bookNodes]);
  const stats = useMemo(() => deriveWritingStats(writingHistory, total.count), [writingHistory, total.count]);

  const update = useCallback(
    (patch: { summary?: string; kvJson?: string; storylineTemplateKvJson?: string }) => {
      if (!currentProject) return;
      void updateProject(currentProject.id, {
        name: currentProject.name,
        summary: currentProject.summary,
        kvJson: currentProject.kvJson,
        storylineTemplateKvJson: currentProject.storylineTemplateKvJson,
        ...patch,
      });
    },
    [currentProject, updateProject],
  );

  if (!projectId || !currentProject) return null;
  const projectPct = total.ready && projectTarget > 0 ? Math.min(100, (total.count / projectTarget) * 100) : 0;
  const todayPct = total.ready && dailyGoal > 0 ? Math.min(100, (stats.todayWords / dailyGoal) * 100) : 0;

  return (
    <>
      <section className="dash-sec">
        <div className="dash-sec__head">
          <BrushIcon name="dharma-wheel" size={15} />
          <h2 className="dash-sec__title">{t('dashboard.sections.writingPlan')}</h2>
        </div>
        <div className="dash-plan">
          <span className="dash-plan__label">{t('projectHome.settings.projectTarget')}</span>
          <label className="ui-field ui-field--mono ui-field--sm glass glass--rest glass--field glass--small">
            <input
              type="number"
              min={0}
              step={1000}
              value={projectTarget}
              aria-label={t('projectHome.settings.projectTarget')}
              onChange={(e) => setProjectWordTarget(projectId, Number(e.target.value) || 0)}
            />
            <span className="ui-field__meta">{t('common.words')}</span>
          </label>
          <span className="dash-plan__readout">
            <span className="sand-track dash-plan__track">
              <span className="sand-stroke" style={{ width: `${projectPct}%` }} />
            </span>
            <span className="dash-ro">
              {total.ready ? `${shortWords(total.count, i18n.language)} · ${projectPct.toFixed(0)}%` : t('common.counting')}
            </span>
          </span>
          <span className="dash-plan__label">{t('projectHome.settings.dailyGoal')}</span>
          <label className="ui-field ui-field--mono ui-field--sm glass glass--rest glass--field glass--small">
            <input
              type="number"
              min={0}
              step={100}
              value={dailyGoal}
              aria-label={t('projectHome.settings.dailyGoal')}
              onChange={(e) => setDailyWordGoal(projectId, Number(e.target.value) || 0)}
            />
            <span className="ui-field__meta">{t('dashboard.plan.wordsPerDay')}</span>
          </label>
          <span className="dash-plan__readout">
            <span className="sand-track dash-plan__track">
              <span className="sand-stroke" style={{ width: `${todayPct}%` }} />
            </span>
            <span className="dash-ro">
              {total.ready ? t('projectHome.todayShort', { today: stats.todayWords.toLocaleString(i18n.language) }) : t('common.counting')}
            </span>
          </span>
        </div>
      </section>

      <section className="dash-sec">
        <div className="dash-sec__head">
          <BrushIcon name="open-book" size={15} />
          <h2 className="dash-sec__title">{t('dashboard.sections.projectProfile')}</h2>
        </div>
        <ProfileEditor
          key={`profile-${currentProject.id}`}
          summary={currentProject.summary}
          onPersist={(summary) => update({ summary })}
        />
      </section>

      <section className="dash-sec">
        <div className="dash-sec__head">
          <BrushIcon name="dharma-wheel" size={15} />
          <h2 className="dash-sec__title">{t('dashboard.sections.projectFacts')}</h2>
        </div>
        <KvEditor
          key={`project-kv-${currentProject.id}`}
          valueJson={currentProject.kvJson}
          onPersist={(kvJson) => {
            if (kvJson !== currentProject.kvJson) update({ kvJson });
          }}
          emptyHint={t('dashboard.empty.noFields')}
        />
      </section>

      <section className="dash-sec">
        <div className="dash-sec__head">
          <BrushIcon name="bamboo" size={15} />
          <h2 className="dash-sec__title">{t('dashboard.sections.storylineTemplate')}</h2>
        </div>
        <KvEditor
          key={`project-storyline-template-${currentProject.id}`}
          valueJson={currentProject.storylineTemplateKvJson}
          onPersist={(storylineTemplateKvJson) => {
            if (storylineTemplateKvJson !== currentProject.storylineTemplateKvJson) {
              update({ storylineTemplateKvJson });
            }
          }}
          variant="template"
          emptyHint={t('dashboard.empty.noTemplateFields')}
        />
      </section>

      <section className="dash-sec">
        <div className="dash-sec__head">
          <BrushIcon name="shikigami" size={15} />
          <h2 className="dash-sec__title">{t('projectHome.settings.checkin')}</h2>
          <span className="dash-sec__spacer" />
          <Switch
            size="sm"
            checked={checkinEnabled}
            onCheckedChange={setCheckinEnabled}
            aria-label={t('projectHome.settings.checkin')}
          />
        </div>
      </section>

      <section className="dash-sec" ref={memoryRef}>
        <div className="dash-sec__head">
          <BrushIcon name="knots" size={15} />
          <h2 className="dash-sec__title">{t('projectMemory.title')}</h2>
        </div>
        <ProjectMemoryEditor projectId={currentProject.id} />
      </section>
    </>
  );
}
