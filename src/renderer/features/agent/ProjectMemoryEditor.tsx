import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentMemory } from '../../domain/agent-memory';
import { getPlatformRuntime } from '../../platform/runtime';
import { requestConfirmation } from '../../store/confirmation-store';
import { useAgentMemory } from '../../usecase/useAgentMemory';
import { BrushIcon } from '../../components/ui/BrushIcon';
import '../../../styles/project-memory.css';

/**
 * PROJECT_MEMORY.md as the author sees it: plain-text entries in document
 * order, each editable in place, with an append box at the end. The author
 * and the Agent edit the same entries, so nothing here is approval-gated;
 * only rows left `pending` from before Project Memory need enabling.
 *
 * On the desktop the entries are one read-only card (the resting glass line,
 * still under the pointer), their actions are text buttons, and the append
 * and edit boxes are the composer's rounded slip with one primary button.
 * The paused mobile shell keeps its outlined list and buttons.
 */
export function ProjectMemoryEditor({
  projectId,
  compact = false,
}: {
  projectId: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const memory = useAgentMemory(projectId);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [busy, setBusy] = useState(false);
  const glass = !getPlatformRuntime().isMobileShell;
  const withGlass = (base: string, classes: string) => (glass ? `${base} ${classes}` : base);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      if (!draft.trim()) return;
      await memory.add(draft);
      setDraft('');
    });

  const startEdit = (entry: AgentMemory) => {
    setEditingId(entry.id);
    setEditingBody(entry.body);
  };

  const saveEdit = () =>
    run(async () => {
      if (!editingId || !editingBody.trim()) return;
      await memory.edit(editingId, editingBody);
      setEditingId(null);
    });

  const remove = (id: string) =>
    run(async () => {
      if (!(await requestConfirmation(t('projectMemory.deleteConfirm')))) return;
      await memory.remove(id);
      if (editingId === id) setEditingId(null);
    });

  const submitOnModEnter = (event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={`pmem${compact ? ' pmem--compact' : ''}${glass ? ' pmem--glass' : ''}`}>
      <p className="pmem__desc">{t('projectMemory.desc')}</p>
      {memory.memories.length === 0 ? (
        <div className="pmem__empty">{t('projectMemory.empty')}</div>
      ) : (
        <ol className={withGlass('pmem__list', 'glass glass--rest glass--still')}>
          {memory.memories.map((entry) => {
            const inactive = entry.status === 'pending';
            const editing = editingId === entry.id;
            return (
              <li key={entry.id} className={`pmem__entry${inactive ? ' pmem__entry--inactive' : ''}`}>
                {editing ? (
                  <div className={withGlass('pmem__edit', 'glass glass--rest glass--field')}>
                    <textarea
                      className="pmem__textarea"
                      value={editingBody}
                      autoFocus
                      rows={Math.min(10, Math.max(2, editingBody.split('\n').length))}
                      onChange={(event) => setEditingBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditingId(null);
                        submitOnModEnter(event, () => void saveEdit());
                      }}
                    />
                    <div className="pmem__actions">
                      <button type="button" className="pmem__btn" onClick={() => setEditingId(null)}>
                        {t('projectMemory.cancel')}
                      </button>
                      <button
                        type="button"
                        className={withGlass('pmem__btn pmem__btn--primary', 'glass glass--primary')}
                        disabled={busy || !editingBody.trim()}
                        onClick={() => void saveEdit()}
                      >
                        {t('projectMemory.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="pmem__body">{entry.body}</div>
                    <div className="pmem__actions pmem__actions--hover">
                      {inactive && (
                        <>
                          <span className="pmem__tag">{t('projectMemory.inactive')}</span>
                          <button
                            type="button"
                            className="pmem__btn"
                            disabled={busy}
                            onClick={() => void run(() => memory.approve(entry.id))}
                          >
                            {glass && <BrushIcon name="check" size={13} />}
                            {t('projectMemory.enable')}
                          </button>
                        </>
                      )}
                      <button type="button" className="pmem__btn" onClick={() => startEdit(entry)}>
                        {glass && <BrushIcon name="edit" size={13} />}
                        {t('projectMemory.edit')}
                      </button>
                      <button
                        type="button"
                        className="pmem__btn pmem__btn--danger"
                        disabled={busy}
                        onClick={() => void remove(entry.id)}
                      >
                        {glass && <BrushIcon name="trash" size={13} />}
                        {t('projectMemory.delete')}
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className={withGlass('pmem__composer', 'glass glass--rest glass--field')}>
        <textarea
          className="pmem__textarea"
          value={draft}
          rows={2}
          placeholder={t('projectMemory.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => submitOnModEnter(event, () => void add())}
        />
        <div className="pmem__actions">
          <button
            type="button"
            className={withGlass('pmem__btn pmem__btn--primary', 'glass glass--primary')}
            disabled={busy || !draft.trim()}
            onClick={() => void add()}
          >
            {t('projectMemory.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
