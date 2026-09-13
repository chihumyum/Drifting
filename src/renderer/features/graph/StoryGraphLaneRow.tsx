import { memo, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalWordCount } from '../../domain/book-node';
import { GRAPH_CONFIG, type PositionedNode, type StoryGraphLane } from './story-graph-layout';

export interface StoryGraphLaneRowProps {
  lane: StoryGraphLane;
  nodes: readonly PositionedNode[];
  chapterCount: number;
  canvasContentWidth: number;
  tileRefs: RefObject<Map<string, HTMLDivElement>>;
  linkSource: string | null;
  isNodeEdgeSelected: (id: string) => boolean;
  onNodePointerDown: (event: PointerEvent<HTMLDivElement>, node: PositionedNode) => void;
  onNodeContextMenu: (event: MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  onNodeClick: (event: MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  onNodeDoubleClick: (node: PositionedNode) => void;
  onLaneContextMenu: (event: MouseEvent<HTMLDivElement>, laneId: string) => void;
}

function LaneRow({ lane, nodes, chapterCount, canvasContentWidth, tileRefs, linkSource,
  isNodeEdgeSelected, onNodePointerDown, onNodeContextMenu, onNodeClick, onNodeDoubleClick, onLaneContextMenu,
}: StoryGraphLaneRowProps) {
  const { t } = useTranslation();
  return (
    <div
      key={lane.id}
      data-storyline-row={lane.id}
      className={`graph-lane-row${lane.synthetic ? ' is-synthetic' : ''}`}
      style={
        {
          height: GRAPH_CONFIG.TRACK_HEIGHT,
          ['--track-color' as string]: lane.color,
        } as React.CSSProperties
      }
    >
      <div
        className="graph-rail-cell"
        style={{ width: GRAPH_CONFIG.RAIL_WIDTH }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (lane.synthetic) return;
          e.stopPropagation();
          onLaneContextMenu(e, lane.id);
        }}
      >
        <div className="graph-rail__name">
          <span className="graph-rail__name-dot" style={{ background: lane.color }} />
          <span>{lane.name}</span>
        </div>
        <div className="graph-rail__meta">
          {t('storyGraph.lane.chapterCount', { count: chapterCount })}
        </div>
      </div>
      <div
        data-node-container
        className="graph-track-cell"
        style={{ width: canvasContentWidth }}
      >
        {nodes.map((node) => {
          const status = node.writingStatus;
          const isDiscarded = status === 'discarded';
          const isDraft = !isDiscarded && status !== 'finished';
          const color = node.storyline?.color || 'hsl(var(--story-4))';
          const isLinkSource = linkSource === node.id;
          return (
            <div
              key={node.id}
              ref={(el) => {
                if (el) tileRefs.current.set(node.id, el);
                else tileRefs.current.delete(node.id);
              }}
              className={[
                'graph-tile',
                isDraft ? 'is-draft' : '',
                isDiscarded ? 'is-discarded' : '',
                isLinkSource ? 'is-link-source' : '',
                isNodeEdgeSelected(node.id) ? 'is-edge-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onContextMenu={(event) => onNodeContextMenu(event, node)}
              onClick={(event) => onNodeClick(event, node)}
              onDoubleClick={() => onNodeDoubleClick(node)}
              style={
                {
                  left: node.x,
                  // Tile sits flush with the bottom of its lane:
                  // top = TRACK_HEIGHT − TILE_HEIGHT. Leaves the
                  // upper half empty so the dotted reading line
                  // at the lane's vertical center traces along
                  // the tile's upper edge (book-mode look).
                  top: GRAPH_CONFIG.TRACK_HEIGHT - GRAPH_CONFIG.TILE_HEIGHT,
                  width: GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT,
                  height: GRAPH_CONFIG.TILE_HEIGHT,
                  ['--tile-color' as string]: color,
                } as React.CSSProperties
              }
              title={
                canonicalWordCount(node) == null
                  ? t('storyGraph.node.titleCounting', {
                      title: node.title || t('common.untitled'),
                    })
                  : t('storyGraph.node.titleWithWords', {
                      title: node.title || t('common.untitled'),
                      count: canonicalWordCount(node),
                    })
              }
            >
              <div className="graph-tile__num">
                § {String(node.bookOrder).padStart(2, '0')}
              </div>
              <div className="graph-tile__title">
                {node.title || t('common.untitled')}
              </div>
              {node.summary && <div className="graph-tile__summary">{node.summary}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const StoryGraphLaneRow = memo(LaneRow);
