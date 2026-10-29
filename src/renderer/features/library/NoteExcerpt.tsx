import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { noteMarkdownExcerpt } from '../../lib/note-markdown';

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
  const ref = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (nearViewport || !ref.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '400px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [nearViewport]);
  const html = useMemo(() => {
    if (!nearViewport) return null;
    // Obsidian callout markers mean nothing to marked; a callout reads as a quote.
    const markdown = noteMarkdownExcerpt(bodyJson, !clamp).replace(/^> \[!note\]\n/gmu, '');
    if (!markdown) return null;
    const rendered = marked.parse(escapeHtml(markdown), { breaks: true, gfm: true, async: false }) as string;
    return rendered.replace(/==([^=\n<]+)==/gu, '<mark>$1</mark>');
  }, [bodyJson, clamp, nearViewport]);
  return (
    <div
      ref={ref}
      className={`library-item-card__snippet-body note-excerpt agent-md${clamp ? ' note-excerpt--clamped' : ''}`}
      onClick={onOpen}
      style={{ maxHeight: clamp ? '9em' : '18em', minHeight: nearViewport ? undefined : (clamp ? '9em' : '18em'), overflow: 'hidden' }}
      {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: nearViewport ? <span className="note-excerpt__empty">{emptyLabel}</span> : null })}
    />
  );
}
