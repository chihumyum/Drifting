import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties, type MutableRefObject } from 'react';
import type { BookElement } from '../../domain/book-element';
import { KindMark } from '../../components/ui/KindMark';
import { SandCell } from '../../components/ui/SandCell';
import { EDGE_HIT_WIDTH } from './super-element-metrics';
import { relateCellHalf, relateEdgeGeometry, relateRoleHalf, type RelatePoint } from './element-relate-layout';

/** One relation drawn in the 关系 layout. */
export interface RelateEdgeView {
  id: string;
  fromId: string;
  toId: string;
  color: string;
  /** [source role, target role] when directed, [shared role] when symmetric. */
  roles: readonly string[];
  bend: number;
  title: string;
}

export interface SuperElementRelateLayerHandle {
  /** Write every cell's and line's place from `live`; called on each frame the layout moves. */
  paint: () => void;
}

export interface SuperElementRelateLayerProps {
  elements: readonly BookElement[];
  colorOf: (element: BookElement) => string | undefined;
  live: MutableRefObject<Map<string, RelatePoint>>;
  /** Where an element without a place yet is drawn (its island). */
  fallback: ReadonlyMap<string, RelatePoint>;
  edges: readonly RelateEdgeView[];
  /** Role names on every line, only on the lines of `activeElementId`, or on none. */
  roleLabels: 'all' | 'active' | 'none';
  /** From far away the role names are drawn larger than the world so they still read. */
  labelScale: number;
  activeElementId: string | null;
  selectedEdgeIds: ReadonlySet<string>;
  /** An element is in focus: the other lines recede, or leave while only its neighbourhood is shown. */
  receding: 'none' | 'recede' | 'hide';
  focusedElementId: string | null;
  connectedElementIds: ReadonlySet<string> | null;
  dimmedElementIds: ReadonlySet<string> | null;
  hiddenElementIds: ReadonlySet<string> | null;
  markWeights: ReadonlyMap<string, number> | null;
  linkSourceElementId: string | null;
  draggingElementId: string | null;
  pinnedElementIds: ReadonlySet<string>;
  /** The most-mentioned elements: from far away they keep their names. */
  majorElementIds: ReadonlySet<string>;
  elementCardRefs?: MutableRefObject<Map<string, HTMLDivElement>>;
  edgeWidths: { normal: number; selected: number };
  onElementClick: (element: BookElement, anchor: DOMRect, opts: { shiftKey: boolean }) => void;
  onElementPreviewEnter?: (element: BookElement, anchor: HTMLElement) => void;
  onPreviewLeave?: () => void;
  selectEdge: (id: string, clientX: number, clientY: number) => void;
}

interface EdgeNodes {
  hit: SVGPathElement | null;
  line: SVGPathElement | null;
  labels: (SVGGElement | null)[];
}

/**
 * The 关系 layout's cells and relation lines, inside the world transform.
 * React draws what each one is; where each one is comes from `live` and is
 * written straight to the DOM (`paint`), after every render and on every
 * frame of a run, so a settling layout never re-renders the canvas.
 */
const RelateLayer = forwardRef<SuperElementRelateLayerHandle, SuperElementRelateLayerProps>(function RelateLayer({
  elements, colorOf, live, fallback, edges, roleLabels, labelScale, activeElementId, selectedEdgeIds, receding,
  focusedElementId, connectedElementIds, dimmedElementIds, hiddenElementIds, markWeights,
  linkSourceElementId, draggingElementId, pinnedElementIds, majorElementIds, elementCardRefs, edgeWidths,
  onElementClick, onElementPreviewEnter, onPreviewLeave, selectEdge,
}, ref) {
  const cells = useRef(new Map<string, HTMLDivElement>());
  const edgeNodes = useRef(new Map<string, EdgeNodes>());
  const names = useMemo(() => new Map(elements.map((element) => [element.id, element.name])), [elements]);
  const labelled = useCallback((edge: RelateEdgeView) => {
    if (roleLabels === 'none') return false;
    const touches = activeElementId !== null && (edge.fromId === activeElementId || edge.toId === activeElementId);
    if (roleLabels === 'active') return touches;
    return activeElementId === null || touches;
  }, [roleLabels, activeElementId]);

  const paint = useCallback(() => {
    const at = (id: string) => live.current.get(id) ?? fallback.get(id);
    for (const [id, cell] of cells.current) {
      const point = at(id);
      if (!point) continue;
      cell.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
    for (const edge of edges) {
      const nodes = edgeNodes.current.get(edge.id);
      const from = at(edge.fromId);
      const to = at(edge.toId);
      if (!nodes || !from || !to) continue;
      const geometry = relateEdgeGeometry({
        fromId: edge.fromId, toId: edge.toId, from, to,
        fromHalf: relateCellHalf(names.get(edge.fromId) ?? ''),
        toHalf: relateCellHalf(names.get(edge.toId) ?? ''),
        bend: edge.bend, roles: edge.roles, labelScale,
      });
      nodes.hit?.setAttribute('d', geometry.d);
      nodes.line?.setAttribute('d', geometry.d);
      const show = labelled(edge) && geometry.labels.length > 0;
      nodes.labels.forEach((label, index) => {
        if (!label) return;
        const place = geometry.labels[index];
        if (!show || !place) {
          label.style.opacity = '0';
          return;
        }
        label.setAttribute('transform', `translate(${place.x.toFixed(1)} ${place.y.toFixed(1)}) scale(${labelScale.toFixed(3)})`);
        label.style.opacity = geometry.labelAlpha.toFixed(2);
      });
    }
  }, [edges, fallback, labelScale, labelled, live, names]);
  useImperativeHandle(ref, () => ({ paint }), [paint]);
  // Places follow every render: a cell that just mounted lands where it belongs.
  useLayoutEffect(() => paint());

  return (
    <>
      <svg className="se-relate-lines" aria-hidden={false}>
        {edges.map((edge) => {
          const selected = selectedEdgeIds.has(edge.id);
          if (receding === 'hide' && !selected) return null;
          const receded = receding !== 'none' && !selected;
          const register = (patch: Partial<EdgeNodes>) => {
            const current = edgeNodes.current.get(edge.id) ?? { hit: null, line: null, labels: [] };
            edgeNodes.current.set(edge.id, { ...current, ...patch });
          };
          return (
            <g
              key={edge.id}
              data-super-edge
              className={['se-relate-line', selected ? 'is-selected' : '', receded ? 'is-receded' : ''].filter(Boolean).join(' ')}
              style={{ '--se-line-c': edge.color } as CSSProperties}
            >
              <path
                ref={(node) => register({ hit: node })}
                className="se-relate-line__hit"
                strokeWidth={EDGE_HIT_WIDTH}
                onClick={(event) => {
                  event.stopPropagation();
                  selectEdge(edge.id, event.clientX, event.clientY);
                }}
              >
                <title>{edge.title}</title>
              </path>
              <path
                ref={(node) => register({ line: node })}
                className="se-relate-line__stroke"
                strokeWidth={selected ? edgeWidths.selected : edgeWidths.normal}
              />
              {edge.roles.filter(Boolean).map((role, index) => {
                const half = relateRoleHalf(role);
                return (
                  <g
                    key={`${index}:${role}`}
                    ref={(node) => {
                      const current = edgeNodes.current.get(edge.id) ?? { hit: null, line: null, labels: [] };
                      const labels = current.labels.slice();
                      labels[index] = node;
                      edgeNodes.current.set(edge.id, { ...current, labels });
                    }}
                    className="se-relate-role"
                    style={{ opacity: 0 }}
                  >
                    <rect x={-half.hw} y={-half.hh} width={half.hw * 2} height={half.hh * 2} rx={4} />
                    <text>{role}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {elements.map((element) => {
        const color = colorOf(element);
        const weight = markWeights?.get(element.id);
        const focused = focusedElementId === element.id;
        const linkSource = linkSourceElementId === element.id;
        const lit = !linkSource && !focused && !!connectedElementIds?.has(element.id);
        return (
          <SandCell
            key={element.id}
            ref={(node) => {
              if (node) cells.current.set(element.id, node);
              else cells.current.delete(element.id);
              if (!elementCardRefs) return;
              if (node) elementCardRefs.current.set(element.id, node);
              else elementCardRefs.current.delete(element.id);
            }}
            selected={focused}
            color={color}
            data-super-card="element"
            data-element-id={element.id}
            className={[
              'se-card',
              'se-card--free',
              lit ? 'is-on' : '',
              linkSource ? 'is-held' : '',
              markWeights && weight === undefined ? 'is-unmentioned' : '',
              dimmedElementIds?.has(element.id) && !focused ? 'is-dim' : '',
              hiddenElementIds?.has(element.id) ? 'is-gone' : '',
              draggingElementId === element.id ? 'is-dragged' : '',
              pinnedElementIds.has(element.id) ? 'is-pinned' : '',
              majorElementIds.has(element.id) ? 'is-major' : '',
            ].filter(Boolean).join(' ')}
            style={weight !== undefined ? ({ '--se-weight': weight.toFixed(3) } as CSSProperties) : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onElementClick(element, event.currentTarget.getBoundingClientRect(), { shiftKey: event.shiftKey });
            }}
            onMouseEnter={(event) => onElementPreviewEnter?.(element, event.currentTarget)}
            onMouseLeave={() => onPreviewLeave?.()}
          >
            <div className="se-card__title">
              <KindMark kind="element" color={color} />
              <span className="se-card__name">{element.name}</span>
            </div>
          </SandCell>
        );
      })}
    </>
  );
});

export const SuperElementRelateLayer = memo(RelateLayer);
