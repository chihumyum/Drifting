import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { AuthFlow } from '../../../features/auth/AuthFlow';
import '../../../../styles/mobile-auth.css';

interface MobileAuthPageProps {
  initialMode: 'signin' | 'signup';
}

export function MobileAuthPage({ initialMode }: MobileAuthPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const returnToLibrary = useCallback(() => navigate('/'), [navigate]);

  return (
    <main className="m-auth">
      <button type="button" className="m-auth__back" onClick={returnToLibrary}>
        <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
        {t('settings.hosted.back_to_library')}
      </button>
      <AuthFlow initialMode={initialMode} presentation="page" onComplete={returnToLibrary} />
    </main>
  );
}
