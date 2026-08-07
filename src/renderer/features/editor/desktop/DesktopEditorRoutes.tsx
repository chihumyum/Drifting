import { AllChaptersEditorView } from '../../../views/AllChaptersEditorView';
import { CategoryEditorView } from '../../../views/CategoryEditorView';
import { ElementEditorView } from '../../../views/ElementEditorView';
import { NodeEditorView } from '../../../views/NodeEditorView';
import { StorylineEditorView } from '../../../views/StorylineEditorView';

export function DesktopAllChaptersEditorRoute() {
  return <AllChaptersEditorView />;
}

export function DesktopNodeEditorRoute() {
  return <NodeEditorView />;
}

export function DesktopStorylineEditorRoute() {
  return <StorylineEditorView />;
}

export function DesktopElementEditorRoute() {
  return <ElementEditorView />;
}

export function DesktopCategoryEditorRoute() {
  return <CategoryEditorView />;
}
