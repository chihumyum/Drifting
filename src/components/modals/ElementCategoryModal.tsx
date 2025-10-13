import { useEffect, useState, type FormEvent } from 'react';
import { ModalShell, modalInputStyle, modalPrimaryButtonStyle, modalSecondaryButtonStyle } from './ModalShell';

export type NewCategoryPayload = {
  name: string;
  color: string;
};

interface ElementCategoryModalProps {
  existingNames: string[];
  initialName?: string;
  initialColor?: string;
  title?: string;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (payload: NewCategoryPayload) => Promise<void>;
}

export function ElementCategoryModal({
  existingNames,
  initialName = '',
  initialColor = '#8367c7',
  title = '新增类别',
  confirmLabel = '创建',
  onClose,
  onSubmit,
}: ElementCategoryModalProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setColor(initialColor);
  }, [initialColor]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写类别名称');
      return;
    }
    if (existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      setError('该类别已存在');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, color });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={title} onClose={onClose}>
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
          颜色
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            style={{ ...modalInputStyle, padding: '4px 6px', height: 34 }}
          />
        </label>
        {error && <div style={{ color: '#d9534f', fontSize: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={modalSecondaryButtonStyle}>
            取消
          </button>
          <button type="submit" disabled={saving} style={modalPrimaryButtonStyle}>
            {saving ? `${confirmLabel}中…` : confirmLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
