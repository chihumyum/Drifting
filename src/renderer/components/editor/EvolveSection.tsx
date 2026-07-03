import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Wand2, AlertTriangle, ArrowRight, Square } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore, type EvolveEditorEngine, type AgentEditMode } from '../../store/settings-store';
import { useEvolveStore, EMPTY_EVOLVE } from '../../store/evolve-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { detectElementDeltas, buildElementChange, landDelta, type FieldDelta } from '../../lib/goal/element-change';
import type { BookElement } from '../../domain/book-element';
import type { AgentBlockChange } from '../../lib/agent/block-diff';
import type { ContradictionSpot, EvolveResult, EvolveStopReason, EvolveTraceStep } from '../../lib/goal/types';

const WARN = 'hsl(28 80% 52%)';
const OK = 'hsl(var(--accent))';

const STOP_LABEL_KEY: Record<EvolveStopReason, string> = {
  converged: 'evolveSection.stop.converged',
  'max-rounds': 'evolveSection.stop.maxRounds',
  stalled: 'evolveSection.stop.stalled',
  'no-scope': 'evolveSection.stop.noScope',
  'dry-run': 'evolveSection.stop.dryRun',
  'needs-confirmation': 'evolveSection.stop.needsConfirmation',
  'out-of-scope': 'evolveSection.stop.outOfScope',
  aborted: 'evolveSection.stop.aborted',
};

// Element editor section: propagate an element-setting change into the prose of the
// chapters that reference it (canon → 正文). Auto-detects what the author changed
// (baseline-on-open vs current), runs the gated evolve loop, then shows an overview
// + the spots needing manual work. canon→patch capture lives elsewhere (DESIGN.md §5).
export function EvolveSection({ elementId, projectId }: { elementId: string; projectId: string }) {
  const { t } = useTranslation();
  const el = useDataStore((s) => s.bookElements.find((e) => e.id === elementId && e.projectId === projectId));
  const { navigateToNode } = useProjectNavigation();
  const editorEngine = useSettingsStore((s) => s.evolveEditorEngine);
  const setEditorEngine = useSettingsStore((s) => s.setEvolveEditorEngine);
  const shadowEditMode = useSettingsStore((s) => s.shadowEditMode);
  const setShadowEditMode = useSettingsStore((s) => s.setShadowEditMode);

  // Baseline captured when this element first opens (adjust-state-during-render —
  // the sanctioned React pattern, same as ElementEditorView's syncedElementKey), so
  // deltas reflect what the author changed this session.
  const [baseline, setBaseline] = useState<{ id: string; el: BookElement } | null>(null);
  if (el && baseline?.id !== el.id) {
    setBaseline({ id: el.id, el: JSON.parse(JSON.stringify(el)) as BookElement });
  }

  // Draft filter (mirrors ArcSection): default OFF — don't rewrite half-written
  // drafts; only chapters the author marked 「finished」 are in scope.
  const [includeDrafts, setIncludeDrafts] = useState(false);

  // Run state is keyed by elementId in the store, so each element shows its OWN
  // evolve and the run survives navigating away and back.
  const { running, phase, result, trace } = useEvolveStore((s) => s.byElement[elementId]) ?? EMPTY_EVOLVE;
  const startRun = useEvolveStore((s) => s.run);
  const stopRun = useEvolveStore((s) => s.stop);

  const deltas = el && baseline ? detectElementDeltas(baseline.el, el) : [];
  const change = el ? buildElementChange(el, deltas, projectId) : null;

  const run = (opts: { dryRun?: boolean; force?: boolean }) => {
    if (!change) return;
    void startRun(elementId, projectId, change, { ...opts, includeDrafts });
  };

  // Exclude a change from evolve by treating it as ALREADY landed — advance the
  // baseline for that field so it stops showing up as a delta (and isn't fed to a
  // run). Re-editing that field later surfaces it again. Avoids wasting a run on
  // settled little tweaks (e.g. a fact you fixed and don't need propagated).
  const dismiss = (d: FieldDelta) => {
    if (!el || !baseline) return;
    setBaseline({ id: baseline.id, el: landDelta(baseline.el, el, d) });
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
          {t('evolveSection.kicker')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {btn(t('evolveSection.actions.dryRun'), () => run({ dryRun: true }), false)}
          {btn(t('evolveSection.actions.evolve'), () => run({}), true)}
          {running && (
            <button
              type="button"
              onClick={() => stopRun(elementId)}
              title={t('evolveSection.actions.stopTitle')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11.5,
                padding: '3px 9px',
                border: `1px solid ${WARN}`,
                borderRadius: 5,
                background: 'hsl(28 80% 52% / 0.1)',
                color: WARN,
                cursor: 'pointer',
              }}
            >
              <Square size={11} />
              {t('evolveSection.actions.stop')}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        <Seg
          label={t('evolveSection.controls.engine')}
          value={editorEngine}
          options={[
            ['agent-sdk', 'Agent SDK'],
            ['shadow-fc', 'Shadow-FC'],
          ]}
          onChange={(v) => setEditorEngine(v as EvolveEditorEngine)}
          disabled={running}
        />
        <Seg
          label={t('evolveSection.controls.approval')}
          value={shadowEditMode}
          options={[
            ['approve', t('evolveSection.controls.needApproval')],
            ['auto', t('evolveSection.controls.auto')],
          ]}
          onChange={(v) => setShadowEditMode(v as AgentEditMode)}
          disabled={running}
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'hsl(var(--ink-4))',
            cursor: running ? 'default' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={includeDrafts}
            disabled={running}
            onChange={(e) => setIncludeDrafts(e.target.checked)}
          />
          {t('evolveSection.controls.includeDrafts')}
        </label>
      </div>

      {deltas.length === 0 && (
        <div style={{ fontSize: 12.5, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '4px 0' }}>
          {t('evolveSection.emptyHint')}
        </div>
      )}

      {deltas.length > 0 && <ChangedFields deltas={deltas} onDismiss={dismiss} disabled={running} />}

      {running && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'hsl(var(--ink-4))', padding: '6px 0', whiteSpace: 'pre-wrap' }}>
          {phase || t('evolveSection.status.preparing')}
        </div>
      )}
      {!running && phase && !result && (
        <div style={{ fontSize: 12, color: 'hsl(0 60% 52%)', padding: '6px 0', whiteSpace: 'pre-wrap' }}>{phase}</div>
      )}

      {/* Live + post-hoc inspection: every critic round and editor tool call. */}
      <TraceView trace={trace} running={running} />

      {result && <EvolveResultView result={result} onJump={navigateToNode} onForce={() => run({ force: true })} running={running} />}
    </section>
  );
}

const PHASE_LABEL_KEY: Record<EvolveTraceStep['phase'], string> = {
  detect: 'evolveSection.trace.phase.detect',
  edit: 'evolveSection.trace.phase.edit',
  verify: 'evolveSection.trace.phase.verify',
};

/** Inspectable trail of the run — each critic 查证/裁决 round and each editor tool
 *  call, tagged [r{round}·phase]《章》. Temporary debugging surface: collapsed by
 *  default after a run, auto-open while running so progress is visible live. */
function TraceView({ trace, running }: { trace: EvolveTraceStep[]; running: boolean }) {
  const { t } = useTranslation();
  if (trace.length === 0) return null;
  // key remount on running-flip: live run renders force-open (progress visible);
  // once done it remounts collapsed and the user's manual toggle isn't clobbered
  // by re-renders (React re-asserts a controlled `open` prop on every commit).
  return (
    <details key={running ? 'live' : 'done'} open={running || undefined} style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'hsl(var(--ink-4))' }}>
        {t('evolveSection.trace.summary', { count: trace.length })}
      </summary>
      <div
        style={{
          maxHeight: 280,
          overflowY: 'auto',
          margin: '6px 0 0',
          padding: '6px 8px',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 6,
          background: 'hsl(var(--paper-deep) / 0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {trace.map((step, i) => (
          <div key={i} style={{ fontSize: 11, lineHeight: 1.5 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              <span style={{ color: 'hsl(var(--ink-4))' }}>
                r{step.round}·{t(PHASE_LABEL_KEY[step.phase])}《{step.chapterTitle}》
              </span>{' '}
              <span style={{ color: step.actor === 'critic' ? 'hsl(265 45% 55%)' : 'hsl(var(--accent))' }}>
                {step.actor === 'critic'
                  ? t('evolveSection.trace.actor.critic')
                  : t('evolveSection.trace.actor.editor')}
              </span>{' '}
              <span style={{ color: 'hsl(var(--ink-2))' }}>{step.step.label}</span>
            </div>
            {step.step.detail && (
              <div style={{ color: 'hsl(var(--ink-3))', paddingLeft: 12 }}>{step.step.detail}</div>
            )}
            {step.step.items?.map((it, j) => (
              <div key={j} style={{ color: 'hsl(var(--ink-3))', paddingLeft: 12 }}>
                · {it}
              </div>
            ))}
            {step.step.calls?.map((c, j) => (
              <div
                key={j}
                title={c.result}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  paddingLeft: 12,
                  color: c.status === 'ok' ? 'hsl(var(--ink-3))' : 'hsl(0 60% 52%)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.tool}
                {c.args ? `(${c.args})` : '()'} → {c.status}
                {c.note ? ` · ${c.note}` : ''}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

function Seg({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--ink-4))' }}>{label}</span>
      <span style={{ display: 'inline-flex', border: '1px solid hsl(var(--rule))', borderRadius: 5, overflow: 'hidden' }}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(v)}
            style={{
              fontSize: 10.5,
              padding: '2px 8px',
              border: 'none',
              cursor: disabled ? 'default' : 'pointer',
              background: value === v ? 'hsl(var(--accent) / 0.15)' : 'transparent',
              color: value === v ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
            }}
          >
            {l}
          </button>
        ))}
      </span>
    </span>
  );
}

function ChangedFields({
  deltas,
  onDismiss,
  disabled,
}: {
  deltas: FieldDelta[];
  onDismiss: (d: FieldDelta) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <details style={{ marginBottom: 6 }} open>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: 'hsl(var(--ink-3))' }}>
        {t('evolveSection.changed.summary', { count: deltas.length })}
        <span style={{ color: 'hsl(var(--ink-1))' }}>{deltas.map((d) => d.label).join('、')}</span>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 0', paddingLeft: 4 }}>
        {deltas.map((d) => (
          <div key={`${d.kind}:${d.label}`} style={{ fontSize: 11.5, lineHeight: 1.45, display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'hsl(var(--ink-4))' }}>{d.label}</span>
              <div style={{ color: 'hsl(var(--ink-4))', textDecoration: 'line-through' }}>{d.oldText || t('evolveSection.changed.empty')}</div>
              <div style={{ color: 'hsl(var(--ink-1))' }}>{d.newText || t('evolveSection.changed.empty')}</div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(d)}
              disabled={disabled}
              title={t('evolveSection.changed.dismissTitle')}
              style={{
                alignSelf: 'flex-start',
                flexShrink: 0,
                fontSize: 10,
                padding: '1px 7px',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 4,
                background: 'transparent',
                color: disabled ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-3))',
                cursor: disabled ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t('evolveSection.changed.dismiss')}
            </button>
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
  const { t } = useTranslation();
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
        {t(STOP_LABEL_KEY[stopReason])}
        {stopReason !== 'out-of-scope' && stopReason !== 'no-scope' && (
          <span style={{ color: 'hsl(var(--ink-4))' }}>
            {' · '}
            {t('evolveSection.result.stats', {
              rounds,
              resolved: resolvedCount,
              residual: residual.length,
              staged,
            })}
          </span>
        )}
        {errors.length > 0 && (
          <span style={{ color: WARN }}>
            {' · '}
            {t('evolveSection.result.errors', { count: errors.length })}
          </span>
        )}
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
          {t('evolveSection.result.confirmAndEvolve', {
            count: worklist?.length ?? residual.length,
          })}
        </button>
      )}

      {/* essence worklist — full appearance set for manual reconception (NOT contradictions) */}
      {worklist && worklist.length > 0 && (
        <ListBlock title={t('evolveSection.result.worklistTitle', { count: worklist.length })}>
          {worklist.map((w) => (
            <Row key={w.chapterId} onJump={() => onJump(w.chapterId)} title={w.title} order={w.order}>
              <span style={{ color: 'hsl(var(--ink-4))' }}>
                {w.blockIds.length
                  ? t('evolveSection.result.appearanceCount', { count: w.blockIds.length })
                  : t('evolveSection.result.appearance')}
              </span>
            </Row>
          ))}
        </ListBlock>
      )}

      {/* residual contradictions — the spots still needing manual attention after the loop */}
      {residual.length > 0 && (
        <ListBlock title={t('evolveSection.result.residualTitle', { count: residual.length })}>
          {residual.map((s, i) => (
            <Row key={`${s.chapterId}-${i}`} onJump={() => onJump(s.chapterId)} title={s.chapterTitle} order={undefined}>
              <span style={{ color: 'hsl(var(--ink-3))' }}>{s.reason}</span>
            </Row>
          ))}
        </ListBlock>
      )}

      {/* Full readable log — every contradiction found + every block changed, per chapter. */}
      <ActivityLog result={result} onJump={onJump} />

      {staged > 0 && (
        <div style={{ fontSize: 11.5, color: 'hsl(var(--ink-4))', padding: '0 2px' }}>
          {t('evolveSection.result.stagedNote', { count: staged })}
        </div>
      )}
    </div>
  );
}

/** Per-chapter rollup of what the run found and what it changed — the "发现了什么矛盾、
 *  改了什么地方" record, so the author can read the whole pass without hopping chapters.
 *  Merges the round-0 discovery list (initialSpots) with the staged edits
 *  (pendingByChapter, before→after), keyed + ordered by chapter. */
function ActivityLog({ result, onJump }: { result: EvolveResult; onJump: (chapterId: string) => void }) {
  const { t } = useTranslation();
  const orderOf = new Map(result.scoped.map((c) => [c.chapterId, c.order] as const));
  const titleOf = new Map(result.scoped.map((c) => [c.chapterId, c.title] as const));
  const rows = new Map<string, { title: string; order: number; found: ContradictionSpot[]; edits: AgentBlockChange[] }>();
  const ensure = (chapterId: string, title: string) => {
    let e = rows.get(chapterId);
    if (!e) {
      e = { title, order: orderOf.get(chapterId) ?? Number.POSITIVE_INFINITY, found: [], edits: [] };
      rows.set(chapterId, e);
    }
    return e;
  };
  for (const s of result.initialSpots) ensure(s.chapterId, s.chapterTitle).found.push(s);
  for (const [chapterId, changes] of Object.entries(result.pendingByChapter)) {
    ensure(chapterId, titleOf.get(chapterId) ?? chapterId).edits.push(...changes);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[1].order - b[1].order);
  if (ordered.length === 0) return null;

  return (
    <ListBlock title={t('evolveSection.activity.title', { count: ordered.length })}>
      {ordered.map(([chapterId, e]) => (
        <details key={chapterId} style={{ borderLeft: '2px solid hsl(var(--rule))', paddingLeft: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1.5, display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <button
              type="button"
              onClick={(ev) => {
                ev.preventDefault();
                onJump(chapterId);
              }}
              title={t('evolveSection.common.jumpToChapter')}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'hsl(var(--accent))', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}
            >
              {e.title}
              {Number.isFinite(e.order) ? ` n${e.order}` : ''}
            </button>
            <span style={{ color: 'hsl(var(--ink-3))' }}>
              {t('evolveSection.activity.summary', {
                found: e.found.length,
                edits: e.edits.length,
              })}
            </span>
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: '5px 0 8px', paddingLeft: 2 }}>
            {e.found.map((s, i) => (
              <div key={`f${i}`} style={{ fontSize: 11.5, lineHeight: 1.45, color: 'hsl(var(--ink-2))' }}>
                <span style={{ color: WARN, marginRight: 5 }}>{t('evolveSection.activity.found')}</span>
                {s.reason}
              </div>
            ))}
            {e.edits.map((c, i) => (
              <div key={`e${i}`} style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                <span style={{ color: OK, marginRight: 5 }}>{t('evolveSection.activity.edit')}</span>
                {c.oldText && (
                  <span style={{ color: 'hsl(var(--ink-4))', textDecoration: 'line-through' }}>{c.oldText}</span>
                )}
                {c.oldText && c.newText && <span style={{ color: 'hsl(var(--ink-4))' }}> → </span>}
                {c.newText && <span style={{ color: 'hsl(var(--ink-1))' }}>{c.newText}</span>}
                {!c.newText && <span style={{ color: 'hsl(var(--ink-4))' }}>{t('common.deleted_paren')}</span>}
              </div>
            ))}
          </div>
        </details>
      ))}
    </ListBlock>
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
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.45, padding: '2px 0', borderLeft: '2px solid hsl(var(--rule))', paddingLeft: 10 }}>
      <button
        type="button"
        onClick={onJump}
        title={t('evolveSection.common.jumpToChapter')}
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
