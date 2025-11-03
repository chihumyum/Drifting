import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';

export function TimelineChapters() {
  const navigate = useNavigate();
  const { bookNodes, selectedNodeId } = useAppStore();
  const { loadNodes } = useBookNodeUsecases();

  useEffect(() => {
    if (bookNodes.length === 0) {
      void loadNodes({ type: 'chapter' });
    }
  }, [bookNodes.length, loadNodes]);

  const chapters = bookNodes.filter(node => node.type === 'chapter');

  const handleChapterClick = (chapterId: string) => {
    navigate(`/editor/${chapterId}`);
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 0, // Start from the very left edge
        right: 0, // Extend to the very right edge
        bottom: 0,
        height: 120,
        background: 'linear-gradient(180deg, rgba(30, 25, 42, 0.98) 0%, rgba(20, 15, 32, 0.98) 100%)',
        borderTop: '1px solid rgba(70, 60, 90, 0.6)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: '16px',
        overflowX: 'auto',
        overflowY: 'hidden',
        zIndex: 50,
      }}
    >
      {/* Header */}
      <div style={{
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid rgba(220, 210, 235, 0.3)',
      }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#4a3d5a',
          letterSpacing: '0.02em',
        }}>
          Timeline • {chapters.length} Chapters
        </div>
        <div style={{ fontSize: 11, color: '#8a7d9a' }}>
          Future: Timeline view with story progression
        </div>
      </div>

      {/* Timeline Track */}
      <div style={{
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: '16px 24px',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}>
        {chapters.map((chapter, index) => {
          const isSelected = chapter.id === selectedNodeId;
          const isActive = chapter.status === 'active';
          
          return (
            <div
              key={chapter.id}
              onClick={() => handleChapterClick(chapter.id)}
              style={{
                minWidth: 180,
                height: 56,
                background: isSelected 
                  ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  : isActive 
                    ? '#ffffff'
                    : 'rgba(255, 255, 255, 0.6)',
                borderRadius: 12,
                padding: '10px 14px',
                cursor: 'pointer',
                border: isSelected 
                  ? '2px solid rgba(102, 126, 234, 0.3)'
                  : '1px solid rgba(200, 190, 220, 0.25)',
                boxShadow: isSelected
                  ? '0 8px 24px rgba(102, 126, 234, 0.35), 0 0 0 3px rgba(102, 126, 234, 0.1)'
                  : isActive
                    ? '0 4px 12px rgba(100, 90, 120, 0.12)'
                    : '0 2px 6px rgba(100, 90, 120, 0.08)',
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(100, 90, 120, 0.18)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = isActive
                    ? '0 4px 12px rgba(100, 90, 120, 0.12)'
                    : '0 2px 6px rgba(100, 90, 120, 0.08)';
                }
              }}
            >
              {/* Chapter Number Badge */}
              <div style={{
                position: 'absolute',
                top: -8,
                left: 12,
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: isSelected ? '#fff' : '#f0ecf5',
                color: isSelected ? '#667eea' : '#6a5d7a',
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
              }}>
                {index + 1}
              </div>

              {/* Chapter Title */}
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                color: isSelected ? '#ffffff' : '#3a2d4a',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 8,
              }}>
                {chapter.title || 'Untitled'}
              </div>

              {/* Chapter Status */}
              <div style={{
                fontSize: 10,
                color: isSelected ? 'rgba(255, 255, 255, 0.85)' : '#8a7d9a',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isSelected 
                    ? '#fff' 
                    : chapter.status === 'active' 
                      ? '#4ade80' 
                      : '#94a3b8',
                }} />
                {chapter.status || 'draft'}
              </div>
            </div>
          );
        })}

        {/* Add Chapter Placeholder */}
        <div style={{
          minWidth: 180,
          height: 56,
          background: 'rgba(255, 255, 255, 0.4)',
          borderRadius: 12,
          border: '2px dashed rgba(150, 140, 180, 0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          fontSize: 13,
          fontWeight: 600,
          color: '#8a7d9a',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'rgba(102, 126, 234, 0.5)';
          e.currentTarget.style.background = 'rgba(102, 126, 234, 0.08)';
          e.currentTarget.style.color = '#667eea';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'rgba(150, 140, 180, 0.3)';
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.4)';
          e.currentTarget.style.color = '#8a7d9a';
        }}>
          + Add Chapter
        </div>
      </div>
    </div>
  );
}
