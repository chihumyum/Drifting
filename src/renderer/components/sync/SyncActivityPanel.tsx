/**
 * SyncActivityPanel — full history view, launched from the settings page
 * sync section. Complements the existing toast HUD which is foreground-
 * only.
 *
 * Shows:
 *   - aggregate metrics (success rate, inflight count, last sync time)
 *   - chronological log filtered by kind/state
 *   - per-row durationMs, byte counts, error message if failed
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncOperationEvent } from '../../lib/events';
import { useSyncObserver } from '../../services/sync-observer.service';
import { SegmentedControl } from '../ui/SegmentedControl';

const STATE_COLOR: Record<SyncOperationEvent['state'], string> = {
  started: 'hsl(var(--story-2))',
  succeeded: 'hsl(var(--story-3))',
  failed: 'hsl(var(--accent))',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarize(event: SyncOperationEvent, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (event.kind === 'yjs') {
    if (event.phase === 'push') {
      return t('syncActivity.summary.push', {
        local: event.localUpdateCount ?? 0,
        accepted: event.serverSeqCount ?? 0,
      });
    }
    return t('syncActivity.summary.pull', {
      remote: event.remoteUpdateCount ?? 0,
      applied: event.appliedUpdateCount ?? 0,
      skipped: event.skippedUpdateCount ?? 0,
    });
  }
  if (event.resourceCount !== undefined) return `${event.resourceCount} resources`;
  return `${event.entityType ?? 'entity'} ${event.operation}`;
}

export function SyncActivityPanel() {
  const { t } = useTranslation();
  const history = useSyncObserver((s) => s.history);
  const metrics = useSyncObserver((s) => s.metrics);
  const clear = useSyncObserver((s) => s.clear);
  const [filterKind, setFilterKind] = useState<'all' | 'yjs' | 'crud'>('all');
  const [filterState, setFilterState] = useState<'all' | 'failed' | 'succeeded' | 'started'>(
    'all',
  );

  const filtered = useMemo(() => {
    return history.filter((e) => {
      if (filterKind !== 'all' && e.kind !== filterKind) return false;
      if (filterState !== 'all' && e.state !== filterState) return false;
      return true;
    });
  }, [history, filterKind, filterState]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Metric strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 10,
          padding: 14,
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 5,
        }}
      >
        <Stat label={t('syncActivity.stats.successRate')} value={`${Math.round(metrics.successRate * 100)}%`} />
        <Stat
          label={t('syncActivity.stats.total')}
          value={`${metrics.succeeded} / ${metrics.total}`}
          sub={t('syncActivity.stats.failed', { count: metrics.failed })}
        />
        <Stat label={t('syncActivity.stats.inflight')} value={String(metrics.inflight)} />
        <Stat
          label={t('syncActivity.stats.lastSuccess')}
          value={metrics.lastSuccessAt ? formatTime(metrics.lastSuccessAt) : '—'}
        />
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <SegmentedControl
          value={filterKind}
          options={(['all', 'yjs', 'crud'] as const).map((kind) => ({
            value: kind,
            label:
              kind === 'all' ? t('syncActivity.filters.all') : kind === 'yjs' ? 'Yjs' : 'CRUD',
          }))}
          onChange={setFilterKind}
        />
        <SegmentedControl
          value={filterState}
          options={(['all', 'started', 'succeeded', 'failed'] as const).map((state) => ({
            value: state,
            label:
              state === 'all'
                ? t('syncActivity.filters.all')
                : t(`syncActivity.state.${state}`),
          }))}
          onChange={setFilterState}
        />
        <span style={{ flex: 1 }} />
        <button className="set-btn" onClick={clear}>
          {t('syncActivity.clear')}
        </button>
      </div>

      {/* Log */}
      <div
        style={{
          border: '1px solid hsl(var(--rule))',
          borderRadius: 5,
          overflow: 'hidden',
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'hsl(var(--ink-4))',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {t('syncActivity.empty')}
          </div>
        ) : (
          filtered.map((event) => (
            <div
              key={event.requestId + ':' + event.state}
              style={{
                display: 'grid',
                gridTemplateColumns: '78px 70px 60px 1fr 60px',
                gap: 12,
                padding: '8px 14px',
                borderBottom: '1px dotted hsl(var(--rule))',
                fontSize: 12,
                alignItems: 'center',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--ink-4))' }}>
                {formatTime(event.at)}
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: STATE_COLOR[event.state],
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: STATE_COLOR[event.state],
                    display: 'inline-block',
                  }}
                />
                {t(`syncActivity.state.${event.state}`)}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--ink-3))' }}>
                {event.kind} · {event.phase}
              </span>
              <span style={{ color: 'hsl(var(--ink-2))', minWidth: 0 }}>
                {summarize(event, t)}
                {event.error && (
                  <span
                    style={{ color: 'hsl(var(--accent))', fontSize: 11, marginLeft: 8 }}
                    title={event.error}
                  >
                    · {event.error.slice(0, 60)}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'hsl(var(--ink-4))',
                  textAlign: 'right',
                }}
              >
                {formatDuration(event.durationMs)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'hsl(var(--ink-4))',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 22,
          color: 'hsl(var(--ink-1))',
          marginTop: 2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'hsl(var(--ink-4))' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
