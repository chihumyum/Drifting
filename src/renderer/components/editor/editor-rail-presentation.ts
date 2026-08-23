import { createContext, useContext } from 'react';

export interface EditorRailPresentationValue {
  outlineVisible?: boolean;
  outlineLabelPitch?: number;
  outlinePortalTargetId?: string;
  commentPortalTargetId?: string;
}

export const EditorRailPresentationContext = createContext<EditorRailPresentationValue | null>(
  null,
);

export function useEditorRailPresentation(): EditorRailPresentationValue | null {
  return useContext(EditorRailPresentationContext);
}
