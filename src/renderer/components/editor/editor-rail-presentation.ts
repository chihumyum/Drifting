import { createContext, useContext } from 'react';

export interface EditorRailPresentationValue {
  outlineVisible?: boolean;
  /** A host that owns `outlineVisible` (the element overview's island) takes
   *  the paper toolbar's outline button too, instead of the global setting. */
  onOutlineToggle?: () => void;
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
