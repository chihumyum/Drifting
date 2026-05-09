import { useState } from 'react';
import { Edit2, Save, X } from 'lucide-react';
import type { OutlineItem } from '../../lib/outline';

interface OutlineSummaryPanelProps {
  outline: OutlineItem[];
  onSummaryUpdate: (outlineId: string, summary: string) => void;
}

export function OutlineSummaryPanel({ outline, onSummaryUpdate }: OutlineSummaryPanelProps) {
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [summaryInput, setSummaryInput] = useState('');

  const startEdit = (item: OutlineItem) => {
    setEditingSummary(item.id);
    setSummaryInput(item.summary || '');
  };

  const saveSummary = () => {
    if (editingSummary) {
      onSummaryUpdate(editingSummary, summaryInput);
      setEditingSummary(null);
      setSummaryInput('');
    }
  };

  const cancelEdit = () => {
    setEditingSummary(null);
    setSummaryInput('');
  };

  if (outline.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          fontSize: 12,
          color: 'rgba(0, 0, 0, 0.45)',
          textAlign: 'center',
        }}
      >
        No headings in this chapter. Add headings to see outline.
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      {outline.map((item) => {
        const isEditing = editingSummary === item.id;
        const indent = (item.level - 1) * 12;

        return (
          <div
            key={item.id}
            style={{
              padding: '8px 8px 8px ' + indent + 'px',
              marginBottom: 8,
              borderRadius: 4,
              background: isEditing ? 'rgba(184, 153, 104, 0.08)' : 'transparent',
            }}
          >
            {/* Heading */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: item.summary || isEditing ? 6 : 0,
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: item.level === 1 ? 600 : 500,
                  color: item.level === 1 ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.65)',
                }}
              >
                {item.text}
              </span>

              {!isEditing && (
                <Edit2
                  size={14}
                  style={{
                    color: 'rgba(184, 153, 104, 0.6)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  onClick={() => startEdit(item)}
                />
              )}
            </div>

            {/* Summary */}
            {isEditing ? (
              <div>
                <textarea
                  value={summaryInput}
                  onChange={(e) => setSummaryInput(e.target.value)}
                  placeholder="Add a summary..."
                  autoFocus
                  style={{
                    width: '100%',
                    minHeight: 60,
                    padding: 8,
                    fontSize: 12,
                    border: '1px solid rgba(184, 153, 104, 0.3)',
                    borderRadius: 4,
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  <button
                    onClick={saveSummary}
                    style={{
                      flex: 1,
                      padding: '6px 12px',
                      fontSize: 12,
                      background: 'rgba(184, 153, 104, 0.9)',
                      color: 'white',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    <Save size={14} />
                    Save
                  </button>
                  <button
                    onClick={cancelEdit}
                    style={{
                      flex: 1,
                      padding: '6px 12px',
                      fontSize: 12,
                      background: 'rgba(0, 0, 0, 0.05)',
                      color: 'rgba(0, 0, 0, 0.65)',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                </div>
              </div>
            ) : item.summary ? (
              <div
                style={{
                  padding: 8,
                  fontSize: 12,
                  color: 'rgba(0, 0, 0, 0.65)',
                  background: 'rgba(184, 153, 104, 0.05)',
                  borderRadius: 4,
                  borderLeft: '2px solid rgba(184, 153, 104, 0.4)',
                  lineHeight: 1.5,
                }}
              >
                {item.summary}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
