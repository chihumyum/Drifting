import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import {
  AGENT_WORKING_MEMORY_PERSISTENT_NOTICE_TOKENS,
  EMPTY_AGENT_WORKING_MEMORY_MD,
  AgentWorkingMemoryConflictError,
} from '../../domain/agent-working-memory';
import {
  clearAgentWorkingMemory,
  saveAgentWorkingMemory,
  useAgentWorkingMemory,
} from '../../usecase/useAgentWorkingMemory';
import { requestConfirmation } from '../../store/confirmation-store';
import { getPlatformRuntime } from '../../platform/runtime';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { EmptyState } from '../../components/ui/EmptyState';

function markdownHtml(value: string): string {
  const escaped = value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
  return marked.parse(escaped, { breaks: true, gfm: true, async: false }) as string;
}

/**
 * WORKING_MEMORY.md, shared by every General Agent conversation.
 *
 * On the desktop it reads like Project Memory: the document is one read-only
 * card (the resting glass line, still under the pointer), its size against
 * the tidy-up thresholds is a dry sand reading, its actions are text buttons
 * with brush icons, and editing writes on the composer's rounded slip with
 * one primary button. The paused mobile shell keeps its outlined fallback.
 */
export function AgentWorkingMemoryView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, refresh } = useAgentWorkingMemory(projectId);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState('');
  const [draftRevision, setDraftRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const glass = !getPlatformRuntime().isMobileShell;

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
  const usagePercent = Math.min(100, Math.round((usage / AGENT_WORKING_MEMORY_PERSISTENT_NOTICE_TOKENS) * 100));

  const updatedText = snapshot?.updatedAt
    ? t('agentPanel.workingMemory.updated', {
        time: new Date(snapshot.updatedAt).toLocaleString(),
        by:
          snapshot.updatedBy === 'author'
            ? t('agentPanel.workingMemory.author')
            : t('agentPanel.workingMemory.agent'),
      })
    : t('agentPanel.workingMemory.neverUpdated');

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
      setMessage(t('agentPanel.workingMemory.saved'));
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

  // Leaving the editor drops the draft; the snapshot seeds it again.
  const cancel = () => {
    setDirty(false);
    setMode('preview');
    setMessage(null);
  };

  if (loading && !snapshot) {
    return <div className="agt-wm__state">{t('agentPanel.workingMemory.loading')}</div>;
  }

  if (glass) {
    const editor = (
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
    );
    return (
      <section className="agt-wm agt-wm--glass" aria-label={t('agentPanel.workingMemory.title')}>
        <header className="agt-wm__head">
          <strong className="agt-wm__title">{t('agentPanel.workingMemory.filename')}</strong>
          <p className="agt-wm__desc">{t('agentPanel.workingMemory.description')}</p>
        </header>

        <div className="agt-wm__reading" title={t('agentPanel.workingMemory.budgetTitle')}>
          <div className="sand-track">
            <span
              className="sand-stroke"
              style={{ width: `${usagePercent}%`, '--sand-c': 'hsl(var(--ink-3))' } as CSSProperties}
            />
          </div>
          <div className="agt-wm__meta">
            <span>{t('agentPanel.workingMemory.tokens', { count: usage })}</span>
            <span>{updatedText}</span>
          </div>
        </div>

        {mode === 'edit' ? (
          <>
            <label className="agt-wm__slip glass glass--rest glass--field">{editor}</label>
            <footer className="agt-wm__footer">
              <span role="status">{message}</span>
              <button type="button" className="agt-wm__text" onClick={cancel}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agt-btn glass glass--primary glass--small"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </footer>
          </>
        ) : snapshot?.exists || dirty ? (
          <>
            <div
              className="agt-wm__card glass glass--rest glass--still agent-md"
              dangerouslySetInnerHTML={{ __html: preview }}
            />
            <footer className="agt-wm__footer">
              <button type="button" className="agt-wm__text" onClick={() => setMode('edit')}>
                <BrushIcon name="edit" size={13} /> {t('agentPanel.workingMemory.edit')}
              </button>
              <button
                type="button"
                className="agt-wm__text agt-wm__text--danger"
                onClick={() => void clear()}
                disabled={saving || !snapshot?.exists}
              >
                <BrushIcon name="eraser" size={13} /> {t('agentPanel.workingMemory.clear')}
              </button>
              <span role="status">{message}</span>
            </footer>
          </>
        ) : (
          <div className="agt-wm__empty">
            <EmptyState icon="file-text" message={t('agentPanel.workingMemory.emptyTitle')} />
            <p className="agt-wm__desc">{t('agentPanel.workingMemory.emptyBody')}</p>
            <button type="button" className="agt-btn glass glass--rest glass--small" onClick={() => setMode('edit')}>
              {t('agentPanel.workingMemory.create')}
            </button>
            {message && <span role="status">{message}</span>}
          </div>
        )}
      </section>
    );
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
        <span>{updatedText}</span>
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
