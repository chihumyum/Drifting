import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';

import type { BookElement } from '../../domain/book-element';

export type ElementIdentityAgentState = 'busy' | 'added' | 'changed' | null;

interface ElementIdentityTileProps {
  element: BookElement;
  selected: boolean;
  agentState: ElementIdentityAgentState;
  agentStateLabel?: string;
  onActivate: () => void;
  onPromote: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPreviewEnter: (anchor: HTMLElement) => void;
  onPreviewLeave: () => void;
}

/**
 * Approximate the readable width of a label without measuring the DOM. Latin
 * glyphs consume about half the width of CJK glyphs; the bounded result lets a
 * wrapping flex row fit more short names while reserving room for long ones.
 */
function compactIdentityBasis(name: string): string {
  const units = Array.from(name.trim()).reduce((total, glyph) => {
    if (/\s/u.test(glyph)) return total + 0.35;
    return total + ((glyph.codePointAt(0) ?? 0) <= 0xff ? 0.62 : 1);
  }, 0);
  return `${Math.round(Math.min(156, Math.max(70, 34 + units * 8)))}px`;
}

/**
 * Compact text identity for the Element panel. The complete name is always the
 * primary content; its flex basis follows the name's approximate reading width
 * and then grows with the remaining room in that row.
 */
export function ElementIdentityTile({
  element,
  selected,
  agentState,
  agentStateLabel,
  onActivate,
  onPromote,
  onContextMenu,
  onPreviewEnter,
  onPreviewLeave,
}: ElementIdentityTileProps) {
  const label = element.name.trim() || '?';
  const statusMark = agentState === 'added' ? 'A' : agentState === 'changed' ? 'M' : '';
  const style = {
    '--element-identity-basis': compactIdentityBasis(label),
  } as CSSProperties;

  return (
    <button
      type="button"
      className={`workspace-list-row element-identity-tile${selected ? ' is-selected' : ''}`}
      style={style}
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
      onClick={onActivate}
      onDoubleClick={onPromote}
      onContextMenu={onContextMenu}
      onMouseEnter={(event) => onPreviewEnter(event.currentTarget)}
      onMouseLeave={onPreviewLeave}
      onFocus={(event) => onPreviewEnter(event.currentTarget)}
      onBlur={onPreviewLeave}
    >
      <span className="element-identity-tile__label">{label}</span>

      {agentState && (
        <span
          aria-hidden
          title={agentStateLabel}
          className={`element-identity-tile__agent element-identity-tile__agent--${agentState}${
            agentState === 'busy' ? ' agent-glyph-busy' : ''
          }`}
        >
          {statusMark}
        </span>
      )}
    </button>
  );
}
