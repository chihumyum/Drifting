import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentContextUsageCategoryKey,
  AgentContextUsageSnapshot,
} from '../../lib/agent/runtime/types';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = Math.PI * 2 * RING_RADIUS;

const CATEGORY_ORDER: readonly AgentContextUsageCategoryKey[] = [
  'system_prompt',
  'user_messages',
  'assistant_messages',
  'thinking',
  'tool_calls',
  'tool_results',
  'write_reviews',
  'write_reverts',
  'freshness',
  'task_plan',
  'task_constraints',
  'compaction_summaries',
  'tool_definitions',
  'provider_overhead',
];

interface AgentContextIndicatorProps {
  snapshot: AgentContextUsageSnapshot | null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function AgentContextIndicator({ snapshot }: AgentContextIndicatorProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const formatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );

  if (!snapshot) return null;

  const formatTokens = (tokens: number) =>
    t('agentPanel.context.tokens', {
      count: formatter.format(tokens),
      defaultValue: '{{count}} tokens',
    });
  const inputPercent = clampPercent(
    (snapshot.estimatedInputTokens / snapshot.contextWindowTokens) * 100,
  );
  const inputPercentLabel = formatter.format(Number(inputPercent.toFixed(1)));
  const pressure = inputPercent >= 90 ? 'high' : inputPercent >= 75 ? 'medium' : 'low';
  const ringOffset = RING_CIRCUMFERENCE * (1 - inputPercent / 100);
  const title = t('agentPanel.context.tooltip', {
    used: formatter.format(snapshot.estimatedInputTokens),
    limit: formatter.format(snapshot.contextWindowTokens),
    percent: inputPercentLabel,
    output: formatter.format(snapshot.reservedOutputTokens),
    safety: formatter.format(snapshot.safetyMarginTokens),
    defaultValue:
      '{{used}} / {{limit}} tokens ({{percent}}%)\nOutput reserve: {{output}} · safety margin: {{safety}}',
  });

  const categoryByKey = new Map(snapshot.categories.map((category) => [category.key, category]));
  const visibleCategories = CATEGORY_ORDER.flatMap((key) => {
    const category = categoryByKey.get(key);
    return category && category.tokens > 0 ? [category] : [];
  });
  const compactionStageLabels = snapshot.compaction.stages.map((stage) =>
    t(`agentPanel.context.compactionStages.${stage}`, { defaultValue: stage }),
  );
  const allocation = [
    {
      key: 'input',
      label: t('agentPanel.context.allocation.input'),
      tokens: snapshot.estimatedInputTokens,
    },
    {
      key: 'output',
      label: t('agentPanel.context.allocation.output'),
      tokens: snapshot.reservedOutputTokens,
    },
    {
      key: 'safety',
      label: t('agentPanel.context.allocation.safety'),
      tokens: snapshot.safetyMarginTokens,
    },
    {
      key: 'free',
      label: t('agentPanel.context.allocation.free'),
      tokens: snapshot.freeTokens,
    },
  ] as const;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="agt-context-indicator"
        data-pressure={pressure}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span
          className="agt-context-indicator__progress"
          role="progressbar"
          aria-label={t('agentPanel.context.progressAria')}
          aria-valuemin={0}
          aria-valuemax={snapshot.contextWindowTokens}
          aria-valuenow={snapshot.estimatedInputTokens}
          aria-valuetext={`${inputPercentLabel}%`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle className="agt-context-indicator__track" cx="12" cy="12" r={RING_RADIUS} />
            <circle
              className="agt-context-indicator__value"
              cx="12"
              cy="12"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={ringOffset}
            />
          </svg>
        </span>
      </button>

      {open && (
        <ModalRoot
          className="agt-context-modal-root"
          onClose={close}
          ariaLabel={t('agentPanel.context.modalAria')}
        >
          <ModalCard className="agt-context-modal" width={540}>
            <ModalHeader
              kicker={t('agentPanel.context.kicker', { iteration: snapshot.iteration })}
              title={t('agentPanel.context.title')}
              subtitle={t('agentPanel.context.summary', {
                used: formatTokens(snapshot.estimatedInputTokens),
                limit: formatTokens(snapshot.contextWindowTokens),
                percent: inputPercentLabel,
              })}
              description={t('agentPanel.context.description')}
              onClose={close}
              closeLabel={t('common.close', { defaultValue: 'Close' })}
            />
            <ModalBody className="agt-context-modal__body">
              <section className="agt-context-section" aria-labelledby="agt-context-allocation">
                <div className="agt-context-section__heading" id="agt-context-allocation">
                  {t('agentPanel.context.allocation.title')}
                </div>
                <div
                  className="agt-context-allocation"
                  role="img"
                  aria-label={t('agentPanel.context.allocation.aria')}
                >
                  {allocation.map((item) => (
                    <span
                      key={item.key}
                      className={`agt-context-allocation__part agt-context-allocation__part--${item.key}`}
                      style={{ width: `${(item.tokens / snapshot.contextWindowTokens) * 100}%` }}
                    />
                  ))}
                </div>
                <div className="agt-context-allocation__legend">
                  {allocation.map((item) => (
                    <div key={item.key} className="agt-context-legend-row">
                      <span
                        className={`agt-context-legend-row__swatch agt-context-legend-row__swatch--${item.key}`}
                        aria-hidden="true"
                      />
                      <span className="agt-context-legend-row__label">{item.label}</span>
                      <span className="agt-context-legend-row__value">
                        {formatTokens(item.tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="agt-context-section" aria-labelledby="agt-context-breakdown">
                <div className="agt-context-section__heading" id="agt-context-breakdown">
                  {t('agentPanel.context.breakdownTitle')}
                </div>
                <div className="agt-context-category-list">
                  {visibleCategories.map((category) => (
                    <div key={category.key} className="agt-context-category">
                      <div className="agt-context-category__copy">
                        <span>{t(`agentPanel.context.categories.${category.key}`)}</span>
                        <span className="agt-context-category__count">
                          {t('agentPanel.context.sources', { count: category.sourceCount })}
                        </span>
                      </div>
                      <span className="agt-context-category__tokens">
                        {formatTokens(category.tokens)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="agt-context-section" aria-labelledby="agt-context-details">
                <div className="agt-context-section__heading" id="agt-context-details">
                  {t('agentPanel.context.detailsTitle')}
                </div>
                <dl className="agt-context-details">
                  <div>
                    <dt>{t('agentPanel.context.pinned')}</dt>
                    <dd>
                      {t('agentPanel.context.pinnedDetail', {
                        total: formatTokens(snapshot.pinned.totalTokens),
                        semantic: formatTokens(snapshot.pinned.semanticTokens),
                        recent: formatTokens(snapshot.pinned.recentTurnTokens),
                        count: snapshot.pinned.sourceCount,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('agentPanel.context.compaction')}</dt>
                    <dd>
                      {snapshot.compaction.stages.length > 0
                        ? t('agentPanel.context.compactionDetail', {
                            saved: formatTokens(snapshot.compaction.savedTokens),
                            stages: compactionStageLabels.join(' → '),
                            count: snapshot.compaction.summaryCount,
                          })
                        : t('agentPanel.context.compactionNone')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('agentPanel.context.coverage')}</dt>
                    <dd>
                      {t('agentPanel.context.coverageDetail', {
                        represented: snapshot.coverage.representedSources,
                        canonical: snapshot.coverage.canonicalSources,
                        discarded: snapshot.coverage.discardedSources,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('agentPanel.context.toolDefinitions')}</dt>
                    <dd>
                      {snapshot.toolDefinitions.length > 0
                        ? snapshot.toolDefinitions
                            .map((tool) => `${tool.name} · ${formatTokens(tool.estimatedTokens)}`)
                            .join(', ')
                        : t('agentPanel.common.none')}
                    </dd>
                  </div>
                </dl>
                <p className="agt-context-details__note">
                  {t('agentPanel.context.orthogonalNote')}
                </p>
              </section>
            </ModalBody>
          </ModalCard>
        </ModalRoot>
      )}
    </>
  );
}
