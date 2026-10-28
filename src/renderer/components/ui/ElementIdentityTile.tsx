import type { CSSProperties } from 'react';

import type { BookElement } from '../../domain/book-element';
import { AgentChangeIndicator } from '../leftBars/AgentChangeIndicator';
import { KindMark } from './KindMark';
import { SandCell } from './SandCell';

/** Tile padding-left 8px plus half of its 10px seal. */
const TILE_MARK_CENTER = 13;

export type ElementIdentityAgentState = 'busy' | 'added' | 'changed' | null;

interface ElementIdentityTileProps {
  element: BookElement;
  selected: boolean;
  /** Category colour: the square seal, the hover ring and the selection frame. */
  color: string;
  agentState: ElementIdentityAgentState;
  agentStateLabel?: string;
  onAgentSeen?: () => void;
  onActivate: () => void;
  onPromote: () => void;
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
  // The seal and its gap take 16px before the name.
  return `${Math.round(Math.min(172, Math.max(80, 44 + units * 12.5)))}px`;
}

/**
 * Compact text identity for the Element panel: the element's square seal and
 * its complete name. The flex basis follows the name's approximate reading
 * width and then grows with the remaining room in that row. It is a sand cell
 * (hover ring, frame drawn from the seal when selected) with a tile frame.
 */
export function ElementIdentityTile({
  element,
  selected,
  color,
  agentState,
  agentStateLabel,
  onAgentSeen,
  onActivate,
  onPromote,
  onPreviewEnter,
  onPreviewLeave,
}: ElementIdentityTileProps) {
  const label = element.name.trim() || '?';
  const statusMark = agentState === 'added' ? 'A' : agentState === 'changed' ? 'M' : '';
  const style = {
    '--element-identity-basis': compactIdentityBasis(label),
  } as CSSProperties;

  return (
    <SandCell
      tile
      selected={selected}
      color={color}
      markCenter={TILE_MARK_CENTER}
      className="element-identity-tile"
      style={style}
      onClick={onActivate}
      onDoubleClick={onPromote}
      onMouseEnter={(event) => onPreviewEnter(event.currentTarget)}
      onMouseLeave={onPreviewLeave}
      onFocus={(event) => onPreviewEnter(event.currentTarget)}
      onBlur={onPreviewLeave}
    >
      <button
        type="button"
        className="element-identity-tile__open"
        aria-label={label}
        aria-current={selected ? 'page' : undefined}
        onClick={(event) => { event.stopPropagation(); onActivate(); }}
        onDoubleClick={(event) => { event.stopPropagation(); onPromote(); }}
      >
        <KindMark kind="element" color={color} busy={agentState === 'busy'} />
        <span className="element-panel-item-label element-identity-tile__label">{label}</span>
      </button>

      {(agentState === 'added' || agentState === 'changed') && (
        <AgentChangeIndicator
          onClick={onAgentSeen}
          title={agentStateLabel}
          className={`element-identity-tile__agent element-identity-tile__agent--${agentState}`}
        >
          {statusMark}
        </AgentChangeIndicator>
      )}
    </SandCell>
  );
}
