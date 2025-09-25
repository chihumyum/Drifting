import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Entity } from '../../model/domain';
import { ModalShell, modalInputStyle, modalPrimaryButtonStyle, modalSecondaryButtonStyle } from './ModalShell';
import { toAliasArray, type NewEntityPayload } from './ElementCreateModal';

interface EntityEditModalProps {
  entity: Entity;
  categories: string[];
  onClose: () => void;
  onSubmit: (payload: NewEntityPayload & { id: string }) => Promise<void>;
  renderCategoryLabel?: (category: string) => string;
}

export function EntityEditModal({
  entity,
  categories,
  onClose,
  onSubmit,
  renderCategoryLabel = (value) => value,
}: EntityEditModalProps) {
  const [name, setName] = useState(entity.name);
  const [category, setCategory] = useState(entity.category);
  const [aliases, setAliases] = useState(aliasesToInput(entity.aliases));
  const [summary, setSummary] = useState(entity.canonicalSummary ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(entity.name);
    setCategory(entity.category);
    setAliases(aliasesToInput(entity.aliases));
    setSummary(entity.canonicalSummary ?? '');
  }, [entity]);

  const options = useMemo(() => {
    if (categories.includes(entity.category)) return categories;
    return [entity.category, ...categories];
  }, [categories, entity.category]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('请填写实体名称');
      return;
    }
    if (!category) {
      setError('请选择类别');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        id: entity.id,
        name: name.trim(),
        category,
        summary,
        aliases: toAliasArray(aliases),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存实体失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="编辑实体" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#584e61' }}>
          名称
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={modalInputStyle}
            autoFocus
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#584e61' }}>
          类别
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            style={modalInputStyle}
          >
            {options.map((item) => (
              <option key={item} value={item}>
                {renderCategoryLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#584e61' }}>
          别名（用逗号分隔）
          <input
            type="text"
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            style={modalInputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#584e61' }}>
          简介
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            style={{ ...modalInputStyle, resize: 'vertical' }}
          />
        </label>
        {error && <div style={{ color: '#d9534f', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={modalSecondaryButtonStyle}>
            取消
          </button>
          <button type="submit" disabled={saving} style={modalPrimaryButtonStyle}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function aliasesToInput(list: string[]) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.join(', ');
}
