import { AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Sparkles, Search, Workflow, CalendarRange } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useInputPreservingActions } from '../../../hooks/useInputPreservingActions';
import { getActiveEditor } from '../../../lib/active-editor';
import { MobileUnifiedBackAction } from './MobileUnifiedBackAction';
import { MobilePaperAgent } from './MobilePaperAgent';
import { MobileEditorAccessory } from './MobileEditorAccessory';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';
import {
  selectMobileUnifiedBarProjection,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';
import {
  MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT,
  readMobileKeyboardInset,
  readMobileKeyboardViewportOffsetTop,
  readMobileSoftwareKeyboardVisible,
} from './mobile-keyboard-geometry';
import {
  emptyMobilePaperSearchSnapshot,
  getMobilePaperSearchOwner,
  subscribeMobilePaperSearchOwner,
  type MobilePaperSearchOwner,
} from './mobile-paper-search';

const subscribeNothing = () => () => undefined;

function MobileUnifiedSearch({
  owner,
}: {
  owner: MobilePaperSearchOwner | null;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seededOwnerRef = useRef<MobilePaperSearchOwner | null>(null);
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? subscribeNothing,
    owner?.getSnapshot ?? emptyMobilePaperSearchSnapshot,
    emptyMobilePaperSearchSnapshot,
  );
  useLayoutEffect(() => {
    // Search owns this input, not the prose editor. Native `autoFocus` lets
    // WebKit scroll the paper to expose a bottom-edge control before the IME
    // geometry arrives. Focus explicitly without scrolling so opening Search
    // never masquerades as an editor/caret transition.
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    // Seed a selected prose range once per Search session. An empty query after
    // Backspace is author input, not permission to reinsert the selection.
    if (!owner || seededOwnerRef.current === owner) return;
    seededOwnerRef.current = owner;
    if (snapshot.query) return;
    const editor = getActiveEditor();
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const selected = editor.state.doc.textBetween(from, to, ' ').trim();
    if (selected) owner.setQuery(selected);
  }, [owner, snapshot.query]);
  return (
    <div className="m-unified-search">
      <input
        ref={inputRef}
        value={snapshot.query}
        onChange={(event) => owner?.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (event.shiftKey) owner?.previous();
          else owner?.next();
        }}
        placeholder={t('findPanel.currentPlaceholder')}
        aria-label={t('findPanel.currentPlaceholder')}
      />
      <span aria-live="polite">
        {snapshot.status === 'searching'
          ? '…'
          : snapshot.total === 0
            ? '0/0'
            : `${snapshot.currentIndex + 1}/${snapshot.total}`}
      </span>
    </div>
  );
}

function MobileUnifiedSearchStep({
  disabled,
  onActivate,
  label,
  children,
}: {
  disabled: boolean;
  onActivate: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button type="button" className="m-unified-bar__action m-unified-search__step"
      disabled={disabled} aria-label={label} onClick={onActivate}>
      {children}
    </button>
  );
}


export function MobileUnifiedBar({
  workspaceUi,
  projectId,
  paperKey,
  onOpenTool,
  keyboardInset,
  editorAccessoryMode,
  onEditorAccessoryModeChange,
  onEditingStateChange,
  onKeyboardStateChange,
  onKeyboardInsetChange,
  onKeyboardViewportOffsetTopChange,
}: {
  workspaceUi: MobileWorkspaceUiState;
  projectId: string;
  paperKey: string;
  onOpenTool: (tool: 'agent' | 'search' | 'plot' | 'timeline') => void;
  keyboardInset: number;
  editorAccessoryMode: 'navigation' | 'formatting';
  onEditorAccessoryModeChange: (mode: 'navigation' | 'formatting') => void;
  onEditingStateChange: (editing: boolean) => void;
  onKeyboardStateChange: (keyboard: 'closed' | 'open') => void;
  onKeyboardInsetChange: (inset: number) => void;
  onKeyboardViewportOffsetTopChange: (offsetTop: number) => void;
}) {
  const { t } = useTranslation();
  const projection = selectMobileUnifiedBarProjection(workspaceUi);
  const searchOwner = useSyncExternalStore(
    subscribeMobilePaperSearchOwner,
    getMobilePaperSearchOwner,
    () => null,
  );

  useEffect(() => {
    if (projection.mode !== 'search' && projection.mode !== 'agent-input' && workspaceUi.overlay !== 'plot' && workspaceUi.overlay !== 'timeline') return undefined;
    const viewport = window.visualViewport;
    let frame = 0;
    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const inset = readMobileKeyboardInset();
        onKeyboardInsetChange(inset);
        onKeyboardViewportOffsetTopChange(readMobileKeyboardViewportOffsetTop());
        onKeyboardStateChange(readMobileSoftwareKeyboardVisible() ? 'open' : 'closed');
      });
    };
    sync();
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
      searchOwner?.clear();
    };
  }, [
    onKeyboardInsetChange,
    onKeyboardViewportOffsetTopChange,
    onKeyboardStateChange,
    projection.mode,
    workspaceUi.overlay,
    searchOwner,
  ]);
  // Every editor-owned Back must keep ProseMirror focused until the typed Back
  // request resolves. Otherwise pointerdown emits blur first, the controller
  // becomes read, and the later click is incorrectly resolved as paper-root.
  const backPreservesFocusUntilResolution =
    projection.mode === 'edit' || projection.mode === 'search' || projection.mode === 'agent-input' || ((workspaceUi.overlay === 'plot' || workspaceUi.overlay === 'timeline') && workspaceUi.keyboard === 'open');
  const handleBack = () =>
    requestMobileWorkspaceBack('visible', {
      preflightDom: projection.mode !== 'edit' && projection.mode !== 'search',
    });
  const backLabel = t('navigation.back');
  const inputActions = useInputPreservingActions<HTMLElement>(true, true);

  const rootTools = [
    ['agent', Sparkles, 'Agent'],
    ['search', Search, t('mobileWorkspace.search.open')],
    ['plot', Workflow, t('mobileWorkspace.paperAgent.plot')],
    ['timeline', CalendarRange, t('mobileWorkspace.paperAgent.timeline')],
  ] as const;
  return (
    <>
    <AnimatePresence>
    {/* Entering Agent always hands input to the composer: an editing origin
        transfers its open IME, a reading origin summons it like Search does. */}
    {projection.visible && projection.mode === 'agent-input' && <MobilePaperAgent key={paperKey} projectId={projectId} paperKey={paperKey} keyboardInset={keyboardInset}
      focusComposer={workspaceUi.transient.kind === 'agent-input'} onClose={handleBack} />}
    </AnimatePresence>
    <footer
      {...inputActions}
      className="m-unified-bar"
      data-debug-id="mobile-unified-bar"
      inert={!projection.visible || projection.mode === 'agent-input'}
      data-mode={projection.mode}
      data-keyboard={workspaceUi.keyboard}
      data-visible={projection.visible && projection.mode !== 'agent-input' ? 'true' : 'false'}
      style={{ '--m-unified-keyboard-inset': `${keyboardInset}px` } as CSSProperties}
      aria-label={t('mobileWorkspace.unifiedBar', { defaultValue: '移动工作栏' })}
    >
      <div
        className="m-unified-bar__content"
      >
        {projection.mode === 'search' ? (
          <>
            <MobileUnifiedBackAction
              preserveFocusUntilBack={backPreservesFocusUntilResolution}
              onBack={handleBack}
              label={backLabel}
            />
            <MobileUnifiedSearch owner={searchOwner} />
            <MobileUnifiedSearchStep
              disabled={!searchOwner}
              onActivate={() => searchOwner?.previous()}
              label={t('findPanel.previousTitle')}
            >
              <ChevronUp size={19} aria-hidden="true" />
            </MobileUnifiedSearchStep>
            <MobileUnifiedSearchStep
              disabled={!searchOwner}
              onActivate={() => searchOwner?.next()}
              label={t('findPanel.nextTitle')}
            >
              <ChevronDown size={19} aria-hidden="true" />
            </MobileUnifiedSearchStep>
          </>
        ) : (
          <>
            {(projection.mode !== 'read' || workspaceUi.overlay === 'plot' || workspaceUi.overlay === 'timeline') && (
              <MobileUnifiedBackAction
                preserveFocusUntilBack={backPreservesFocusUntilResolution}
                onBack={handleBack}
                label={backLabel}
              />
            )}
            {projection.mode !== 'agent-input' && <MobileEditorAccessory
              active={projection.mode === 'edit'}
              mode={editorAccessoryMode}
              onModeChange={onEditorAccessoryModeChange}
              onEditingStateChange={onEditingStateChange}
              onKeyboardInsetChange={onKeyboardInsetChange}
              onKeyboardViewportOffsetTopChange={onKeyboardViewportOffsetTopChange}
            />}
            {(projection.mode === 'read' || (projection.mode === 'edit' && editorAccessoryMode === 'navigation')) && rootTools.map(([tool, Icon, label]) => (
              <button key={tool} type="button" className="m-unified-bar__tool" data-debug-id={`mobile-tool-${tool}`}
                aria-label={label} aria-pressed={workspaceUi.overlay === tool}
                onClick={() => onOpenTool(tool)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button>
            ))}
          </>
        )}
      </div>
    </footer>
    </>
  );
}
