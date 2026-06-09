import { useState } from 'react';
import { Loader2, Wand2, AlertTriangle, ArrowRight } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { evolveElement } from '../../lib/goal/evolve-element';
import { detectElementDeltas, buildElementChange, type FieldDelta } from '../../lib/goal/element-change';
import type { BookElement } from '../../domain/book-element';
import type { EvolveResult, EvolveStopReason } from '../../lib/goal/types';

const WARN = 'hsl(28 80% 52%)';
const OK = 'hsl(var(--accent))';

const STOP_LABEL: Record<EvolveStopReason, string> = {
  converged: '已收敛 · 矛盾清零',
  'max-rounds': '到轮次上限 · 仍有残余',
  stalled: '停滞 · 未净收缩',
  'no-scope': '无出场章',
  'dry-run': '仅检测',
  'needs-confirmation': '规模较大 · 待确认',
  'out-of-scope': '本质改写 · 需逐场手动',
};

// Element editor section: propagate an element-setting change into the prose of the
// chapters that reference it (canon → 正文). Auto-detects what the author changed
// (baseline-on-open vs current), runs the gated evolve loop, then shows an overview
// + the spots needing manual work. canon→patch capture lives elsewhere (DESIGN.md §5).
export function EvolveSection({ elementId, projectId }: { elementId: string; projectId: string }) {
  const el = useDataStore((s) => s.bookElements.find((e) => e.id === elementId && e.projectId === projectId));
  const { navigateToNode } = useProjectNavigation();

  // Baseline captured when this element first opens (adjust-state-during-render —
  // the sanctioned React pattern, same as ElementEditorView's syncedElementKey), so
  // deltas reflect what the author changed this session.
  const [baseline, setBaseline] = useState<{ id: string; el: BookElement } | null>(null);
  if (el && baseline?.id !== el.id) {
    setBaseline({ id: el.id, el: JSON.parse(JSON.stringify(el)) as BookElement });
  }

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [result, setResult] = useState<EvolveResult | null>(null);

  const deltas = el && baseline ? detectElementDeltas(baseline.el, el) : [];
  const change = el ? buildElementChange(el, deltas, projectId) : null;

  const run = async (opts: { dryRun?: boolean; force?: boolean }) => {
    if (!change) return;
    setRunning(true);
    setResult(null);
    setPhase('');
    try {
      const r = await evolveElement(projectId, change, { ...opts, log: setPhase });
      setResult(r);
    } catch (e) {
      setPhase(`失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const btn = (label: string, onClick: () => void, primary: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={running || !change}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11.5,
        padding: '3px 9px',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 5,
        background: primary ? 'hsl(var(--accent) / 0.12)' : 'hsl(var(--paper-deep))',
        color: running || !change ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
        cursor: running || !change ? 'default' : 'pointer',
      }}
    >
      {running && primary ? (
        <Loader2 size={12} style={{ animation: 'drift-spin 0.9s linear infinite' }} />
      ) : (
        <Wand2 size={12} />
      )}
      {label}
    </button>
  );

  return (
    <section style={{ marginTop: 20, borderTop: '1px solid hsl(var(--rule))', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Wand2 size={14} style={{ color: 'hsl(var(--ink-3))' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em', color: 'hsl(var(--ink-3))' }}>
          演化 · EVOLVE
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {btn('仅检测', () => void run({ dryRun: true }), false)}
          {btn('一键演化', () => void run({}), true)}
        </div>
      </div>

      {deltas.length === 0 && (
        <div style={{ fontSize: 12.5, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '4px 0' }}>
          — 改了该设定后，一键把所有引用它的章节正文改去适应（canon → 正文） —
        </div>
      )}

      {deltas.length > 0 && <ChangedFields deltas={deltas} />}

      {running && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '6px 0', whiteSpace: 'pre-wrap' }}>
          {phase || '准备中…'}
        </div>
      )}
      {!running && phase && !result && (
        <div style={{ fontSize: 12, color: 'hsl(0 60% 52%)', padding: '6px 0', whiteSpace: 'pre-wrap' }}>{phase}</div>
      )}

      {result && <EvolveResultView result={result} onJump={navigateToNode} onForce={() => void run({ force: true })} running={running} />}
    </section>
  );
}

function ChangedFields({ deltas }: { deltas: FieldDelta[] }) {
  return (
    <details style={{ marginBottom: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: 'hsl(var(--ink-3))' }}>
        你改动了：<span style={{ color: 'hsl(var(--ink-1))' }}>{deltas.map((d) => d.label).join('、')}</span>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 0', paddingLeft: 4 }}>
        {deltas.map((d) => (
          <div key={d.label} style={{ fontSize: 11.5, lineHeight: 1.45 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--ink-4))' }}>{d.label}</span>
            <div style={{ color: 'hsl(var(--ink-4))', textDecoration: 'line-through' }}>{d.oldText || '（空）'}</div>
            <div style={{ color: 'hsl(var(--ink-1))' }}>{d.newText || '（空）'}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function EvolveResultView({
  result,
  onJump,
  onForce,
  running,
}: {
  result: EvolveResult;
  onJump: (chapterId: string) => void;
  onForce: () => void;
  running: boolean;
}) {
  const { stopReason, worklist, residual, resolvedCount, rounds, errors, note } = result;
  const staged = Object.values(result.pendingByChapter).reduce((n, cs) => n + cs.length, 0);
  const accent = stopReason === 'converged' ? OK : stopReason === 'out-of-scope' || stopReason === 'needs-confirmation' ? WARN : 'hsl(var(--ink-3))';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: accent,
          border: '1px solid hsl(var(--rule))',
          background: 'hsl(var(--paper-deep) / 0.4)',
          borderRadius: 6,
          padding: '6px 8px',
        }}
      >
        {STOP_LABEL[stopReason]}
        {stopReason !== 'out-of-scope' && stopReason !== 'no-scope' && (
          <span style={{ color: 'hsl(var(--ink-4))' }}>
            {' · '}
            {rounds}轮 · 化解 {resolvedCount} · 残余 {residual.length} · 暂存 {staged} 块改动
          </span>
        )}
        {errors.length > 0 && <span style={{ color: WARN }}>{` · ${errors.length} 章失败(已隔离)`}</span>}
      </div>

      {note && (
        <div style={{ fontSize: 12, color: 'hsl(var(--ink-2))', lineHeight: 1.5, padding: '0 2px' }}>
          <AlertTriangle size={11} style={{ color: WARN, verticalAlign: '-1px', marginRight: 4 }} />
          {note}
        </div>
      )}

      {stopReason === 'needs-confirmation' && (
        <button
          type="button"
          onClick={onForce}
          disabled={running}
          style={{
            alignSelf: 'flex-start',
            fontSize: 11.5,
            padding: '3px 10px',
            border: `1px solid ${WARN}`,
            borderRadius: 5,
            background: 'hsl(28 80% 52% / 0.1)',
            color: running ? 'hsl(var(--ink-4))' : WARN,
            cursor: running ? 'default' : 'pointer',
          }}
        >
          确认并演化（{worklist?.length ?? residual.length} 受影响）
        </button>
      )}

      {/* essence worklist — full appearance set for manual reconception (NOT contradictions) */}
      {worklist && worklist.length > 0 && (
        <ListBlock title={`出场清单 · ${worklist.length} 章（逐场重构，非矛盾清单）`}>
          {worklist.map((w) => (
            <Row key={w.chapterId} onJump={() => onJump(w.chapterId)} title={w.title} order={w.order}>
              <span style={{ color: 'hsl(var(--ink-4))' }}>{w.blockIds.length ? `${w.blockIds.length} 处出场` : '出场'}</span>
            </Row>
          ))}
        </ListBlock>
      )}

      {/* residual contradictions — the spots still needing manual attention after the loop */}
      {residual.length > 0 && (
        <ListBlock title={`需手动 · ${residual.length} 处残余矛盾`}>
          {residual.map((s, i) => (
            <Row key={`${s.chapterId}-${i}`} onJump={() => onJump(s.chapterId)} title={s.chapterTitle} order={undefined}>
              <span style={{ color: 'hsl(var(--ink-3))' }}>{s.reason}</span>
            </Row>
          ))}
        </ListBlock>
      )}

      {staged > 0 && (
        <div style={{ fontSize: 11.5, color: 'hsl(var(--ink-4))', padding: '0 2px' }}>
          已暂存 {staged} 块改动 → 到对应章节逐块审阅（✓ 接受 / ✗ 驳回）。
        </div>
      )}
    </div>
  );
}

function ListBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.05em', color: 'hsl(var(--ink-4))' }}>{title}</span>
      {children}
    </div>
  );
}

function Row({
  onJump,
  title,
  order,
  children,
}: {
  onJump: () => void;
  title: string;
  order?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.45, padding: '2px 0', borderLeft: '2px solid hsl(var(--rule))', paddingLeft: 10 }}>
      <button
        type="button"
        onClick={onJump}
        title="跳到该章"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'hsl(var(--accent))', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 2 }}
      >
        {title}
        {order !== undefined && Number.isFinite(order) ? ` n${order}` : ''}
        <ArrowRight size={10} />
      </button>
      <span style={{ flex: 1, minWidth: 0, color: 'hsl(var(--ink-2))' }}>{children}</span>
    </div>
  );
}
