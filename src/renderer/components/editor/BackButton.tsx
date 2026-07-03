import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
/*
global BackButton
*/
export function BackButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== 'default';

  if (!canGoBack) return null;

  return (
    <button
      onClick={() => navigate(-1)}
      style={{
        position: 'absolute',
        top: 16,
        left: 24,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderRadius: 8,
        border: '1px solid rgba(0, 0, 0, 0.1)',
        background: 'white',
        cursor: 'pointer',
        fontSize: 14,
        color: '#333',
        transition: 'all 0.2s ease',
        zIndex: 10,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'white';
      }}
    >
      <ArrowLeft size={16} />
      {t('navigation.back')}
    </button>
  );
}
