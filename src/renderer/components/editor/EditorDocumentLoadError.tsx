import { useTranslation } from 'react-i18next';

/**
 * Canonical prose failed to replay. Showing an explicit, read-only state is
 * safer than revealing an empty temporary editor or leaving the desktop stage
 * permanently covered by the outgoing tab.
 */
export function EditorDocumentLoadError() {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      data-editor-document-load-error
      style={{
        margin: '0 0 12px',
        padding: '9px 10px',
        border: '1px solid hsl(var(--destructive) / 0.3)',
        borderRadius: 4,
        background: 'hsl(var(--destructive) / 0.08)',
        color: 'hsl(var(--destructive))',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {t('entityEditor.bodyLoadError')}
    </div>
  );
}
