/**
 * Editor preferences → CSS variables.
 *
 * The editor view consumes CSS custom properties (--editor-font-family,
 * --editor-font-size, --editor-line-height, --editor-max-width,
 * --editor-indent). Centralising the application here means the editor
 * stylesheet doesn't need to know about the settings store, and the settings
 * page doesn't need to know about ProseMirror selectors.
 */
import type {
  EditorFontSource,
  FocusLineMode,
  LineHeight,
  ParagraphIndent,
} from '../store/settings-store';
import { IMPORTED_PROSE_FONT_FAMILY } from './prose-fonts';

export interface EditorPreferences {
  editorFontSource: EditorFontSource;
  editorSystemFontFamily: string;
  bodyFontSize: number;
  lineHeight: LineHeight;
  maxLineWidth: number;
  paragraphIndent: ParagraphIndent;
  /** Em per Tab indent level (drives --editor-indent-step). */
  editorIndentStep: number;
  /** Vertical gap between paragraphs in em (drives --editor-paragraph-spacing). */
  paragraphSpacing: number;
  focusLine: FocusLineMode;
  entityLinkInteractive: boolean;
}

const INDENT_EM: Record<ParagraphIndent, string> = {
  none: '0',
  one: '1em',
  two: '2em',
};

function quoteFontFamily(family: string): string {
  const escaped = family
    .trim()
    .slice(0, 128)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, ' ');
  return `"${escaped}"`;
}

export function editorFontFamilyValue(
  source: EditorFontSource,
  customSystemFamily: string,
): string {
  switch (source) {
    case 'system-sans':
      return 'var(--font-prose-system-sans)';
    case 'system-custom':
      return customSystemFamily.trim()
        ? `${quoteFontFamily(customSystemFamily)}, var(--font-prose-system-serif)`
        : 'var(--font-prose-system-serif)';
    case 'imported':
      return `"${IMPORTED_PROSE_FONT_FAMILY}", var(--font-prose-system-serif)`;
    case 'system-serif':
    default:
      return 'var(--font-prose-system-serif)';
  }
}

export function applyEditorPreferences(prefs: EditorPreferences): void {
  const root = document.documentElement;
  root.style.setProperty(
    '--editor-font-family',
    editorFontFamilyValue(prefs.editorFontSource, prefs.editorSystemFontFamily),
  );
  root.style.setProperty('--editor-font-size', `${prefs.bodyFontSize}px`);
  root.style.setProperty('--editor-line-height', String(prefs.lineHeight));
  root.style.setProperty('--editor-max-width', `${prefs.maxLineWidth}px`);
  root.style.setProperty('--editor-indent', INDENT_EM[prefs.paragraphIndent]);
  root.style.setProperty('--editor-indent-step', `${prefs.editorIndentStep}em`);
  root.style.setProperty('--editor-paragraph-spacing', `${prefs.paragraphSpacing}em`);
  root.setAttribute('data-focus-line', prefs.focusLine);
  root.setAttribute('data-entity-link-interactive', prefs.entityLinkInteractive ? 'on' : 'off');
}
