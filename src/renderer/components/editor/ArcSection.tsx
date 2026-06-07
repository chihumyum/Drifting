import { useState } from 'react';
import { Loader2, Spline } from 'lucide-react';
import { useElementArc } from '../../usecase/useElementArc';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { ArcConfidence, ArcMap } from '../../domain/element-arc';

const CONF_COLOR: Record<ArcConfidence, string> = {
  high: 'hsl(var(--accent))',
  med: 'hsl(var(--ink-3))',
  low: 'hsl(var(--ink-4))',
};
const TENSION_LABEL: Record<string, string> = {
  contrast: '前后对比',
  'possible-drift': '疑似漂移',
  'uncommitted-evolution': '未记录的演化',
};

// Element editor section: derive + display this element's cross-chapter arc. The
// derivation runs the read-pipeline (deriveElementArc) and persists to `element_arc`;
// here we render the resulting ArcMap. Provenance is chapter-level — labels/orders
// click through to the chapter (no block-level drill-down; that proved noise).
export function ArcSection({ elementId, projectId }: { elementId: string; projectId: string }) {
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
          弧线 · ARC
        </span>
        <span
          title="弧线派生属于 Shadow 模块（影）的只读分析能力；模型档位在 设置 · Shadow 里调。"
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
          Shadow
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
          {arc ? '重新派生' : '派生弧线'}
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
        包含草稿章（默认仅已完成章）
      </label>

      {running && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '6px 0' }}>
          派生中…（逐章抽取 → 蒸馏 → 综合，约 1–2 分钟）
        </div>
      )}
      {job?.status === 'failed' && !running && (
        <div style={{ fontSize: 12, color: 'hsl(0 60% 52%)', padding: '6px 0', whiteSpace: 'pre-wrap' }}>
          ✗ 派生失败：{job.error}
        </div>
      )}
      {!arc && !running && job?.status !== 'failed' && (
        <div style={{ fontSize: 12.5, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '4px 0' }}>
          — 从正文派生该元素的跨章发展轨迹（只读分析，不改稿） —
        </div>
      )}

      {arc && <ArcMapView arc={arc} onJump={jump} />}
    </section>
  );
}

function ArcMapView({ arc, onJump }: { arc: ArcMap; onJump: (chapterId: string) => void }) {
  const overlayByOrder = new Map(arc.patchOverlay.map((o) => [o.atOrder, o]));
  // `n{order}` is a narrative-axis position (narrativeOrder ?? bookOrder), NOT a
  // reader-facing chapter number — keep the neutral `n` framing the point chips use.
  const axisLabel = arc.axis === 'narrativeOrder' ? '叙事序' : '书序';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        title={`覆盖 ${arc.coverage.appearances} 个出场章；截至${axisLabel}位置 n${arc.coverage.generatedAtOrder}（n = ${axisLabel}，非读者章号）`}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'hsl(var(--ink-4))' }}
      >
        覆盖 {arc.coverage.appearances} 章 · 截至 n{arc.coverage.generatedAtOrder}
        {arc.coverage.skipped > 0 ? ` · 跳过 ${arc.coverage.skipped}` : ''}
      </div>

      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'hsl(var(--ink-3))' }}>整体弧线</summary>
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
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderLeft: '2px solid hsl(var(--rule))', paddingLeft: 10 }}
            >
              <button
                type="button"
                onClick={() => onJump(p.chapterId)}
                title="跳到该章"
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
                      title={`作者 patch「${overlay.patchTitle}」${overlay.alignsWithDerived ? '·命中' : '·未对上'}`}
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
            张力 · 待确认
          </span>
          {arc.tensions.map((t, i) => (
            <div key={i} style={{ fontSize: 12, color: 'hsl(var(--ink-2))', lineHeight: 1.45 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'hsl(var(--ink-4))', marginRight: 6 }}>
                [{TENSION_LABEL[t.kind] ?? t.kind}]
              </span>
              {t.note}
              {t.orders.length > 0 && (
                <span style={{ marginLeft: 6 }}>
                  {t.orders.map((o, j) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => onJump(t.chapterIds[j] ?? '')}
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
