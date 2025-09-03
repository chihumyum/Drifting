import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEntitiesStore } from '../store/entities';
import { useState } from 'react';

interface ChapterEditorProps {
  chapterId: string;
  onClose: () => void;
}

export function ChapterEditor({ chapterId, onClose }: ChapterEditorProps) {
  const { chapters, updateChapter, entities, getCharacters, getLocations } = useEntitiesStore();
  const chapter = chapters.find(ch => ch.id === chapterId);
  const [title, setTitle] = useState(chapter?.title || '');
  
  const characters = getCharacters();
  const locations = getLocations();
  
  const editor = useEditor({
    extensions: [StarterKit],
    content: chapter?.content || '',
    onUpdate: ({ editor }) => {
      updateChapter(chapterId, { content: editor.getHTML() });
    },
  });

  if (!chapter) return null;

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    updateChapter(chapterId, { title: newTitle });
  };

  const availableCharacters = characters.filter(ch => !chapter.characters.includes(ch.id));
  const availableLocations = locations.filter(loc => !chapter.locations.includes(loc.id));

  const addCharacterToChapter = (characterId: string) => {
    updateChapter(chapterId, { 
      characters: [...chapter.characters, characterId] 
    });
  };

  const addLocationToChapter = (locationId: string) => {
    updateChapter(chapterId, { 
      locations: [...chapter.locations, locationId] 
    });
  };

  const removeCharacterFromChapter = (characterId: string) => {
    updateChapter(chapterId, { 
      characters: chapter.characters.filter(id => id !== characterId) 
    });
  };

  const removeLocationFromChapter = (locationId: string) => {
    updateChapter(chapterId, { 
      locations: chapter.locations.filter(id => id !== locationId) 
    });
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '24px',
        maxWidth: '800px',
        width: '90%',
        maxHeight: '80vh',
        overflow: 'auto',
        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.25)'
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <input
            type="text"
            value={title}
            onChange={handleTitleChange}
            style={{
              fontSize: '18px',
              fontWeight: 'bold',
              border: '1px solid #ccc',
              borderRadius: '4px',
              padding: '8px',
              flex: 1,
              marginRight: '16px'
            }}
            placeholder="Chapter title..."
          />
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              backgroundColor: '#f0f0f0',
              border: '1px solid #ccc',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Close
          </button>
        </div>

        {/* Characters and Locations */}
        <div style={{ display: 'flex', gap: '24px', marginBottom: '16px' }}>
          {/* Characters */}
          <div style={{ flex: 1 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Characters</h4>
            <div style={{ marginBottom: '8px' }}>
              {chapter.characters.map(charId => {
                const character = characters.find(ch => ch.id === charId);
                return character ? (
                  <div key={charId} style={{ 
                    display: 'inline-block', 
                    margin: '2px', 
                    padding: '4px 8px', 
                    backgroundColor: '#e0e0e0', 
                    borderRadius: '12px',
                    fontSize: '12px'
                  }}>
                    {character.name}
                    <button 
                      onClick={() => removeCharacterFromChapter(charId)}
                      style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      ×
                    </button>
                  </div>
                ) : null;
              })}
            </div>
            <select 
              onChange={(e) => {
                if (e.target.value) {
                  addCharacterToChapter(e.target.value);
                  e.target.value = '';
                }
              }}
              style={{ fontSize: '12px', padding: '4px' }}
            >
              <option value="">Add character...</option>
              {availableCharacters.map(char => (
                <option key={char.id} value={char.id}>{char.name}</option>
              ))}
            </select>
          </div>

          {/* Locations */}
          <div style={{ flex: 1 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Locations</h4>
            <div style={{ marginBottom: '8px' }}>
              {chapter.locations.map(locId => {
                const location = locations.find(loc => loc.id === locId);
                return location ? (
                  <div key={locId} style={{ 
                    display: 'inline-block', 
                    margin: '2px', 
                    padding: '4px 8px', 
                    backgroundColor: '#ffe0e0', 
                    borderRadius: '12px',
                    fontSize: '12px'
                  }}>
                    {location.name}
                    <button 
                      onClick={() => removeLocationFromChapter(locId)}
                      style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      ×
                    </button>
                  </div>
                ) : null;
              })}
            </div>
            <select 
              onChange={(e) => {
                if (e.target.value) {
                  addLocationToChapter(e.target.value);
                  e.target.value = '';
                }
              }}
              style={{ fontSize: '12px', padding: '4px' }}
            >
              <option value="">Add location...</option>
              {availableLocations.map(loc => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Content Editor */}
        <div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Content</h4>
          <div style={{
            border: '1px solid #ccc',
            borderRadius: '4px',
            minHeight: '200px',
            padding: '12px'
          }}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  );
}