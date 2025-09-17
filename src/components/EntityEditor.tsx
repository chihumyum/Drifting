import { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { X, Save } from 'lucide-react';
import { query, run } from '../lib/db';
import type { Entry } from '../lib/schema';

interface EntityEditorProps {
  entityId: string;
  onClose: () => void;
}

export function EntityEditor({ entityId, onClose }: EntityEditorProps) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<Entry['type']>('character');
  const [aliases, setAliases] = useState<string>('');
  const [attributes, setAttributes] = useState<string>('{}');

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none min-h-[200px] p-4',
      },
    },
  });

  useEffect(() => {
    const load = async () => {
      const rows = await query<Entry>(`SELECT * FROM entry WHERE id='${entityId}' LIMIT 1`);
      const e = rows[0] || null;
      setEntry(e);
      if (e) {
        setName(e.name);
        setType(e.type as Entry['type']);
        setAliases(safeToCSV(e.aliases_json));
        setAttributes(safePrettyJSON(e.attributes_json));
        if (editor) editor.commands.setContent(e.canonical_summary || '');
      }
    };
    load();
  }, [entityId, editor]);

  const handleSave = () => {
    if (!entry || !editor) return;
    const canonical = editor.getHTML();
    const aliasesJson = safeFromCSV(aliases);
    const attributesJson = safeMinJSON(attributes);
    (async () => {
      await run(`UPDATE entry SET 
        name='${escapeSql(name)}', 
        type='${escapeSql(type)}', 
        aliases_json='${escapeSql(aliasesJson)}', 
        attributes_json='${escapeSql(attributesJson)}', 
        canonical_summary='${escapeSql(canonical)}',
        updated_at='${new Date().toISOString()}'
        WHERE id='${entry.id}'`);
    })().then(onClose).catch((e) => console.error('Failed to save entry', e));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  if (!entry) {
    return null;
  }

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <div 
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          width: '90%',
          maxWidth: '800px',
          maxHeight: '90vh',
          overflow: 'hidden',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 24px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8f9fa'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Entity name"
              style={{
                fontSize: '18px',
                fontWeight: 'bold',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                minWidth: '200px'
              }}
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as Entry['type'])}
              style={{ fontSize: '14px', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', minWidth: '120px' }}
            >
              <option value="character">character</option>
              <option value="location">location</option>
              <option value="object">object</option>
              <option value="faction">faction</option>
              <option value="concept">concept</option>
            </select>
          </div>
          
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleSave}
              style={{
                padding: '8px 16px',
                backgroundColor: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '14px'
              }}
            >
              <Save size={16} />
              Save
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '8px',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: '4px'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: '300px' }}>
          <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div style={{ fontSize: '14px', color: '#666', marginBottom: 6 }}>Aliases (comma-separated)</div>
              <input
                type="text"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
              />

              <div style={{ fontSize: '14px', color: '#666', margin: '16px 0 6px' }}>Attributes (JSON)</div>
              <textarea
                value={attributes}
                onChange={(e) => setAttributes(e.target.value)}
                rows={10}
                style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </div>

            <div>
              <div style={{ fontSize: '14px', color: '#666', marginBottom: 6 }}>Canonical Summary</div>
              {editor && (
                <div style={{ minHeight: '250px', border: '1px solid #ccc', borderRadius: 6 }}>
                  <EditorContent editor={editor} style={{ minHeight: '250px', padding: 12 }} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 24px',
          borderTop: '1px solid #e0e0e0',
          backgroundColor: '#f8f9fa',
          fontSize: '12px',
          color: '#666',
          display: 'flex',
          justifyContent: 'space-between'
        }}>
          <span>Press Ctrl/Cmd + S to save, Esc to close</span>
          <span>Entity ID: {entityId}</span>
        </div>
      </div>
    </div>
  );
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''");
}

function safeToCSV(json: string | undefined): string {
  try { const arr = json ? JSON.parse(json) as string[] : []; return arr.join(', '); } catch { return ''; }
}
function safeFromCSV(csv: string): string {
  const arr = csv.split(',').map(s => s.trim()).filter(Boolean);
  return JSON.stringify(arr);
}
function safePrettyJSON(json: string | undefined): string {
  try { return JSON.stringify(JSON.parse(json || '{}'), null, 2); } catch { return '{}'; }
}
function safeMinJSON(json: string): string {
  try { return JSON.stringify(JSON.parse(json)); } catch { return '{}'; }
}
