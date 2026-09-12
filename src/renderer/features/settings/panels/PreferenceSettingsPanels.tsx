import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSettingsStore,
  TYPEWRITER_POSITION_MAX,
  TYPEWRITER_POSITION_MIN,
  type DateFormat,
  type EditorFontSource,
  type LocaleCode,
  type ParagraphIndent,
  type ThemeMode,
} from '../../../store/settings-store';
import { UI_LOCALE_OPTIONS } from '../../../lib/i18n';
import { ACCENT_COLOR_DEFAULT_DARK, ACCENT_COLOR_DEFAULT_LIGHT } from '../../../lib/theme';
import { platform, type SystemFontFamily } from '../../../platform';
import {
  getImportedProseFontMetadata,
  importProseFont,
  IMPORTED_PROSE_FONT_ACCEPT,
  ProseFontImportError,
  removeImportedProseFont,
  type ImportedProseFontMetadata,
} from '../../../lib/prose-fonts';
import {
  ENTITY_LINK_COLOR_KINDS,
  type EntityLinkColorKind,
  type EntityLinkColorMode,
} from '../../../lib/entity-link-appearance';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSegment,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

export function AppearancePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const resolvedTheme =
    themeMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : themeMode;
  const displayedAccentColor =
    accentColor ??
    (resolvedTheme === 'dark' ? ACCENT_COLOR_DEFAULT_DARK : ACCENT_COLOR_DEFAULT_LIGHT);

  const themes: { value: ThemeMode; name: string; kind: string; tp: string }[] = [
    { value: 'light', name: t('settings.appearance.light'), kind: 'LIGHT', tp: 'tp--light' },
    { value: 'dark', name: t('settings.appearance.dark'), kind: 'DARK', tp: 'tp--dark' },
    { value: 'system', name: t('settings.appearance.system'), kind: 'SYSTEM', tp: 'tp--system' },
  ];

  return (
    <section className="set-panel" ref={registerRef} id="appearance">
      <SettingsPanelHeader
        kicker={t('settings.appearance.kicker')}
        title={t('settings.appearance.title')}
        sub={t('settings.appearance.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.theme')} hint="THEME" />
        <div className="set-theme-grid">
          {themes.map((t) => (
            <button
              key={t.value}
              className={
                'set-theme-card' + (themeMode === t.value ? ' set-theme-card--active' : '')
              }
              onClick={() => setThemeMode(t.value)}
            >
              <div className={'set-theme-card__preview ' + t.tp}>
                <div className="set-theme-card__preview-bar">
                  <span className="set-theme-card__preview-light" />
                  <span className="set-theme-card__preview-light" />
                  <span className="set-theme-card__preview-light" />
                </div>
                <div className="set-theme-card__preview-body">
                  <div className="set-theme-card__preview-rail" />
                  <div className="set-theme-card__preview-lines">
                    <div className="set-theme-card__preview-line" />
                    <div className="set-theme-card__preview-line" />
                    <div className="set-theme-card__preview-line" />
                  </div>
                  <div className="set-theme-card__preview-aux" />
                </div>
              </div>
              <div className="set-theme-card__meta">
                <span className="set-theme-card__name">{t.name}</span>
                <span className="set-theme-card__kind">{t.kind}</span>
              </div>
              <div className="set-theme-card__check">✓</div>
            </button>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.appearance.accent')} hint="ACCENT" />
        <SettingsRow
          label={t('settings.appearance.accent_color')}
          desc={t('settings.appearance.accent_color_desc')}
          control={
            <div className="set-color-picker">
              <input
                className="set-color-picker__input"
                type="color"
                value={displayedAccentColor}
                aria-label={t('settings.appearance.accent_color')}
                onChange={(event) => setAccentColor(event.target.value)}
              />
              <span className="set-color-picker__value">{displayedAccentColor.toUpperCase()}</span>
              {accentColor && (
                <button
                  type="button"
                  className="set-btn set-btn--ghost"
                  onClick={() => setAccentColor(null)}
                >
                  {t('settings.appearance.accent_reset')}
                </button>
              )}
            </div>
          }
        />
      </div>
    </section>
  );
}

function formatFontFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EditorFontControl() {
  const { t, i18n } = useTranslation();
  const editorFontSource = useSettingsStore((state) => state.editorFontSource);
  const setEditorFontSource = useSettingsStore((state) => state.setEditorFontSource);
  const editorSystemFontFamily = useSettingsStore((state) => state.editorSystemFontFamily);
  const setEditorSystemFontFamily = useSettingsStore((state) => state.setEditorSystemFontFamily);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [systemFamilyDraft, setSystemFamilyDraft] = useState(editorSystemFontFamily);
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [loadingSystemFonts, setLoadingSystemFonts] = useState(true);
  const [systemFontsUnavailable, setSystemFontsUnavailable] = useState(false);
  const [importedFont, setImportedFont] = useState<ImportedProseFontMetadata | null>(null);
  const [loadingImportedFont, setLoadingImportedFont] = useState(true);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontMessage, setFontMessage] = useState<{
    tone: 'error' | 'success';
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getImportedProseFontMetadata()
      .then((metadata) => {
        if (!cancelled) setImportedFont(metadata);
      })
      .catch(() => {
        if (!cancelled) {
          setFontMessage({ tone: 'error', text: t('settings.editor.font_error_storage') });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingImportedFont(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void platform.typography
      .listSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch(() => {
        if (!cancelled) setSystemFontsUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingSystemFonts(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectKnownSystemFont = useCallback(
    (family: string) => {
      if (!family) return;
      setSystemFamilyDraft(family);
      setEditorSystemFontFamily(family);
      setEditorFontSource('system-custom');
      setFontMessage(null);
    },
    [setEditorFontSource, setEditorSystemFontFamily],
  );

  const messageForImportError = useCallback(
    (error: unknown): string => {
      if (error instanceof ProseFontImportError) {
        switch (error.code) {
          case 'empty':
            return t('settings.editor.font_error_empty');
          case 'unsupported-format':
            return t('settings.editor.font_error_format');
          case 'too-large':
            return t('settings.editor.font_error_size');
          case 'invalid-font':
            return t('settings.editor.font_error_invalid');
          case 'storage-unavailable':
            return t('settings.editor.font_error_storage');
        }
      }
      return t('settings.editor.font_error_unknown');
    },
    [t],
  );

  const applySystemFont = useCallback(() => {
    const family = systemFamilyDraft.trim();
    if (!family) {
      setFontMessage({ tone: 'error', text: t('settings.editor.font_system_required') });
      return;
    }
    setEditorSystemFontFamily(family);
    setEditorFontSource('system-custom');
    setFontMessage({ tone: 'success', text: t('settings.editor.font_system_applied') });
  }, [setEditorFontSource, setEditorSystemFontFamily, systemFamilyDraft, t]);

  const handleFontFile = useCallback(
    async (file: File) => {
      setFontBusy(true);
      setFontMessage(null);
      try {
        const metadata = await importProseFont(file);
        setImportedFont(metadata);
        setEditorFontSource('imported');
        setFontMessage({ tone: 'success', text: t('settings.editor.font_import_done') });
      } catch (error) {
        setFontMessage({ tone: 'error', text: messageForImportError(error) });
      } finally {
        setFontBusy(false);
      }
    },
    [messageForImportError, setEditorFontSource, t],
  );

  const removeImportedFont = useCallback(async () => {
    setFontBusy(true);
    setFontMessage(null);
    try {
      await removeImportedProseFont();
      setImportedFont(null);
      if (useSettingsStore.getState().editorFontSource === 'imported') {
        setEditorFontSource('system-serif');
      }
      setFontMessage({ tone: 'success', text: t('settings.editor.font_remove_done') });
    } catch (error) {
      setFontMessage({ tone: 'error', text: messageForImportError(error) });
    } finally {
      setFontBusy(false);
    }
  }, [messageForImportError, setEditorFontSource, t]);

  const options: {
    source: EditorFontSource;
    label: string;
    detail: string;
    disabled?: boolean;
  }[] = [
    {
      source: 'system-serif',
      label: t('settings.editor.font_system_serif'),
      detail: t('settings.editor.font_system_serif_desc'),
    },
    {
      source: 'system-sans',
      label: t('settings.editor.font_system_sans'),
      detail: t('settings.editor.font_system_sans_desc'),
    },
    {
      source: 'system-mono',
      label: t('settings.editor.font_system_mono'),
      detail: t('settings.editor.font_system_mono_desc'),
    },
    {
      source: 'system-custom',
      label: t('settings.editor.font_system_custom'),
      detail: editorSystemFontFamily || t('settings.editor.font_not_configured'),
      disabled: !editorSystemFontFamily,
    },
    {
      source: 'imported',
      label: t('settings.editor.font_imported'),
      detail: loadingImportedFont
        ? t('settings.editor.font_loading')
        : importedFont?.fileName || t('settings.editor.font_not_imported'),
      disabled: loadingImportedFont || !importedFont,
    },
  ];

  return (
    <div className="set-font-control">
      <div
        className="set-font-options"
        role="radiogroup"
        aria-label={t('settings.editor.font_source')}
      >
        {options.map((option) => (
          <button
            key={option.source}
            type="button"
            role="radio"
            aria-checked={editorFontSource === option.source}
            className={
              'set-font-option' +
              (editorFontSource === option.source ? ' set-font-option--active' : '')
            }
            disabled={option.disabled || fontBusy}
            onClick={() => setEditorFontSource(option.source)}
          >
            <span className="set-font-option__name">{option.label}</span>
            <span className="set-font-option__detail">{option.detail}</span>
          </button>
        ))}
      </div>

      <div className="set-font-tools">
        <div className="set-font-tool">
          <div className="set-font-tool__copy">
            <span className="set-font-tool__title">{t('settings.editor.font_system_title')}</span>
            <span className="set-font-tool__desc">
              {t('settings.editor.font_system_help')}{' '}
              {loadingSystemFonts
                ? t('settings.editor.font_system_loading')
                : systemFontsUnavailable
                  ? t('settings.editor.font_system_unavailable')
                  : t('settings.editor.font_system_loaded', { count: systemFonts.length })}
            </span>
          </div>
          <div className="set-font-tool__actions">
            <select
              className="set-input set-font-tool__select"
              aria-label={t('settings.editor.font_system_placeholder')}
              value={
                systemFonts.some((font) => font.family === editorSystemFontFamily)
                  ? editorSystemFontFamily
                  : ''
              }
              disabled={loadingSystemFonts || systemFontsUnavailable || systemFonts.length === 0}
              onChange={(event) => selectKnownSystemFont(event.target.value)}
            >
              <option value="">
                {loadingSystemFonts
                  ? t('settings.editor.font_system_loading')
                  : t('settings.editor.font_system_placeholder')}
              </option>
              {systemFonts.map((font) => {
                const localizedAlias = i18n.resolvedLanguage?.startsWith('zh')
                  ? font.aliases.find((alias) => /[\u3400-\u9fff]/u.test(alias))
                  : undefined;
                return (
                  <option key={font.family} value={font.family}>
                    {localizedAlias ? `${localizedAlias} — ${font.family}` : font.family}
                  </option>
                );
              })}
            </select>
          </div>
          <details className="set-font-tool__manual">
            <summary>{t('settings.editor.font_system_manual')}</summary>
            <div className="set-font-tool__manual-actions">
              <input
                className="set-input set-font-tool__input"
                value={systemFamilyDraft}
                maxLength={128}
                placeholder={t('settings.editor.font_system_manual_placeholder')}
                aria-label={t('settings.editor.font_system_manual_placeholder')}
                onChange={(event) => setSystemFamilyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applySystemFont();
                }}
              />
              <button
                type="button"
                className="set-btn"
                disabled={fontBusy}
                onClick={applySystemFont}
              >
                {t('settings.editor.font_use')}
              </button>
            </div>
          </details>
        </div>

        <div className="set-font-tool">
          <div className="set-font-tool__copy">
            <span className="set-font-tool__title">{t('settings.editor.font_import_title')}</span>
            <span className="set-font-tool__desc">
              {importedFont
                ? `${importedFont.fileName} · ${formatFontFileSize(importedFont.byteLength)}`
                : t('settings.editor.font_import_help')}
            </span>
          </div>
          <div className="set-font-tool__actions">
            <button
              type="button"
              className="set-btn"
              disabled={fontBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {fontBusy
                ? t('settings.editor.font_importing')
                : importedFont
                  ? t('settings.editor.font_replace')
                  : t('settings.editor.font_import')}
            </button>
            {importedFont && (
              <button
                type="button"
                className="set-btn set-btn--ghost"
                disabled={fontBusy}
                onClick={() => void removeImportedFont()}
              >
                {t('settings.editor.font_remove')}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORTED_PROSE_FONT_ACCEPT}
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFontFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {fontMessage && (
        <div
          className={`set-font-message set-font-message--${fontMessage.tone}`}
          role={fontMessage.tone === 'error' ? 'alert' : 'status'}
        >
          {fontMessage.text}
        </div>
      )}
    </div>
  );
}

export function EditorPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const {
    bodyFontSize,
    setBodyFontSize,
    lineHeight,
    setLineHeight,
    paragraphIndent,
    setParagraphIndent,
    editorIndentStep,
    setEditorIndentStep,
    paragraphSpacing,
    setParagraphSpacing,
    maxLineWidth,
    setMaxLineWidth,
    resetEditorStyle,
    typewriterMode,
    setTypewriterMode,
    typewriterPosition,
    setTypewriterPosition,
    caretColor,
    setCaretColor,
    entityLinkColorMode,
    setEntityLinkColorMode,
    entityLinkKindColors,
    setEntityLinkKindColor,
    autosave,
    setAutosave,
    autoElementLinkEnabled,
    setAutoElementLinkEnabled,
  } = useSettingsStore();

  const entityLinkKindLabels: Record<EntityLinkColorKind, string> = {
    element: t('settings.editor.entity_link_kind_element'),
    chapter: t('settings.editor.entity_link_kind_chapter'),
    drift: t('settings.editor.entity_link_kind_drift'),
    patch: t('settings.editor.entity_link_kind_patch'),
    category: t('settings.editor.entity_link_kind_category'),
    storyline: t('settings.editor.entity_link_kind_storyline'),
  };
  // A phone cannot render the 480–1280px paper width literally. Preserve a
  // readable sample while scaling that range into a visible 78–100% miniature
  // so the paper-width control still has immediate feedback on mobile.
  const mobilePreviewWidth = 78 + ((maxLineWidth - 480) / (1280 - 480)) * 22;
  const previewStyle = {
    '--set-mobile-preview-width': `${mobilePreviewWidth.toFixed(2)}%`,
  } as CSSProperties;

  return (
    <section className="set-panel" ref={registerRef} id="editor">
      <SettingsPanelHeader
        kicker={t('settings.editor.kicker')}
        title={t('settings.editor.title')}
        sub={t('settings.editor.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.editor.preview')} hint="PREVIEW" />
        {/* Live sample — reads the same --editor-* CSS variables the real editor
            does (set by applyEditorPreferences), so 字号 / 行距 / 段间距 / 段首缩进
            and the Tab 缩进 width all update here as the controls below change. */}
        {/* The box's own width tracks 纸张宽度 (--editor-max-width), capped to the
            settings column, so narrowing the page narrows the preview too. */}
        <div className="set-preview" style={previewStyle} aria-hidden="true">
          <p>{t('settings.editor.preview_p1')}</p>
          <p>{t('settings.editor.preview_p2')}</p>
          <p>{t('settings.editor.preview_p3')}</p>
          <p>{t('settings.editor.preview_p4')}</p>
          <p data-indent="1">{t('settings.editor.preview_p5')}</p>
          <p>{t('settings.editor.preview_p6')}</p>
        </div>
      </div>

      <div className="set-sec">
        <SettingsSectionHeader
          title={t('settings.editor.typesetting')}
          hint="TYPESETTING"
          action={
            <button type="button" className="set-btn set-btn--ghost" onClick={resetEditorStyle}>
              {t('settings.editor.reset_style')}
            </button>
          }
        />
        <SettingsRow
          label={t('settings.editor.font_source')}
          desc={t('settings.editor.font_scope_desc')}
          control={<EditorFontControl />}
          stack
        />
        <SettingsRow
          label={t('settings.editor.font_size')}
          desc={t('settings.editor.font_size_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={12}
                max={28}
                value={bodyFontSize}
                onChange={(e) => setBodyFontSize(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{bodyFontSize} px</span>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.line_height')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={1.0}
                max={2.0}
                step={0.02}
                value={lineHeight}
                onChange={(e) => setLineHeight(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{lineHeight.toFixed(2)}</span>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.indent')}
          desc={t('settings.editor.indent_desc')}
          control={
            <SettingsSegment<ParagraphIndent>
              value={paragraphIndent}
              options={[
                { value: 'none', label: t('settings.editor.indent_none') },
                { value: 'one', label: t('settings.editor.indent_one') },
                { value: 'two', label: t('settings.editor.indent_two') },
              ]}
              onChange={setParagraphIndent}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.tab_indent')}
          desc={t('settings.editor.tab_indent_desc')}
          control={
            <SettingsSegment<string>
              value={String(editorIndentStep)}
              options={['1', '2', '3', '4'].map((v) => ({
                value: v,
                label: t('settings.editor.chars_count', { count: v }),
              }))}
              onChange={(v) => setEditorIndentStep(Number(v))}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.paragraph_spacing')}
          desc={t('settings.editor.paragraph_spacing_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={0}
                max={2.5}
                step={0.05}
                value={paragraphSpacing}
                onChange={(e) => setParagraphSpacing(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{paragraphSpacing.toFixed(2)} em</span>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.page_width')}
          desc={t('settings.editor.page_width_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={480}
                max={1280}
                step={10}
                value={maxLineWidth}
                onChange={(e) => setMaxLineWidth(Number(e.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{maxLineWidth} px</span>
            </div>
          }
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.editor.flow')} hint="FLOW" />
        <SettingsRow
          label={t('settings.editor.typewriter_mode')}
          desc={t('settings.editor.typewriter_mode_desc')}
          control={<SettingsToggle on={typewriterMode} onChange={setTypewriterMode} />}
        />
        <SettingsRow
          label={t('settings.editor.typewriter_position')}
          desc={t('settings.editor.typewriter_position_desc')}
          control={
            <div className="set-slider">
              <input
                type="range"
                min={TYPEWRITER_POSITION_MIN}
                max={TYPEWRITER_POSITION_MAX}
                step={1}
                value={typewriterPosition}
                disabled={!typewriterMode}
                aria-label={t('settings.editor.typewriter_position')}
                onChange={(event) => setTypewriterPosition(Number(event.target.value))}
                style={{ width: 140 }}
              />
              <span className="set-slider__val">{typewriterPosition}%</span>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.caret_color')}
          desc={t('settings.editor.caret_color_desc')}
          control={
            <div className="set-color-picker">
              <input
                className="set-color-picker__input"
                type="color"
                value={caretColor}
                aria-label={t('settings.editor.caret_color')}
                onChange={(event) => setCaretColor(event.target.value)}
              />
              <span className="set-color-picker__value">{caretColor.toUpperCase()}</span>
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.entity_link_style')}
          desc={t('settings.editor.entity_link_style_desc')}
          stack
          control={
            <div className="set-entity-link-style">
              <SettingsSegment<EntityLinkColorMode>
                value={entityLinkColorMode}
                options={[
                  {
                    value: 'contextual',
                    label: t('settings.editor.entity_link_style_contextual'),
                  },
                  {
                    value: 'kind',
                    label: t('settings.editor.entity_link_style_kind'),
                  },
                  {
                    value: 'hover',
                    label: t('settings.editor.entity_link_style_hover'),
                  },
                  {
                    value: 'prose',
                    label: t('settings.editor.entity_link_style_prose'),
                  },
                ]}
                onChange={setEntityLinkColorMode}
              />
              {entityLinkColorMode === 'kind' && (
                <div className="set-entity-link-colors">
                  {ENTITY_LINK_COLOR_KINDS.map((kind) => (
                    <label key={kind} className="set-entity-link-color">
                      <span className="set-entity-link-color__label">
                        {entityLinkKindLabels[kind]}
                      </span>
                      <span className="set-color-picker">
                        <input
                          className="set-color-picker__input"
                          type="color"
                          value={entityLinkKindColors[kind]}
                          aria-label={entityLinkKindLabels[kind]}
                          onChange={(event) => setEntityLinkKindColor(kind, event.target.value)}
                        />
                        <span className="set-color-picker__value">
                          {entityLinkKindColors[kind].toUpperCase()}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          }
        />
        <SettingsRow
          label={t('settings.editor.auto_element_link')}
          desc={t('settings.editor.auto_element_link_desc')}
          control={<SettingsToggle on={autoElementLinkEnabled} onChange={setAutoElementLinkEnabled} />}
        />
        <SettingsRow
          label={t('settings.editor.autosave')}
          desc={
            <>
              {t('settings.editor.autosave_desc_a')} <code>3 {t('settings.editor.seconds')}</code>
              {t('settings.editor.autosave_desc_b')}
            </>
          }
          control={<SettingsToggle on={autosave} onChange={setAutosave} />}
        />
      </div>
    </section>
  );
}

export function LanguagePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const {
    uiLocale,
    setUiLocale,
    manuscriptLocale,
    setManuscriptLocale,
    spellcheck,
    setSpellcheck,
    dateFormat,
    setDateFormat,
  } = useSettingsStore();

  const manuscriptLocales: { code: LocaleCode; name: string; native: string }[] = [
    {
      code: 'zh-CN',
      name: t('settings.language.locales.zhCN'),
      native: t('settings.language.locales.default'),
    },
    {
      code: 'zh-TW',
      name: t('settings.language.locales.zhTW'),
      native: t('settings.language.locales.traditional'),
    },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'ja', name: '日本語', native: '日本語' },
    { code: 'ko', name: '한국어', native: '한국어' },
    { code: 'fr', name: 'Français', native: t('settings.language.locales.beta') },
  ];
  const normalizedUiLocale = uiLocale.startsWith('zh') ? 'zh-CN' : 'en';

  return (
    <section className="set-panel" ref={registerRef} id="language">
      <SettingsPanelHeader
        kicker={t('settings.language.kicker')}
        title={t('settings.language.title')}
        sub={t('settings.language.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.language.ui_locale')} hint="UI LOCALE" />
        <div className="set-locales">
          {UI_LOCALE_OPTIONS.map((l) => (
            <button
              key={l.code}
              className={
                'set-locale' + (normalizedUiLocale === l.code ? ' set-locale--active' : '')
              }
              onClick={() => setUiLocale(l.code)}
            >
              <span className="set-locale__code">{l.code}</span>
              <span className="set-locale__name">{l.name}</span>
              <span className="set-locale__native">{l.native}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.language.manuscript')} hint="MANUSCRIPT" />
        <SettingsRow
          label={t('settings.language.manuscript_default')}
          desc={t('settings.language.manuscript_default_desc')}
          control={
            <select
              className="set-input"
              style={{ minWidth: 220 }}
              value={manuscriptLocale}
              onChange={(e) => setManuscriptLocale(e.target.value as LocaleCode)}
            >
              {manuscriptLocales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} · {l.code}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          label={t('settings.language.spellcheck')}
          desc={t('settings.language.spellcheck_desc')}
          control={<SettingsToggle on={spellcheck} onChange={setSpellcheck} />}
        />
        <SettingsRow
          label={t('settings.language.date_format')}
          desc={t('settings.language.date_format_desc')}
          control={
            <SettingsSegment<DateFormat>
              value={dateFormat}
              options={[
                { value: 'cjk', label: t('settings.language.date_cjk') },
                { value: 'iso', label: 'ISO' },
                { value: 'us', label: 'US' },
              ]}
              onChange={setDateFormat}
            />
          }
        />
      </div>
    </section>
  );
}
