import { useMemo, useState } from 'react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { EntityKind } from '../../lib/extensions/entity-link';

export interface RelationTarget {
  kind: EntityKind;
  id: string;
  label: string;
  color?: string;
}

interface Props {
  /** Currently-selected target keys, encoded as `${kind}:${id}`. */
  selected: Set<string>;
  onAdd: (target: RelationTarget) => void;
  onRemove: (target: RelationTarget) => void;
  /** Behavior of the already-selected chips in the top row.
   *  - `navigate` (default): chip body opens the entity, trailing × removes
   *    the relation. Used in memo / material cards in the side panel.
   *  - `toggle`: whole chip removes the relation. Used inside compose
   *    dialogs where navigating away would dismiss the dialog. */
  selectedChipMode?: 'navigate' | 'toggle';
}

/**
 * Inline relation editor for a memo or material. Surfaces every project
 * entity (chapter / drift / element / storyline / category) as a chip;
 * clicking toggles the relation in the underlying `entity_reference` table.
 *
 * Drifts are nodes with `mainStorylineId == null` — they appear under a
 * separate header so users don't confuse them with regular chapters.
 */
export function EntityRelationPicker({
  selected,
  onAdd,
  onRemove,
  selectedChipMode = 'navigate',
}: Props) {
  const { bookNodes, bookElements, storylines, bookElementCategories } = useDataStore();
  const { navigateToNode, navigateToElement, navigateToStoryline, navigateToCategory } =
    useProjectNavigation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  // Click on the selected-chip body should jump to the linked entity. Click
  // on the ×/+ icon (handled inside Chip) still removes the relation. The
  // group-picker chips below keep the "whole chip toggles" semantics.
  const navigateToTarget = (t: RelationTarget) => {
    switch (t.kind) {
      case 'node':
        navigateToNode(t.id);
        return;
      case 'element':
        navigateToElement(t.id);
        return;
      case 'storyline':
        navigateToStoryline(t.id);
        return;
      case 'category':
        navigateToCategory(t.id);
        return;
      default:
        return;
    }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (s: string) => !q || s.toLowerCase().includes(q);

    const chapters: RelationTarget[] = [];
    const drifts: RelationTarget[] = [];
    bookNodes.forEach((n) => {
      const label = n.title || (n.mainStorylineId ? 'Untitled Chapter' : 'Untitled Drift');
      if (!matches(label)) return;
      const sl = n.mainStorylineId
        ? storylines.find((s) => s.id === n.mainStorylineId)
        : undefined;
      const target: RelationTarget = { kind: 'node', id: n.id, label, color: sl?.color };
      if (n.mainStorylineId) chapters.push(target);
      else drifts.push(target);
    });

    const elements: RelationTarget[] = bookElements
      .filter((e) => matches(e.name || ''))
      .map((e) => {
        const cat = bookElementCategories.find((c) => c.id === e.categoryId);
        return { kind: 'element', id: e.id, label: e.name || 'Untitled Element', color: cat?.color };
      });

    const sls: RelationTarget[] = storylines
      .filter((s) => matches(s.name || ''))
      .map((s) => ({ kind: 'storyline', id: s.id, label: s.name || 'Untitled Storyline', color: s.color }));

    const cats: RelationTarget[] = bookElementCategories
      .filter((c) => matches(c.name || ''))
      .map((c) => ({ kind: 'category', id: c.id, label: c.name || c.id, color: c.color }));

    return { chapters, drifts, elements, storylines: sls, categories: cats };
  }, [bookNodes, bookElements, storylines, bookElementCategories, query]);

  const toggle = (t: RelationTarget) => {
    const key = `${t.kind}:${t.id}`;
    if (selected.has(key)) onRemove(t);
    else onAdd(t);
  };

  // Build the list of currently-selected chips by looking up labels for each
  // selected key against the same store data. Anything we can't resolve (e.g.
  // a stale link to a deleted entity) renders with the raw id so the user can
  // still remove it.
  const selectedChips = useMemo<RelationTarget[]>(() => {
    const out: RelationTarget[] = [];
    selected.forEach((key) => {
      const [kind, id] = key.split(':') as [EntityKind, string];
      switch (kind) {
        case 'node': {
          const n = bookNodes.find((x) => x.id === id);
          const sl = n?.mainStorylineId
            ? storylines.find((s) => s.id === n.mainStorylineId)
            : undefined;
          out.push({
            kind,
            id,
            label: n?.title || (n?.mainStorylineId ? 'Untitled Chapter' : 'Untitled Drift'),
            color: sl?.color,
          });
          break;
        }
        case 'element': {
          const e = bookElements.find((x) => x.id === id);
          const cat = e ? bookElementCategories.find((c) => c.id === e.categoryId) : undefined;
          out.push({ kind, id, label: e?.name || id, color: cat?.color });
          break;
        }
        case 'storyline': {
          const s = storylines.find((x) => x.id === id);
          out.push({ kind, id, label: s?.name || id, color: s?.color });
          break;
        }
        case 'category': {
          const c = bookElementCategories.find((x) => x.id === id);
          out.push({ kind, id, label: c?.name || id, color: c?.color });
          break;
        }
        default:
          out.push({ kind, id, label: id });
      }
    });
    return out;
  }, [selected, bookNodes, bookElements, storylines, bookElementCategories]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        {selectedChips.map((chip) =>
          selectedChipMode === 'navigate' ? (
            <Chip
              key={`${chip.kind}:${chip.id}`}
              target={chip}
              selected
              onClick={() => navigateToTarget(chip)}
              onRemove={() => onRemove(chip)}
            />
          ) : (
            <Chip
              key={`${chip.kind}:${chip.id}`}
              target={chip}
              selected
              onClick={() => toggle(chip)}
            />
          ),
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            padding: '2px 6px',
            borderRadius: 3,
            border: '1px dashed hsl(var(--rule))',
            background: 'transparent',
            color: 'hsl(var(--ink-3))',
            cursor: 'pointer',
          }}
        >
          {open ? '收起' : '＋ 关联'}
        </button>
      </div>

      {open && (
        <div
          style={{
            border: '1px solid hsl(var(--rule))',
            borderRadius: 4,
            background: 'hsl(var(--surface))',
            padding: 8,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索章节 / 元素 / 故事线…"
            style={{
              width: '100%',
              fontFamily: 'var(--font-serif)',
              fontSize: 12.5,
              padding: '4px 6px',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 3,
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-1))',
              marginBottom: 8,
              outline: 'none',
            }}
          />
          <Group label="章节" items={groups.chapters} selected={selected} onToggle={toggle} />
          <Group label="浮缀" items={groups.drifts} selected={selected} onToggle={toggle} />
          <Group label="元素" items={groups.elements} selected={selected} onToggle={toggle} />
          <Group label="故事线" items={groups.storylines} selected={selected} onToggle={toggle} />
          <Group label="类目" items={groups.categories} selected={selected} onToggle={toggle} />
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  items,
  selected,
  onToggle,
}: {
  label: string;
  items: RelationTarget[];
  selected: Set<string>;
  onToggle: (t: RelationTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'hsl(var(--ink-4))',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {items.map((t) => (
          <Chip
            key={`${t.kind}:${t.id}`}
            target={t}
            selected={selected.has(`${t.kind}:${t.id}`)}
            onClick={() => onToggle(t)}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  target,
  selected,
  onClick,
  onRemove,
}: {
  target: RelationTarget;
  selected: boolean;
  onClick: () => void;
  /** When set, splits the chip so body click runs `onClick` and the trailing
   *  × runs `onRemove`. Without it the whole chip is one toggle button. */
  onRemove?: () => void;
}) {
  if (onRemove) {
    // Split-mode: rendered as a div so the body and × can be independent
    // click targets (nested <button>s are invalid HTML).
    return (
      <div
        title={target.id}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'var(--font-serif)',
          fontSize: 12,
          padding: '2px 4px 2px 8px',
          borderRadius: 12,
          border: '1px solid hsl(var(--rule))',
          background: 'hsl(var(--ink-1) / 0.06)',
          color: 'hsl(var(--ink-1))',
          maxWidth: 200,
        }}
      >
        <button
          onClick={onClick}
          title={`跳转至 ${target.label}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {target.color && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: target.color,
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{target.label}</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="移除关联"
          aria-label="移除关联"
          style={{
            display: 'inline-grid',
            placeItems: 'center',
            width: 14,
            height: 14,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1,
            borderRadius: '50%',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--rule))';
            e.currentTarget.style.color = 'hsl(var(--ink-1))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'hsl(var(--ink-4))';
          }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onClick}
      title={target.id}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-serif)',
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 12,
        border: '1px solid hsl(var(--rule))',
        background: selected ? 'hsl(var(--ink-1) / 0.06)' : 'transparent',
        color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
        cursor: 'pointer',
        maxWidth: 200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {target.color && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: target.color,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{target.label}</span>
      <span style={{ color: 'hsl(var(--ink-4))', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {selected ? '×' : '+'}
      </span>
    </button>
  );
}
