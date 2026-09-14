/* eslint-disable react-refresh/only-export-components -- The deferred code registry is a reload boundary, not a Fast Refresh component export. */
import { getPlatformRuntime } from '../platform/runtime';
import { DesktopAppShell } from '../shells/desktop/DesktopAppShell';
import { MobileAppShell } from '../shells/mobile/MobileAppShell';
import { MobileSettingsView } from '../shells/mobile/standalone/MobileSettingsView';
import { DesktopStandaloneSettingsView } from '../features/settings/desktop/DesktopStandaloneSettingsView';
import { EditorShell } from '../views/EditorShell';
import { ProjectDashboard } from '../views/ProjectDashboard';
import {
  DesktopAllChaptersEditorRoute, DesktopCategoryEditorRoute, DesktopElementEditorRoute,
  DesktopNodeEditorRoute, DesktopStorylineEditorRoute,
} from '../features/editor/desktop/DesktopEditorRoutes';

function Workspace() {
  const isMobileShell = getPlatformRuntime().isMobileShell;
  return isMobileShell ? <MobileAppShell /> : <DesktopAppShell />;
}
function Settings() {
  const isMobileShell = getPlatformRuntime().isMobileShell;
  return isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />;
}
function Home() { return <EditorShell view="project-home"><ProjectDashboard /></EditorShell>; }
function AllChapters() { return <EditorShell view="all-chapters-editor"><DesktopAllChaptersEditorRoute /></EditorShell>; }
function Node() { return <EditorShell view="node-editor"><DesktopNodeEditorRoute /></EditorShell>; }
function Storyline() { return <EditorShell view="storyline-editor"><DesktopStorylineEditorRoute /></EditorShell>; }
function Element() { return <EditorShell view="element-editor"><DesktopElementEditorRoute /></EditorShell>; }
function Category() { return <EditorShell view="category-editor"><DesktopCategoryEditorRoute /></EditorShell>; }

// Module cache contains component code only. Project runtime and editor/session
// ownership remain inside the existing shells, mounted after the route is ready.
export const projectRoutes = { workspace: Workspace, settings: Settings, home: Home, allChapters: AllChapters, node: Node, storyline: Storyline, element: Element, category: Category };
