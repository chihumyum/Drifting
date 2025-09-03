import { Handle, Position } from 'reactflow';
import { useEntitiesStore } from '../store/entities';

interface ChapterNodeData {
  chapterId: string;
  onEdit?: (chapterId: string) => void;
}

export function ChapterNode({ data }: { data: ChapterNodeData }) {
  const { chapters, entities } = useEntitiesStore();
  const chapter = chapters.find(ch => ch.id === data.chapterId);

  if (!chapter) return null;

  const chapterEntities = entities.filter(entity => 
    chapter.characters.includes(entity.id) || chapter.locations.includes(entity.id)
  );
  const chapterCharacters = chapterEntities.filter(entity => entity.type === 'character');
  const chapterLocations = chapterEntities.filter(entity => entity.type === 'location');

  const handleDoubleClick = () => {
    if (data.onEdit) {
      data.onEdit(data.chapterId);
    }
  };

  return (
    <div 
      style={{
        backgroundColor: 'white',
        border: '1px solid #ccc',
        borderRadius: '8px',
        padding: '12px',
        minWidth: '200px',
        maxWidth: '250px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        fontSize: '12px',
        cursor: 'pointer'
      }}
      onDoubleClick={handleDoubleClick}
    >
      <Handle type="target" position={Position.Left} />
      
      {/* Chapter Title */}
      <div style={{ 
        fontSize: '12px', 
        color: 'red', 
        fontWeight: 'bold', 
        marginBottom: '8px' 
      }}>
        {chapter.title}
      </div>
      
      {/* Characters and Locations */}
      <div style={{ marginBottom: '8px', color: '#666' }}>
        {chapterCharacters.map((char) => (
          <div key={char.id} style={{ fontSize: '11px' }}>
            {char.name}
          </div>
        ))}
        {chapterLocations.map((loc) => (
          <div key={loc.id} style={{ fontSize: '11px', color: 'red' }}>
            {loc.name}
          </div>
        ))}
      </div>
      
      {/* Content Preview */}
      <div style={{ 
        fontSize: '11px', 
        lineHeight: '1.3',
        color: '#333',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical'
      }}>
        {chapter.content.replace(/<[^>]*>/g, '')}
      </div>
      
      <Handle type="source" position={Position.Right} />
    </div>
  );
}