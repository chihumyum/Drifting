import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Spline } from 'lucide-react';
import { useElementArc } from '../../usecase/useElementArc';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { ArcConfidence, ArcMap } from '../../domain/element-arc';

const CONF_COLOR: Record<ArcConfidence, string> = {
  high: 'hsl(var(--accent))',
  med: 'hsl(var(--ink-3))',
  low: 'hsl(var(--ink-4))',
};

// Element editor section: derive + display this element's cross-chapter arc. The
// derivation runs the read-pipeline (deriveElementArc) and persists to `element_arc`;
// here we render the resulting ArcMap. Provenance is chapter-level — labels/orders
// click through to the chapter (no block-level drill-down; that proved noise).
export function ArcSection({ elementId, projectId }: { elementId: string; projectId: string }) {
  const { t } = useTranslation();
  const { job, deriving, derive } = useElementArc(elementId, projectId);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const { navigateToNode } = useProjectNavigation();

  const arc = job?.status === 'done' ? job.result : null;
  const running = deriving || job?.status === 'running';
  const jump = (chapterId: string) => {
    if (chapterId) navigateToNode(chapterId);
  };

  return (
    <section style={{ marginTop: 20, borderTop: '1px solid hsl(var(--rule))', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Spline size={14} style={{ color: 'hsl(var(--ink-3))' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', color: 'hsl(var(--ink-3))' }}>
          {t('arcSection.title')}
        </span>
        <span
          title={t('arcSection.shadowBadgeTitle')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8.5,
            letterSpacing: '0.1em',
            color: 'hsl(var(--ink-4))',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 4,
            padding: '1px 5px',
            textTransform: 'uppercase',
          }}
        >
          {t('arcSection.shadowBadge')}
        </span>
        <button
          type="button"
          onClick={() => void derive(includeDrafts)}
          disabled={running}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11.5,
            padding: '3px 9px',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 5,
            background: 'hsl(var(--paper-deep))',
            color: running ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
            cursor: running ? 'default' : 'pointer',
          }}
        >
          {running ? (
            <Loader2 size={12} style={{ animation: 'drift-spin 0.9s linear infinite' }} />
          ) : (
            <Spline size={12} />
          )}
          {arc ? t('arcSection.actions.rerun') : t('arcSection.actions.derive')}
        </button>
      </div>

      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
          marginBottom: 8,
        }}
      >
        <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
        {t('arcSection.includeDrafts')}
      </label>

      {running && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '6px 0' }}>
          {t('arcSection.running')}
        </div>
      )}
      {job?.status === 'failed' && !running && (
        <div style={{ fontSize: 12, color: 'hsl(0 60% 52%)', padding: '6px 0', whiteSpace: 'pre-wrap' }}>
          {t('arcSection.failed', { error: job.error })}
        </div>
      )}
      {!arc && !running && job?.status !== 'failed' && (
        <div style={{ fontSize: 12.5, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '4px 0' }}>
          {t('arcSection.empty')}
        </div>
      )}

      {arc && <ArcMapView arc={arc} onJump={jump} />}
    </section>
  );
}

function ArcMapView({ arc, onJump }: { arc: ArcMap; onJump: (chapterId: string) => void }) {
  const { t } = useTranslation();
  const overlayByOrder = new Map(arc.patchOverlay.map((o) => [o.atOrder, o]));
  // `n{order}` is a narrative-axis position (narrativeOrder ?? bookOrder), NOT a
  // reader-facing chapter number — keep the neutral `n` framing the point chips use.
  const axisLabel = arc.axis === 'narrativeOrder'
    ? t('arcSection.axis.narrativeOrder')
    : t('arcSection.axis.bookOrder');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        title={t('arcSection.coverageTitle', {
          count: arc.coverage.appearances,
          axis: axisLabel,
          order: arc.coverage.generatedAtOrder,
        })}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'hsl(var(--ink-4))' }}
      >
        {t('arcSection.coverageLine', {
          count: arc.coverage.appearances,
          order: arc.coverage.generatedAtOrder,
        })}
        {arc.coverage.skipped > 0 ? t('arcSection.skipped', { count: arc.coverage.skipped }) : ''}
      </div>

      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'hsl(var(--ink-3))' }}>
          {t('arcSection.overall')}
        </summary>
        <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.6, color: 'hsl(var(--ink-2))' }}>
          {arc.narrative}
        </p>
      </details>

      {/* Trajectory — vertical order axis */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {arc.points.map((p) => {
          const overlay = overlayByOrder.get(p.order);
          return (
            <div
              key={`${p.order}-${p.label}`}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                padding: '4px 10px',
                borderRadius: 'var(--radius-xs)',
                background: 'hsl(var(--ink-1) / 0.025)',
              }}
            >
              <button
                type="button"
                onClick={() => onJump(p.chapterId)}
                title={t('evolveSection.common.jumpToChapter')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'hsl(var(--accent))',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                n{p.order}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'hsl(var(--ink-1))', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: CONF_COLOR[p.confidence], flexShrink: 0 }} />
                  {p.label}
                  {overlay && (
                    <span
                      title={t('arcSection.patchOverlayTitle', {
                        title: overlay.patchTitle,
                        status: overlay.alignsWithDerived
                          ? t('arcSection.patchOverlayHit')
                          : t('arcSection.patchOverlayMiss'),
                      })}
                      style={{ fontSize: 10, color: overlay.alignsWithDerived ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))' }}
                    >
                      ◆{overlay.alignsWithDerived ? '' : '?'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'hsl(var(--ink-3))', lineHeight: 1.4 }}>{p.state}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tensions — neutral surfacing */}
      {arc.tensions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', color: 'hsl(var(--ink-4))' }}>
            {t('arcSection.tensionsTitle')}
          </span>
          {arc.tensions.map((tension, i) => (
            <div key={i} style={{ fontSize: 12, color: 'hsl(var(--ink-2))', lineHeight: 1.45 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                [{t(`arcSection.tensionKind.${tension.kind}`, { defaultValue: tension.kind })}]
              </span>
              {tension.note}
              {tension.orders.length > 0 && (
                <span style={{ marginLeft: 6 }}>
                  {tension.orders.map((o, j) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => onJump(tension.chapterIds[j] ?? '')}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--accent))', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                    >
                      →n{o}
                    </button>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
