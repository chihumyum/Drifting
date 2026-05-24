/**
 * Editor preferences → CSS variables.
 *
 * The editor view consumes CSS custom properties (--editor-font-size,
 * --editor-line-height, --editor-max-width, --editor-indent). Centralising
 * the application here means the editor stylesheet doesn't need to know
 * about the settings store, and the settings page doesn't need to know
 * about ProseMirror selectors.
 */
import type { FocusLineMode, LineHeight, ParagraphIndent } from '../store/settings-store';

export interface EditorPreferences {
  bodyFontSize: number;
  lineHeight: LineHeight;
  maxLineWidth: number;
  paragraphIndent: ParagraphIndent;
  focusLine: FocusLineMode;
  entityHighlight: boolean;
  entityLinkInteractive: boolean;
}

const INDENT_EM: Record<ParagraphIndent, string> = {
  none: '0',
  one: '1em',
  two: '2em',
};

export function applyEditorPreferences(prefs: EditorPreferences): void {
  const root = document.documentElement;
  root.style.setProperty('--editor-font-size', `${prefs.bodyFontSize}px`);
  root.style.setProperty('--editor-line-height', String(prefs.lineHeight));
  root.style.setProperty('--editor-max-width', `${prefs.maxLineWidth}px`);
  root.style.setProperty('--editor-indent', INDENT_EM[prefs.paragraphIndent]);
  root.setAttribute('data-focus-line', prefs.focusLine);
  root.setAttribute('data-entity-highlight', prefs.entityHighlight ? 'on' : 'off');
  root.setAttribute('data-entity-link-interactive', prefs.entityLinkInteractive ? 'on' : 'off');
}
