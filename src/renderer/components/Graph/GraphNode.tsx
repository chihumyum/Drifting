import { memo } from 'react';
import { BookNode } from '../../domain/book_node';
import { Storyline } from '../../domain/storyline';
import { BookElement } from '../../domain/book_element';

interface GraphNodeProps {
    node: BookNode;
    storylines: Storyline[];
    elements: BookElement[];
    isSelected: boolean;
    scale: number;
    onSelect: (id: string, multi: boolean) => void;
    onNavigate: (id: string) => void;
    onElementClick: (id: string) => void;
    onMouseDown: (e: React.MouseEvent, id: string) => void;
    onOutputMouseDown: (e: React.MouseEvent, id: string) => void; // For creating edges
}

export const GraphNode = memo(({
    node,
    storylines,
    elements,
    isSelected,
    // scale,
    onSelect,
    onNavigate,
    onElementClick,
    onMouseDown,
    onOutputMouseDown
}: GraphNodeProps) => { // Removed separate onMouseDown since we handle it in the main div

    // Decide color based on primary storyline
    // const primaryStoryline = storylines[0];
    // const accentColor = primaryStoryline?.color || '#b89968';

    return (
        <div
            className={`absolute flex flex-col rounded-xl bg-white shadow-sm transition-shadow duration-200 overflow-hidden group select-none ${isSelected ? 'ring-2 ring-blue-500 shadow-md' : 'hover:shadow-md'}`}
            style={{
                left: node.position?.x || 0,
                top: node.position?.y || 0,
                width: 240,
                height: 160,
                transform: 'translate(-50%, -50%)', // Centered
                cursor: 'grab'
            }}
            onMouseDown={(e) => {
                e.stopPropagation();
                onMouseDown(e, node.id);
            }}
            onClick={(e) => {
                e.stopPropagation();
                if (e.metaKey || e.shiftKey) {
                    onSelect(node.id, true);
                } else {
                    onSelect(node.id, false);
                }
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                onNavigate(node.id);
            }}
        >
            {/* Storyline Multi-Color Bar */}
            <div className="flex h-[4px] params-full w-full">
                {storylines.length > 0 ? (
                    storylines.map((sl) => (
                        <div
                            key={sl.id}
                            style={{ backgroundColor: sl.color || '#b89968' }}
                            className="flex-1"
                            title={sl.name}
                        />
                    ))
                ) : (
                    <div className="w-full bg-gray-200" />
                )}
            </div>

            {/* Header / Title Bar */}
            <div
                className="px-3 py-2 border-b border-gray-100 flex items-center justify-between"
            >
                <div className="flex items-center gap-2 overflow-hidden">
                    <span className="font-semibold text-gray-800 text-sm truncate" title={node.title}>
                        {node.title}
                    </span>
                </div>
                {/* Transfer Station Icon if multiple */}
                {storylines.length > 1 && (
                    <div className="flex -space-x-1" title="Transfer Station">
                        {storylines.slice(0, 3).map(sl => (
                            <div key={sl.id} className="w-2 h-2 rounded-full border border-white" style={{ backgroundColor: sl.color }} />
                        ))}
                        {storylines.length > 3 && <div className="w-2 h-2 rounded-full bg-gray-300 border border-white" />}
                    </div>
                )}
                {storylines.length === 1 && (
                    <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: storylines[0].color }}
                        title={storylines[0].name}
                    />
                )}
            </div>

            {/* Content Body */}
            <div className="flex-1 p-3 flex flex-col gap-2 overflow-hidden bg-gray-50/50">

                {/* Summary */}
                <p className="text-xs text-gray-500 line-clamp-3 leading-relaxed">
                    {node.summary || "No summary..."}
                </p>

                {/* Elements / Tags */}
                <div className="flex flex-wrap gap-1 mt-auto pt-2">
                    {elements.slice(0, 4).map(el => (
                        <span
                            key={el.id}
                            onClick={(e) => {
                                e.stopPropagation();
                                onElementClick(el.id);
                            }}
                            className="px-1.5 py-0.5 text-[10px] rounded bg-gray-200 text-gray-600 hover:bg-blue-100 hover:text-blue-700 cursor-pointer transition-colors"
                        >
                            {el.name}
                        </span>
                    ))}
                    {elements.length > 4 && (
                        <span className="px-1.5 py-0.5 text-[10px] text-gray-400">+{elements.length - 4}</span>
                    )}
                </div>
            </div>

            {/* Connection Handle (Output) */}
            <div
                className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-crosshair transition-opacity"
                onMouseDown={(e) => {
                    e.stopPropagation();
                    onOutputMouseDown(e, node.id);
                }}
            >
                <div className="w-2 h-2 rounded-full bg-blue-400 ring-2 ring-white"></div>
            </div>

            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {/* Edit button or similar could go here */}
            </div>

        </div>
    );
});

GraphNode.displayName = 'GraphNode';
