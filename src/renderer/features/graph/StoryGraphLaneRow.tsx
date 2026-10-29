import { memo, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { KindMark } from '../../components/ui/KindMark';
import { SandCell } from '../../components/ui/SandCell';
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
  onNodeClick: (event: MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  onNodeDoubleClick: (node: PositionedNode) => void;
  /** Resting on a tile or a storyline's rail cell shows its hover card. */
  onNodePreviewEnter: (event: MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  onLanePreviewEnter: (event: MouseEvent<HTMLDivElement>, laneId: string) => void;
  onPreviewLeave: () => void;
  /**
   * Desktop: the lane names are sidebar cells and each chapter is a slab of
   * glass rimmed in its storyline's colour, like the Bottom Timeline. The
   * paused mobile shell keeps the tinted tiles.
   */
  glass?: boolean;
}

function LaneRow({ lane, nodes, chapterCount, canvasContentWidth, tileRefs, linkSource,
  isNodeEdgeSelected, onNodePointerDown, onNodeClick, onNodeDoubleClick,
  onNodePreviewEnter, onLanePreviewEnter, onPreviewLeave, glass = false,
}: StoryGraphLaneRowProps) {
  const { t } = useTranslation();
  const railName = glass ? (
    <div className="graph-rail__main">
      <div className="graph-rail__name">
        {!lane.synthetic && <KindMark kind="storyline" color={lane.color} />}
        <span>{lane.name}</span>
      </div>
      <div className="graph-rail__meta">
        {t('storyGraph.lane.chapterCount', { count: chapterCount })}
      </div>
    </div>
  ) : (
    <>
      <div className="graph-rail__name">
        <span className="graph-rail__name-dot" style={{ background: lane.color }} />
        <span>{lane.name}</span>
      </div>
      <div className="graph-rail__meta">
        {t('storyGraph.lane.chapterCount', { count: chapterCount })}
      </div>
    </>
  );
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
        className={`graph-rail-cell${glass ? ' graph-rail-cell--glass' : ''}`}
        style={{ width: GRAPH_CONFIG.RAIL_WIDTH }}
        // Synthetic lanes (本书 / 未归属) have no storyline behind them.
        onMouseEnter={lane.synthetic ? undefined : (event) => onLanePreviewEnter(event, lane.id)}
        onMouseLeave={lane.synthetic ? undefined : onPreviewLeave}
      >
        {glass && !lane.synthetic ? (
          <SandCell selected={false} color={lane.color} className="graph-rail__cell">
            {railName}
          </SandCell>
        ) : (
          railName
        )}
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
          const edgeSelected = isNodeEdgeSelected(node.id);
          return (
            <div
              key={node.id}
              ref={(el) => {
                if (el) tileRefs.current.set(node.id, el);
                else tileRefs.current.delete(node.id);
              }}
              className={[
                'graph-tile',
                glass ? 'glass glass--rest' : '',
                isDraft ? 'is-draft' : '',
                isDiscarded ? 'is-discarded' : '',
                isLinkSource ? 'is-link-source' : '',
                edgeSelected ? 'is-edge-selected' : '',
                glass && edgeSelected ? 'is-on' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onClick={(event) => onNodeClick(event, node)}
              onDoubleClick={() => onNodeDoubleClick(node)}
              onMouseEnter={(event) => onNodePreviewEnter(event, node)}
              onMouseLeave={onPreviewLeave}
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
                  ...(glass ? { ['--glass-cc' as string]: color } : null),
                } as React.CSSProperties
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
