import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import {
  AGENT_WORKING_MEMORY_SOFT_TOKENS,
  EMPTY_AGENT_WORKING_MEMORY_MD,
  AgentWorkingMemoryConflictError,
} from '../../domain/agent-working-memory';
import {
  clearAgentWorkingMemory,
  saveAgentWorkingMemory,
  useAgentWorkingMemory,
} from '../../usecase/useAgentWorkingMemory';
import { requestConfirmation } from '../../store/confirmation-store';

function markdownHtml(value: string): string {
  const escaped = value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
  return marked.parse(escaped, { breaks: true, gfm: true, async: false }) as string;
}

export function AgentWorkingMemoryView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, refresh } = useAgentWorkingMemory(projectId);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState('');
  const [draftRevision, setDraftRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot || dirty) return;
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setDraft(snapshot.exists ? snapshot.contentMd : EMPTY_AGENT_WORKING_MEMORY_MD);
      setDraftRevision(snapshot.revision);
    });
    return () => {
      alive = false;
    };
  }, [dirty, snapshot]);

  const preview = useMemo(() => markdownHtml(draft), [draft]);
  const usage = snapshot?.approxTokens ?? 0;
  const usagePercent = Math.min(100, Math.round((usage / AGENT_WORKING_MEMORY_SOFT_TOKENS) * 100));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveAgentWorkingMemory(projectId, {
        contentMd: draft,
        expectedRevision: draftRevision,
        updatedBy: 'author',
      });
      setDraft(result.snapshot.contentMd || EMPTY_AGENT_WORKING_MEMORY_MD);
      setDraftRevision(result.snapshot.revision);
      setDirty(false);
      setMode('preview');
      setMessage(
        result.compacted
          ? t('agentPanel.workingMemory.savedCompacted')
          : t('agentPanel.workingMemory.saved'),
      );
    } catch (error) {
      if (error instanceof AgentWorkingMemoryConflictError) {
        await refresh();
        setMessage(t('agentPanel.workingMemory.conflictDraftPreserved'));
      } else {
        setMessage(error instanceof Error ? error.message : t('agentPanel.workingMemory.failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!snapshot) return;
    const confirmed = await requestConfirmation(t('agentPanel.workingMemory.clearConfirm'));
    if (!confirmed) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await clearAgentWorkingMemory(projectId, snapshot.revision, 'author');
      setDraft(EMPTY_AGENT_WORKING_MEMORY_MD);
      setDraftRevision(next.revision);
      setDirty(false);
      setMode('preview');
      setMessage(t('agentPanel.workingMemory.cleared'));
    } catch (error) {
      if (error instanceof AgentWorkingMemoryConflictError) {
        await refresh();
        setMessage(t('agentPanel.workingMemory.conflictClear'));
      } else {
        setMessage(error instanceof Error ? error.message : t('agentPanel.workingMemory.failed'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading && !snapshot) {
    return <div className="agt-wm__state">{t('agentPanel.workingMemory.loading')}</div>;
  }

  return (
    <section className="agt-wm" aria-label={t('agentPanel.workingMemory.title')}>
      <header className="agt-wm__header">
        <div>
          <strong>{t('agentPanel.workingMemory.filename')}</strong>
          <p>{t('agentPanel.workingMemory.description')}</p>
        </div>
        <div className="agt-wm__actions">
          <button type="button" onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>
            {mode === 'edit'
              ? t('agentPanel.workingMemory.preview')
              : t('agentPanel.workingMemory.edit')}
          </button>
          <button type="button" onClick={() => void clear()} disabled={saving || !snapshot?.exists}>
            {t('agentPanel.workingMemory.clear')}
          </button>
        </div>
      </header>

      <div className="agt-wm__meter" title={t('agentPanel.workingMemory.budgetTitle')}>
        <span style={{ width: `${usagePercent}%` }} />
      </div>
      <div className="agt-wm__meta">
        <span>{t('agentPanel.workingMemory.tokens', { count: usage })}</span>
        <span>
          {snapshot?.updatedAt
            ? t('agentPanel.workingMemory.updated', {
                time: new Date(snapshot.updatedAt).toLocaleString(),
                by:
                  snapshot.updatedBy === 'author'
                    ? t('agentPanel.workingMemory.author')
                    : t('agentPanel.workingMemory.agent'),
              })
            : t('agentPanel.workingMemory.neverUpdated')}
        </span>
      </div>

      {mode === 'edit' ? (
        <textarea
          className="agt-wm__editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
            setMessage(null);
          }}
          aria-label={t('agentPanel.workingMemory.editorLabel')}
        />
      ) : snapshot?.exists || dirty ? (
        <div className="agt-wm__preview agent-md" dangerouslySetInnerHTML={{ __html: preview }} />
      ) : (
        <div className="agt-wm__state">
          <strong>{t('agentPanel.workingMemory.emptyTitle')}</strong>
          <span>{t('agentPanel.workingMemory.emptyBody')}</span>
          <button type="button" onClick={() => setMode('edit')}>
            {t('agentPanel.workingMemory.create')}
          </button>
        </div>
      )}

      {(mode === 'edit' || message) && (
        <footer className="agt-wm__footer">
          <span role="status">{message}</span>
          {mode === 'edit' && (
            <button type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
