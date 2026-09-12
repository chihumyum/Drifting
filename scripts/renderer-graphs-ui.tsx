import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceNavigationButtons } from '../src/renderer/components/topBars/WorkspaceNavigationButtons';
import { MobileSettingsView } from '../src/renderer/shells/mobile/standalone/MobileSettingsView';
import { useUiStore } from '../src/renderer/store/ui-store';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import { SuperViewNavigationProvider } from '../src/renderer/components/SuperViewNavigationContext';
import { SuperViewRelationUiProvider } from '../src/renderer/features/graph/SuperViewRelationUiContext';
import { MobileSuperViewHost } from '../src/renderer/shells/mobile/workspace/MobileSuperViewHost';
import { StoryGraphView } from '../src/renderer/views/StoryGraphView';
import { SuperElementView } from '../src/renderer/views/SuperViews/SuperElementView';
import { createSyntheticWorkspaceProjection } from '../src/renderer/performance/fixture';
import { genericAssociationRelationType } from '../src/renderer/domain/entity-relation-type';
import { useDataStore } from '../src/renderer/store/data-store';
import '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/ui-controls.css';
import '../src/styles/desktop-shell.css';
import '../src/styles/settings.css';
import '../src/styles/mobile-workspace.css';

type View = 'none' | 'graph' | 'element' | 'memo-material';
const observations = { mounts: 0, unmounts: 0, active: 'none', projectId: 'synthetic-a', editorId: '', text: '' };
let editor: Editor | null = null;
function publish(projectId: string) {
  const state = useDataStore.getState();
  const fixture = createSyntheticWorkspaceProjection(projectId, 12, 8);
  fixture.bookNodes = fixture.bookNodes.map((node, index) => ({ ...node,
    title: `${projectId} chapter ${index}`, ...(index === 0 ? { kind: 'drift' as const, bookOrder: null, narrativeOrder: null } : {}),
  }));
  fixture.bookElements = fixture.bookElements.map((element, index) => ({ ...element, name: `${projectId} element ${index}` }));
  const type = genericAssociationRelationType(projectId, '2026-09-12T00:00:00.000Z');
  fixture.entityRelationTypes = [type];
  fixture.entityRelations = [[1, 2], [0, 1]].map(([from, to], index) => ({
    id: `synthetic-edge-${index}`, projectId, fromKind: 'node', fromId: fixture.bookNodes[from].id,
    toKind: 'node', toId: fixture.bookNodes[to].id, relationTypeId: type.id, createdAt: type.createdAt, updatedAt: type.updatedAt,
  }));
  const epoch = state.requestWorkspaceProjection(projectId, 'loading');
  state.commitWorkspaceProjection(projectId, epoch, fixture);
}
const api = {
  observations, open: (_view: View) => {}, project: (_project: string) => {}, navigate: (_path: string) => {},
  edit() { editor!.commands.insertContent(' synthetic edit'); },
  inspect() { return { ...observations, text: editor?.getText() }; },
};

export function Draft() {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const doc = new Y.Doc();
    const instance = new Editor({ element: host.current!, extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc })] });
    instance.commands.setContent('<p>Synthetic draft</p>');
    editor = instance; observations.mounts++; observations.editorId = doc.guid;
    return () => { observations.unmounts++; instance.destroy(); doc.destroy(); editor = null; };
  }, []);
  return <div id="synthetic-editor" ref={host} />;
}
export function Fixture() {
  const active = useUiStore(state => state.activeSuperView);
  const setActive = useUiStore(state => state.setActiveSuperView);
  const route = useLocation();
  const navigate = useNavigate();
  const preload = new URLSearchParams(location.search).has('preload');
  const [projectId, setProjectId] = useState('synthetic-a');
  const mobile = new URLSearchParams(location.search).has('mobile');
  const navigator = useMemo(() => ({ projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }), [projectId]);
  const navigation = useMemo(() => ({ active, setActive }), [active, setActive]);
  useLayoutEffect(() => {
    observations.active = active; observations.projectId = projectId;
    api.open = setActive; api.navigate = navigate;
    api.project = (next) => { publish(next); setProjectId(next); };
  }, [active, projectId, setActive, navigate]);
  return <WorkspaceNavigationProvider navigator={navigator}>
    <SuperViewRelationUiProvider projectId={projectId} key={projectId}>
      <SuperViewNavigationProvider value={navigation}>
        <Draft />
        {preload && (route.pathname === '/settings' ? <MobileSettingsView /> : <WorkspaceNavigationButtons />)}
        {mobile ? <MobileSuperViewHost active={active === 'none' ? null : active} onActiveChange={(next) => setActive(next ?? 'none')} returnPointCaptured />
          : <>{active === 'graph' && <StoryGraphView />}{active === 'element' && <SuperElementView />}</>}
      </SuperViewNavigationProvider>
    </SuperViewRelationUiProvider>
  </WorkspaceNavigationProvider>;
}
publish('synthetic-a');
useUiStore.setState({ activeSuperView: 'none', lastActiveSuperView: 'graph' });
Object.assign(window, { __GRAPHS_UI__: api });
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
