import { useMemo } from 'react';
import { marked } from 'marked';
import { noteToMarkdown } from '../../lib/note-markdown';

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
}

/**
 * A note rendered read-only like an Agent reply: Markdown from the note's
 * document, raw HTML escaped first. Used by library cards; the note itself is
 * edited in its tab.
 */
export function NoteExcerpt({
  bodyJson,
  emptyLabel,
  clamp,
  onOpen,
}: {
  bodyJson: string | null;
  emptyLabel: string;
  /** Collapsed cards show the first lines only. */
  clamp: boolean;
  onOpen: () => void;
}) {
  const html = useMemo(() => {
    // Obsidian callout markers mean nothing to marked; a callout reads as a quote.
    const markdown = noteToMarkdown(bodyJson).replace(/^> \[!note\]\n/gmu, '');
    if (!markdown) return null;
    const rendered = marked.parse(escapeHtml(markdown), { breaks: true, gfm: true, async: false }) as string;
    return rendered.replace(/==([^=\n<]+)==/gu, '<mark>$1</mark>');
  }, [bodyJson]);
  return (
    <div
      className={`library-item-card__snippet-body note-excerpt agent-md${clamp ? ' note-excerpt--clamped' : ''}`}
      onClick={onOpen}
      {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: <span className="note-excerpt__empty">{emptyLabel}</span> })}
    />
  );
}
