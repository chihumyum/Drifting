import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenuSurface } from '../ui/ContextMenuSurface';

// In-place combobox for changing an element's secondary group (groupName)
// within its category. Replaces the old jump-to-editor + modal flow — opened
// straight from the element cell's context menu like the drift move picker.
//
// groupName is a free-text label (not an entity), so this is a combobox, not a
// plain list: type to filter existing groups OR type a brand-new name and press
// Enter to create-and-move. A "无分组" row clears the group. Portals to <body>
// with position:fixed + viewport clamp, mirroring SimpleContextMenu.
export interface ElementGroupPickerProps {
  x: number;
  y: number;
  current: string | null;
  // Existing group names in the element's category (deduped, any order).
  existing: string[];
  onPick: (groupName: string | null) => void;
  onClose: () => void;
}

export function ElementGroupPicker({
  x,
  y,
  current,
  existing,
  onPick,
  onClose,
}: ElementGroupPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const lower = trimmed.toLowerCase();
    return existing
      .filter((g) => !lower || g.toLowerCase().includes(lower))
      .sort((a, b) => a.localeCompare(b));
  }, [existing, trimmed]);
  // Offer "create new" when the typed name doesn't already exist (case-insensitive).
  const canCreate =
    trimmed.length > 0 && !existing.some((g) => g.toLowerCase() === trimmed.toLowerCase());

  const pick = (name: string | null) => {
    onPick(name);
    onClose();
  };

  return (
    <ContextMenuSurface
      x={x}
      y={y}
      onClose={onClose}
      className="editor-bar__menu"
      style={{
        minWidth: 200,
        maxHeight: '60vh',
        overflowY: 'auto',
      }}
    >
      <div className="editor-bar__menu-section-label">{t('elementGroupPicker.title')}</div>
      <div style={{ padding: '2px 8px 6px' }}>
        <input
          autoFocus
          value={query}
          placeholder={t('elementGroupPicker.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) {
              e.preventDefault();
              pick(trimmed);
            }
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '4px 8px',
            border: '1px solid hsl(var(--rule-strong))',
            borderRadius: 4,
            background: 'hsl(var(--paper))',
            color: 'hsl(var(--ink-1))',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </div>

      {canCreate && (
        <button
          type="button"
          className="editor-bar__menu-item"
          onClick={() => pick(trimmed)}
        >
          {t('elementGroupPicker.createGroup', { name: trimmed })}
        </button>
      )}

      <button
        type="button"
        className="editor-bar__menu-item"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
        onClick={() => pick(null)}
      >
        <span>{t('elementGroupPicker.noGroup')}</span>
        {current == null && <span aria-hidden>✓</span>}
      </button>

      {filtered.length > 0 && <div className="editor-bar__menu-divider" />}
      {filtered.map((name) => (
        <button
          key={name}
          type="button"
          className="editor-bar__menu-item"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          onClick={() => pick(name)}
        >
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {name}
          </span>
          {current === name && <span aria-hidden>✓</span>}
        </button>
      ))}
    </ContextMenuSurface>
  );
}
