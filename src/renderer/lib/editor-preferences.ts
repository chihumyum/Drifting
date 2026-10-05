/**
 * Authored-content preferences → CSS variables.
 *
 * Manuscript prose, entity bodies/templates and patch bodies share the content
 * font, font size, line height and paragraph spacing on desktop and mobile.
 * Layout-specific preferences remain owned by each surface's styles.
 * Centralising the application here keeps styles independent from the store.
 */
import type {
  EditorFontSource,
  EditorTextWrap,
  LineHeight,
  ParagraphIndent,
} from '../store/settings-store';
import type { EntityLinkColorMode } from './entity-link-appearance';
import { IMPORTED_PROSE_FONT_FAMILY } from './prose-fonts';

export interface EditorPreferences {
  editorFontSource: EditorFontSource;
  editorSystemFontFamily: string;
  bodyFontSize: number;
  lineHeight: LineHeight;
  maxLineWidth: number;
  editorTextWrap: EditorTextWrap;
  paragraphIndent: ParagraphIndent;
  /** Em per Tab indent level (drives --editor-indent-step). */
  editorIndentStep: number;
  /** Gap after paragraphs/headings in body-font em (resolved to px for every block). */
  paragraphSpacing: number;
  caretColor: string;
  entityLinkInteractive: boolean;
  entityLinkColorMode: EntityLinkColorMode;
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
    case 'system-mono':
      return 'var(--font-prose-mono)';
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
  root.style.setProperty('--editor-text-wrap', prefs.editorTextWrap);
  root.style.setProperty('--editor-indent', INDENT_EM[prefs.paragraphIndent]);
  root.style.setProperty('--editor-indent-step', `${prefs.editorIndentStep}em`);
  // Resolve against the body size once; heading-local em would enlarge the gap.
  root.style.setProperty('--editor-paragraph-spacing', `${prefs.paragraphSpacing * prefs.bodyFontSize}px`);
  root.style.setProperty('--editor-caret-color', prefs.caretColor);
  root.setAttribute('data-entity-link-interactive', prefs.entityLinkInteractive ? 'on' : 'off');
  root.setAttribute('data-entity-link-style', prefs.entityLinkColorMode);
}
