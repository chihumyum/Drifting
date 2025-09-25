import { useEffect, useState, type FormEvent } from "react";
import {
  ModalShell,
  modalInputStyle,
  modalPrimaryButtonStyle,
  modalSecondaryButtonStyle,
} from "./ModalShell";

export type NewEntityPayload = {
  name: string;
  category: string;
  summary?: string;
  aliases?: string[];
};

interface EntityCreateModalProps {
  categories: string[];
  defaultCategory?: string;
  onClose: () => void;
  onSubmit: (payload: NewEntityPayload) => Promise<void>;
  renderCategoryLabel?: (category: string) => string;
}

export function EntityCreateModal({
  categories,
  defaultCategory,
  onClose,
  onSubmit,
  renderCategoryLabel = (value) => value,
}: EntityCreateModalProps) {
  const startingCategory = defaultCategory ?? categories[0] ?? "";
  const [name, setName] = useState("");
  const [category, setCategory] = useState(startingCategory);
  const [aliases, setAliases] = useState("");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultCategory) {
      setCategory(defaultCategory);
    }
  }, [defaultCategory]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请填写实体名称");
      return;
    }
    if (!category) {
      setError("请选择类别");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        category,
        summary,
        aliases: toAliasArray(aliases),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建实体失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="新建实体" onClose={onClose}>
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 12,
            color: "#584e61",
          }}
        >
          名称
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={modalInputStyle}
            autoFocus
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 12,
            color: "#584e61",
          }}
        >
          类别
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            style={modalInputStyle}
          >
            {categories.map((item) => (
              <option key={item} value={item}>
                {renderCategoryLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 12,
            color: "#584e61",
          }}
        >
          别名（用逗号分隔）
          <input
            type="text"
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            style={modalInputStyle}
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 12,
            color: "#584e61",
          }}
        >
          简介
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={4}
            style={{ ...modalInputStyle, resize: "vertical" }}
          />
        </label>
        {error && <div style={{ color: "#d9534f", fontSize: 12 }}>{error}</div>}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 8,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={modalSecondaryButtonStyle}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            style={modalPrimaryButtonStyle}
          >
            {saving ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export function toAliasArray(raw: string) {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
