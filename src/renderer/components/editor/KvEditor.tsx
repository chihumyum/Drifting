import { useCallback, useEffect, useRef, useState } from 'react';
import type { KvEntry, KvList } from '../../domain/kv';
import { parseKv, stringifyKv } from '../../domain/kv';

interface Props {
  // JSON-stringified KvList from the entity. Re-seeded into local edit state
  // whenever this string changes between renders so external updates (e.g.
  // server pull) don't get clobbered by the local buffer.
  valueJson: string;
  // Called with the next JSON-stringified KvList. Fired on blur so we don't
  // round-trip a write per keystroke.
  onPersist: (nextJson: string) => void;
  // Whether this editor is for "the entity's own KV" or "the template KV"
  // (which is just normal KV semantically, but renders with a slightly
  // different placeholder and empty-state copy).
  variant?: 'own' | 'template';
  // Optional override of the placeholder copy. Mostly useful for the
  // template variants where we want to hint about who inherits the row.
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  // Optional empty-state hint when the list has zero rows.
  emptyHint?: string;
  // Whether the user can edit values. Defaults to true; pass false for
  // read-only contexts (e.g. preview of an inherited template).
  readOnly?: boolean;
}

// Lightweight key/value table editor used wherever an entity (or template)
// exposes a list of { key, value } facts. Designed to drop into the existing
// .elem-body / page sections without bringing its own surface.
//
// Mutation model: local rows live in state, get serialized via stringifyKv
// on blur, and bubble up through onPersist. We strip trailing empty rows in
// stringifyKv so a draft trailing row never gets persisted by accident.
export function KvEditor({
  valueJson,
  onPersist,
  variant = 'own',
  keyPlaceholder,
  valuePlaceholder,
  emptyHint,
  readOnly = false,
}: Props) {
  const initialList = parseKv(valueJson);
  const [rows, setRows] = useState<KvList>(initialList);
  // Track the last `valueJson` we hydrated from so external updates (server
  // pull, optimistic write-back) re-seed local state without thrashing on
  // every render. We compare against the JSON because the parsed list is a
  // fresh array each call.
  const lastSeededRef = useRef<string>(valueJson);
  useEffect(() => {
    if (valueJson !== lastSeededRef.current) {
      lastSeededRef.current = valueJson;
      setRows(parseKv(valueJson));
    }
  }, [valueJson]);

  const commit = useCallback(
    (next: KvList) => {
      const nextJson = stringifyKv(next);
      // Avoid no-op writes — saves a sync round trip. Compare against the
      // last value we actually persisted (held in lastSeededRef), NOT the
      // current `rows` state — handleBlur passes `rows` itself in, so a
      // comparison against `rows` would always early-return and the save
      // would never fire.
      if (nextJson === lastSeededRef.current) return;
      lastSeededRef.current = nextJson;
      onPersist(nextJson);
    },
    [onPersist],
  );

  const handleChangeKey = (idx: number, key: string) => {
    setRows((prev) => prev.map((row, i) => (i === idx ? { ...row, key } : row)));
  };
  const handleChangeValue = (idx: number, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === idx ? { ...row, value } : row)));
  };
  const handleBlur = () => commit(rows);
  const handleAdd = () => {
    const next: KvList = [...rows, { key: '', value: '' }];
    setRows(next);
    // Don't persist on add — the new row is blank and stringifyKv would
    // strip it anyway. Persist happens on blur after the user types.
  };
  const handleRemove = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    commit(next);
  };

  const resolvedKeyPlaceholder =
    keyPlaceholder ?? (variant === 'template' ? '字段名 · key (e.g. 视角)' : '字段 · key');
  const resolvedValuePlaceholder =
    valuePlaceholder ?? (variant === 'template' ? '默认值 / 提示 · value' : '内容 · value');
  const resolvedEmptyHint =
    emptyHint ??
    (variant === 'template'
      ? '— 尚未定义任何模版字段。新建子项时不会自动填充任何 KV —'
      : '— 尚无 KV 字段 —');

  return (
    <div className="kv-editor" data-variant={variant}>
      {rows.length === 0 && <div className="kv-editor__empty">{resolvedEmptyHint}</div>}
      {rows.length > 0 && (
        <div className="kv-editor__list" role="list">
          {rows.map((row, idx) => (
            <KvRow
              key={idx}
              row={row}
              keyPlaceholder={resolvedKeyPlaceholder}
              valuePlaceholder={resolvedValuePlaceholder}
              readOnly={readOnly}
              onKeyChange={(key) => handleChangeKey(idx, key)}
              onValueChange={(value) => handleChangeValue(idx, value)}
              onBlur={handleBlur}
              onRemove={() => handleRemove(idx)}
            />
          ))}
        </div>
      )}
      {!readOnly && (
        <button type="button" className="kv-editor__add" onClick={handleAdd}>
          + 新增字段
        </button>
      )}
    </div>
  );
}

interface RowProps {
  row: KvEntry;
  keyPlaceholder: string;
  valuePlaceholder: string;
  readOnly: boolean;
  onKeyChange: (key: string) => void;
  onValueChange: (value: string) => void;
  onBlur: () => void;
  onRemove: () => void;
}

function KvRow({
  row,
  keyPlaceholder,
  valuePlaceholder,
  readOnly,
  onKeyChange,
  onValueChange,
  onBlur,
  onRemove,
}: RowProps) {
  return (
    <div className="kv-editor__row" role="listitem">
      <input
        type="text"
        className="kv-editor__key"
        value={row.key}
        placeholder={keyPlaceholder}
        disabled={readOnly}
        onChange={(e) => onKeyChange(e.target.value)}
        onBlur={onBlur}
        spellCheck={false}
      />
      <textarea
        className="kv-editor__value"
        value={row.value}
        placeholder={valuePlaceholder}
        disabled={readOnly}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={onBlur}
        rows={1}
        spellCheck={false}
      />
      {!readOnly && (
        <button
          type="button"
          className="kv-editor__remove"
          onClick={onRemove}
          title="Remove row"
          aria-label="Remove row"
        >
          ×
        </button>
      )}
    </div>
  );
}
