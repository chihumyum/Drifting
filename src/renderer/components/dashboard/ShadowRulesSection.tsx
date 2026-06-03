import { useCallback, useEffect, useMemo, useState } from 'react';
import loglevel from 'loglevel';
import { createProjectRuleRepository } from '../../sqlite-repo/project-rule-repo';
import type { ProjectRule } from '../../domain/project-rule';
import { compileRule, hashRuleContent } from '../../lib/ai/shadow-rules';

const log = loglevel.getLogger('ShadowRules');

// Temporary authoring surface for shadow review rules, parked in the project
// dashboard. The author writes rules FREEFORM (one per row); on save each
// rawContent is compiled by an LLM normalizer into a checklist of atomic, typed
// assertions, shown read-only beneath the rule (the author-visible guardrail).
export function ShadowRulesSection({ projectId }: { projectId: string }) {
  const repo = useMemo(() => createProjectRuleRepository(), []);
  const [rules, setRules] = useState<ProjectRule[]>([]);

  const reload = useCallback(async () => {
    setRules(await repo.listByProject(projectId));
  }, [repo, projectId]);

  // Initial load. setState fires only AFTER the await (inside the async IIFE),
  // never synchronously in the effect body — keeps react-hooks/set-state-in-effect
  // happy. The cancel flag guards a late resolve after unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await repo.listByProject(projectId);
      if (!cancelled) setRules(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, projectId]);

  const addRule = useCallback(async () => {
    await repo.create({ projectId });
    void reload();
  }, [repo, projectId, reload]);

  // Save rawContent, then compile it into a checklist. Both persist to the row.
  const commitRule = useCallback(
    async (id: string, rawContent: string) => {
      await repo.update(id, { rawContent });
      const hash = hashRuleContent(rawContent);
      if (!rawContent.trim()) {
        await repo.update(id, { checklist: [], compiledFromHash: hash });
        await reload();
        return;
      }
      try {
        const checklist = await compileRule(rawContent, projectId);
        await repo.update(id, { checklist, compiledFromHash: hash });
      } catch (e) {
        log.error('rule compile failed', e);
      } finally {
        await reload();
      }
    },
    [repo, projectId, reload],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await repo.update(id, { enabled });
      void reload();
    },
    [repo, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await repo.delete(id);
      void reload();
    },
    [repo, reload],
  );

  return (
    <section className="dash-section" style={{ marginBottom: 0 }}>
      <div className="dash-section__head">
        <div className="dash-section__title">
          <span className="dash-section__title-mark">⊘</span>
          <span className="dash-section__title-cn">Shadow 规则</span>
          <span className="dash-section__title-en">Shadow Rules</span>
        </div>
        <button
          type="button"
          onClick={() => void addRule()}
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.08em',
            color: 'hsl(var(--accent))',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          ＋ 新增规则
        </button>
      </div>
      <div style={{ padding: '0 4px' }}>
        {rules.length === 0 ? (
          <div
            style={{
              fontSize: 13,
              fontStyle: 'italic',
              color: 'hsl(var(--ink-4))',
              padding: '8px 2px',
            }}
          >
            — 暂无规则。用自然语言写下本书的设定/约束，保存后自动编译成可检查的 checklist —
          </div>
        ) : (
          rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onCommit={commitRule}
              onToggle={toggle}
              onRemove={remove}
            />
          ))
        )}
        <p
          style={{
            marginTop: 10,
            fontSize: 11.5,
            color: 'hsl(var(--ink-4))',
            lineHeight: 1.5,
          }}
        >
          每条规则会被 LLM 编译成原子 checklist；机械项（字数/出场/禁用词）零误报，语义项交由审阅引擎判断。本书简介与字段作为辅助依据，不必在此重复。
        </p>
      </div>
    </section>
  );
}

interface RuleRowProps {
  rule: ProjectRule;
  onCommit: (id: string, rawContent: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

function RuleRow({ rule, onCommit, onToggle, onRemove }: RuleRowProps) {
  const [draft, setDraft] = useState(rule.rawContent);
  const [committing, setCommitting] = useState(false);
  // Re-sync the local draft when the underlying rule changes (prev-snapshot
  // pattern, mirroring ChapterEditor — avoids the set-state-in-effect lint).
  const [synced, setSynced] = useState({ id: rule.id, raw: rule.rawContent });
  if (synced.id !== rule.id || synced.raw !== rule.rawContent) {
    setSynced({ id: rule.id, raw: rule.rawContent });
    setDraft(rule.rawContent);
  }

  const commit = async () => {
    if (draft === rule.rawContent) return;
    setCommitting(true);
    try {
      await onCommit(rule.id, draft);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={{ padding: '8px 2px', borderTop: '1px solid hsl(var(--rule))' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          rows={2}
          placeholder="例：全文第三人称限知 / 主角第五章前不知身世 / 目标字数 3000"
          style={{
            flex: 1,
            resize: 'vertical',
            fontFamily: 'var(--font-serif)',
            fontSize: 13.5,
            lineHeight: 1.4,
            color: 'hsl(var(--ink-1))',
            background: 'transparent',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 4,
            padding: '6px 8px',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => void onToggle(rule.id, e.target.checked)}
            />
            启用
          </label>
          <button
            type="button"
            onClick={() => void onRemove(rule.id)}
            title="删除规则"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'hsl(var(--ink-4))',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Compiled checklist (read-only, author-visible). */}
      {committing ? (
        <div
          style={{
            marginTop: 6,
            paddingLeft: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'hsl(var(--ink-4))',
          }}
        >
          编译中…
        </div>
      ) : rule.checklist.length > 0 ? (
        <div style={{ marginTop: 6, paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rule.checklist.map((ci) => (
            <div
              key={ci.id}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                fontSize: 12,
                color: 'hsl(var(--ink-3))',
              }}
            >
              <span style={{ color: 'hsl(var(--ink-4))' }}>·</span>
              <span style={{ flex: 1, lineHeight: 1.35 }}>{ci.assertion}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  letterSpacing: '0.04em',
                  color: ci.type === 'semantic' ? 'hsl(var(--ink-4))' : 'hsl(var(--accent))',
                  whiteSpace: 'nowrap',
                }}
              >
                {ci.type}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
