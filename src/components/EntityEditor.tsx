import { useState, useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { X, Save, Plus } from 'lucide-react';
import { query, run } from '../lib/db';
import type { Entity, EntityStage } from '../model/schema';
import { DEFAULT_entity_CATEGORIES } from '../model/schema';
import { listEntityCategories, ensureEntityCategory } from '../lib/entity';
import { events } from '../lib/events';

interface EntityEditorProps {
  entityId: string;
  onClose: () => void;
}

export function EntityEditor({ entityId, onClose }: EntityEditorProps) {
  const [entry, setEntry] = useState<Entity | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<Entity['type']>('character');
  const [aliases, setAliases] = useState<string>('');
  const [attributes, setAttributes] = useState<string>('{}');
  const [stages, setStages] = useState<EntityStage[]>([]);
  const [categories, setCategories] = useState<string[]>(() => [...DEFAULT_entity_CATEGORIES]);

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
      try {
        const rows = await listEntityCategories();
        if (rows.length) {
          setCategories((prev) => dedupeCategories([...prev, ...rows.map((row) => row.name)]));
        }
      } catch (error) {
        console.error('Failed to load categories', error);
      }

  const rows = await query<Entity>(`SELECT * FROM entity WHERE id='${entityId}' LIMIT 1`);
      const e = rows[0] || null;
      setEntry(e);
      if (e) {
        setName(e.name);
        setType(e.type as Entity['type']);
        setCategories((prev) => dedupeCategories([...prev, e.type]));
        setAliases(safeToCSV(e.aliases_json));
        setAttributes(safePrettyJSON(e.attributes_json));
        if (editor) editor.commands.setContent(e.canonical_summary || '');

  const stageRows = await query<EntityStage>(`SELECT * FROM entity_stage WHERE entity_id='${entityId}' ORDER BY start_order`);
        setStages(stageRows);
      } else {
        setStages([]);
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
      await ensureEntityCategory(type);
      await run(`UPDATE entity SET 
        name='${escapeSql(name)}', 
        type='${escapeSql(type)}', 
        aliases_json='${escapeSql(aliasesJson)}', 
        attributes_json='${escapeSql(attributesJson)}', 
        canonical_summary='${escapeSql(canonical)}',
        updated_at='${new Date().toISOString()}'
        WHERE id='${entry.id}'`);
      events.emit('entries:changed');
      events.emit('categories:changed');
    })().then(onClose).catch((e) => console.error('Failed to save entry', e));
  };

  const addStage = useCallback(async () => {
    if (!entry) return;
    const now = new Date().toISOString();
    const base = stages.length ? stages[stages.length - 1].end_order + 1 : 1;
    const stage: EntityStage = {
      id: `stage_${Date.now()}`,
      entry_id: entry.id,
      start_order: base,
      end_order: base + 1,
      attributes_patch_json: '{}',
      stage_summary: '',
      created_at: now,
    };
    try {
      await run(`INSERT INTO entity_stage (id, entity_id, start_order, end_order, attributes_patch_json, stage_summary, created_at)
        VALUES ('${stage.id}', '${stage.entry_id}', ${stage.start_order}, ${stage.end_order}, '${stage.attributes_patch_json}', '', '${now}')`);
      setStages((prev) => [...prev, stage]);
      events.emit('entryStages:changed');
    } catch (error) {
      console.error('Failed to add stage', error);
    }
  }, [entry, stages]);

  const updateStageField = useCallback(async <K extends keyof EntityStage>(stageId: string, field: K, value: EntityStage[K]) => {
    try {
      let sqlValue: string;
      if (field === 'start_order' || field === 'end_order') {
        sqlValue = String(value);
      } else if (field === 'attributes_patch_json') {
        sqlValue = `'${escapeSql(typeof value === 'string' ? safeMinJSON(value) : '{}')}'`;
      } else if (field === 'stage_summary') {
        sqlValue = `'${escapeSql(String(value ?? ''))}'`;
      } else {
        return;
      }

  await run(`UPDATE entity_stage SET ${field}=${sqlValue} WHERE id='${stageId}'`);
      events.emit('entryStages:changed');
    } catch (error) {
      console.error('Failed to update stage', error);
    }
  }, []);

  const removeStage = useCallback(async (stageId: string) => {
    try {
  await run(`DELETE FROM entity_stage WHERE id='${stageId}'`);
      setStages((prev) => prev.filter((stage) => stage.id !== stageId));
      events.emit('entryStages:changed');
    } catch (error) {
      console.error('Failed to delete stage', error);
    }
  }, []);

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as Entity['type'])}
                style={{ fontSize: '14px', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', minWidth: '140px' }}
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const value = prompt('新的类别名称', '');
                  if (!value) return;
                  const trimmed = value.trim();
                  if (!trimmed) return;
                  ensureEntityCategory(trimmed).then(() => {
                    setCategories((prev) => dedupeCategories([...prev, trimmed]));
                    setType(trimmed);
                    events.emit('categories:changed');
                  }).catch((error) => {
                    console.error('Failed to create category', error);
                  });
                }}
                style={{
                  border: 'none',
                  backgroundColor: '#ded3f0',
                  color: '#4d3f59',
                  padding: '4px 8px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Plus size={14} />
                新类别
              </button>
            </div>
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

            <div style={{ gridColumn: '1 / span 2', marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#4a4252' }}>Stage Progression</div>
                <button
                  onClick={addStage}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid #c7bdcf',
                    backgroundColor: '#f6f0ff',
                    color: '#5d5273',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  + Add Stage
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {stages.length === 0 && (
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: 10,
                    border: '1px dashed #d5cbdd',
                    color: '#8c8296',
                    fontSize: 12
                  }}>
                    No stages yet. Add stages to describe how this entity evolves alongside the story timeline.
                  </div>
                )}

                {stages.map((stage) => (
                  <div
                    key={stage.id}
                    style={{
                      border: '1px solid #d4cadf',
                      borderRadius: 12,
                      padding: '14px 16px',
                      backgroundColor: '#faf7ff',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12
                    }}
                  >
                    <div style={{ display: 'flex', gap: 12 }}>
                      <label style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: '#6c6372', marginBottom: 4 }}>Start Order</div>
                        <input
                          type="number"
                          value={stage.start_order}
                          onChange={(e) => {
                            const value = Number(e.target.value || 0);
                            setStages((prev) => prev.map((s) => s.id === stage.id ? { ...s, start_order: value } : s));
                          }}
                          onBlur={(e) => {
                            const value = Number(e.target.value || 0);
                            void updateStageField(stage.id, 'start_order', value);
                          }}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #c8bed2' }}
                        />
                      </label>
                      <label style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: '#6c6372', marginBottom: 4 }}>End Order</div>
                        <input
                          type="number"
                          value={stage.end_order}
                          onChange={(e) => {
                            const value = Number(e.target.value || 0);
                            setStages((prev) => prev.map((s) => s.id === stage.id ? { ...s, end_order: value } : s));
                          }}
                          onBlur={(e) => {
                            const value = Number(e.target.value || 0);
                            void updateStageField(stage.id, 'end_order', value);
                          }}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #c8bed2' }}
                        />
                      </label>
                      <button
                        onClick={() => removeStage(stage.id)}
                        style={{
                          alignSelf: 'flex-end',
                          border: 'none',
                          backgroundColor: '#fbe5e8',
                          color: '#b44a57',
                          borderRadius: 8,
                          padding: '6px 10px',
                          fontSize: 12,
                          cursor: 'pointer'
                        }}
                      >
                        删除
                      </button>
                    </div>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#6c6372' }}>Stage Summary</span>
                      <textarea
                        value={stage.stage_summary || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setStages((prev) => prev.map((s) => s.id === stage.id ? { ...s, stage_summary: value } : s));
                        }}
                        onBlur={(e) => {
                          const value = e.target.value;
                          void updateStageField(stage.id, 'stage_summary', value);
                        }}
                        rows={3}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid #c8bed2',
                          fontSize: 12,
                          resize: 'vertical'
                        }}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#6c6372' }}>Attribute Patch (JSON)</span>
                      <textarea
                        value={stage.attributes_patch_json || '{}'}
                        onChange={(e) => {
                          const value = e.target.value;
                          setStages((prev) => prev.map((s) => s.id === stage.id ? { ...s, attributes_patch_json: value } : s));
                        }}
                        onBlur={(e) => {
                          const sanitized = safeMinJSON(e.target.value);
                          setStages((prev) => prev.map((s) => s.id === stage.id ? { ...s, attributes_patch_json: sanitized } : s));
                          void updateStageField(stage.id, 'attributes_patch_json', sanitized);
                        }}
                        rows={3}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid #c8bed2',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 12,
                          resize: 'vertical'
                        }}
                      />
                    </label>
                  </div>
                ))}
              </div>
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

function dedupeCategories(categories: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  categories.forEach((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  });
  return result;
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
