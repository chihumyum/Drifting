/**
 * ShadowQuickSettings — the compact Shadow settings page embedded inside the
 * avatar menu. It contains the quick controls writers actually reach for:
 *   - 完成时自动审阅 — auto-run a shadow review when a chapter is marked finished
 *     (shadowAutoRun). Off = mark finished directly; deps-change re-review is never
 *     automatic, it only shows as the「需复审」reminder in ShadowPanel.
 *   - 规则 — the project's freeform review rules (reuses ShadowRulesSection embedded):
 *     edit + enable inline, compiled to checklists on save
 * Room is left below for future Shadow config without a redesign.
 */
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/settings-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { ShadowRulesSection } from './dashboard/ShadowRulesSection';
import '../../styles/copilot-surface.css';

export function ShadowQuickSettings({ onOpenFullSettings }: { onOpenFullSettings?: () => void }) {
  const { t } = useTranslation();
  const autoRun = useSettingsStore((s) => s.shadowAutoRun);
  const setAutoRun = useSettingsStore((s) => s.setShadowAutoRun);
  const { projectId } = useProjectNavigation();

  return (
    <div
      style={{
        padding: 10,
        fontSize: 13,
        color: 'var(--copilot-text)',
      }}
    >
      <ToggleRow
        label={t('shadowQuickMenu.autoReview')}
        desc={t('shadowQuickMenu.autoReviewDesc')}
        checked={autoRun}
        onChange={setAutoRun}
      />

      <div style={{ borderTop: '1px solid var(--copilot-border-soft)', margin: '8px 0 6px' }} />
      <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', margin: '0 2px 4px' }}>
        {t('shadowQuickMenu.rules')}
      </div>
      {projectId ? (
        <ShadowRulesSection projectId={projectId} embedded />
      ) : (
        <div
          style={{
            fontSize: 12,
            fontStyle: 'italic',
            color: 'var(--copilot-text-dim)',
            padding: '4px 2px',
          }}
        >
          {t('shadowQuickMenu.noProject')}
        </div>
      )}

      {onOpenFullSettings && (
        <button
          type="button"
          onClick={onOpenFullSettings}
          style={{
            marginTop: 8,
            width: '100%',
            border: '1px solid var(--copilot-border)',
            borderRadius: 'var(--copilot-radius-sm)',
            background: 'transparent',
            color: 'var(--copilot-text)',
            padding: '5px 8px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {t('settings.copilot.moreSettings')}
        </button>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        width: '100%',
        border: 'none',
        background: 'transparent',
        padding: '5px 4px',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--copilot-text)' }}>{label}</span>
        {desc && (
          <span style={{ fontSize: 10.5, color: 'var(--copilot-text-dim)', lineHeight: 1.3 }}>
            {desc}
          </span>
        )}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 30,
          height: 17,
          borderRadius: 999,
          background: checked ? 'var(--copilot-accent)' : 'var(--copilot-toggle-off)',
          position: 'relative',
          transition: 'background 0.15s',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: 'var(--copilot-knob)',
            transform: checked ? 'translateX(13px)' : 'translateX(0)',
            transition: 'transform 0.15s',
          }}
        />
      </span>
    </button>
  );
}
